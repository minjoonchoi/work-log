import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareInstall, applyInstall } from '../../scripts/install.mjs';
import { applyUninstall } from '../../scripts/uninstall.mjs';
import { locations, skillLinks } from '../../scripts/install-state.mjs';
import { getAgentConnections, connectAgent, disconnectAgent, connectAgentComponent, disconnectAgentComponent } from '../../scripts/agent-connections.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-component-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const homeDir = path.join(dir, "User's Home"), sourceApp = path.join(dir, 'Source.app'), loc = locations(homeDir);
  const mac = path.join(sourceApp, 'Contents/MacOS'), bundle = path.join(sourceApp, 'Contents/Resources/harness');
  fs.mkdirSync(mac, { recursive: true });
  for (const name of ['node', 'WorkLog', 'WorkLogKeychain']) fs.writeFileSync(path.join(mac, name), 'fixture', { mode: 0o755 });
  for (const [name, value] of [['skills/work/SKILL.md', 'Fixture work skill.'], ['src/hook.mjs', '// fixture hook']]) {
    const file = path.join(bundle, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
  }
  const plan = prepareInstall({ homeDir, sourceApp, output: path.join(dir, 'plan') });
  assert.equal(applyInstall(plan, { activate: false }).status, 'installed');
  const options = { homeDir };
  const row = engine => getAgentConnections(options).connections.find(item => item.engine === engine);
  return { dir, homeDir, loc, plan, options, row,
    links: engine => skillLinks(loc, plan.skills, plan.runtimeRoot).filter(link => engine === 'claude'
      ? link.path.includes('/.claude/') : !link.path.includes('/.claude/')),
    connect: (engine, component) => connectAgentComponent(engine, component, options),
    disconnect: (engine, component) => disconnectAgentComponent(engine, component, options),
    receipt: () => JSON.parse(fs.readFileSync(loc.manifest, 'utf8')),
    uninstall: () => applyUninstall({ homeDir, deactivate: false }) };
}

for (const engine of ['claude', 'codex']) for (const first of ['tracking', 'harness']) {
  test(`${engine}: ${first} connects alone, survives reinstall, and disconnects without changing the other component`, t => {
    const f = fixture(t), second = first === 'tracking' ? 'harness' : 'tracking';
    f.connect(engine, first);
    assert.equal(f.row(engine)[first].state, 'connected'); assert.equal(f.row(engine)[second].state, 'disconnected');
    assert.equal(f.row(engine).state, f.row(engine).tracking.state);
    assert.equal(fs.existsSync(f.loc.configs[engine]), first === 'tracking');
    for (const link of f.links(engine)) assert.equal(fs.existsSync(link.path), first === 'harness');
    const before = f.receipt(), snapshot = f.row(engine);
    assert.equal(applyInstall(f.plan, { activate: false, reinstall: true }).status, 'reinstalled');
    assert.deepEqual(f.receipt().hooks, before.hooks); assert.deepEqual(f.receipt().links, before.links);
    assert.deepEqual(f.row(engine), snapshot, 'reinstall must retain the selected connection independently');
    f.connect(engine, second);
    assert.equal(f.row(engine).tracking.state, 'connected'); assert.equal(f.row(engine).harness.state, 'connected');
    const full = f.receipt(), config = fs.readFileSync(f.loc.configs[engine], 'utf8');
    const identities = full.links.map(link => ({ path: link.path, ino: fs.lstatSync(link.path).ino }));
    f.disconnect(engine, first);
    assert.equal(f.row(engine)[first].state, 'disconnected'); assert.equal(f.row(engine)[second].state, 'connected');
    if (first === 'harness') {
      assert.equal(fs.readFileSync(f.loc.configs[engine], 'utf8'), config);
      assert.deepEqual(f.receipt().hooks, full.hooks, 'hook timestamps and identities are unchanged');
    } else {
      assert.deepEqual(f.receipt().links, full.links);
      for (const link of identities) assert.equal(fs.lstatSync(link.path).ino, link.ino);
    }
    f.disconnect(engine, first);
    assert.equal(f.row(engine)[second].state, 'connected', 'scoped disconnect is idempotent');
    assert.equal(f.uninstall().status, 'uninstalled');
    for (const root of ['.claude', '.codex', '.agents']) assert.equal(fs.existsSync(path.join(f.homeDir, root)), false);
  });
}

