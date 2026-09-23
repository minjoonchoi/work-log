import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareInstall, applyInstall } from '../../scripts/install.mjs';
import { prepareUninstall, applyUninstall } from '../../scripts/uninstall.mjs';
import { controlServices } from '../../scripts/service-control.mjs';
import { getAgentConnections, connectAgent, disconnectAgent } from '../../scripts/agent-connections.mjs';
import { quote, locations, skillLinks } from '../../scripts/install-state.mjs';
import { ROOT, readEndpoint } from '../../src/shared.mjs';
import { Harness, eventually } from '../helpers.mjs';

function setup(t, real = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-install-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const homeDir = path.join(dir, "User's Home"), sourceApp = path.join(dir, 'Source.app');
  fs.mkdirSync(path.join(sourceApp, 'Contents/MacOS'), { recursive: true });
  const bundle = path.join(sourceApp, 'Contents/Resources/harness'); fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(sourceApp, 'Contents/MacOS/node'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  for (const name of ['WorkLog', 'WorkLogKeychain']) fs.writeFileSync(path.join(sourceApp, 'Contents/MacOS', name), 'test-package-placeholder');
  fs.writeFileSync(path.join(bundle, 'immutable.txt'), 'v1');
  fs.cpSync(path.join(ROOT, 'skills'), path.join(bundle, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'src'), { recursive: true }); fs.writeFileSync(path.join(bundle, 'src/hook.mjs'), '// fixture hook');
  if (real) {
    for (const name of ['src', 'bin', 'harness', 'contracts', 'apps/web']) fs.cpSync(path.join(ROOT, name), path.join(bundle, name), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'scripts'), { recursive: true });
    for (const name of ['agent-connections', 'install-state', 'install-output', 'install', 'uninstall', 'service-control']) fs.copyFileSync(path.join(ROOT, `scripts/${name}.mjs`), path.join(bundle, `scripts/${name}.mjs`));
    for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, name), path.join(bundle, name));
    for (const name of ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string']) fs.cpSync(path.join(ROOT, 'node_modules', name), path.join(bundle, 'node_modules', name), { recursive: true });
  }
  const config = { model: 'preserve-me', disableAllHooks: true, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'company-required-hook' }] }],
    Custom: [{ hooks: [{ type: 'command', command: 'echo worklog-not-owned' }] }] } };
  const loc = locations(homeDir);
  for (const target of Object.values(loc.configs)) {
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(config));
  }
  for (const target of ['.claude/CLAUDE.md', '.codex/AGENTS.md']) fs.writeFileSync(path.join(homeDir, target), 'User owned instructions\n');
  const plan = prepareInstall({ output: path.join(dir, 'plan'), homeDir, sourceApp });
  return { dir, homeDir, sourceApp, plan, loc, config,
    links: skillLinks(loc, plan.skills, plan.runtimeRoot).map(l => ({ target: l.path, source: l.target })),
    connect: () => { for (const engine of ['claude', 'codex']) connectAgent(engine, { homeDir }); },
    install: options => applyInstall(plan, { activate: false, ...options }),
    uninstall: options => applyUninstall({ homeDir, deactivate: false, ...options }),
    read: engine => JSON.parse(fs.readFileSync(loc.configs[engine], 'utf8')),
    write: (engine, value) => fs.writeFileSync(loc.configs[engine], JSON.stringify(value)) };
}
const present = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

test('install and reinstall own only app/services until each agent is explicitly connected', t => {
  const f = setup(t), before = Object.fromEntries(Object.entries(f.loc.configs).map(([engine, file]) => [engine, fs.readFileSync(file)]));
  assert.equal(getAgentConnections({ homeDir: f.homeDir }).available, false);
  const result = f.install(); assert.equal(result.activated, false);
  assert.deepEqual(f.plan.hooks, {}); assert.deepEqual(f.plan.links, []);
  const receipt = JSON.parse(fs.readFileSync(f.loc.manifest));
  assert.equal(receipt.format, 2); assert.deepEqual(receipt.hooks, []); assert.deepEqual(receipt.links, []);
  assert.deepEqual(getAgentConnections({ homeDir: f.homeDir }).connections.map(row => row.state), ['disconnected', 'disconnected']);
  for (const [engine, file] of Object.entries(f.loc.configs)) assert.deepEqual(fs.readFileSync(file), before[engine]);
  for (const link of f.links) assert.equal(present(link.target), false);
  assert.equal(f.install().status, 'already_installed');
  const connected = connectAgent('claude', { homeDir: f.homeDir });
  assert.deepEqual(connected.connections.map(row => row.state), ['connected', 'disconnected']);
  assert.equal(f.read('claude').hooks.Stop.length, 2); assert.deepEqual(fs.readFileSync(f.loc.configs.codex), before.codex);
  assert.equal(connectAgent('claude', { homeDir: f.homeDir }).connections[0].state, 'connected');
  assert.equal(f.read('claude').hooks.Stop.length, 2);
  const connectedBytes = fs.readFileSync(f.loc.configs.claude);
  assert.equal(f.install().status, 'already_installed'); assert.deepEqual(fs.readFileSync(f.loc.configs.claude), connectedBytes);
  connectAgent('codex', { homeDir: f.homeDir });
  for (const link of f.links) {
    assert.equal(fs.readlinkSync(link.target), link.source);
    assert.match(fs.readFileSync(path.join(link.target, 'SKILL.md'), 'utf8'), /name: work/);
  }
  assert.equal(f.read('claude').hooks.PostToolUseFailure.length, 1);
  assert.equal(f.read('codex').hooks.PostToolUseFailure, undefined);
  assert.equal(fs.readFileSync(path.join(f.homeDir, '.codex/AGENTS.md'), 'utf8'), 'User owned instructions\n');
});

