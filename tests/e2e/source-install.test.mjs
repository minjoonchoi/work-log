import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installFromSource } from '../../scripts/install-source.mjs';
import { prepareInstall, applyInstall } from '../../scripts/install.mjs';
import { inventory, locations } from '../../scripts/install-state.mjs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { applyUninstall } from '../../scripts/uninstall.mjs';
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

test('an existing verified installation rebuilds and keeps an explicitly connected agent without connecting the other', t => {
  const f = setup(t), original = f.existing();
  connectAgent('claude', { homeDir: f.homeDir });
  const receipt = fs.readFileSync(f.loc.manifest, 'utf8'), configurations = Object.fromEntries(Object.entries(f.loc.configs).map(([engine, file]) => [engine, fs.readFileSync(file, 'utf8')]));
  const connections = getAgentConnections({ homeDir: f.homeDir });
  assert.deepEqual(connections.connections.map(({ state }) => state), ['connected', 'disconnected']);
  fs.writeFileSync(path.join(f.sourceApp, 'Contents/MacOS/WorkLog'), 'new GUI payload');
  const result = f.install();
  assert.equal(result.status, 'reinstalled'); assert.equal(result.installation_id, original.installation_id);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(f.loc.app, 'Contents/MacOS/WorkLog'), 'utf8'), 'new GUI payload');
  assert.equal(JSON.parse(fs.readFileSync(f.loc.manifest)).id, JSON.parse(receipt).id);
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

test('a rebuilt installation cleans identical legacy copies after replacement', t => {
  const f = setup(t); f.existing(); for (const app of f.legacy) f.duplicate(app);
  const result = f.install(); assert.equal(f.calls.length, 1);
  assert.equal(result.status, 'reinstalled'); assert.deepEqual([...result.build_cleanup.removed].sort(), [...f.legacy].sort());
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

for (const engines of [[], ['claude'], ['codex'], ['claude', 'codex']])
  test(`reinstall preserves data and exact connection ownership for ${engines.join('+') || 'disconnected agents'}; uninstall still works`, t => {
    const f = setup(t); f.existing();
    for (const engine of engines) connectAgent(engine, { homeDir: f.homeDir });
    const before = JSON.parse(fs.readFileSync(f.loc.manifest));
    const configs = Object.values(f.loc.configs).map(file => [file, fs.readFileSync(file)]);
    const links = before.links.map(link => ({ ...link, inode: fs.lstatSync(link.path).ino }));
    const db = new DatabaseSync(path.join(f.loc.data, 'memory.sqlite'));
    db.exec("CREATE TABLE history (body TEXT); INSERT INTO history VALUES ('업무 이력 보존')"); db.close();
    const files = { 'custom-tasks.json': '{"user":"type"}', 'execution-settings.json': '{"model":"custom"}',
      'integrations/atlassian.json': '{"ca_cert_path":"/company/ca.pem"}', 'runs/artifact.md': '# 결과' };
    for (const [name, value] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(f.loc.data, name)), { recursive: true }); fs.writeFileSync(path.join(f.loc.data, name), value);
    }
    const stored = Object.keys(files).concat('memory.sqlite').map(file => [path.join(f.loc.data, file), fs.readFileSync(path.join(f.loc.data, file))]);
    fs.writeFileSync(path.join(f.sourceApp, 'Contents/Resources/harness/src/hook.mjs'), '// updated hook implementation\n');
    fs.writeFileSync(path.join(f.sourceApp, 'Contents/Resources/harness/skills/work/SKILL.md'), '---\nname: work\n---\nUpdated instructions.\n');
    const result = f.install(); assert.equal(result.status, 'reinstalled'); assert.equal(result.installation_id, before.id);
    const after = JSON.parse(fs.readFileSync(f.loc.manifest));
    assert.equal(after.version, before.version); assert.ok(after.updated_at); assert.equal(after.replacement, undefined);
    assert.deepEqual(after.hooks, before.hooks); assert.deepEqual(after.links, before.links);
    for (const [file, contents] of [...configs, ...stored]) assert.deepEqual(fs.readFileSync(file), contents);
    for (const link of links) {
      assert.equal(fs.lstatSync(link.path).ino, link.inode);
      assert.match(fs.readFileSync(path.join(link.path, 'SKILL.md'), 'utf8'), /Updated instructions/);
    }
    assert.deepEqual(getAgentConnections({ homeDir: f.homeDir }).connections.map(row => row.state),
      ['claude', 'codex'].map(engine => engines.includes(engine) ? 'connected' : 'disconnected'));
    assert.equal(applyUninstall({ homeDir: f.homeDir, deactivate: false }).status, 'uninstalled');
    for (const [file, contents] of stored) assert.deepEqual(fs.readFileSync(file), contents);
  });

