import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareInstall, applyInstall } from '../../scripts/install.mjs';
import { prepareUninstall, applyUninstall } from '../../scripts/uninstall.mjs';
import { controlServices } from '../../scripts/service-control.mjs';
import { quote, locations } from '../../scripts/install-state.mjs';
import { ROOT } from '../../src/shared.mjs';
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
  if (real) {
    for (const name of ['src', 'bin', 'harness', 'contracts', 'apps/web']) fs.cpSync(path.join(ROOT, name), path.join(bundle, name), { recursive: true });
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
    install: options => applyInstall(plan, { activate: false, ...options }),
    uninstall: options => applyUninstall({ homeDir, deactivate: false, ...options }),
    read: engine => JSON.parse(fs.readFileSync(loc.configs[engine], 'utf8')),
    write: (engine, value) => fs.writeFileSync(loc.configs[engine], JSON.stringify(value)) };
}
const present = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

test('install plan, owned installation, and reinstall preserve user instructions and register one request skill without duplicate hooks', t => {
  const f = setup(t);
  assert.equal(present(f.plan.targetApp), false); assert.deepEqual(f.read('codex'), f.config);
  const result = f.install(); assert.equal(result.activated, false);
  assert.equal(f.plan.skills.join(), 'work');
  for (const engine of ['codex', 'claude']) {
    const after = f.read(engine);
    assert.equal(after.model, 'preserve-me'); assert.equal(after.disableAllHooks, true); assert.deepEqual(after.hooks.Stop[0], f.config.hooks.Stop[0]);
    assert.equal(after.hooks.Stop.length, 2); assert.equal(after.hooks.UserPromptSubmit.length, 1);
    assert.match(after.hooks.Stop[1].hooks[0].command, new RegExp(result.installation_id));
  }
  assert.equal(fs.readFileSync(path.join(f.plan.runtimeRoot, 'harness/immutable.txt'), 'utf8'), 'v1');
  assert.equal(f.plan.files.length, 3); assert.equal(f.plan.links.length, 3);
  for (const link of f.plan.links) {
    assert.equal(fs.readlinkSync(link.target), link.source);
    assert.match(fs.readFileSync(path.join(link.target, 'SKILL.md'), 'utf8'), /name: work/);
  }
  assert.equal(f.plan.hooks.claude.hooks.PostToolUseFailure.length, 1);
  assert.equal(f.plan.hooks.codex.hooks.PostToolUseFailure, undefined);
  assert.ok(f.plan.files.some(file => file.content.includes('<string>--background</string>')));
  assert.equal(f.install().status, 'already_installed'); assert.equal(f.read('codex').hooks.Stop.length, 2);
  assert.equal(fs.readFileSync(path.join(f.homeDir, '.codex/AGENTS.md'), 'utf8'), 'User owned instructions\n');
});

test('uninstall removes only owned hooks, links and binaries; later user settings, co-located hooks and SQLite data survive', t => {
  const f = setup(t); f.install();
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
  for (const link of f.plan.links) assert.equal(present(link.target), false);
  assert.equal(present(f.loc.app), false); assert.equal(present(f.plan.runtimeRoot), false);
  assert.equal(fs.readFileSync(db, 'utf8'), 'persistent-user-data'); assert.ok(present(path.join(externalSkill, 'SKILL.md')));
  assert.equal(fs.readFileSync(path.join(f.homeDir, '.claude/CLAUDE.md'), 'utf8'), 'User owned instructions\n');
  fs.mkdirSync(f.loc.app); fs.writeFileSync(path.join(f.loc.app, 'new-owner.txt'), 'keep new app');
  assert.equal(f.uninstall().status, 'uninstalled'); assert.equal(fs.readFileSync(path.join(f.loc.app, 'new-owner.txt'), 'utf8'), 'keep new app');
});

