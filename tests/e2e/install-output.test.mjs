import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shared.mjs';
import { locations, quote } from '../../scripts/install-state.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-install-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const homeDir = path.join(dir, "User's Home"), project = path.join(dir, 'project'), sourceApp = path.join(dir, 'Fixture App.app');
  for (const name of ['src', 'harness']) fs.mkdirSync(path.join(project, name), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(project, 'scripts'), { recursive: true });
  for (const name of ['Makefile', 'src/shared.mjs', 'harness/jobs.json']) fs.copyFileSync(path.join(ROOT, name), path.join(project, name));
  fs.mkdirSync(path.join(sourceApp, 'Contents/MacOS'), { recursive: true });
  for (const name of ['node', 'WorkLog', 'WorkLogKeychain']) fs.writeFileSync(path.join(sourceApp, 'Contents/MacOS', name), `fixture ${name}\n`, { mode: 0o755 });
  const skill = path.join(sourceApp, 'Contents/Resources/harness/skills/work');
  fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: work\n---\nFixture skill.\n');
  fs.mkdirSync(homeDir, { recursive: true });
  const env = { ...process.env, HOME: homeDir, TMPDIR: dir, NODE_NO_WARNINGS: '1', HARNESS_DATA_DIR: path.join(homeDir, 'isolated-data'),
    NODE: process.execPath, HARNESS_BUNDLE_NODE: process.execPath, HARNESS_NODE_DOWNLOAD: '0', HARNESS_NODE_CACHE: path.join(dir, 'node-cache') };
  const invoke = (command, args) => {
    const result = spawnSync(command, args, { cwd: project, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null, result.stderr);
    return result;
  };
  const installArgs = ['--home-dir', homeDir, '--source-app', sourceApp, '--output', path.join(dir, 'plan'), '--no-activate'];
  const uninstallArgs = ['--home-dir', homeDir, '--no-deactivate'];
  return { dir, homeDir, sourceApp, project, loc: locations(homeDir),
    install: (...args) => invoke(process.execPath, ['scripts/install.mjs', ...installArgs, ...args]),
    uninstall: (...args) => invoke(process.execPath, ['scripts/uninstall.mjs', ...uninstallArgs, ...args]),
    make: (target, args = []) => invoke('make', [target, `${target.startsWith('uninstall') ? 'UNINSTALL_ARGS' : 'INSTALL_ARGS'}=${args.map(quote).join(' ')}`]),
    installArgs, uninstallArgs };
}