test('rebuild failure and unrecorded installed files preserve the previous app before any service stop', t => {
  const f = setup(t); f.existing(); const before = inventory(f.loc.app), receipt = fs.readFileSync(f.loc.manifest);
  assert.throws(() => f.install({ build: () => { throw new Error('build failed'); } }), /build failed/);
  assert.deepEqual(inventory(f.loc.app), before); assert.deepEqual(fs.readFileSync(f.loc.manifest), receipt);
  const extra = path.join(f.loc.app, 'user-note.txt'); fs.writeFileSync(extra, 'keep');
  assert.throws(() => f.install({ build: () => assert.fail('must validate ownership first') }), /수정·추가/);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'keep');
});

function services(f) {
  const receipt = JSON.parse(fs.readFileSync(f.loc.manifest));
  for (const file of receipt.files) file.activation = 'registered';
  fs.writeFileSync(f.loc.manifest, JSON.stringify(receipt));
  const registered = new Set(receipt.files.map(file => file.label)), calls = [];
  const state = { refuseStop: false, failStarts: 0, onStopped: null };
  const launchctl = (_, args) => {
    calls.push(args);
    const file = args[0] === 'bootstrap' ? receipt.files.find(file => file.path === args[2])
      : receipt.files.find(file => file.label === args[1].split('/').at(-1));
    if (args[0] === 'bootstrap') {
      if (state.failStarts > 0) { state.failStarts--; return { status: 5, stderr: 'fixture start failure' }; }
      registered.add(file.label); return { status: 0 };
    }
    if (!registered.has(file.label)) return { status: 113, stderr: 'Could not find service' };
    if (args[0] === 'bootout') {
      if (state.refuseStop) return { status: 5, stderr: 'fixture stop failure' };
      registered.delete(file.label); if (!registered.size) state.onStopped?.(); return { status: 0 };
    }
    return { status: 0, stdout: `program = ${file.argv[0]}\narguments = {\n${file.argv.join('\n')}\n}\n` };
  };
  return { state, registered, calls, launchctl };
}

test('reinstall restarts only its three owned services and refuses no-activate or failed stop without swapping files', t => {
  const f = setup(t); f.existing(); const service = services(f), before = inventory(f.loc.app);
  assert.throws(() => f.install({ launchctl: service.launchctl }), /종료 확인/);
  assert.deepEqual(inventory(f.loc.app), before); assert.equal(service.calls.length, 0);
  service.state.refuseStop = true;
  assert.throws(() => f.install({ activate: true, launchctl: service.launchctl }), /fixture stop failure/);
  assert.deepEqual(inventory(f.loc.app), before); assert.equal(service.registered.size, 3);
  service.state.refuseStop = false;
  fs.writeFileSync(path.join(f.sourceApp, 'Contents/MacOS/WorkLog'), 'v2');
  assert.equal(f.install({ activate: true, launchctl: service.launchctl }).status, 'reinstalled');
  assert.equal(service.registered.size, 3); assert.equal(fs.readFileSync(path.join(f.loc.app, 'Contents/MacOS/WorkLog'), 'utf8'), 'v2');
});

test('new service start failure restores previous files and services; failed rollback restart remains recoverable', t => {
  const f = setup(t); f.existing(); const service = services(f), before = inventory(f.loc.app);
  fs.writeFileSync(path.join(f.sourceApp, 'Contents/MacOS/WorkLog'), 'v2');
  service.state.failStarts = 1;
  assert.throws(() => f.install({ activate: true, launchctl: service.launchctl }), /이전 설치 파일을 복원/);
  assert.deepEqual(inventory(f.loc.app), before); assert.equal(service.registered.size, 3);
  service.state.failStarts = 2;
  assert.throws(() => f.install({ activate: true, launchctl: service.launchctl }), /복구 기록과 백업/);
  assert.deepEqual(inventory(f.loc.app), before);
  assert.equal(JSON.parse(fs.readFileSync(f.loc.manifest)).replacement.phase, 'restored');
  assert.equal(f.install({ activate: true, launchctl: service.launchctl }).status, 'reinstalled');
  assert.equal(service.registered.size, 3); assert.equal(JSON.parse(fs.readFileSync(f.loc.manifest)).replacement, undefined);
});

