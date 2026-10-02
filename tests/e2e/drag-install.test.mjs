import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDraggedApp } from '../../scripts/first-launch.mjs';
import { applyUninstall } from '../../scripts/uninstall.mjs';
import { locations, readManifest, inventory, selectAppLocation, safeInstallationPath } from '../../scripts/install-state.mjs';
import { connectAgent } from '../../scripts/agent-connections.mjs';
import { digest } from '../../src/shared.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-drag-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'Team User'), loc = locations(homeDir), app = loc.app;
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  for (const file of ['node', 'WorkLog', 'WorkLogKeychain']) fs.writeFileSync(path.join(app, 'Contents/MacOS', file), file, { mode: 0o755 });
  fs.mkdirSync(path.join(app, 'Contents/Resources/harness/skills/work'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Resources/harness/skills/work/SKILL.md'), 'work');
  fs.mkdirSync(path.join(app, 'Contents/Resources/harness/src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Resources/harness/src/hook.mjs'), '');
  return { root, homeDir, loc, app, install: opts => installDraggedApp(app, { homeDir, activate: false, ...opts }) };
}
test('Finder copy is adopted in place; repeat launch is idempotent; uninstall preserves work', t => {
  const f = fixture(t), ino = fs.statSync(f.app).ino, files = inventory(f.app);
  assert.equal(f.install().status, 'installed');
  assert.equal(fs.statSync(f.app).ino, ino);
  assert.deepEqual(inventory(f.app), files);
  assert.equal(f.install().status, 'already_installed');
  const marker = path.join(f.loc.data, 'work-record'); fs.writeFileSync(marker, 'keep');
  assert.equal(applyUninstall({ homeDir: f.homeDir, deactivate: false }).status, 'uninstalled');
  assert.equal(fs.existsSync(f.app), false); assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
});
test('first launch journals completed ownership before starting the login app', t => {
  const f = fixture(t), calls = [];
  const launchctl = (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'print') return { status: 113, stderr: 'Could not find service' };
    assert.equal(readManifest(f.loc).state, 'installed');
    assert.equal(readManifest(f.loc).files[0].activation, 'starting');
    return { status: 0 };
  };
  f.install({ activate: true, launchctl });
  assert.deepEqual(calls, ['print', 'bootstrap']);
  assert.equal(readManifest(f.loc).files[0].activation, 'registered');
});
test('only exact Applications locations are accepted; global bundle symlinks cannot escape', t => {
  const f = fixture(t);
  for (const target of ['/Applications/Other.app', '/tmp/WorkLog.app', `${f.app}/../Other.app`]) {
    assert.throws(() => selectAppLocation(f.loc, target));
  }
  selectAppLocation(f.loc, '/Applications/WorkLog.app');
  assert.throws(() => safeInstallationPath(f.loc, '/Applications/Other.app'));
  assert.throws(() => safeInstallationPath(f.loc, '/Applications/WorkLog.app/../../etc/passwd'));
  assert.throws(() => installDraggedApp(path.join(f.root, 'Elsewhere.app'), { homeDir: f.homeDir, activate: false }));
});
for (const purge of [false, true]) test(`uninstall ${purge ? 'purges only owned connection data' : 'keeps saved credentials by default'}`, t => {
  const f = fixture(t); f.install();
  for (const engine of ['claude', 'codex']) {
    fs.mkdirSync(path.dirname(f.loc.configs[engine]), { recursive: true });
    fs.writeFileSync(f.loc.configs[engine], JSON.stringify({ model: 'keep', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'company-hook' }] }] } }));
    connectAgent(engine, { homeDir: f.homeDir });
  }
  const files = ['integrations/atlassian.json', 'token', 'runtime.endpoint.json', 'manager.endpoint.json'];
  for (const file of [...files, 'work-record', 'company-ca.pem']) {
    fs.mkdirSync(path.dirname(path.join(f.loc.data, file)), { recursive: true });
    fs.writeFileSync(path.join(f.loc.data, file), 'keep-or-purge');
  }
  const calls = [], result = applyUninstall({ homeDir: f.homeDir, deactivate: false, purgeConnections: purge,
    credentialRunner: (binary, args, options) => { calls.push({ binary, ...JSON.parse(options.input) }); return { status: 0, stdout: '{"ok":true}' }; } });
  assert.equal(result.status, 'uninstalled');
  assert.equal(calls.length, purge ? 2 : 0);
  if (purge) assert.deepEqual(calls.map(row => row.account), ['oauth', 'client'].map(prefix => `${prefix}-${digest(f.loc.data).slice(0, 24)}`));
  for (const file of files) assert.equal(fs.existsSync(path.join(f.loc.data, file)), !purge);
  for (const file of ['work-record', 'company-ca.pem']) assert.equal(fs.existsSync(path.join(f.loc.data, file)), true);
  for (const file of Object.values(f.loc.configs)) {
    const config = JSON.parse(fs.readFileSync(file)); assert.equal(config.model, 'keep');
    assert.deepEqual(config.hooks.Stop, [{ hooks: [{ type: 'command', command: 'company-hook' }] }]);
    assert.equal(fs.readFileSync(file, 'utf8').includes('WORKLOG_INSTALL_ID'), false);
  }
});
test('Keychain failure keeps app and settings for retry, and purge intent survives retry', t => {
  const f = fixture(t); f.install();
  const file = path.join(f.loc.data, 'integrations/atlassian.json'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, '{}');
  let result = applyUninstall({ homeDir: f.homeDir, deactivate: false, purgeConnections: true, credentialRunner: () => ({ status: 1, stdout: '{"ok":false}' }) });
  assert.equal(result.status, 'needs_attention'); assert.equal(fs.existsSync(f.app), true); assert.equal(fs.existsSync(file), true);
  assert.match(result.preserved[0].reason, /Keychain/);
  result = applyUninstall({ homeDir: f.homeDir, deactivate: false, credentialRunner: () => ({ status: 0, stdout: '{"ok":true}' }) });
  assert.equal(result.status, 'uninstalled'); assert.equal(fs.existsSync(file), false);
});
test('purge removes older owned connection backups and refuses symlinked settings', t => {
  const f = fixture(t); f.install();
  const old = path.join(f.loc.data, 'install-backups', '11111111-1111-1111-1111-111111111111');
  fs.mkdirSync(old, { recursive: true });
  const backup = path.join(old, 'claude-22222222-2222-2222-2222-222222222222.json');
  fs.writeFileSync(backup, '{}');
  fs.writeFileSync(path.join(old, 'user-note.txt'), 'keep');
  const external = path.join(f.root, 'external.json'); fs.writeFileSync(external, 'do-not-touch');
  fs.mkdirSync(path.join(f.loc.data, 'integrations'));
  fs.symlinkSync(external, path.join(f.loc.data, 'integrations/atlassian.json'));
  const result = applyUninstall({ homeDir: f.homeDir, deactivate: false, purgeConnections: true,
    credentialRunner: () => ({ status: 0, stdout: '{"ok":true}' }) });
  assert.equal(result.status, 'needs_attention'); assert.equal(fs.existsSync(f.app), true);
  assert.equal(fs.readFileSync(external, 'utf8'), 'do-not-touch');
  assert.equal(fs.existsSync(backup), false); assert.equal(fs.existsSync(path.join(old, 'user-note.txt')), true);
});
test('first-launch registration failure is retryable without another app copy', t => {
  const f = fixture(t), ino = fs.statSync(f.app).ino;
  const failed = (command, args) => args[0] === 'print'
    ? { status: 113, stderr: 'Could not find service' } : { status: 1, stderr: 'fixture registration failure' };
  assert.throws(() => f.install({ activate: true, launchctl: failed }), /서비스 등록 실패/);
  assert.equal(readManifest(f.loc).state, 'installed');
  assert.equal(readManifest(f.loc).files[0].activation, 'starting');
  f.install({ activate: true, launchctl: (command, args) => args[0] === 'print'
    ? { status: 113, stderr: 'Could not find service' } : { status: 0 } });
  assert.equal(readManifest(f.loc).files[0].activation, 'registered');
  assert.equal(fs.statSync(f.app).ino, ino);
});
