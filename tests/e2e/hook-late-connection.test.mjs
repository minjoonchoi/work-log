import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Harness, eventually } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

const spool = h => fs.readdirSync(path.join(h.dir, 'spool')).filter(file => file.endsWith('.json'))
  .map(file => ({ file, event: JSON.parse(fs.readFileSync(path.join(h.dir, 'spool', file), 'utf8')) }));
const runHook = (h, engine, event, extra = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/hook.mjs'), engine], {
    env: { ...process.env, HARNESS_DATA_DIR: h.dir, ...extra }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.once('error', reject); child.once('exit', code => code === 0 && !stdout ? resolve() : reject(new Error(`${code}: ${stdout} ${stderr}`)));
  child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
});
async function setup(t, start = true) {
  const h = new Harness(); t.after(() => h.close());
  if (start) await h.start('manager');
  return h;
}

test('connecting mid-session captures input and Stop without SessionStart for native and fallback turns', async t => {
  const h = await setup(t);
  for (const [index, engine, inputTurn, outputTurn] of [
    [0, 'codex', 'native-turn', 'native-turn'], [1, 'claude', null, null],
    [2, 'codex', 'input-native', null], [3, 'codex', null, 'output-native']
  ]) {
    const session_id = `late-connected-${index}`;
    h.hook(engine, { session_id, event_id: 'input-1', hook_event_name: 'UserPromptSubmit', turn_id: inputTurn, prompt: `중간 연결 요청 ${index}` });
    h.hook(engine, { session_id, event_id: 'output-1', hook_event_name: 'Stop', turn_id: outputTurn, last_assistant_message: '완료된 응답' });
  }
  await eventually(() => h.manager('/health'), value => value.events === 8);
  const items = await h.manager('/items'); assert.equal(items.length, 4);
  for (const item of items) {
    const detail = await h.manager(`/items/${item.id}`);
    assert.equal(detail.sessions.length, 1); assert.equal(detail.sessions[0].pending, false);
    const input = detail.events.find(event => event.kind === 'input'), output = detail.events.find(event => event.kind === 'output');
    assert.equal(output.resolution, 'matched'); assert.equal(output.turn_id, input.turn_id);
    assert.equal(output.source, 'system_hook'); assert.equal(output.time_source, 'hook_observed');
    assert.equal(detail.events.some(event => event.kind === 'session.started'), false);
    const history = await h.manager(`/items/${item.id}/history?session_id=${detail.sessions[0].id}`);
    assert.equal(history.records.length, 2);
  }
});

test('first delivered Stop and SessionStart wait for input; replay preserves the first observation', async t => {
  const h = await setup(t, false), raw = { session_id: 'already-running', event_id: 'first-stop', hook_event_name: 'Stop', last_assistant_message: '입력을 관측하지 못한 응답' };
  h.hook('codex', raw);
  const first = spool(h)[0].event;
  await h.start('manager');
  await eventually(() => h.manager('/health'), value => value.events === 1);
  assert.deepEqual(await h.manager('/items'), []);
  h.hook('codex', raw);
  h.hook('codex', { session_id: raw.session_id, event_id: 'late-start', hook_event_name: 'SessionStart' });
  await eventually(() => h.manager('/health'), value => value.events === 2);
  assert.deepEqual(await h.manager('/items'), []);
  h.hook('codex', { session_id: raw.session_id, event_id: 'first-input', hook_event_name: 'UserPromptSubmit', prompt: '수집 시작 후 첫 요청' });
  await eventually(() => h.manager('/health'), value => value.events === 3);
  const items = await h.manager('/items'); assert.equal(items.length, 1); const [item] = items;
  const detail = await h.manager(`/items/${item.id}`), output = detail.events.find(event => event.kind === 'output');
  assert.equal(output.event_at, first.event_at); assert.equal(output.observed_at, first.observed_at);
  assert.equal(output.resolution, 'unresolved'); assert.equal(output.turn_id, null);
});

