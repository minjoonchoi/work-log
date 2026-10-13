import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareInstall, applyInstall, checkInstallation } from '../../scripts/install.mjs';
import { locations, readManifest } from '../../scripts/install-state.mjs';
import { applyUninstall } from '../../scripts/uninstall.mjs';
import { cleanBuildCopies } from '../../scripts/install-source.mjs';

function fixture(t, legacy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-system-install-'));
  const home = path.join(root, 'home'), system = path.join(root, 'Applications'), sourceApp = path.join(root, 'Source.app');
  fs.mkdirSync(system);
  fs.mkdirSync(path.join(sourceApp, 'Contents/MacOS'), { recursive: true });
  for (const name of ['node', 'WorkLog', 'WorkLogKeychain']) fs.writeFileSync(path.join(sourceApp, 'Contents/MacOS', name), name, { mode: 0o755 });
  fs.mkdirSync(path.join(sourceApp, 'Contents/Resources/harness/skills/work'), { recursive: true });
  fs.writeFileSync(path.join(sourceApp, 'Contents/Resources/harness/skills/work/SKILL.md'), 'fixture');
  const install = () => applyInstall(prepareInstall({ homeDir: home, sourceApp, output: path.join(root, 'plan') }), { activate: false, reinstall: true });
  if (legacy) {
    install();
    const file = locations(home).manifest, receipt = JSON.parse(fs.readFileSync(file));
    delete receipt.app_location; fs.writeFileSync(file, JSON.stringify(receipt));
  }
  // Map every system filesystem operation to this test's private directory.
  // Production path resolution and receipts still use the literal /Applications.
  const map = value => typeof value === 'string' && (value === '/Applications' || value.startsWith('/Applications/')) ? system + value.slice('/Applications'.length) : value;
  for (const name of ['lstatSync', 'statSync', 'existsSync', 'readdirSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'rmdirSync', 'unlinkSync', 'rmSync', 'chmodSync', 'accessSync', 'readlinkSync', 'realpathSync']) {
    const original = fs[name]; t.mock.method(fs, name, (file, ...args) => original(map(file), ...args));
  }
  for (const name of ['renameSync', 'cpSync', 'copyFileSync']) {
    const original = fs[name]; t.mock.method(fs, name, (from, to, ...args) => original(map(from), map(to), ...args));
  }
  t.mock.method(os, 'homedir', () => home);
  const user = os.userInfo(); t.mock.method(os, 'userInfo', () => ({ ...user, homedir: home }));
  t.after(() => { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, home, sourceApp, install, app: '/Applications/WorkLog.app', legacy: path.join(home, 'Applications/WorkLog.app'), loc: () => locations(home) };
}

test('fresh source installation, replacement, cleanup and uninstall use system Applications and preserve data', t => {
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

test('legacy user installation moves once, preserving identity, runtime, settings and records', t => {
  const f = fixture(t, true), before = readManifest(f.loc());
  const marker = path.join(f.loc().data, 'settings.json'); fs.writeFileSync(marker, 'keep');
  const result = f.install(), after = readManifest(f.loc());
  assert.equal(result.installed, f.app); assert.equal(after.id, before.id);
  assert.equal(after.trees[1].path, before.trees[1].path);
  assert.equal(fs.existsSync(f.legacy), false); assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  assert.equal(after.files[0].argv[0], `${f.app}/Contents/MacOS/WorkLog`);
  assert.equal(f.install().status, 'reinstalled');
});

test('occupied destination and permission denial leave legacy installation intact', t => {
  const f = fixture(t, true), before = fs.readFileSync(f.loc().manifest);
  fs.mkdirSync(f.app); fs.writeFileSync(`${f.app}/foreign`, 'keep');
  assert.throws(f.install, /이미 앱이/);
  assert.deepEqual(fs.readFileSync(f.loc().manifest), before);
  fs.rmSync(f.app, { recursive: true });
  const access = fs.accessSync; t.mock.method(fs, 'accessSync', (file, mode) => { if (file === '/Applications') throw new Error('EACCES'); return access(file, mode); });
  assert.throws(f.install, /쓰기 권한/);
  assert.deepEqual(fs.readFileSync(f.loc().manifest), before); assert.ok(fs.existsSync(f.legacy));
});

for (const boundary of ['app', 'runtime']) test(`failed ${boundary} swap restores original user app and registration`, t => {
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
  assert.equal(fs.existsSync(f.legacy), false);
});