test('malformed or redirected agent configuration never blocks app install, reinstall or uninstall', t => {
  const f = setup(t), outside = path.join(f.dir, 'outside-config');
  fs.writeFileSync(f.loc.configs.claude, '{malformed'); fs.writeFileSync(outside, 'user settings');
  fs.unlinkSync(f.loc.configs.codex); fs.symlinkSync(outside, f.loc.configs.codex);
  assert.equal(f.install().status, 'installed'); assert.equal(f.install().status, 'already_installed');
  assert.ok(getAgentConnections({ homeDir: f.homeDir }).connections.every(row => row.state === 'disconnected'));
  assert.throws(() => connectAgent('claude', { homeDir: f.homeDir }), /JSON/);
  assert.throws(() => connectAgent('codex', { homeDir: f.homeDir }), /심링크/);
  assert.equal(f.uninstall().status, 'uninstalled');
  assert.equal(fs.readFileSync(f.loc.configs.claude, 'utf8'), '{malformed');
  assert.equal(fs.readlinkSync(f.loc.configs.codex), outside); assert.equal(fs.readFileSync(outside, 'utf8'), 'user settings');
});

for (const eventValue of [null, false, 0, '', {}]) test(`connection rejects an existing non-array hook event ${JSON.stringify(eventValue)} without rewriting it`, t => {
  const f = setup(t); f.install();
  for (const engine of ['claude', 'codex']) {
    const config = f.read(engine); config.hooks.Stop = eventValue; f.write(engine, config);
    const before = fs.readFileSync(f.loc.configs[engine]), receipt = fs.readFileSync(f.loc.manifest);
    assert.throws(() => connectAgent(engine, { homeDir: f.homeDir }), /Stop 설정 형식/);
    assert.deepEqual(fs.readFileSync(f.loc.configs[engine]), before); assert.deepEqual(fs.readFileSync(f.loc.manifest), receipt);
  }
  for (const link of f.links) assert.equal(present(link.target), false);
});

for (const relative of ['node', 'harness/src/hook.mjs', 'harness/skills/work/SKILL.md']) test(`connection detects missing ${relative} and reconnect preserves existing ownership until restored`, t => {
  const f = setup(t); f.install(); connectAgent('claude', { homeDir: f.homeDir });
  const file = path.join(f.plan.runtimeRoot, relative), contents = fs.readFileSync(file), mode = fs.statSync(file).mode;
  const config = fs.readFileSync(f.loc.configs.claude), receipt = fs.readFileSync(f.loc.manifest);
  fs.unlinkSync(file);
  const snapshot = getAgentConnections({ homeDir: f.homeDir });
  assert.equal(snapshot.available, true); assert.equal(snapshot.connections[0].state, 'needs_attention');
  assert.match(snapshot.connections[0].message, /실행 파일 또는 스킬/);
  assert.throws(() => connectAgent('claude', { homeDir: f.homeDir }), /실행 파일 또는 스킬/);
  assert.deepEqual(fs.readFileSync(f.loc.configs.claude), config); assert.deepEqual(fs.readFileSync(f.loc.manifest), receipt);
  assert.ok(present(f.links[0].target)); assert.equal(present(file), false);
  fs.writeFileSync(file, contents, { mode });
  assert.equal(connectAgent('claude', { homeDir: f.homeDir }).connections[0].state, 'connected');
  assert.deepEqual(fs.readFileSync(f.loc.configs.claude), config);
});

test('a link created by another actor after connection preflight is never adopted or removed', t => {
  const f = setup(t); f.install(); const original = fs.symlinkSync, link = f.links[0];
  fs.symlinkSync = (target, file, ...options) => {
    if (file === link.target) original(target, file, ...options);
    return original(target, file, ...options);
  };
  try { assert.throws(() => connectAgent('claude', { homeDir: f.homeDir }), error => error.code === 'EEXIST'); }
  finally { fs.symlinkSync = original; }
  const identity = fs.lstatSync(link.target), receipt = JSON.parse(fs.readFileSync(f.loc.manifest));
  assert.equal(receipt.links[0].pending, true); assert.equal(receipt.links[0].identity, undefined);
  assert.equal(getAgentConnections({ homeDir: f.homeDir }).connections[0].state, 'needs_attention');
  assert.throws(() => disconnectAgent('claude', { homeDir: f.homeDir }), /소유를 확인/);
  assert.equal(fs.readlinkSync(link.target), link.source); assert.equal(fs.lstatSync(link.target).ino, identity.ino);
  assert.throws(() => connectAgent('claude', { homeDir: f.homeDir }), /소유를 확인/);
  assert.equal(f.uninstall().status, 'needs_attention'); assert.ok(present(f.plan.runtimeRoot));
  assert.equal(fs.lstatSync(link.target).ino, identity.ino);
  fs.unlinkSync(link.target); assert.equal(f.uninstall().status, 'uninstalled');
});

