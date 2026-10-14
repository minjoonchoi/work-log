import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareInstall, applyInstall, checkInstallation } from '../../scripts/install.mjs';
import { locations, readManifest } from '../../scripts/install-state.mjs';
import { applyUninstall } from '../../scripts/uninstall.mjs';
import { installDraggedApp } from '../../scripts/first-launch.mjs';
import { cleanBuildCopies } from '../../scripts/install-source.mjs';

function fixture(t, legacy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-system-install-'));
  const home = path.join(root, 'home'), system = path.join(root, 'Applications'), sourceApp = path.join(root, 'Source.app');
  fs.mkdirSync(system);
  fs.mkdirSync(path.join(sourceApp, 'Contents/MacOS'), { recursive: true });
  for (const name of ['node', 'WorkLog', 'WorkLogKeychain']) fs.writeFileSync(path.join(sourceApp, 'Contents/MacOS', name), name, { mode: 0o755 });
  fs.mkdirSync(path.join(sourceApp, 'Contents/Resources/harness/skills/work'), { recursive: true });
  fs.writeFileSync(path.join(sourceApp, 'Contents/Resources/harness/skills/work/SKILL.md'), 'fixture');
  fs.writeFileSync(path.join(sourceApp, 'Contents/Info.plist'), '<key>CFBundleIdentifier</key><string>local.worklog.harness</string>');
  fs.writeFileSync(path.join(sourceApp, 'Contents/Resources/harness/package.json'), JSON.stringify({ name: 'work-log' }));
  const install = () => applyInstall(prepareInstall({ homeDir: home, sourceApp, output: path.join(root, 'plan') }), { activate: false, reinstall: true });
  // Map every system filesystem operation to this test's private directory.
  // Production path resolution and receipts still use the literal /Applications.
  let readOnly = false;
  const denied = file => { if (readOnly && typeof file === 'string' && (file === '/Applications' || file.startsWith('/Applications/'))) throw Object.assign(new Error('read-only Applications'), { code: 'EACCES' }); };
  const map = value => typeof value === 'string' && (value === '/Applications' || value.startsWith('/Applications/')) ? system + value.slice('/Applications'.length) : value;
  for (const name of ['lstatSync', 'statSync', 'existsSync', 'readdirSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'rmdirSync', 'unlinkSync', 'rmSync', 'chmodSync', 'accessSync', 'readlinkSync', 'realpathSync']) {
    const original = fs[name]; t.mock.method(fs, name, (file, ...args) => { if (['writeFileSync', 'mkdirSync', 'rmdirSync', 'unlinkSync', 'rmSync', 'chmodSync', 'accessSync'].includes(name)) denied(file); return original(map(file), ...args); });
  }
  for (const name of ['renameSync', 'cpSync', 'copyFileSync']) {
    const original = fs[name]; t.mock.method(fs, name, (from, to, ...args) => { denied(to); if (name === 'renameSync') denied(from); return original(map(from), map(to), ...args); });
  }
  t.mock.method(os, 'homedir', () => home);
  const user = os.userInfo(); t.mock.method(os, 'userInfo', () => ({ ...user, homedir: home }));
  t.after(() => { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });
  if (legacy) {
    fs.cpSync(sourceApp, '/Applications/WorkLog.app', { recursive: true });
    installDraggedApp('/Applications/WorkLog.app', { homeDir: home, activate: false });
  }
  readOnly = true;
  return { allowGlobalWrites: () => { readOnly = false; }, root, home, sourceApp, install, app: path.join(home, 'Applications/WorkLog.app'), legacy: '/Applications/WorkLog.app', loc: () => locations(home) };
}

test('fresh source installation, replacement, cleanup and uninstall use user Applications and preserve data', t => {
  const f = fixture(t);
  assert.equal(f.install().installed, f.app);
  const marker = path.join(f.loc().data, 'work-record'); fs.writeFileSync(marker, 'keep');
  fs.writeFileSync(path.join(f.sourceApp, 'Contents/MacOS/WorkLog'), 'new');
  assert.equal(f.install().status, 'reinstalled');
  assert.equal(fs.readFileSync(`${f.app}/Contents/MacOS/WorkLog`, 'utf8'), 'new');
  const duplicate = path.join(f.root, 'dist/WorkLog.app'); fs.mkdirSync(path.dirname(duplicate)); fs.cpSync(f.sourceApp, duplicate, { recursive: true });
  assert.deepEqual(cleanBuildCopies({ homeDir: f.home, projectRoot: f.root }).removed, [duplicate]);
  assert.equal(applyUninstall({ homeDir: f.home, deactivate: false }).status, 'uninstalled');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
});

test('read-only system installation switches to user Applications, preserving identity, runtime, settings and records', t => {
  const f = fixture(t, true), before = readManifest(f.loc());
  const marker = path.join(f.loc().data, 'settings.json'); fs.writeFileSync(marker, 'keep');
  const db = new DatabaseSync(path.join(f.loc().data, 'memory.sqlite'));
  db.exec("CREATE TABLE saved_session (summary TEXT); INSERT INTO saved_session VALUES ('keep session');");
  t.after(() => db.close());
  const result = f.install(), after = readManifest(f.loc());
  assert.equal(result.installed, f.app); assert.equal(after.id, before.id);
  assert.equal(after.trees[1].path, before.trees[1].path);
  assert.equal(db.prepare('SELECT summary FROM saved_session').get().summary, 'keep session');
  assert.equal(fs.existsSync(f.legacy), true); assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  assert.equal(after.files[0].argv[0], `${f.app}/Contents/MacOS/WorkLog`);
  assert.equal(f.install().status, 'reinstalled');
});

test('occupied user destination leaves system installation intact', t => {
  const f = fixture(t, true), before = fs.readFileSync(f.loc().manifest);
  fs.mkdirSync(f.app, { recursive: true }); fs.writeFileSync(`${f.app}/foreign`, 'keep');
  assert.throws(f.install, /이미 앱이/);
  assert.deepEqual(fs.readFileSync(f.loc().manifest), before);

});

for (const boundary of ['app', 'runtime']) test(`failed ${boundary} swap restores original system app and registration`, t => {
  const f = fixture(t, true), before = readManifest(f.loc()), rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!failed && from.includes('.worklog-stage-') && from.endsWith(boundary === 'app' ? '-0' : '-1')) { failed = true; throw new Error('swap failed'); }
    return rename(from, to);
  });
  assert.throws(f.install, /이전 설치 파일을 복원/);
  assert.ok(fs.existsSync(f.legacy)); assert.equal(fs.existsSync(f.app), false);
  assert.deepEqual(readManifest(f.loc()).files, before.files);
  checkInstallation({ homeDir: f.home, activate: false });
  assert.equal(f.install().installed, f.app);
});

