import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareInstall, applyInstall } from '../../scripts/install.mjs';
import { applyUninstall } from '../../scripts/uninstall.mjs';
import { locations, quote } from '../../scripts/install-state.mjs';
import { ROOT, readEndpoint } from '../../src/shared.mjs';
import { Harness, eventually } from '../helpers.mjs';

async function installedManager(t, { existing = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-agent-api-'));
  const homeDir = path.join(temp, "User's Home"), app = path.join(temp, 'Source.app'), loc = locations(homeDir);
  const mac = path.join(app, 'Contents/MacOS'), bundled = path.join(app, 'Contents/Resources/harness');
  fs.mkdirSync(mac, { recursive: true }); fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(mac, 'node'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  for (const name of ['WorkLog', 'WorkLogKeychain']) fs.writeFileSync(path.join(mac, name), 'fixture');
  for (const folder of ['src', 'bin', 'harness', 'contracts', 'apps/web', 'skills', 'scripts'])
    fs.cpSync(path.join(ROOT, folder), path.join(bundled, folder), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(bundled, 'package.json'));
  for (const pkg of ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string'])
    fs.cpSync(path.join(ROOT, 'node_modules', pkg), path.join(bundled, 'node_modules', pkg), { recursive: true });
  const original = '{\n  "theme": "user-owned", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "company-hook"}]}]}\n}';
  if (existing) for (const file of Object.values(loc.configs)) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, original);
  }
  const plan = prepareInstall({ homeDir, sourceApp: app, output: path.join(temp, 'plan') });
  assert.equal(applyInstall(plan, { activate: false }).status, 'installed');
  if (existing) for (const file of Object.values(loc.configs)) assert.equal(fs.readFileSync(file, 'utf8'), original);
  const h = new Harness(loc.data); h.env = { HARNESS_TEST_HOME: homeDir };
  h.serviceRoot = path.join(plan.runtimeRoot, 'harness'); h.executable = path.join(plan.runtimeRoot, 'node');
  t.after(async () => { await h.close(false); fs.rmSync(temp, { recursive: true, force: true }); });
  await h.start('manager');
  return { h, homeDir, loc, plan, original };
}
const state = (snapshot, engine) => snapshot.connections.find(c => c.engine === engine).state;

test('installed manager explicitly connects each agent, records real hook input/output and disconnects without losing history', async t => {
  const f = await installedManager(t), { h, loc } = f;
  const initial = await h.manager('/agent-connections');
  assert.equal(initial.available, true); assert.ok(initial.connections.every(c => c.state === 'disconnected'));
  const endpoint = readEndpoint(h.dir, 'manager');
  assert.equal((await fetch(`http://127.0.0.1:${endpoint.port}/api/agent-connections/codex`, { method: 'POST' })).status, 401);
  await assert.rejects(h.manager('/agent-connections/codex', { method: 'POST', body: { homeDir: '/another/home' } }), /별도의 경로/);
  let result = await h.manager('/agent-connections/codex', { method: 'POST', body: {} });
  assert.equal(state(result, 'codex'), 'connected'); assert.equal(state(result, 'claude'), 'disconnected');
  assert.equal(result.connections.find(c => c.engine === 'codex').collection.state, 'awaiting_hook');
  assert.equal(fs.readFileSync(loc.configs.claude, 'utf8'), f.original);
  const first = fs.readFileSync(loc.configs.codex, 'utf8');
  await h.manager('/agent-connections/codex', { method: 'POST', body: {} });
  assert.equal(fs.readFileSync(loc.configs.codex, 'utf8'), first, 'repeated connect must not duplicate hooks');
  result = await h.manager('/agent-connections/claude', { method: 'POST', body: {} });
  assert.ok(result.connections.every(c => c.state === 'connected'));
  for (const engine of ['codex', 'claude']) {
    const config = JSON.parse(fs.readFileSync(loc.configs[engine], 'utf8'));
    for (const [event, content] of [['UserPromptSubmit', { prompt: `${engine} 연결 후 입력` }], ['Stop', { last_assistant_message: `${engine} 연결 후 응답` }]]) {
      const command = config.hooks[event].flatMap(group => group.hooks).find(hook => hook.command.includes('WORKLOG_INSTALL_ID')).command;
      const run = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ hook_event_name: event, session_id: `${engine}-connected`, turn_id: 't1', ...content }),
        encoding: 'utf8', env: { ...process.env, HOME: f.homeDir, HARNESS_WORKER: '' } });
      assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, '');
    }
  }
  const items = await eventually(() => h.manager('/items'), items => items.length === 2 && items.every(item => item.session_count === 1));
  for (const item of items) {
    const detail = await eventually(() => h.manager(`/items/${item.id}`), detail => detail.sessions[0]?.pending === false);
    assert.equal(detail.sessions[0].pending, false);
  }
  const observed = await h.manager('/agent-connections');
  assert.ok(observed.connections.every(c => c.collection.state === 'observed' && c.collection.last_event_kind === 'output'));
  // These agent sessions existed before WorkLog was connected: no SessionStart was delivered.
  for (const item of items) assert.ok(!(await h.manager(`/items/${item.id}`)).events.some(e => e.kind === 'session.started'));
  result = await h.manager('/agent-connections/codex', { method: 'DELETE', body: {} });
  assert.equal(state(result, 'codex'), 'disconnected'); assert.equal(state(result, 'claude'), 'connected');
  assert.equal(result.connections.find(c => c.engine === 'codex').collection.state, 'inactive');
  assert.deepEqual(JSON.parse(fs.readFileSync(loc.configs.codex, 'utf8')), JSON.parse(f.original));
  assert.equal(fs.existsSync(path.join(f.homeDir, '.agents/skills/work')), false);
  assert.equal((await h.manager('/items')).length, 2);
  await h.manager('/agent-connections/codex', { method: 'DELETE', body: {} });
  const reconnected = await h.manager('/agent-connections/codex', { method: 'POST', body: {} });
  assert.equal(reconnected.connections.find(c => c.engine === 'codex').collection.state, 'awaiting_hook', 'old hook receipts must not prove the new connection');
  await h.close(false);
  assert.equal(applyUninstall({ homeDir: f.homeDir, deactivate: false }).status, 'uninstalled');
  for (const file of Object.values(loc.configs)) assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(f.original));
  assert.ok(fs.existsSync(path.join(loc.data, 'memory.sqlite')));
  assert.equal(fs.existsSync(loc.app), false); assert.equal(fs.existsSync(f.plan.runtimeRoot), false);
});

test('GUI connections on a fresh home remove newly created settings and link directories on uninstall', async t => {
  const f = await installedManager(t, { existing: false });
  for (const root of ['.claude', '.codex', '.agents']) assert.equal(fs.existsSync(path.join(f.homeDir, root)), false);
  for (const engine of ['claude', 'codex']) await f.h.manager(`/agent-connections/${engine}`, { method: 'POST', body: {} });
  await f.h.close(false);
  const result = applyUninstall({ homeDir: f.homeDir, deactivate: false });
  assert.equal(result.status, 'uninstalled', JSON.stringify(result));
  for (const root of ['.claude', '.codex', '.agents']) assert.equal(fs.existsSync(path.join(f.homeDir, root)), false, root);
});

test('a development or isolated manager never edits the host agent configuration', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  assert.equal((await h.manager('/agent-connections')).available, false);
  await assert.rejects(h.manager('/agent-connections/codex', { method: 'POST', body: {} }), /설치된 WorkLog/);
});