test('disconnect is independent and idempotent, preserves user hooks and keeps every original backup', t => {
  const f = setup(t); f.install(); f.connect();
  const codex = fs.readFileSync(f.loc.configs.codex), backupDir = path.join(f.loc.data, 'install-backups', f.plan.installationId);
  const firstBackups = fs.readdirSync(backupDir);
  assert.equal(firstBackups.length, 2);
  assert.ok(firstBackups.every(file => fs.readFileSync(path.join(backupDir, file), 'utf8') === JSON.stringify(f.config)));
  assert.match(getAgentConnections({ homeDir: f.homeDir }).connections[0].message, /비활성화/);
  const changed = f.read('claude'); changed.customProperty = 'preserve';
  changed.hooks.Stop[1].hooks.push({ type: 'command', command: 'new-company-hook' }); f.write('claude', changed);
  assert.deepEqual(disconnectAgent('claude', { homeDir: f.homeDir }).connections.map(row => row.state), ['disconnected', 'connected']);
  assert.equal(f.read('claude').customProperty, 'preserve'); assert.equal(f.read('claude').disableAllHooks, true);
  assert.deepEqual(f.read('claude').hooks.Stop, [f.config.hooks.Stop[0], { hooks: [{ type: 'command', command: 'new-company-hook' }] }]);
  assert.deepEqual(fs.readFileSync(f.loc.configs.codex), codex); assert.ok(present(f.links[1].target));
  const disconnected = fs.readFileSync(f.loc.configs.claude);
  disconnectAgent('claude', { homeDir: f.homeDir }); assert.deepEqual(fs.readFileSync(f.loc.configs.claude), disconnected);
  connectAgent('claude', { homeDir: f.homeDir });
  assert.equal(fs.readdirSync(backupDir).length, 3);
  for (const file of firstBackups) assert.equal(fs.readFileSync(path.join(backupDir, file), 'utf8'), JSON.stringify(f.config));
});

test('new empty agent configs and directories are tracked and removed, while later user data survives', t => {
  const f = setup(t);
  for (const dir of ['.claude', '.codex']) fs.rmSync(path.join(f.homeDir, dir), { recursive: true });
  f.install();
  for (const dir of ['.claude', '.codex', '.agents']) assert.equal(present(path.join(f.homeDir, dir)), false);
  f.connect();
  const receipt = JSON.parse(fs.readFileSync(f.loc.manifest));
  assert.deepEqual(new Set(receipt.created_configs), new Set(Object.values(f.loc.configs)));
  assert.ok(receipt.created_directories.includes(path.join(f.homeDir, '.agents/skills')));
  disconnectAgent('claude', { homeDir: f.homeDir }); assert.equal(present(path.join(f.homeDir, '.claude')), false);
  const config = f.read('codex'); config.userSetting = true; f.write('codex', config);
  const ownSkill = path.join(f.homeDir, '.agents/skills/user-skill'); fs.mkdirSync(ownSkill); fs.writeFileSync(path.join(ownSkill, 'SKILL.md'), 'keep');
  assert.equal(f.uninstall().status, 'uninstalled');
  assert.deepEqual(f.read('codex'), { userSetting: true }); assert.equal(present(path.join(f.homeDir, '.codex/worklog')), false);
  assert.equal(fs.readFileSync(path.join(ownSkill, 'SKILL.md'), 'utf8'), 'keep');
});

test('connection intent survives partial failure and reconnect safely repairs only recorded resources', t => {
  const f = setup(t); f.install(); const original = fs.symlinkSync;
  fs.symlinkSync = (target, link, ...options) => {
    if (link === f.links[0].target) {
      const receipt = JSON.parse(fs.readFileSync(f.loc.manifest));
      assert.equal(receipt.hooks[0].engine, 'claude'); assert.equal(receipt.links[0].path, link);
      assert.equal(f.read('claude').hooks.Stop.length, 2);
      throw new Error('fixture link creation interrupted');
    }
    return original(target, link, ...options);
  };
  try { assert.throws(() => connectAgent('claude', { homeDir: f.homeDir }), /fixture link/); }
  finally { fs.symlinkSync = original; }
  assert.equal(getAgentConnections({ homeDir: f.homeDir }).connections[0].state, 'needs_attention');
  assert.equal(connectAgent('claude', { homeDir: f.homeDir }).connections[0].state, 'connected');
  assert.equal(f.read('claude').hooks.Stop.length, 2); assert.deepEqual(f.read('codex'), f.config);
  assert.equal(f.uninstall().status, 'uninstalled'); assert.deepEqual(f.read('claude'), f.config);
});

test('changed owned hooks are preserved and reported by disconnect until the user restores them', t => {
  const f = setup(t); f.install(); connectAgent('claude', { homeDir: f.homeDir });
  const original = fs.readFileSync(f.loc.configs.claude), config = f.read('claude');
  config.hooks.Stop[1].hooks[0].timeout = 123; f.write('claude', config);
  assert.throws(() => disconnectAgent('claude', { homeDir: f.homeDir }), /변경되었거나 중복/);
  assert.equal(getAgentConnections({ homeDir: f.homeDir }).connections[0].state, 'needs_attention');
  assert.equal(f.read('claude').hooks.Stop[1].hooks[0].timeout, 123); assert.ok(present(f.plan.runtimeRoot));
  assert.throws(() => connectAgent('claude', { homeDir: f.homeDir }), /변경되었거나 중복/);
  fs.writeFileSync(f.loc.configs.claude, original);
  assert.equal(disconnectAgent('claude', { homeDir: f.homeDir }).connections[0].state, 'disconnected');
  assert.deepEqual(f.read('claude'), f.config);
});