for (const change of ['timeout', 'duplicate', 'remove-marker', 'malformed']) test(`uninstall preserves ${change} hook edits and dependent runtime, then safely resumes`, t => {
  const f = setup(t); f.install(); const original = fs.readFileSync(f.loc.configs.claude, 'utf8');
  const config = f.read('claude');
  if (change === 'timeout') config.hooks.Stop[1].hooks[0].timeout = 8;
  if (change === 'duplicate') config.hooks.Stop.push(structuredClone(config.hooks.Stop[1]));
  if (change === 'remove-marker') config.hooks.Stop[1].hooks[0].command = config.hooks.Stop[1].hooks[0].command.replace(/^WORKLOG_INSTALL_ID='[^']+' /, '');
  if (change === 'malformed') fs.writeFileSync(f.loc.configs.claude, '{bad json'); else f.write('claude', config);
  const before = fs.readFileSync(f.loc.configs.claude, 'utf8');
  const result = f.uninstall(); assert.equal(result.status, 'needs_attention'); assert.ok(present(f.plan.runtimeRoot));
  if (change === 'malformed') assert.equal(fs.readFileSync(f.loc.configs.claude, 'utf8'), before);
  else assert.ok(f.read('claude').hooks.Stop.some(g => g.hooks.some(h => h.command.includes('src/hook.mjs'))));
  fs.writeFileSync(f.loc.configs.claude, original);
  assert.equal(f.uninstall().status, 'uninstalled');
});

for (const kind of ['different-link', 'regular-file', 'directory']) test(`uninstall preserves a skill path replaced with a ${kind}`, t => {
  const f = setup(t); f.install(); const link = f.plan.links[0].target; fs.unlinkSync(link);
  const external = path.join(f.dir, 'user-owned'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'keep.txt'), 'keep');
  if (kind === 'different-link') fs.symlinkSync(external, link);
  if (kind === 'regular-file') fs.writeFileSync(link, 'replacement');
  if (kind === 'directory') { fs.mkdirSync(link); fs.writeFileSync(path.join(link, 'own.txt'), 'replacement'); }
  assert.equal(f.uninstall().status, 'needs_attention'); assert.ok(present(link));
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'keep');
});

test('pre-existing or dangling instruction symlink blocks installation without changing user hooks', t => {
  const f = setup(t); const link = f.plan.links[0].target;
  fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(path.join(f.dir, 'missing-user-target'), link);
  assert.throws(() => f.install(), /덮어쓰지/); assert.deepEqual(f.read('claude'), f.config);
  assert.equal(present(f.loc.app), false); assert.equal(fs.readlinkSync(link), path.join(f.dir, 'missing-user-target'));
});

test('uninstall never follows a replaced config file or parent directory symlink', t => {
  const f = setup(t); f.install();
  const outside = path.join(f.dir, 'outside.json'); fs.writeFileSync(outside, JSON.stringify({ keep: true }));
  fs.unlinkSync(f.loc.configs.claude); fs.symlinkSync(outside, f.loc.configs.claude);
  const skills = path.dirname(f.plan.links[1].target), originalSkills = `${skills}-moved`;
  fs.renameSync(skills, originalSkills); fs.symlinkSync(originalSkills, skills);
  assert.equal(f.uninstall().status, 'needs_attention');
  assert.equal(fs.readFileSync(outside, 'utf8'), JSON.stringify({ keep: true }));
  assert.ok(present(path.join(originalSkills, 'work')));
});

test('changed app files and new runtime files preserve complete installation trees', t => {
  const f = setup(t); f.install();
  const changed = path.join(f.loc.app, 'Contents/MacOS/WorkLog'); fs.writeFileSync(changed, 'user-replaced-app');
  const added = path.join(f.plan.runtimeRoot, 'new-user-file.txt'); fs.writeFileSync(added, 'keep');
  assert.equal(f.uninstall().status, 'needs_attention');
  assert.equal(fs.readFileSync(changed, 'utf8'), 'user-replaced-app'); assert.equal(fs.readFileSync(added, 'utf8'), 'keep');
  assert.ok(present(path.join(f.plan.runtimeRoot, 'node')));
});