for (const phase of ['pending', 'committed']) test(`interrupted migration at ${phase} is recoverable on the next install`, t => {
  const f = fixture(t, true), rename = fs.renameSync, unlink = fs.unlinkSync;
  let interrupt = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (interrupt && phase === 'pending' && (from.includes('.worklog-stage-') && from.endsWith('-1') || from.includes('.worklog-reinstall-'))) throw new Error('interrupted');
    return rename(from, to);
  });
  t.mock.method(fs, 'unlinkSync', file => {
    if (interrupt && phase === 'committed' && file.includes('.worklog-reinstall-')) throw new Error('interrupted');
    return unlink(file);
  });
  assert.throws(f.install, /interrupted/);
  assert.equal(readManifest(f.loc()).replacement.phase, phase);
  interrupt = false;
  checkInstallation({ homeDir: f.home, activate: false });
  assert.equal(f.install().installed, f.app);
  assert.equal(readManifest(f.loc()).replacement, undefined);
  assert.equal(fs.existsSync(f.legacy), true);
});

for (const writable of [true, false]) test(`uninstall cleans retired global app when writable=${writable} without failing user uninstall`, t => {
  const f = fixture(t, true); f.install();
  const marker = path.join(f.loc().data, 'memory-marker'); fs.writeFileSync(marker, 'keep');
  if (writable) f.allowGlobalWrites();
  const result = applyUninstall({ homeDir: f.home, deactivate: false });
  assert.equal(result.status, 'uninstalled');
  assert.equal(fs.existsSync(f.app), false);
  assert.equal(fs.existsSync(f.legacy), !writable);
  assert.equal(result.leftover_apps.length, writable ? 0 : 1);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  f.allowGlobalWrites();
  assert.equal(applyUninstall({ homeDir: f.home, deactivate: false }).status, 'uninstalled');
  assert.equal(fs.existsSync(f.legacy), false);
});

test('old receipts without retired inventory clean identified global WorkLog but preserve foreign bundles', t => {
  const f = fixture(t, true); f.install(); f.allowGlobalWrites();
  const receipt = readManifest(f.loc()); delete receipt.retired_app;
  fs.writeFileSync(f.loc().manifest, JSON.stringify(receipt));
  fs.writeFileSync(`${f.legacy}/Contents/Info.plist`, '<key>CFBundleIdentifier</key><string>other.app</string>');
  const result = applyUninstall({ homeDir: f.home, deactivate: false });
  assert.equal(result.status, 'uninstalled'); assert.ok(fs.existsSync(f.legacy));
  fs.writeFileSync(`${f.legacy}/Contents/Info.plist`, '<key>CFBundleIdentifier</key><string>local.worklog.harness</string>');
  assert.equal(applyUninstall({ homeDir: f.home, deactivate: false }).status, 'uninstalled');
  assert.equal(fs.existsSync(f.legacy), false);
});

test('modified retired app is preserved without blocking removal of the current installation', t => {
  const f = fixture(t, true); f.install(); f.allowGlobalWrites();
  fs.writeFileSync(`${f.legacy}/user-file`, 'keep');
  const result = applyUninstall({ homeDir: f.home, deactivate: false });
  assert.equal(result.status, 'uninstalled'); assert.equal(result.leftover_apps.length, 1);
  assert.equal(fs.readFileSync(`${f.legacy}/user-file`, 'utf8'), 'keep');
});
