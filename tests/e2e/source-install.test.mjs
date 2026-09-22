import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installFromSource } from '../../scripts/install-source.mjs';
import { prepareInstall, applyInstall } from '../../scripts/install.mjs';
import { inventory, locations } from '../../scripts/install-state.mjs';
import { connectAgent, getAgentConnections } from '../../scripts/agent-connections.mjs';

const present = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

function setup(t, { configurations = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-source-install-e2e-'));
  const homeDir = path.join(dir, "User's Home"), projectRoot = path.join(dir, 'project'), sourceApp = path.join(dir, 'Fixture.app');
  const loc = locations(homeDir), calls = [];
  t.after(() => {
    for (const call of calls) fs.rmSync(call.outputDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(path.join(sourceApp, 'Contents/MacOS'), { recursive: true });
  for (const name of ['node', 'WorkLog', 'WorkLogKeychain'])
    fs.writeFileSync(path.join(sourceApp, 'Contents/MacOS', name), `fixture-${name}\n`, { mode: 0o755 });
  const skill = path.join(sourceApp, 'Contents/Resources/harness/skills/work');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: work\n---\nFixture request skill.\n');
  const hook = path.join(sourceApp, 'Contents/Resources/harness/src/hook.mjs');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, 'process.exit(0);\n');
  const config = { model: 'keep-me', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'company-hook' }] }] } };
  for (const file of configurations ? Object.values(loc.configs) : []) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config));
  }
  const build = options => {
    calls.push(options);
    const app = path.join(options.outputDir, 'WorkLog.app');
    fs.cpSync(sourceApp, app, { recursive: true });
    return { app, archive: null, signing: 'fixture', test_data_root: null };
  };
  const legacy = [path.join(projectRoot, 'dist/WorkLog.app'), path.join(projectRoot, 'dist/package/WorkLog/WorkLog.app')];
  return { dir, homeDir, projectRoot, sourceApp, loc, config, calls, build, legacy,
    install: options => installFromSource({ homeDir, projectRoot, activate: false, build, ...options }),
    existing: () => applyInstall(prepareInstall({ homeDir, sourceApp, output: path.join(dir, 'existing-plan') }), { activate: false }),
    duplicate: target => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(sourceApp, target, { recursive: true }); },
    read: engine => JSON.parse(fs.readFileSync(loc.configs[engine], 'utf8')) };
}

function preserved(result, candidate) {
  assert.equal(result.build_cleanup.removed.includes(candidate), false);
  const item = result.build_cleanup.preserved.find(row => row.path === candidate);
  assert.ok(item, `missing preservation result for ${candidate}`);
  assert.equal(typeof item.reason, 'string'); assert.ok(item.reason.length > 0);
}

test('source installation builds without an archive in an owned temporary directory and removes it after installation', t => {
  const f = setup(t), originalConfigs = Object.fromEntries(Object.entries(f.loc.configs).map(([engine, file]) => [engine, fs.readFileSync(file, 'utf8')]));
  const result = f.install();
  assert.equal(result.status, 'installed'); assert.equal(result.installed, f.loc.app); assert.equal(result.activated, false);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].archive, false);
  assert.ok(f.calls[0].outputDir.startsWith(path.join(os.tmpdir(), 'worklog-source-install-')));
  assert.equal(present(f.calls[0].outputDir), false);
  assert.equal(present(path.join(f.projectRoot, 'dist')), false);
  assert.deepEqual(inventory(f.loc.app), inventory(f.sourceApp));
  assert.deepEqual(result.build_cleanup, { removed: [], preserved: [] });
  const receipt = JSON.parse(fs.readFileSync(f.loc.manifest));
  assert.equal(receipt.state, 'installed'); assert.equal(receipt.format, 2);
  assert.deepEqual(receipt.hooks, []); assert.deepEqual(receipt.links, []);
  for (const engine of ['claude', 'codex']) {
    assert.equal(fs.readFileSync(f.loc.configs[engine], 'utf8'), originalConfigs[engine]);
  }
  for (const folder of ['.claude/skills', '.codex/worklog', '.agents']) assert.equal(present(path.join(f.homeDir, folder)), false);
  assert.deepEqual(getAgentConnections({ homeDir: f.homeDir }).connections.map(({ state }) => state), ['disconnected', 'disconnected']);
});

test('source installation does not create agent configuration directories on a fresh home', t => {
  const f = setup(t, { configurations: false });
  assert.equal(f.install().status, 'installed');
  for (const folder of ['.claude', '.codex', '.agents']) assert.equal(present(path.join(f.homeDir, folder)), false);
});