test('missing ownership receipt and path-tampered receipt never authorize deleting similarly named resources', t => {
  const f = setup(t); f.install(); const original = fs.readFileSync(f.loc.manifest, 'utf8'); fs.unlinkSync(f.loc.manifest);
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
  const f = setup(t); f.install();
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
  const f = setup(t); f.install(); const service = serviceFixture(f, { delayed: 2 });
  const result = f.uninstall({ deactivate: true, launchctl: service.launchctl });
  assert.equal(result.status, 'uninstalled', JSON.stringify(result));
  assert.equal(service.calls.filter(args => args[0] === 'bootout').length, 3);
  assert.equal(service.registered.size, 0); assert.equal(present(f.loc.app), false);
  assert.deepEqual(f.read('codex'), f.config);
});

test('uninstall timeout preserves files and hooks until a later confirmed service stop', t => {
  const f = setup(t); f.install(); const service = serviceFixture(f, { neverStops: true });
  const result = f.uninstall({ deactivate: true, launchctl: service.launchctl, stopTimeoutMs: 1 });
  assert.equal(result.status, 'needs_attention'); assert.deepEqual(result.removed, []);
  assert.ok(result.preserved.every(row => row.reason.includes('대기 시간이 초과')));
  assert.ok(present(f.loc.app)); assert.equal(f.read('codex').hooks.Stop.length, 2);
  service.registered.clear();
  assert.equal(f.uninstall({ deactivate: true, launchctl: service.launchctl }).status, 'uninstalled');
});

test('GUI quit preserves user work and runtime while stopping the manager; reopening cancels draining without duplicate services', async t => {
  const f = setup(t); f.install(); const service = serviceFixture(f);
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
  const f = setup(t); f.install(); const service = serviceFixture(f, { delayed: 1 });
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
  const f = setup(t); f.install(); const service = serviceFixture(f); let attempts = 0;
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
  const install = spawnSync('make', ['-o', 'build', 'install', `NODE=${process.execPath}`,
    `INSTALL_ARGS=--home-dir ${quote(f.homeDir)} --source-app ${quote(f.sourceApp)} --no-activate --output ${quote(path.join(f.dir, 'make-plan'))}`], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(install.status, 0, install.stderr); assert.ok(present(f.loc.app));
  const command = ['uninstall', `NODE=${process.execPath}`, `UNINSTALL_ARGS=--home-dir ${quote(f.homeDir)} --no-deactivate`];
  const removed = spawnSync('make', command, { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(removed.status, 0, removed.stderr); assert.equal(present(f.loc.app), false);
  assert.equal(spawnSync('make', command, { cwd: ROOT, encoding: 'utf8', timeout: 15000 }).status, 0);
  assert.deepEqual(f.read('codex'), f.config);
});

test('concurrent install/uninstall is blocked by the same live-owner lock without changing hooks', t => {
  const f = setup(t); f.install();
  const lock = path.join(f.loc.data, 'installation.lock'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'other-operation' }));
  assert.throws(() => f.install(), /이미 실행 중/); assert.throws(() => f.uninstall(), /이미 실행 중/);
  assert.equal(f.read('codex').hooks.Stop.length, 2); assert.ok(present(f.loc.app));
  fs.unlinkSync(lock); assert.equal(f.uninstall().status, 'uninstalled');
});

test('installed request skill delegates natural language to classification and a Codex protocol worker, and hooks feed the work item before uninstall', async t => {
  const f = setup(t, true); f.install();
  const h = new Harness(f.loc.data); h.executable = path.join(f.plan.runtimeRoot, 'node'); h.serviceRoot = path.join(f.plan.runtimeRoot, 'harness');
  h.testMode = false; h.env = { HARNESS_CODEX_BIN: path.join(ROOT, 'tests/fixtures/cli-double.mjs') };
  t.after(() => h.close(false)); await h.start('runtime'); await h.start('manager');
  const requestFile = path.join(f.dir, 'request.json'); fs.writeFileSync(requestFile, JSON.stringify({ prompt: '초대 기능 PRD를 작성해 주세요.' }));
  const helper = path.join(f.plan.links[0].target, 'scripts/harness');
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