test('tracking ignores foreign skill paths and harness ignores malformed hook settings', t => {
  const f = fixture(t), link = f.links('codex')[0];
  fs.mkdirSync(link.path, { recursive: true }); fs.writeFileSync(path.join(link.path, 'SKILL.md'), 'user-owned skill');
  f.connect('codex', 'tracking');
  const hooks = fs.readFileSync(f.loc.configs.codex, 'utf8');
  assert.throws(() => f.connect('codex', 'harness'), /덮어쓰지/);
  assert.equal(fs.readFileSync(f.loc.configs.codex, 'utf8'), hooks);
  assert.equal(f.row('codex').tracking.state, 'connected'); assert.equal(f.row('codex').harness.state, 'disconnected');
  fs.mkdirSync(path.dirname(f.loc.configs.claude), { recursive: true });
  fs.writeFileSync(f.loc.configs.claude, '{ malformed user setting');
  f.connect('claude', 'harness');
  assert.throws(() => f.connect('claude', 'tracking'), /JSON/);
  assert.equal(f.row('claude').harness.state, 'connected'); assert.equal(f.row('claude').tracking.state, 'disconnected');
  f.disconnect('claude', 'harness');
  assert.equal(fs.readFileSync(f.loc.configs.claude, 'utf8'), '{ malformed user setting');
  assert.equal(f.uninstall().status, 'uninstalled');
  assert.equal(fs.readFileSync(path.join(link.path, 'SKILL.md'), 'utf8'), 'user-owned skill');
});

test('an edited owned hook cannot block harness removal and is never silently replaced', t => {
  const f = fixture(t); connectAgent('codex', f.options);
  const original = fs.readFileSync(f.loc.configs.codex, 'utf8'), config = JSON.parse(original);
  config.hooks.Stop[0].hooks[0].timeout = 123;
  fs.writeFileSync(f.loc.configs.codex, JSON.stringify(config));
  assert.equal(f.row('codex').tracking.state, 'needs_attention'); assert.equal(f.row('codex').harness.state, 'connected');
  f.disconnect('codex', 'harness');
  assert.equal(f.row('codex').harness.state, 'disconnected');
  assert.equal(JSON.parse(fs.readFileSync(f.loc.configs.codex)).hooks.Stop[0].hooks[0].timeout, 123);
  f.connect('codex', 'harness'); const links = f.receipt().links;
  assert.throws(() => f.disconnect('codex', 'tracking'), /변경되었거나 중복/);
  assert.deepEqual(f.receipt().links, links); assert.equal(f.row('codex').harness.state, 'connected');
  fs.writeFileSync(f.loc.configs.codex, original);
  disconnectAgent('codex', f.options);
  assert.equal(f.row('codex').tracking.state, 'disconnected'); assert.equal(f.row('codex').harness.state, 'disconnected');
});

test('interrupted tracking intent recovers without rewriting connected skill links', t => {
  const f = fixture(t); f.connect('codex', 'harness');
  const links = f.receipt().links, original = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    if (to === f.loc.configs.codex) throw new Error('fixture config commit interrupted');
    return original(from, to, ...args);
  };
  try { assert.throws(() => f.connect('codex', 'tracking'), /fixture config/); }
  finally { fs.renameSync = original; }
  assert.equal(f.row('codex').tracking.state, 'needs_attention'); assert.equal(f.row('codex').harness.state, 'connected');
  assert.deepEqual(f.receipt().links, links);
  f.connect('codex', 'tracking');
  assert.equal(f.row('codex').tracking.state, 'connected'); assert.deepEqual(f.receipt().links, links);
  for (const link of links) assert.equal(fs.lstatSync(link.path).ino, link.identity.ino);
  assert.equal(f.uninstall().status, 'uninstalled');
});