test('source installation preserves malformed agent settings and unrelated work skills without reading them', t => {
  const f = setup(t), malformed = '{ user configuration is not valid JSON';
  fs.writeFileSync(f.loc.configs.claude, malformed);
  const links = ['.claude/skills/work', '.agents/skills/work', '.codex/worklog/skills/work'].map(file => path.join(f.homeDir, file));
  for (const target of links) {
    fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'SKILL.md'), 'Existing user skill.\n');
  }
  assert.equal(f.install().status, 'installed');
  assert.equal(fs.readFileSync(f.loc.configs.claude, 'utf8'), malformed);
  assert.deepEqual(f.read('codex'), f.config);
  for (const target of links) assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'Existing user skill.\n');
});

test('an existing verified installation skips rebuilding and keeps an explicitly connected agent without connecting the other', t => {
  const f = setup(t), original = f.existing();
  connectAgent('claude', { homeDir: f.homeDir });
  const receipt = fs.readFileSync(f.loc.manifest, 'utf8'), configurations = Object.fromEntries(Object.entries(f.loc.configs).map(([engine, file]) => [engine, fs.readFileSync(file, 'utf8')]));
  const connections = getAgentConnections({ homeDir: f.homeDir });
  assert.deepEqual(connections.connections.map(({ state }) => state), ['connected', 'disconnected']);
  const result = f.install({ build: () => assert.fail('existing installation must not rebuild') });
  assert.equal(result.status, 'already_installed'); assert.equal(result.installation_id, original.installation_id);
  assert.equal(fs.readFileSync(f.loc.manifest, 'utf8'), receipt);
  for (const [engine, file] of Object.entries(f.loc.configs)) assert.equal(fs.readFileSync(file, 'utf8'), configurations[engine]);
  assert.deepEqual(getAgentConnections({ homeDir: f.homeDir }), connections);
  assert.equal(present(path.join(f.projectRoot, 'dist')), false);
});

test('an existing changed installation fails verification before rebuilding or removing legacy apps', t => {
  const f = setup(t); f.existing(); f.duplicate(f.legacy[0]);
  const appFile = path.join(f.loc.app, 'Contents/MacOS/WorkLog'); fs.writeFileSync(appFile, 'user changed installed app');
  assert.throws(() => f.install({ build: () => assert.fail('changed installation must not rebuild') }), /기존 설치가 변경/);
  assert.equal(fs.readFileSync(appFile, 'utf8'), 'user changed installed app'); assert.ok(present(f.legacy[0]));
});

test('a failed build removes its partial temporary output and preserves legacy apps and user configuration', t => {
  const f = setup(t); f.duplicate(f.legacy[0]); const original = inventory(f.legacy[0]);
  assert.throws(() => f.install({ build: options => {
    f.calls.push(options);
    fs.mkdirSync(path.join(options.outputDir, 'WorkLog.app')); fs.writeFileSync(path.join(options.outputDir, 'partial.txt'), 'partial build');
    throw new Error('fixture build failure');
  } }), /fixture build failure/);
  assert.equal(f.calls.length, 1); assert.equal(present(f.calls[0].outputDir), false);
  assert.equal(present(f.loc.app), false); assert.deepEqual(inventory(f.legacy[0]), original); assert.deepEqual(f.read('codex'), f.config);
});

test('an installation collision cleans temporary build output without replacing the existing app or removing legacy apps', t => {
  const f = setup(t); f.duplicate(f.legacy[0]);
  fs.mkdirSync(f.loc.app, { recursive: true }); fs.writeFileSync(path.join(f.loc.app, 'owner.txt'), 'existing user app');
  const original = inventory(f.legacy[0]);
  assert.throws(() => f.install(), /덮어쓰지/);
  assert.equal(f.calls.length, 1); assert.equal(present(f.calls[0].outputDir), false);
  assert.equal(fs.readFileSync(path.join(f.loc.app, 'owner.txt'), 'utf8'), 'existing user app');
  assert.deepEqual(inventory(f.legacy[0]), original); assert.deepEqual(f.read('claude'), f.config);
});

test('successful installation removes both identical legacy app copies while preserving package helpers and archives', t => {
  const f = setup(t); for (const app of f.legacy) f.duplicate(app);
  const helper = path.join(f.projectRoot, 'dist/package/WorkLog/Install WorkLog.command');
  const archive = path.join(f.projectRoot, 'dist/WorkLog-macos-arm64.zip');
  fs.writeFileSync(helper, 'existing package helper'); fs.writeFileSync(archive, 'existing release archive');
  const result = f.install();
  assert.deepEqual([...result.build_cleanup.removed].sort(), [...f.legacy].sort()); assert.deepEqual(result.build_cleanup.preserved, []);
  for (const app of f.legacy) assert.equal(present(app), false);
  assert.equal(fs.readFileSync(helper, 'utf8'), 'existing package helper'); assert.equal(fs.readFileSync(archive, 'utf8'), 'existing release archive');
  assert.deepEqual(inventory(f.loc.app), inventory(f.sourceApp));
});