test('connection mutation shares the installation lock and cannot claim unrecorded hooks', t => {
  const f = setup(t); f.install();
  const lock = path.join(f.loc.data, 'installation.lock'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  for (const operation of [connectAgent, disconnectAgent]) assert.throws(() => operation('codex', { homeDir: f.homeDir }), /이미 실행 중/);
  fs.unlinkSync(lock); connectAgent('codex', { homeDir: f.homeDir });
  const config = f.read('codex'); disconnectAgent('codex', { homeDir: f.homeDir }); f.write('codex', config);
  assert.throws(() => connectAgent('codex', { homeDir: f.homeDir }), /소유 기록이 없는/);
  assert.deepEqual(f.read('codex'), config);
  const receipt = JSON.parse(fs.readFileSync(f.loc.manifest)); receipt.created_directories.push(f.homeDir);
  fs.writeFileSync(f.loc.manifest, JSON.stringify(receipt)); assert.throws(() => f.uninstall(), /디렉터리 소유 경로/);
});

test('uninstall removes only owned hooks, links and binaries; later user settings, co-located hooks and SQLite data survive', t => {
  const f = setup(t); f.install(); f.connect();
  for (const engine of ['claude', 'codex']) {
    const config = f.read(engine); config.model = 'changed-after-install'; config.userAdded = true;
    config.hooks.Stop[1].hooks.push({ type: 'command', command: 'user-added-hook-in-same-group' });
    f.write(engine, config);
  }
  const db = path.join(f.loc.data, 'memory.sqlite'); fs.writeFileSync(db, 'persistent-user-data');
  const externalSkill = path.join(f.homeDir, '.claude/skills/my-skill'); fs.mkdirSync(externalSkill); fs.writeFileSync(path.join(externalSkill, 'SKILL.md'), 'keep');
  const dry = prepareUninstall({ homeDir: f.homeDir }); assert.equal(dry.status, 'planned'); assert.ok(present(f.loc.app));
  const result = f.uninstall(); assert.equal(result.status, 'uninstalled', JSON.stringify(result.preserved));
  for (const engine of ['claude', 'codex']) {
    const config = f.read(engine); assert.equal(config.model, 'changed-after-install'); assert.equal(config.userAdded, true);
    assert.deepEqual(config.hooks.Stop, [f.config.hooks.Stop[0], { hooks: [{ type: 'command', command: 'user-added-hook-in-same-group' }] }]);
    assert.deepEqual(config.hooks.Custom, f.config.hooks.Custom); assert.equal(config.hooks.UserPromptSubmit, undefined);
  }
  for (const link of f.links) assert.equal(present(link.target), false);
  assert.equal(present(f.loc.app), false); assert.equal(present(f.plan.runtimeRoot), false);
  assert.equal(fs.readFileSync(db, 'utf8'), 'persistent-user-data'); assert.ok(present(path.join(externalSkill, 'SKILL.md')));
  assert.equal(fs.readFileSync(path.join(f.homeDir, '.claude/CLAUDE.md'), 'utf8'), 'User owned instructions\n');
  fs.mkdirSync(f.loc.app, { recursive: true }); fs.writeFileSync(path.join(f.loc.app, 'new-owner.txt'), 'keep new app');
  assert.equal(f.uninstall().status, 'uninstalled'); assert.equal(fs.readFileSync(path.join(f.loc.app, 'new-owner.txt'), 'utf8'), 'keep new app');
});

for (const change of ['timeout', 'duplicate', 'remove-marker', 'malformed']) test(`uninstall preserves ${change} hook edits and dependent runtime, then safely resumes`, t => {
  const f = setup(t); f.install(); f.connect(); const original = fs.readFileSync(f.loc.configs.claude, 'utf8');
  const config = f.read('claude');
  if (change === 'timeout') config.hooks.Stop[1].hooks[0].timeout = 8;
  if (change === 'duplicate') config.hooks.Stop.push(structuredClone(config.hooks.Stop[1]));
  if (change === 'remove-marker') config.hooks.Stop[1].hooks[0].command = config.hooks.Stop[1].hooks[0].command.replace(/WORKLOG_INSTALL_ID='[^']+' /, '');
  if (change === 'malformed') fs.writeFileSync(f.loc.configs.claude, '{bad json'); else f.write('claude', config);
  const before = fs.readFileSync(f.loc.configs.claude, 'utf8');
  const result = f.uninstall(); assert.equal(result.status, 'needs_attention'); assert.ok(present(f.plan.runtimeRoot));
  if (change === 'malformed') assert.equal(fs.readFileSync(f.loc.configs.claude, 'utf8'), before);
  else assert.ok(f.read('claude').hooks.Stop.some(g => g.hooks.some(h => h.command.includes('src/hook.mjs'))));
  fs.writeFileSync(f.loc.configs.claude, original);
  assert.equal(f.uninstall().status, 'uninstalled');
});

for (const kind of ['different-link', 'regular-file', 'directory']) test(`uninstall preserves a skill path replaced with a ${kind}`, t => {
  const f = setup(t); f.install(); f.connect(); const link = f.links[0].target; fs.unlinkSync(link);
  const external = path.join(f.dir, 'user-owned'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'keep.txt'), 'keep');
  if (kind === 'different-link') fs.symlinkSync(external, link);
  if (kind === 'regular-file') fs.writeFileSync(link, 'replacement');
  if (kind === 'directory') { fs.mkdirSync(link); fs.writeFileSync(path.join(link, 'own.txt'), 'replacement'); }
  assert.equal(f.uninstall().status, 'needs_attention'); assert.ok(present(link));
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'keep');
});