test('interrupted multi-link harness intent recovers without changing connected hooks', t => {
  const f = fixture(t); f.connect('codex', 'tracking');
  const hooks = fs.readFileSync(f.loc.configs.codex, 'utf8'), record = f.receipt().hooks;
  const original = fs.symlinkSync, links = f.links('codex');
  fs.symlinkSync = (target, file, ...args) => {
    if (file === links[1].path) throw new Error('fixture second link interrupted');
    return original(target, file, ...args);
  };
  try { assert.throws(() => f.connect('codex', 'harness'), /fixture second link/); }
  finally { fs.symlinkSync = original; }
  assert.equal(f.row('codex').harness.state, 'needs_attention'); assert.equal(f.row('codex').tracking.state, 'connected');
  assert.equal(f.receipt().links[0].pending, false); assert.equal(f.receipt().links[1].pending, true);
  f.connect('codex', 'harness');
  assert.equal(f.row('codex').harness.state, 'connected');
  assert.equal(fs.readFileSync(f.loc.configs.codex, 'utf8'), hooks); assert.deepEqual(f.receipt().hooks, record);
  assert.equal(f.uninstall().status, 'uninstalled');
});

test('a concurrent foreign link remains unowned while tracking can disconnect independently', t => {
  const f = fixture(t); f.connect('codex', 'tracking');
  const original = fs.symlinkSync, link = f.links('codex')[0];
  fs.symlinkSync = (target, file, ...args) => {
    if (file === link.path) original(target, file, ...args);
    return original(target, file, ...args);
  };
  try { assert.throws(() => f.connect('codex', 'harness'), error => error.code === 'EEXIST'); }
  finally { fs.symlinkSync = original; }
  const inode = fs.lstatSync(link.path).ino;
  assert.equal(f.row('codex').tracking.state, 'connected'); assert.equal(f.row('codex').harness.state, 'needs_attention');
  f.disconnect('codex', 'tracking');
  assert.equal(f.row('codex').tracking.state, 'disconnected');
  assert.throws(() => f.disconnect('codex', 'harness'), /소유를 확인/);
  assert.equal(fs.lstatSync(link.path).ino, inode);
  assert.equal(f.uninstall().status, 'needs_attention'); assert.equal(fs.lstatSync(link.path).ino, inode);
  fs.unlinkSync(link.path); assert.equal(f.uninstall().status, 'uninstalled');
});

for (const component of ['tracking', 'harness']) test(`process exit during ${component} connection recovers its journal and stale lock independently`, t => {
  const f = fixture(t), other = component === 'tracking' ? 'harness' : 'tracking';
  f.connect('codex', other);
  const before = f.receipt(), config = fs.existsSync(f.loc.configs.codex) ? fs.readFileSync(f.loc.configs.codex, 'utf8') : null;
  const target = component === 'tracking' ? f.loc.configs.codex : f.links('codex')[1].path;
  const script = `
    import fs from 'node:fs';
    import { connectAgentComponent } from ${JSON.stringify(new URL('../../scripts/agent-connections.mjs', import.meta.url).href)};
    const method = ${JSON.stringify(component === 'tracking' ? 'renameSync' : 'symlinkSync')};
    const original = fs[method];
    fs[method] = (source, target, ...options) => {
      if (target === ${JSON.stringify(target)}) process.exit(82);
      return original(source, target, ...options);
    };
    connectAgentComponent('codex', ${JSON.stringify(component)}, { homeDir: ${JSON.stringify(f.homeDir)} });
  `;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(crashed.status, 82, crashed.stderr);
  assert.ok(fs.existsSync(path.join(f.loc.data, 'installation.lock')));
  assert.equal(f.row('codex')[component].state, 'needs_attention'); assert.equal(f.row('codex')[other].state, 'connected');
  f.connect('codex', component);
  assert.equal(f.row('codex')[component].state, 'connected'); assert.equal(f.row('codex')[other].state, 'connected');
  assert.equal(fs.existsSync(path.join(f.loc.data, 'installation.lock')), false);
  if (component === 'tracking') {
    assert.deepEqual(f.receipt().links, before.links);
    for (const link of before.links) assert.equal(fs.lstatSync(link.path).ino, link.identity.ino);
  } else {
    assert.deepEqual(f.receipt().hooks, before.hooks);
    assert.equal(fs.readFileSync(f.loc.configs.codex, 'utf8'), config);
  }
  assert.equal(f.uninstall().status, 'uninstalled');
});