function human(result, meaning, status = 0) {
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, meaning);
  assert.doesNotMatch(result.stdout, /^\s*(?:\{\s*"|\[\s*[{\"])/, 'stdout should contain a human result rather than serialized state');
  assert.doesNotMatch(result.stdout, /<plist|"installation_id"|"removed"\s*:/);
  return result.stdout;
}

function structured(result, status = 0) {
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
  const value = JSON.parse(result.stdout);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value;
}

test('CLI install and reinstall give Korean results and keep progress off stdout', t => {
  const f = setup(t);
  const result = f.install('--apply'), installed = human(result, /설치.*완료/);
  assert.match(result.stderr, /\[WorkLog\].*확인|\[WorkLog\].*설치/, 'installation progress belongs on stderr');
  assert.ok(installed.includes(f.loc.app)); assert.ok(fs.existsSync(f.loc.manifest));
  const receipt = fs.readFileSync(f.loc.manifest);
  human(f.install('--apply'), /재설치.*완료/);
  assert.equal(JSON.parse(fs.readFileSync(f.loc.manifest)).id, JSON.parse(receipt).id);
  for (const name of ['.claude', '.codex', '.agents']) assert.equal(fs.existsSync(path.join(f.homeDir, name)), false);
});

test('human installation and removal plans show destinations without applying them', t => {
  const f = setup(t);
  const installPlan = human(f.install(), /설치.*계획/);
  assert.ok(installPlan.includes(f.loc.app)); assert.equal(fs.existsSync(f.loc.manifest), false);
  assert.equal(fs.existsSync(f.loc.app), false);
  structured(f.install('--apply', '--json'));
  const receipt = fs.readFileSync(f.loc.manifest);
  const uninstallPlan = human(f.uninstall(), /제거.*계획/);
  assert.ok(uninstallPlan.includes(f.loc.app));
  assert.deepEqual(fs.readFileSync(f.loc.manifest), receipt); assert.ok(fs.existsSync(f.loc.app));
});

test('human uninstall and repeated uninstall preserve work history and custom task data', t => {
  const f = setup(t); structured(f.install('--apply', '--json'));
  const saved = { 'memory.sqlite': 'fixture work history', 'custom-task-types.json': '{"fixture":"custom task"}' };
  for (const [name, value] of Object.entries(saved)) fs.writeFileSync(path.join(f.loc.data, name), value);
  const output = human(f.uninstall('--apply'), /제거.*완료/);
  assert.match(output, /보존/); assert.equal(fs.existsSync(f.loc.app), false);
  human(f.uninstall('--apply'), /제거.*완료|이미.*제거|설치.*내역.*없/);
  for (const [name, value] of Object.entries(saved)) assert.equal(fs.readFileSync(path.join(f.loc.data, name), 'utf8'), value);
});

test('changed owned files are preserved with a readable reason and the existing exit code two', t => {
  const f = setup(t); structured(f.install('--apply', '--json'));
  const changed = path.join(f.loc.app, 'Contents/MacOS/WorkLog'); fs.writeFileSync(changed, 'user changed app');
  const output = human(f.uninstall('--apply'), /확인.*필요/, 2);
  assert.ok(output.includes(f.loc.app)); assert.match(output, /변경|추가/); assert.match(output, /보존/);
  assert.equal(fs.readFileSync(changed, 'utf8'), 'user changed app');
  const retry = structured(f.uninstall('--apply', '--json'), 2);
  assert.equal(retry.status, 'needs_attention'); assert.ok(retry.preserved.some(row => row.path === f.loc.app && row.reason));
});

test('no receipt and an unmanaged app have distinct readable outcomes without removing files', t => {
  const f = setup(t);
  human(f.uninstall('--apply'), /설치.*내역.*없/);
  assert.equal(structured(f.uninstall('--apply', '--json')).status, 'not_installed');
  fs.mkdirSync(f.loc.app, { recursive: true }); const owned = path.join(f.loc.app, 'user.txt'); fs.writeFileSync(owned, 'keep');
  human(f.uninstall('--apply'), /확인.*필요/, 2);
  assert.equal(structured(f.uninstall('--apply', '--json'), 2).status, 'unmanaged');
  assert.equal(fs.readFileSync(owned, 'utf8'), 'keep');
});

test('CLI errors remain on stderr with exit one and JSON opt-in keeps the error object', t => {
  const f = setup(t);
  fs.unlinkSync(path.join(f.sourceApp, 'Contents/MacOS/WorkLogKeychain'));
  const humanError = f.install('--apply');
  assert.equal(humanError.status, 1); assert.equal(humanError.stdout, '');
  assert.match(humanError.stderr, /\[WorkLog\].*설치.*실패/); assert.match(humanError.stderr, /빌드|WorkLogKeychain/);
  const jsonError = f.install('--apply', '--json');
  assert.equal(jsonError.status, 1); assert.equal(jsonError.stdout, '');
  assert.match(JSON.parse(jsonError.stderr).error, /빌드|WorkLogKeychain/);
  fs.mkdirSync(f.loc.data, { recursive: true }); fs.writeFileSync(f.loc.manifest, '{broken receipt');
  const removeError = f.uninstall('--apply');
  assert.equal(removeError.status, 1); assert.equal(removeError.stdout, ''); assert.match(removeError.stderr, /\[WorkLog\].*제거.*실패/);
  const removeJson = f.uninstall('--apply', '--json');
  assert.equal(removeJson.status, 1); assert.equal(removeJson.stdout, ''); assert.equal(typeof JSON.parse(removeJson.stderr).error, 'string');
});

test('JSON opt-in preserves installation, plan, reinstallation and removal result shapes', t => {
  const f = setup(t);
  const plan = structured(f.install('--json'));
  assert.equal(plan.targetApp, f.loc.app); assert.equal(plan.homeDir, f.homeDir); assert.equal(plan.files.length, 3);
  assert.ok(plan.files.every(file => file.content.includes('<plist'))); assert.deepEqual(plan.links, []);
  const installed = structured(f.install('--apply', '--json'));
  assert.equal(installed.status, 'installed'); assert.equal(installed.installed, f.loc.app); assert.equal(installed.activated, false);
  assert.equal(structured(f.install('--apply', '--json')).status, 'reinstalled');
  const removal = structured(f.uninstall('--json'));
  assert.equal(removal.status, 'planned'); assert.equal(removal.app, f.loc.app); assert.ok(Array.isArray(removal.preserve));
  const removed = structured(f.uninstall('--apply', '--json'));
  assert.equal(removed.status, 'uninstalled'); assert.ok(removed.removed.length > 0); assert.deepEqual(removed.preserved, []);
  const repeated = structured(f.uninstall('--apply', '--json'));
  assert.equal(repeated.status, 'uninstalled'); assert.equal(repeated.installation_id, installed.installation_id);
  assert.equal(repeated.app, removal.app); assert.deepEqual(repeated.preserve, removal.preserve);
});

test('make forwards human and JSON install/uninstall arguments using only the fixture app and temporary home', t => {
  const f = setup(t);
  human(f.make('install-plan', f.installArgs), /설치.*계획/);
  assert.equal(structured(f.make('install-plan', [...f.installArgs, '--json'])).targetApp, f.loc.app);
  human(f.make('install', f.installArgs), /설치.*완료/);
  const repeated = structured(f.make('install', [...f.installArgs, '--json']));
  assert.equal(repeated.status, 'reinstalled'); assert.deepEqual(repeated.build_cleanup, { removed: [], preserved: [] });
  human(f.make('uninstall-plan', f.uninstallArgs), /제거.*계획/);
  assert.equal(structured(f.make('uninstall-plan', [...f.uninstallArgs, '--json'])).status, 'planned');
  human(f.make('uninstall', f.uninstallArgs), /제거.*완료/);
  assert.equal(structured(f.make('uninstall', [...f.uninstallArgs, '--json'])).status, 'uninstalled');
  assert.equal(fs.existsSync(path.join(f.project, 'node_modules')), false); assert.equal(fs.existsSync(path.join(f.project, 'dist')), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'node-cache')), false);
});