test('pre-existing or dangling instruction symlink blocks only explicit connection', t => {
  const f = setup(t), link = f.links[0].target;
  fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(path.join(f.dir, 'missing-user-target'), link);
  assert.equal(f.install().status, 'installed');
  assert.throws(() => connectAgent('claude', { homeDir: f.homeDir }), /덮어쓰지/);
  assert.deepEqual(f.read('claude'), f.config); assert.ok(present(f.loc.app));
  assert.equal(fs.readlinkSync(link), path.join(f.dir, 'missing-user-target'));
  assert.equal(getAgentConnections({ homeDir: f.homeDir }).connections[0].state, 'disconnected');
  assert.equal(f.uninstall().status, 'uninstalled'); assert.ok(present(link));
});

test('uninstall never follows a replaced config file or parent directory symlink', t => {
  const f = setup(t); f.install(); f.connect();
  const outside = path.join(f.dir, 'outside.json'); fs.writeFileSync(outside, JSON.stringify({ keep: true }));
  fs.unlinkSync(f.loc.configs.claude); fs.symlinkSync(outside, f.loc.configs.claude);
  const skills = path.dirname(f.links[1].target), originalSkills = `${skills}-moved`;
  fs.renameSync(skills, originalSkills); fs.symlinkSync(originalSkills, skills);
  assert.equal(f.uninstall().status, 'needs_attention');
  assert.equal(fs.readFileSync(outside, 'utf8'), JSON.stringify({ keep: true }));
  assert.ok(present(path.join(originalSkills, 'work')));
});

test('changed app files and new runtime files preserve complete installation trees', t => {
  const f = setup(t); f.install(); f.connect();
  const changed = path.join(f.loc.app, 'Contents/MacOS/WorkLog'); fs.writeFileSync(changed, 'user-replaced-app');
  const added = path.join(f.plan.runtimeRoot, 'new-user-file.txt'); fs.writeFileSync(added, 'keep');
  assert.equal(f.uninstall().status, 'needs_attention');
  assert.equal(fs.readFileSync(changed, 'utf8'), 'user-replaced-app'); assert.equal(fs.readFileSync(added, 'utf8'), 'keep');
  assert.ok(present(path.join(f.plan.runtimeRoot, 'node')));
});

test('missing ownership receipt and path-tampered receipt never authorize deleting similarly named resources', t => {
  const f = setup(t); f.install(); f.connect(); const original = fs.readFileSync(f.loc.manifest, 'utf8'); fs.unlinkSync(f.loc.manifest);
  assert.equal(f.uninstall().status, 'unmanaged'); assert.ok(present(f.loc.app));
  const modified = JSON.parse(original); modified.trees[0].path = f.homeDir; fs.writeFileSync(f.loc.manifest, JSON.stringify(modified));
  assert.throws(() => f.uninstall(), /허용 경로/); assert.ok(present(f.loc.app)); assert.equal(f.read('claude').hooks.Stop.length, 2);
  const escapedVersion = JSON.parse(original); escapedVersion.version = '..'; fs.writeFileSync(f.loc.manifest, JSON.stringify(escapedVersion));
  assert.throws(() => f.uninstall(), /버전 형식/); assert.ok(present(f.loc.app));
});

test('activation failure keeps its receipt; uninstall stops only verified owned services and cleans partial installation', t => {
  const f = setup(t), registered = new Map();
  const launcher = (command, args) => {
    assert.equal(command, 'launchctl');
    if (args[0] === 'bootstrap') {
      if (registered.size === 1) return { status: 5, stderr: 'fixture bootstrap failure' };
      const file = f.plan.files.find(x => x.target === args[2]); registered.set(file.label, file); return { status: 0 };
    }
    const label = args[1].split('/').at(-1), file = registered.get(label);
    if (!file) return { status: 113, stderr: 'Could not find service' };
    if (args[0] === 'print') return { status: 0, stdout: `program = ${file.argv[0]}\narguments = {\n${file.argv.join('\n')}\n}\n` };
    assert.equal(args[0], 'bootout'); assert.equal(label, 'local.worklog.runtime'); registered.delete(label); return { status: 0 };
  };
  assert.throws(() => f.install({ activate: true, launchctl: launcher }), /fixture bootstrap failure/);
  assert.equal(JSON.parse(fs.readFileSync(f.loc.manifest)).state, 'install_failed');
  assert.equal(f.uninstall({ deactivate: true, launchctl: launcher }).status, 'uninstalled'); assert.equal(registered.size, 0);
});