test('an existing installed receipt authorizes identical legacy cleanup without a new build', t => {
  const f = setup(t); f.existing(); for (const app of f.legacy) f.duplicate(app);
  const result = f.install({ build: () => assert.fail('legacy cleanup must not rebuild') });
  assert.equal(result.status, 'already_installed'); assert.deepEqual([...result.build_cleanup.removed].sort(), [...f.legacy].sort());
  for (const app of f.legacy) assert.equal(present(app), false);
});

for (const change of ['modified file', 'additional file', 'missing file', 'changed mode'])
  test(`legacy cleanup preserves a copy with a ${change}`, t => {
    const f = setup(t); f.duplicate(f.legacy[0]);
    const file = path.join(f.legacy[0], 'Contents/MacOS/WorkLog');
    if (change === 'modified file') fs.writeFileSync(file, 'different app');
    if (change === 'additional file') fs.writeFileSync(path.join(f.legacy[0], 'user-note.txt'), 'keep');
    if (change === 'missing file') fs.unlinkSync(file);
    if (change === 'changed mode') fs.chmodSync(file, 0o644);
    const original = inventory(f.legacy[0]), result = f.install();
    preserved(result, f.legacy[0]); assert.deepEqual(inventory(f.legacy[0]), original);
  });

test('legacy cleanup preserves an app symlink and its identical target', t => {
  const f = setup(t); fs.mkdirSync(path.dirname(f.legacy[0]), { recursive: true }); fs.symlinkSync(f.sourceApp, f.legacy[0]);
  const original = inventory(f.sourceApp), result = f.install();
  preserved(result, f.legacy[0]); assert.equal(fs.readlinkSync(f.legacy[0]), f.sourceApp); assert.deepEqual(inventory(f.sourceApp), original);
});

for (const ancestor of ['', 'dist', 'dist/package', 'dist/package/WorkLog'])
  test(`legacy cleanup preserves an app reached through a symlink at ${ancestor || 'projectRoot'}`, t => {
    const f = setup(t), link = path.join(f.projectRoot, ancestor), target = path.join(f.dir, 'external-directory');
    fs.mkdirSync(target);
    if (ancestor) fs.mkdirSync(path.dirname(link), { recursive: true }); else fs.rmdirSync(link);
    fs.symlinkSync(target, link);
    const candidate = ancestor.startsWith('dist/package') ? f.legacy[1] : f.legacy[0];
    f.duplicate(candidate); const original = inventory(candidate), result = f.install();
    preserved(result, candidate); assert.equal(fs.readlinkSync(link), target); assert.deepEqual(inventory(candidate), original);
  });

test('an explicit source app skips building and remains intact while another exact legacy copy is removed', t => {
  const f = setup(t); for (const app of f.legacy) f.duplicate(app);
  const original = inventory(f.legacy[0]);
  const result = f.install({ sourceApp: f.legacy[0], build: () => assert.fail('explicit source app must not rebuild') });
  assert.equal(result.status, 'installed'); preserved(result, f.legacy[0]); assert.deepEqual(inventory(f.legacy[0]), original);
  assert.deepEqual(result.build_cleanup.removed, [f.legacy[1]]); assert.equal(present(f.legacy[1]), false);
});

test('an explicit source symlink also protects its actual legacy app target from cleanup', t => {
  const f = setup(t); f.duplicate(f.legacy[0]);
  const alias = path.join(f.dir, 'Explicit.app'); fs.symlinkSync(f.legacy[0], alias);
  const original = inventory(f.legacy[0]);
  const result = f.install({ sourceApp: alias, build: () => assert.fail('explicit source app must not rebuild') });
  assert.equal(result.status, 'installed'); preserved(result, f.legacy[0]); assert.deepEqual(inventory(f.legacy[0]), original);
  assert.equal(fs.readlinkSync(alias), f.legacy[0]);
});

test('an explicitly empty source path is rejected before building or changing installation files', t => {
  const f = setup(t);
  for (const sourceApp of ['', '   ']) {
    assert.throws(() => f.install({ sourceApp, build: () => assert.fail('empty source must not fall back to building') }), /source-app/);
  }
  assert.equal(present(f.loc.app), false);
  assert.equal(present(f.loc.manifest), false);
  assert.deepEqual(f.read('codex'), f.config);
});