test('failure after service shutdown and before journaling restarts the unchanged installation', t => {
  const f = setup(t); f.existing(); const service = services(f), original = fs.renameSync;
  service.state.onStopped = () => {
    fs.renameSync = (source, target) => {
      if (target === f.loc.manifest && JSON.parse(fs.readFileSync(source)).state === 'reinstalling') throw new Error('journal write failed');
      return original(source, target);
    };
  };
  try { assert.throws(() => f.install({ activate: true, launchctl: service.launchctl }), /journal write failed/); }
  finally { fs.renameSync = original; }
  assert.equal(service.registered.size, 3); assert.equal(JSON.parse(fs.readFileSync(f.loc.manifest)).state, 'installed');
});

for (const boundary of ['backup-app', 'replace-app', 'backup-runtime', 'replace-runtime', 'cleanup', 'rollback-cleanup'])
  test(`process termination at ${boundary} recovers ownership and completes the next installation`, t => {
    const f = setup(t); f.existing(); connectAgent('codex', { homeDir: f.homeDir });
    const configs = fs.readFileSync(f.loc.configs.codex);
    fs.writeFileSync(path.join(f.sourceApp, 'Contents/MacOS/WorkLog'), 'new package');
    const script = `
      import fs from 'node:fs';
      import { installFromSource } from ${JSON.stringify(new URL('../../scripts/install-source.mjs', import.meta.url).href)};
      const rename = fs.renameSync, unlink = fs.unlinkSync;
      fs.renameSync = (source, target) => {
        if (${JSON.stringify(boundary)} === 'rollback-cleanup' && source.includes('.worklog-stage-') && source.endsWith('-1')) throw new Error('fixture replacement failure');
        const result = rename(source, target);
        if ((${JSON.stringify(boundary)} === 'backup-app' && target.includes('.worklog-reinstall-') && target.endsWith('-0'))
          || (${JSON.stringify(boundary)} === 'replace-app' && source.includes('.worklog-stage-') && source.endsWith('-0'))
          || (${JSON.stringify(boundary)} === 'backup-runtime' && target.includes('.worklog-reinstall-') && target.endsWith('-1'))
          || (${JSON.stringify(boundary)} === 'replace-runtime' && source.includes('.worklog-stage-') && source.endsWith('-1'))) process.exit(79);
        return result;
      };
      fs.unlinkSync = target => {
        const result = unlink(target);
        if (${JSON.stringify(boundary)} === 'cleanup' && target.includes('.worklog-reinstall-')) process.exit(79);
        if (${JSON.stringify(boundary)} === 'rollback-cleanup' && target.startsWith(${JSON.stringify(f.loc.app + path.sep)})) process.exit(79);
        return result;
      };
      installFromSource({homeDir:${JSON.stringify(f.homeDir)},projectRoot:${JSON.stringify(f.projectRoot)},sourceApp:${JSON.stringify(f.sourceApp)},activate:false});
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TMPDIR: f.dir }, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 79, child.stderr);
    assert.ok(JSON.parse(fs.readFileSync(f.loc.manifest)).replacement);
    assert.throws(() => applyUninstall({ homeDir: f.homeDir, deactivate: false }), /중단된 재설치/);
    assert.equal(f.install().status, 'reinstalled');
    assert.equal(fs.readFileSync(path.join(f.loc.app, 'Contents/MacOS/WorkLog'), 'utf8'), 'new package');
    assert.deepEqual(fs.readFileSync(f.loc.configs.codex), configs);
    assert.equal(getAgentConnections({ homeDir: f.homeDir }).connections[1].state, 'connected');
    assert.equal(JSON.parse(fs.readFileSync(f.loc.manifest)).replacement, undefined);
    for (const folder of [path.dirname(f.loc.app), path.join(f.loc.data, 'versions')])
      assert.ok(fs.readdirSync(folder).every(name => !name.startsWith('.worklog-')));
  });