test('a service reusing the label with other program arguments is not stopped and blocks removal', t => {
  const f = setup(t); f.install(); f.connect();
  const receipt = JSON.parse(fs.readFileSync(f.loc.manifest)); receipt.files[0].activation = 'registered'; fs.writeFileSync(f.loc.manifest, JSON.stringify(receipt));
  const calls = [];
  const result = f.uninstall({ deactivate: true, launchctl: (command, args) => {
    calls.push(args); return { status: 0, stdout: 'program = /other/app\narguments = {\n/other/app\n}\n' };
  } });
  assert.equal(result.status, 'needs_attention'); assert.ok(calls.every(args => args[0] === 'print'));
  assert.ok(present(f.loc.app)); assert.equal(f.read('claude').hooks.Stop.length, 2);
});

function serviceFixture(f, { delayed = 0, neverStops = false } = {}) {
  const receipt = JSON.parse(fs.readFileSync(f.loc.manifest));
  for (const file of receipt.files) file.activation = 'registered';
  fs.writeFileSync(f.loc.manifest, JSON.stringify(receipt));
  const registered = new Map(f.plan.files.map(file => [file.label, { file, pid: 999999999 }])), calls = [];
  const launchctl = (command, args) => {
    assert.equal(command, 'launchctl'); calls.push(args);
    if (args[0] === 'bootstrap') {
      const file = f.plan.files.find(file => file.target === args[2]);
      registered.set(file.label, { file, pid: 999999999 }); return { status: 0 };
    }
    const label = args[1].split('/').at(-1), service = registered.get(label);
    if (!service) return { status: 113, stderr: 'Could not find service' };
    if (args[0] === 'bootout') { service.pending = delayed; if (!delayed && !neverStops) registered.delete(label); return { status: 0 }; }
    if (args[0] === 'kickstart') { service.pid = 999999999; return { status: 0 }; }
    assert.equal(args[0], 'print');
    if ('pending' in service && !neverStops && service.pending-- === 0) { registered.delete(label); return { status: 113, stderr: 'Could not find service' }; }
    return { status: 0, stdout: `program = ${service.file.argv[0]}\narguments = {\n${service.file.argv.join('\n')}\n}\n${service.pid ? `pid = ${service.pid}\n` : ''}` };
  };
  return { registered, calls, launchctl, control: (action, options) => controlServices(action, {
    homeDir: f.homeDir, appPath: f.loc.app, dataDir: f.loc.data, launchctl, ...options
  }) };
}

test('uninstall waits for asynchronous launchd removal instead of treating the first pending print as a failure', t => {
  const f = setup(t); f.install(); f.connect(); const service = serviceFixture(f, { delayed: 2 });
  const result = f.uninstall({ deactivate: true, launchctl: service.launchctl });
  assert.equal(result.status, 'uninstalled', JSON.stringify(result));
  assert.equal(service.calls.filter(args => args[0] === 'bootout').length, 3);
  assert.equal(service.registered.size, 0); assert.equal(present(f.loc.app), false);
  assert.deepEqual(f.read('codex'), f.config);
});

test('uninstall timeout preserves files and hooks until a later confirmed service stop', t => {
  const f = setup(t); f.install(); f.connect(); const service = serviceFixture(f, { neverStops: true });
  const result = f.uninstall({ deactivate: true, launchctl: service.launchctl, stopTimeoutMs: 1 });
  assert.equal(result.status, 'needs_attention'); assert.deepEqual(result.removed, []);
  assert.ok(result.preserved.every(row => row.reason.includes('대기 시간이 초과')));
  assert.ok(present(f.loc.app)); assert.equal(f.read('codex').hooks.Stop.length, 2);
  service.registered.clear();
  assert.equal(f.uninstall({ deactivate: true, launchctl: service.launchctl }).status, 'uninstalled');
});

test('GUI quit preserves user work and runtime while stopping the manager; reopening cancels draining without duplicate services', async t => {
  const f = setup(t); f.install(); f.connect(); const service = serviceFixture(f);
  let release; const pending = new Promise(resolve => { release = resolve; });
  const stopping = service.control('stop', { runtimeRequest: async (dir, role, endpoint) => {
    assert.equal(dir, f.loc.data); assert.equal(role, 'runtime'); assert.equal(endpoint, '/lifecycle/quit');
    await pending; return { status: 'draining', remaining_user_runs: 2 };
  } });
  assert.throws(() => f.uninstall(), /이미 실행 중/, 'async lifecycle retains the installation lock');
  release(); assert.equal((await stopping).status, 'user_work_continues');
  assert.deepEqual(service.calls.filter(args => args[0] === 'bootout').map(args => args[1].split('/').at(-1)), ['local.worklog.manager']);
  assert.ok(service.registered.has('local.worklog.runtime')); assert.ok(service.registered.has('local.worklog.gui'));
  assert.ok(present(f.loc.app)); assert.equal(f.read('codex').hooks.Stop.length, 2);
  let resumed = 0;
  assert.equal((await service.control('start', { runtimeRequest: async (_, __, endpoint) => {
    assert.equal(endpoint, '/lifecycle/start'); resumed++; return { status: 'running' };
  } })).status, 'started');
  assert.equal(resumed, 1); assert.equal(service.registered.size, 3);
  assert.equal(service.calls.filter(args => args[0] === 'bootstrap').length, 1);
});