for (const engine of ['codex', 'claude']) test(`${engine}: opening and resuming waits for first prompt across service restart`, async t => {
  const h = await setup(t), session_id = `${engine}-opened-only`;
  const start = { session_id, event_id: 'start', hook_event_name: 'SessionStart' };
  h.hook(engine, start);
  h.hook(engine, { session_id, event_id: 'tool', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
  h.hook(engine, { session_id, event_id: 'end', hook_event_name: 'SessionEnd' });
  await eventually(() => h.manager('/health'), value => value.events === 3);
  assert.deepEqual(await h.manager('/items'), []);
  await h.stop('manager'); await h.start('manager');
  h.hook(engine, start);
  h.hook(engine, { session_id, event_id: 'resume', hook_event_name: 'SessionStart', source: 'resume' });
  await eventually(() => h.manager('/health'), value => value.events === 4);
  assert.deepEqual(await h.manager('/items'), []);
  h.hook(engine, { session_id, event_id: 'input', hook_event_name: 'UserPromptSubmit', turn_id: 'one', prompt: '첫 사용자 요청' });
  h.hook(engine, { session_id, event_id: 'output', hook_event_name: 'Stop', turn_id: 'one', last_assistant_message: '첫 응답' });
  await eventually(() => h.manager('/health'), value => value.events === 6);
  const [item] = await h.manager('/items'), detail = await h.manager(`/items/${item.id}`);
  assert.equal((await h.manager('/items')).length, 1); assert.equal(item.title, '첫 사용자 요청');
  assert.equal(detail.agents.length, 1); assert.equal(detail.sessions.length, 1); assert.equal(detail.events.length, 6);
  assert.equal(detail.sessions[0].start_at, detail.events.find(event => event.kind === 'input').event_at);
  assert.equal(item.created_at, detail.sessions[0].start_at);
  assert.equal(detail.events.filter(event => event.kind === 'session.started').length, 2);
  h.hook(engine, { session_id, event_id: 'compact', hook_event_name: 'SessionStart', source: 'compact' });
  h.hook(engine, { session_id, event_id: 'next-input', hook_event_name: 'UserPromptSubmit', turn_id: 'two', prompt: '같은 업무 이어서' });
  await eventually(() => h.manager('/health'), value => value.events === 8);
  assert.deepEqual((await h.manager('/items')).map(row => row.id), [item.id]);
  assert.equal((await h.manager(`/items/${item.id}`)).sessions.length, 1);
});

test('offline receipts survive manager restart and resolved fallback replay without conflicts', async t => {
  const h = await setup(t, false), input = { session_id: 'offline-late', event_id: 'input', hook_event_name: 'UserPromptSubmit', prompt: '오프라인 요청' };
  const output = { session_id: input.session_id, event_id: 'output', hook_event_name: 'Stop', last_assistant_message: '오프라인 응답' };
  h.hook('claude', input); h.hook('claude', output);
  const original = spool(h).map(row => row.event);
  assert.equal(original.find(event => event.kind === 'output').turn_id, null);
  assert.equal(fs.existsSync(path.join(h.dir, 'hook-state.sqlite')), false);
  await h.start('manager'); await eventually(() => h.manager('/health'), value => value.events === 2);
  const [item] = await h.manager('/items'), detail = await h.manager(`/items/${item.id}`);
  assert.equal(detail.sessions[0].pending, false);
  await h.stop('manager'); h.hook('claude', input); h.hook('claude', output);
  assert.deepEqual(spool(h).map(row => row.event).sort((a, b) => a.id.localeCompare(b.id)), original.sort((a, b) => a.id.localeCompare(b.id)));
  await h.start('manager'); await eventually(() => fs.readdirSync(path.join(h.dir, 'spool')).length, size => size === 0);
  assert.equal((await h.manager('/health')).events, 2);
  assert.equal(fs.existsSync(path.join(h.dir, 'quarantine')), false);
});

test('parallel hooks ignore a held legacy SQLite write lock and duplicate deliveries publish one complete receipt', async t => {
  const h = await setup(t, false), lock = new DatabaseSync(path.join(h.dir, 'hook-state.sqlite'));
  lock.exec('CREATE TABLE turns(agent TEXT PRIMARY KEY,turn_id TEXT,ambiguous INTEGER); BEGIN EXCLUSIVE');
  t.after(() => { lock.exec('ROLLBACK'); lock.close(); });
  const source = { session_id: 'parallel-retry', event_id: 'input', hook_event_name: 'UserPromptSubmit', prompt: '동일 원본 재전송' };
  const start = performance.now();
  await Promise.all(Array.from({ length: 12 }, () => runHook(h, 'codex', source)));
  assert.ok(performance.now() - start < 2000, 'hooks must finish within their two-second timeout even while the old database is locked');
  assert.equal(spool(h).length, 1); assert.equal(fs.existsSync(path.join(h.dir, 'hook-error.json')), false);
  await Promise.all(Array.from({ length: 12 }, (_, index) => runHook(h, 'codex', {
    ...source, session_id: `parallel-${index}`, event_id: `independent-${index}`
  })));
  assert.equal(spool(h).length, 13);
  assert.equal(fs.readdirSync(path.join(h.dir, 'hook-receipts')).filter(file => file.endsWith('.tmp')).length, 0);
  await h.start('manager'); await eventually(() => h.manager('/health'), value => value.events === 13);
  assert.equal((await h.manager('/items')).length, 13);
});

test('late input restores fallback association and later overlapping input revokes it without rewriting source provenance', async t => {
  const h = await setup(t, false);
  h.hook('claude', { session_id: 'late-order', event_id: 'input', hook_event_name: 'UserPromptSubmit', prompt: '첫 입력' });
  h.hook('claude', { session_id: 'late-order', event_id: 'output', hook_event_name: 'Stop', last_assistant_message: '관측된 출력' });
  const originals = spool(h), input = originals.find(row => row.event.kind === 'input').event;
  const output = originals.find(row => row.event.kind === 'output').event;
  for (const row of originals) fs.unlinkSync(path.join(h.dir, 'spool', row.file));
  await h.start('manager'); await h.ingest([output]);
  assert.deepEqual(await h.manager('/items'), []);
  await h.ingest([input]);
  const [item] = await h.manager('/items');
  const linked = await h.manager(`/items/${item.id}`), before = await h.manager(`/items/${item.id}/history?session_id=${linked.sessions[0].id}`);
  assert.equal(linked.events.find(event => event.kind === 'output').resolution, 'matched');
  const middle = new Date((Date.parse(input.event_at) + Date.parse(output.event_at)) / 2).toISOString();
  await h.ingest([{ ...input, id: 'late-second-input', turn_id: 'local-turn-second', event_at: middle, observed_at: middle }]);
  const changed = await h.manager(`/items/${item.id}`), changedOutput = changed.events.find(event => event.kind === 'output');
  assert.equal(changedOutput.resolution, 'unresolved'); assert.equal(changedOutput.turn_id, null);
  assert.equal(changedOutput.source_turn_id, null); assert.equal(changedOutput.turn_source, 'missing');
  assert.equal(changedOutput.event_at, output.event_at); assert.equal(changedOutput.text, output.text);
  assert.equal(changed.sessions[0].pending, true);
  const after = await h.manager(`/items/${item.id}/history?session_id=${linked.sessions[0].id}`);
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(await h.ingest([output]), { inserted: 0, duplicates: 1 });
});

test('worker hooks create no tracking directory or records even with invalid JSON', async t => {
  const h = await setup(t, false), workerDir = path.join(h.dir, 'worker-must-not-exist');
  await runHook(h, 'codex', '{invalid', { HARNESS_WORKER: '1', HARNESS_DATA_DIR: workerDir });
  assert.equal(fs.existsSync(workerDir), false);
  assert.equal(fs.existsSync(path.join(h.dir, 'spool')), false);
});

test('legacy pending spool and later source-ID retry retain the original observation after upgrade', async t => {
  const h = await setup(t, false);
  const original = { id: 'legacy-source-input', engine: 'claude', agent_session_id: 'legacy-agent', source_session_id: 'legacy-agent',
    kind: 'input', event_at: '2026-09-17T09:00:00.000Z', observed_at: '2026-09-17T09:00:00.000Z',
    time_source: 'hook_observed', turn_id: 'local-turn-legacy', text: '기존 수집 요청', source: 'system_hook', role: 'user', hook_event_name: 'UserPromptSubmit' };
  fs.mkdirSync(path.join(h.dir, 'spool'));
  fs.writeFileSync(path.join(h.dir, 'spool', 'legacy.json'), JSON.stringify(original));
  await h.start('manager'); await eventually(() => h.manager('/health'), value => value.events === 1);
  h.hook('claude', { session_id: original.agent_session_id, event_id: original.id, hook_event_name: original.hook_event_name, prompt: original.text });
  await eventually(() => fs.readdirSync(path.join(h.dir, 'spool')).length, count => count === 0);
  const [item] = await h.manager('/items'), detail = await h.manager(`/items/${item.id}`);
  assert.equal(detail.events.length, 1); assert.equal(detail.events[0].event_at, original.event_at);
  assert.equal(detail.events[0].turn_id, original.turn_id); assert.equal(fs.existsSync(path.join(h.dir, 'quarantine')), false);
});
