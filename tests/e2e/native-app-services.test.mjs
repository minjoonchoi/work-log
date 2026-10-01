import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, alive, readEndpoint, request } from '../../src/shared.mjs';
import { eventually } from '../helpers.mjs';

test('one native host owns, restarts and drains its services; host death leaves no orphan services', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-app-services-'));
  const processes = new Set();
  t.after(() => { for (const pid of processes) if (alive(pid)) process.kill(pid, 'SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); });
  const app = path.join(dir, 'Applications/WorkLog.app');
  const bin = path.join(dir, 'nvm-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env node\nprocess.exit(process.argv[2] === "--version" ? 0 : 1);\n', { mode: 0o755 });
  const agents = path.join(dir, 'Library/LaunchAgents'); fs.mkdirSync(agents, { recursive: true });
  const installedPath = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  fs.writeFileSync(path.join(agents, 'local.worklog.gui.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>${installedPath}</string></dict></dict></plist>`);
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(app, 'Contents/MacOS/node'));
  fs.symlinkSync(ROOT, path.join(app, 'Contents/Resources/harness'));
  const main = fs.readFileSync(path.join(ROOT, 'apps/macos/main.swift'), 'utf8').split('let application = NSApplication.shared')[0];
  const source = path.join(dir, 'main.swift'), executable = path.join(dir, 'host');
  fs.writeFileSync(source, main + `
let application = NSApplication.shared
let services = AppServices()
let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HARNESS_DATA_DIR"]!)
try services.start(app: root.appendingPathComponent("Applications/WorkLog.app"), dataRoot: root)
let probe = Process()
probe.executableURL = URL(fileURLWithPath: "/usr/bin/env")
probe.arguments = ["codex", "--version"]
probe.environment = services.children["runtime"]!.environment
try probe.run(); probe.waitUntilExit()
if probe.terminationStatus != 0 { exit(2) }
var stopping = false
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    if !stopping && FileManager.default.fileExists(atPath: root.appendingPathComponent("stop").path) {
        stopping = true
        services.stop(dataRoot: root) { error in
            if let error = error { fputs(error, stderr); exit(1) }
            exit(0)
        }
    }
}
application.run()
`);
  const compiled = spawnSync('swiftc', ['-framework', 'Cocoa', '-framework', 'WebKit', source, '-o', executable], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  async function start() {
    const child = spawn(executable, { env: { ...process.env, HARNESS_DATA_DIR: dir, HARNESS_TEST_MODE: '1', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.add(child.pid);
    await eventually(async () => {
      const quick = await request(dir, 'manager', '/api/quick');
      return quick.health.runtime_connected && readEndpoint(dir, 'manager').pid !== previousManager;
    });
    const manager = readEndpoint(dir, 'manager').pid, runtime = readEndpoint(dir, 'runtime').pid;
    processes.add(manager); processes.add(runtime);
    for (const pid of [manager, runtime]) {
      const parent = spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' });
      assert.equal(Number(parent.stdout.trim()), child.pid);
    }
    return { child, manager, runtime };
  }
  let previousManager;
  const first = await start();
  process.kill(first.manager, 'SIGKILL');
  const replacement = await eventually(() => readEndpoint(dir, 'manager').pid, pid => pid !== first.manager && alive(pid));
  processes.add(replacement);
  await eventually(() => request(dir, 'manager', '/api/quick'));
  const exited = new Promise(resolve => first.child.once('exit', resolve));
  fs.writeFileSync(path.join(dir, 'stop'), '');
  assert.equal(await exited, 0);
  assert.equal(alive(first.runtime), false); assert.equal(alive(replacement), false);
  fs.unlinkSync(path.join(dir, 'stop')); previousManager = replacement;
  const second = await start();
  second.child.kill('SIGKILL');
  await eventually(() => !alive(second.manager) && !alive(second.runtime));
});