test('GUI quit without user work stops backend services but preserves installation; dormant runtime is restarted on open', async t => {
  const f = setup(t); f.install(); f.connect(); const service = serviceFixture(f, { delayed: 1 });
  assert.equal((await service.control('stop', { runtimeRequest: async () => ({ status: 'draining', remaining_user_runs: 0 }) })).status, 'stopped');
  assert.deepEqual([...service.registered.keys()], ['local.worklog.gui']);
  assert.ok(present(f.loc.app)); assert.equal(f.read('codex').hooks.Stop.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(f.loc.manifest)).state, 'installed');
  service.registered.set('local.worklog.runtime', { file: f.plan.files[0], pid: null });
  assert.equal((await service.control('start', { runtimeRequest: async () => ({ status: 'running' }) })).status, 'started');
  assert.ok(service.calls.some(args => args[0] === 'kickstart' && args[1].endsWith('/local.worklog.runtime')));
  assert.match(f.plan.files[0].content, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
});

test('reopening recovers when a draining runtime exits after its PID was observed', async t => {
  const f = setup(t); f.install(); f.connect(); const service = serviceFixture(f); let attempts = 0;
  const result = await service.control('start', { runtimeRequest: async () => {
    if (++attempts === 1) { service.registered.get('local.worklog.runtime').pid = null; throw new Error('connection closed during draining'); }
    assert.ok(service.registered.get('local.worklog.runtime').pid); return { status: 'running' };
  } });
  assert.equal(result.status, 'started'); assert.equal(attempts, 2);
  assert.equal(service.calls.filter(args => args[0] === 'kickstart').length, 1);
});

test('an already registered service blocks installation before hooks or owned files are changed', t => {
  const f = setup(t);
  assert.throws(() => f.install({ activate: true, launchctl: (command, args) => {
    assert.equal(args[0], 'print'); return { status: 0, stdout: 'existing service' };
  } }), /이미 등록된 서비스/);
  assert.deepEqual(f.read('claude'), f.config); assert.equal(present(f.loc.app), false); assert.equal(present(f.loc.manifest), false);
});

test('make install/uninstall uses real CLI entrypoints against an isolated home; repeated removal is safe', t => {
  const f = setup(t);
  const install = spawnSync('make', ['install', `NODE=${process.execPath}`,
    `INSTALL_ARGS=--home-dir ${quote(f.homeDir)} --source-app ${quote(f.sourceApp)} --no-activate --output ${quote(path.join(f.dir, 'make-plan'))}`], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(install.status, 0, install.stderr); assert.ok(present(f.loc.app));
  const command = ['uninstall', `NODE=${process.execPath}`, `UNINSTALL_ARGS=--home-dir ${quote(f.homeDir)} --no-deactivate`];
  const removed = spawnSync('make', command, { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(removed.status, 0, removed.stderr); assert.equal(present(f.loc.app), false);
  assert.equal(spawnSync('make', command, { cwd: ROOT, encoding: 'utf8', timeout: 15000 }).status, 0);
  assert.deepEqual(f.read('codex'), f.config);
});

test('concurrent install/uninstall is blocked by the same live-owner lock without changing hooks', t => {
  const f = setup(t); f.install(); f.connect();
  const lock = path.join(f.loc.data, 'installation.lock'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'other-operation' }));
  assert.throws(() => f.install(), /이미 실행 중/); assert.throws(() => f.uninstall(), /이미 실행 중/);
  assert.equal(f.read('codex').hooks.Stop.length, 2); assert.ok(present(f.loc.app));
  fs.unlinkSync(lock); assert.equal(f.uninstall().status, 'uninstalled');
});

test('installed request skill delegates natural language to classification and a Codex protocol worker, and hooks feed the work item before uninstall', async t => {
  const f = setup(t, true); f.install(); f.connect();
  const h = new Harness(f.loc.data); h.executable = path.join(f.plan.runtimeRoot, 'node'); h.serviceRoot = path.join(f.plan.runtimeRoot, 'harness');
  h.testMode = false; h.env = { HARNESS_CODEX_BIN: path.join(ROOT, 'tests/fixtures/cli-double.mjs') };
  t.after(() => h.close(false)); await h.start('runtime'); await h.start('manager');
  const requestFile = path.join(f.dir, 'request.json'); fs.writeFileSync(requestFile, JSON.stringify({ prompt: '초대 기능 PRD를 작성해 주세요.' }));
  const helper = path.join(f.links[0].target, 'scripts/harness');
  const child = spawnSync(helper, ['run', '--input', requestFile, '--wait'], { cwd: f.dir, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr); const run = JSON.parse(child.stdout);
  assert.equal(run.status, 'completed'); assert.equal(run.task, 'prd.create'); assert.equal(run.engine, 'codex'); assert.ok(present(run.artifact.file));
  const hook = f.read('claude').hooks.UserPromptSubmit[0].hooks[0].command;
  const sent = spawnSync('/bin/sh', ['-c', hook], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'installed-agent', prompt: '설치 후 입력' }), encoding: 'utf8' });
  assert.equal(sent.status, 0, sent.stderr);
  await eventually(() => h.manager('/items'), rows => rows.some(row => row.title.includes('설치 후 입력')));
  assert.equal(f.uninstall().status, 'needs_attention', 'running services must stop before files are removed');
  await h.close(false); assert.equal(f.uninstall().status, 'uninstalled');
  assert.ok(present(path.join(f.loc.data, 'memory.sqlite'))); assert.ok(present(run.artifact.file));
});

