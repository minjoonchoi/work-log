import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shared.mjs';
import { Harness, event } from '../helpers.mjs';

test('native GUI recovers failed pages and termination callbacks, preserves background startup, and opens a window on launch or reopen', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-native-connection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let ready = false, navigationFailures = 0;
  const successfulNavigations = { '/': 0, '/quick': 0 };
  const server = http.createServer((req, res) => {
    if (!ready) { navigationFailures += req.url === '/' || req.url === '/quick' ? 1 : 0; req.socket.destroy(); return; }
    if (req.url === '/api/quick') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ counts: { current: 0, attention: 0, waiting: 0 }, health: { runtime_connected: true } }));
      return;
    }
    if (req.url in successfulNavigations) successfulNavigations[req.url]++;
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><body>native connection recovered</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  fs.writeFileSync(path.join(dir, 'manager.endpoint.json'), JSON.stringify({ port: server.address().port }));
  fs.writeFileSync(path.join(dir, 'token'), 'isolated-native-test-token');
  const main = fs.readFileSync(path.join(ROOT, 'apps/macos/main.swift'), 'utf8').split('let application = NSApplication.shared')[0];
  const driver = `
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let delegate = AppDelegate()
delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
let background = ProcessInfo.processInfo.arguments.contains("--background")
let backgroundHidden = !delegate.window.isVisible && !delegate.popover.isShown && delegate.webView == nil
if background { delegate.loadMain() }
let retry = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in delegate.refreshConnection() }
var firstMain = "", firstQuick = ""
Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { _ in
    delegate.webView!.evaluateJavaScript("document.body.innerText") { value, error in firstMain = value as? String ?? "" }
    delegate.quickWebView!.evaluateJavaScript("document.body.innerText") { value, error in firstQuick = value as? String ?? "" }
}
// Exercise the public WKNavigationDelegate notification without terminating any
// unrelated WebKit processes on the developer's machine.
Timer.scheduledTimer(withTimeInterval: 3.5, repeats: false) { _ in
    for view in [delegate.webView!, delegate.quickWebView!] {
        view.evaluateJavaScript("document.body.innerText = 'terminated content'") { _, _ in delegate.webViewWebContentProcessDidTerminate(view) }
    }
}
Timer.scheduledTimer(withTimeInterval: 5.5, repeats: false) { _ in
    delegate.webView!.evaluateJavaScript("document.body.innerText") { main, error in
        delegate.quickWebView!.evaluateJavaScript("document.body.innerText") { quick, error in
            let initialLaunchOpenedWindow = delegate.window.isVisible && !delegate.popover.isShown
            _ = delegate.applicationShouldHandleReopen(application, hasVisibleWindows: false)
            let reopenedWindow = delegate.window.isVisible && !delegate.popover.isShown
            delegate.window.orderOut(nil)
            let result: [String: Any] = ["firstMain": firstMain, "firstQuick": firstQuick,
                "main": main as? String ?? "", "quick": quick as? String ?? "", "health": delegate.connectionItem.title,
                "backgroundHidden": backgroundHidden, "initialLaunchOpenedWindow": initialLaunchOpenedWindow, "reopenedWindow": reopenedWindow]
            let bytes = try! JSONSerialization.data(withJSONObject: result)
            print(String(data: bytes, encoding: .utf8)!)
            fflush(stdout)
            exit(0)
        }
    }
}
application.run()
`;
  const source = path.join(dir, 'main.swift'), executable = path.join(dir, 'native-test');
  fs.writeFileSync(source, main + driver);
  const compiled = spawnSync('swiftc', ['-framework', 'Cocoa', '-framework', 'WebKit', source, '-o', executable], { encoding: 'utf8', timeout: 20000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  async function run(args) {
    const child = spawn(executable, args, { env: { ...process.env, HARNESS_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout.trim());
  }
  const recover = setTimeout(() => { ready = true; }, 1500); t.after(() => clearTimeout(recover));
  const result = await run(['--background']);
  assert.ok(navigationFailures >= 2, 'both initial WebView requests fail while the endpoint remains unchanged');
  assert.equal(result.backgroundHidden, true);
  assert.equal(result.initialLaunchOpenedWindow, false);
  assert.equal(result.reopenedWindow, true);
  assert.equal(result.health, '실행·관리 서비스 연결됨');
  assert.equal(result.firstMain, 'native connection recovered');
  assert.equal(result.firstQuick, 'native connection recovered');
  assert.equal(result.main, 'native connection recovered');
  assert.equal(result.quick, 'native connection recovered');
  assert.deepEqual(successfulNavigations, { '/': 2, '/quick': 2 }, 'healthy polling preserves loaded pages');
  const launched = await run([]);
  assert.equal(launched.initialLaunchOpenedWindow, true, 'ordinary app launch opens the main window instead of toggling the menu-bar popover');
  assert.equal(launched.reopenedWindow, true);
});

test('native WebViews load the real manager pages, injected authentication, modules and work item data', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
  const h = await new Harness().start('manager');
  t.after(() => h.close());
  await h.ingest([event('native-real-ui', 'input', '10:00:00', 'turn-1', { text: '네이티브 연결 확인 업무', work_item_id: 'native-ui-item' })]);
  const main = fs.readFileSync(path.join(ROOT, 'apps/macos/main.swift'), 'utf8').split('let application = NSApplication.shared')[0];
  const source = path.join(h.dir, 'main.swift'), executable = path.join(h.dir, 'native-test');
  fs.writeFileSync(source, main + `
let application = NSApplication.shared
let delegate = AppDelegate()
delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
delegate.loadMain()
let refresh = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in delegate.refreshConnection(); delegate.setQuickVisible(true) }
Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { _ in
    delegate.webView!.evaluateJavaScript("JSON.stringify({ title: document.title, items: document.querySelector('#item-count')?.textContent, body: document.body.innerText, error: document.querySelector('#error')?.textContent, icons: Array.from(document.querySelectorAll('.sidebar button svg')).map(icon => icon.getBBox().width > 0 && icon.getBoundingClientRect().width > 0) })") { main, error in
        delegate.quickWebView!.evaluateJavaScript("JSON.stringify({ count: document.querySelector('#current-count')?.textContent, body: document.body.innerText, icons: Array.from(document.querySelectorAll('button svg')).map(icon => icon.getBBox().width > 0 && icon.getBoundingClientRect().width > 0) })") { quick, error in
            let result: [String: Any] = ["main": main as? String ?? "", "quick": quick as? String ?? "", "mainReady": delegate.mainReady, "statusIconVisible": (delegate.statusItem.button?.image?.size.width ?? 0) > 0]
            print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
            fflush(stdout); exit(0)
        }
    }
}
application.run()
`);
  const compiled = spawnSync('swiftc', ['-framework', 'Cocoa', '-framework', 'WebKit', source, '-o', executable], { encoding: 'utf8', timeout: 15000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const child = spawn(executable, ['--background'], { env: { ...process.env, HARNESS_DATA_DIR: h.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0, stderr);
  const result = JSON.parse(stdout.trim()), page = JSON.parse(result.main), quick = JSON.parse(result.quick);
  assert.equal(result.mainReady, true, 'the real module completes its authenticated initial load and notifies the native host');
  assert.equal(page.title, 'WorkLog'); assert.equal(page.items, '1'); assert.equal(page.error, '');
  assert.match(page.body, /네이티브 연결 확인 업무/);
  assert.equal(quick.count, '1'); assert.match(quick.body, /네이티브 연결 확인 업무/);
  assert.deepEqual(page.icons, Array(7).fill(true), 'bundled SVG menu icons render in the native WKWebView');
  assert.deepEqual(quick.icons, Array(4).fill(true), 'quick panel SVG icons render in the native WKWebView');
  assert.equal(result.statusIconVisible, true, 'native vector fallback supplies an image in a test executable without bundle resources');
});
