import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shared.mjs';

test('native app serializes startup/quit, accepts retained user work, and stays open after service control failures', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-native-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = fs.readFileSync(path.join(ROOT, 'apps/macos/main.swift'), 'utf8').split('let application = NSApplication.shared')[0];
  const source = path.join(dir, 'main.swift'), executable = path.join(dir, 'native-test');
  fs.writeFileSync(source, main + `
let application = NSApplication.shared
let delegate = AppDelegate()
let env = ProcessInfo.processInfo.environment
let root = URL(fileURLWithPath: env["WORKLOG_TEST_ROOT"]!)
let scenario = env["WORKLOG_NATIVE_SCENARIO"]!
if scenario != "development" {
    delegate.serviceControl = ServiceControlClient(resolve: { _ in
        ServiceControlPaths(node: root.appendingPathComponent("node"), script: root.appendingPathComponent("stub.mjs"), app: root.appendingPathComponent("WorkLog.app"))
    })
}
application.delegate = delegate
var quitRequested = false, waitedForStart = false, failureVisible = false, failureMessage = ""
let terminateObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
    let result: [String: Any] = ["waitedForStart": waitedForStart, "failureVisible": failureVisible, "failureMessage": failureMessage,
        "developmentSkipped": ServiceControlClient.installedPaths(delegate.dataRoot) == nil]
    print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
    fflush(stdout)
}
let poll = Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { _ in
    guard delegate.window != nil else { return }
    if delegate.servicesStarting && delegate.terminationPending { waitedForStart = true }
    if let message = delegate.serviceControlError, !failureVisible {
        failureMessage = message
        failureVisible = delegate.window.isVisible && delegate.window.attachedSheet != nil && !delegate.terminationPending
        if let sheet = delegate.window.attachedSheet { delegate.window.endSheet(sheet); sheet.orderOut(nil) }
        NSApp.terminate(nil)
    } else if !quitRequested && scenario != "start-fails" {
        waitedForStart = delegate.servicesStarting
        quitRequested = true; NSApp.terminate(nil)
    }
}
Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { _ in
    print("native lifecycle timed out"); fflush(stdout); exit(70)
}
application.run()
`);
  const compiled = spawnSync('swiftc', ['-framework', 'Cocoa', '-framework', 'WebKit', source, '-o', executable], { encoding: 'utf8', timeout: 15000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  for (const scenario of ['stopped', 'user_work_continues', 'stop-fails', 'malformed-stop', 'start-fails', 'development']) await t.test(scenario, async () => {
    const workspace = path.join(dir, scenario); fs.mkdirSync(workspace);
    const log = path.join(workspace, 'calls.jsonl');
    fs.symlinkSync(process.execPath, path.join(workspace, 'node'));
    fs.writeFileSync(path.join(workspace, 'stub.mjs'), `import fs from 'node:fs';
      const args=process.argv.slice(2),action=args[0],log=${JSON.stringify(log)},scenario=${JSON.stringify(scenario)};
      const calls=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').map(line=>JSON.parse(line)):[];
      fs.appendFileSync(log,JSON.stringify({phase:'begin',args})+'\\n');
      if(action==='start')await new Promise(resolve=>setTimeout(resolve,200));
      const stops=calls.filter(c=>c.phase==='begin'&&c.args[0]==='stop').length;
      fs.appendFileSync(log,JSON.stringify({phase:'end',args})+'\\n');
      if(action==='start'&&scenario==='start-fails'){console.error(JSON.stringify({error:'서비스 시작 fixture 실패'}));process.exit(1);}
      if(action==='stop'&&scenario==='stop-fails'&&stops===0){console.log(JSON.stringify({status:'needs_attention',preserved:[{reason:'서비스 종료 fixture 실패'}]}));process.exit(2);}
      if(action==='stop'&&scenario==='malformed-stop'&&stops===0){console.log('not a valid result');process.exit(0);}
      console.log(JSON.stringify({status:action==='start'?'started':scenario==='user_work_continues'?'user_work_continues':'stopped'}));
    `);
    const child = spawn(executable, ['--background'], { env: { ...process.env, HARNESS_DATA_DIR: workspace,
      WORKLOG_TEST_ROOT: workspace, WORKLOG_NATIVE_SCENARIO: scenario }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0, stderr || stdout);
    const result = JSON.parse(stdout.trim());
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    assert.equal(result.developmentSkipped, true, 'temporary native bundles cannot control the installed app');
    if (scenario === 'development') { assert.deepEqual(calls, []); return; }
    const expected = ['start', 'stop', ...(['stop-fails', 'malformed-stop'].includes(scenario) ? ['stop'] : [])];
    assert.deepEqual(calls.map(call => `${call.phase}:${call.args[0]}`), expected.flatMap(action => [`begin:${action}`, `end:${action}`]));
    for (const call of calls) assert.deepEqual(call.args.slice(1), ['--app-path', path.join(workspace, 'WorkLog.app'), '--data-root', workspace]);
    if (scenario !== 'start-fails') assert.equal(result.waitedForStart, true, 'quit waits for the in-flight startup helper');
    if (scenario.includes('fails') || scenario === 'malformed-stop') {
      assert.equal(result.failureVisible, true, 'failure keeps a visible window and alert before the user retries');
      assert.match(result.failureMessage, /fixture 실패|상태를 확인하지 못했습니다/);
    } else assert.equal(result.failureVisible, false);
  });
});