test('packaged custom task settings survive uninstall and reinstall unchanged and packaged GUI serves SVG icons', async t => {
  const f = setup(t, true);
  // Add the protocol fixture to this fake package before its owned inventory is captured.
  const fixtures = path.join(f.sourceApp, 'Contents/Resources/harness/tests/fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tests/fixtures/worker.mjs'), path.join(fixtures, 'worker.mjs'));
  f.install(); f.connect();
  const h = new Harness(f.loc.data); h.executable = path.join(f.plan.runtimeRoot, 'node'); h.serviceRoot = path.join(f.plan.runtimeRoot, 'harness');
  t.after(() => h.close(false)); await h.start('runtime'); await h.start('manager');
  const initial = await h.manager('/execution-settings');
  const backends = { codex: { model: null, effort: null }, claude: { model: null, effort: null } };
  const created = await h.manager('/execution-settings/custom-tasks', { method: 'POST', body: {
    revision: initial.revision, template_id: 'prd.create', label: '설치 고객 PRD', description: '설치 고객의 요구와 수용 기준을 정리한다.',
    routing_terms: ['설치 고객 PRD'], instruction: '# 설치 고객 지시문\n\n요구와 제약을 구분한다.', backend: 'codex', backends
  } });
  const task = created.created_task_id, instruction = '# 재설치 보존 지시문\n\n고객별 **수용 기준**과 실패 경로를 확인한다.';
  const edited = await h.manager(`/execution-settings/${task}`, { method: 'PUT', body: {
    revision: created.revision, label: '고객 계약 PRD', description: '고객 계약의 요구와 수용 기준을 정리한다.', routing_terms: ['고객 계약 PRD'],
    instruction, backend: 'claude', backends: { codex: { model: 'gpt-5.5', effort: 'high' }, claude: { model: 'claude-opus-4-6', effort: 'max' } }
  } });
  const settingsFile = path.join(f.loc.data, 'execution-settings.json'), original = fs.readFileSync(settingsFile);
  await h.close(false);
  assert.equal(f.uninstall().status, 'uninstalled'); assert.deepEqual(fs.readFileSync(settingsFile), original);
  const replan = prepareInstall({ output: path.join(f.dir, 'reinstall-plan'), homeDir: f.homeDir, sourceApp: f.sourceApp });
  assert.equal(applyInstall(replan, { activate: false }).status, 'installed');
  assert.deepEqual(fs.readFileSync(settingsFile), original);
  await h.start('runtime'); await h.start('manager');
  const restored = await h.manager('/execution-settings'), saved = restored.tasks.find(value => value.id === task);
  assert.equal(restored.revision, edited.revision); assert.equal(saved.source, 'user'); assert.equal(saved.template_id, 'prd.create');
  assert.equal(saved.label, '고객 계약 PRD'); assert.equal(saved.instruction, instruction); assert.equal(saved.backend, 'claude');
  assert.equal(saved.backends.codex.model, 'gpt-5.5'); assert.equal(saved.backends.codex.effort, 'high');
  assert.equal(saved.backends.claude.model, 'claude-opus-4-6'); assert.equal(saved.backends.claude.effort, 'max');
  const catalog = await h.runtime('/catalog'), custom = catalog.jobs.find(job => job.id === task), template = catalog.jobs.find(job => job.id === 'prd.create');
  assert.equal(custom.source, 'user'); assert.equal(custom.template_id, template.id);
  assert.deepEqual(custom.input_schema, template.input_schema); assert.equal(custom.workflow, template.workflow);
  await assert.rejects(h.runtime('/runs', { method: 'POST', body: { task, input: { unexpected: true }, engine: 'fixture' } }), error => error.status === 400);
  const run = await h.finish(await h.runtime('/runs', { method: 'POST', body: { task, input: { requirements: '계약별 승인 기준을 정리한다.' }, engine: 'fixture' } }));
  assert.equal(run.status, 'completed', run.message); assert.ok(present(run.artifact.file));
  assert.ok(fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8').includes(instruction));
  assert.deepEqual(fs.readFileSync(settingsFile), original, 'startup, catalog access and execution preserve settings bytes');
  const base = `http://127.0.0.1:${readEndpoint(f.loc.data, 'manager').port}`;
  const page = await fetch(`${base}/`), icons = await fetch(`${base}/icons.css`);
  assert.equal(page.status, 200); assert.equal(icons.status, 200); assert.match(icons.headers.get('content-type'), /^text\/css/);
  const html = await page.text(); assert.match(html, /href="\/icons\.css"/);
  assert.match(html, /<svg[^>]+class="menu-icon"[^>]+data-icon="execution"/);
  assert.match(await icons.text(), /\.menu-icon/);
  await h.close(false); assert.equal(f.uninstall().status, 'uninstalled');
  assert.deepEqual(fs.readFileSync(settingsFile), original);
});
