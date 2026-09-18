import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, event, pair, eventually } from '../helpers.mjs';
import { id, json } from '../../src/shared.mjs';

async function scenario(t) { const h = await new Harness().start('manager'); t.after(() => h.close()); return h; }
test('SES-003: 19:59.999 remains; exactly 20 minutes starts a new window; time excludes idle tail', async t => {
  const h = await scenario(t);
  await h.ingest([...pair('agent-a', '09:00:00.000', '09:05:00.000'), ...pair('agent-a', '09:24:59.999', '09:26:00.000', 't2'), ...pair('agent-a', '09:46:00.000', '09:50:00.000', 't3')]);
  const [item] = await h.manager('/items'), detail = await h.manager(`/items/${item.id}`);
  assert.equal(detail.sessions.length, 2);
  assert.equal(detail.sessions[0].end_at, '2026-09-17T09:26:00.000Z');
  assert.equal(detail.sessions[1].start_at, '2026-09-17T09:46:00.000Z');
});
test('SES-004/MRG: merge multi-day agent histories without resegmenting; subsequent events follow aliases', async t => {
  const h = await scenario(t);
  await h.ingest([...pair('a', '2026-09-16T09:00:00Z', '2026-09-16T09:05:00Z', 'a1', { text: '권한 PRD' }),
    ...pair('a', '09:00:00', '09:05:00', 'a2'), ...pair('b', '09:15:00', '09:24:00', 'b1', { text: '권한 API' })]);
  const before = await h.manager('/items'), details = await Promise.all(before.map(w => h.manager(`/items/${w.id}`)));
  const sessionIds = details.flatMap(d => d.sessions.map(s => s.id)).sort(), target = before[0].id;
  const input = { ids: before.map(w => w.id), target, operation_id: id() };
  const [merged, retried] = await Promise.all([h.manager('/merge', { method: 'POST', body: input }), h.manager('/merge', { method: 'POST', body: input })]);
  assert.equal(merged.id, retried.id); assert.equal((await h.manager('/items')).length, 1);
  assert.deepEqual((await h.manager(`/items/${target}`)).sessions.map(s => s.id).sort(), sessionIds);
  await h.ingest([...pair('a', '09:25:00', '09:27:00', 'a3')]);
  const detail = await h.manager(`/items/${target}`);
  assert.equal(detail.sessions.length, 4, 'a uses its 09:05 output, not b 09:24');
  assert.equal((await h.manager(`/items/${before[1].id}`)).item.id, target);
  assert.equal((await h.manager('/items?q=권한')).length, 1);
});
test('late output rebuilds projections; retry dedup is by source ID, not identical content', async t => {
  const h = await scenario(t);
  const inputs = [event('a', 'input', '09:00:00', 't1', { text: '동일 요청' }), event('a', 'input', '10:00:00', 't2', { text: '동일 요청' })];
  await h.ingest(inputs); const [item] = await h.manager('/items');
  const first = await h.manager(`/items/${item.id}`); assert.equal(first.sessions.length, 1);
  const output = event('a', 'output', '09:05:00', 't1');
  await h.ingest([output]); const second = await h.manager(`/items/${item.id}`);
  assert.equal(second.sessions.length, 2); assert.equal(second.sessions[0].id, first.sessions[0].id);
  assert.deepEqual(await h.ingest([...inputs, output]), { inserted: 0, duplicates: 3 });
  assert.equal((await h.manager(`/items/${item.id}`)).events.length, 3);
});
test('overlapping turns associate output to original session; no output keeps window pending', async t => {
  const h = await scenario(t);
  await h.ingest([...pair('a', '09:00:00', '09:05:00'), event('a', 'input', '09:30:00', 't2'), event('a', 'input', '09:31:00', 't3'), event('a', 'output', '09:40:00', 't2')]);
  const [item] = await h.manager('/items'), d = await h.manager(`/items/${item.id}`);
  assert.equal(d.sessions.length, 3); assert.equal(d.sessions[1].end_at, '2026-09-17T09:40:00.000Z');
  assert.equal(d.sessions[2].end_at, d.sessions[2].start_at); assert.equal(d.sessions[2].pending, true);
});
test('missing body and unresolvable outputs are explicit; no fabricated text or completion', async t => {
  const h = await scenario(t);
  await h.ingest([event('a', 'output', '09:00:00', null, { text: null }), event('a', 'input', '09:10:00'), event('a', 'output', '09:15:00', 't1', { text: null })]);
  const [item] = await h.manager('/items'), d = await h.manager(`/items/${item.id}`);
  assert.equal(d.events[0].resolution, 'unresolved'); assert.equal(d.events[2].resolution, 'missing_body');
  assert.equal(d.sessions.length, 1); assert.equal(item.state, 'tracked'); assert.equal(d.events[2].text, null);
});
test('headless metadata/worker events attach to parent, never create or stretch user session', async t => {
  const h = await scenario(t);
  await h.ingest(pair('a', '09:00:00', '09:05:00'));
  const [item] = await h.manager('/items');
  await h.ingest(pair('internal', '10:00:00', '10:20:00', 'worker', { role: 'metadata', work_item_id: item.id, parent: { engine: 'codex', agent_session_id: 'a', turn_id: 't1', work_item_id: item.id } }));
  const d = await h.manager(`/items/${item.id}`);
  assert.equal((await h.manager('/items')).length, 1); assert.equal(d.sessions.length, 1);
  assert.equal(d.sessions[0].end_at, '2026-09-17T09:05:00.000Z');
  assert.equal(d.events.filter(e => e.role === 'metadata' && e.session_id === d.sessions[0].id).length, 2);
});
test('hook subprocess spools while manager is offline, then restart recovers timestamps and deduplicates', async t => {
  const h = await scenario(t); await h.stop('manager');
  h.hook('codex', { session_id: 'actual-hook-session', hook_event_name: 'SessionStart' });
  h.hook('codex', { session_id: 'actual-hook-session', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: '내 업무' });
  h.hook('codex', { session_id: 'actual-hook-session', hook_event_name: 'Stop', turn_id: 'turn-1', last_assistant_message: '완료 응답' });
  const files = fs.readdirSync(path.join(h.dir, 'spool')).filter(f => f.endsWith('.json'));
  const original = files.map(f => fs.readFileSync(path.join(h.dir, 'spool', f), 'utf8'));
  assert.equal(files.length, 3); await h.start('manager');
  await eventually(() => h.manager('/health'), s => s.events === 3);
  const [item] = await h.manager('/items'), d = await h.manager(`/items/${item.id}`);
  assert.equal(d.sessions.length, 1); assert.equal(d.sessions[0].pending, false);
  assert.equal(d.events.find(e => e.kind === 'input').text, '내 업무');
  for (let i = 0; i < files.length; i++) fs.writeFileSync(path.join(h.dir, 'spool', files[i]), original[i]);
  await h.stop('manager'); await h.start('manager');
  await eventually(() => fs.readdirSync(path.join(h.dir, 'spool')).length, n => n === 0);
  assert.equal((await h.manager('/health')).events, 3);
});
test('Claude local turn fallback refuses ambiguous overlapping prompts', async t => {
  const h = await scenario(t);
  for (const hook of [{ hook_event_name: 'UserPromptSubmit', prompt: '첫 입력' }, { hook_event_name: 'UserPromptSubmit', prompt: '두 번째 입력' }, { hook_event_name: 'Stop', last_assistant_message: '대응이 불명확한 출력' }]) h.hook('claude', { session_id: 'c1', ...hook });
  await eventually(() => h.manager('/health'), s => s.events === 3);
  const [item] = await h.manager('/items'), d = await h.manager(`/items/${item.id}`);
  assert.equal(d.events.at(-1).resolution, 'unresolved'); assert.equal(d.sessions[0].pending, true);
});
test('calendar item mode unions overlaps but preserves idle gaps and midnight source session', async t => {
  const h = await scenario(t);
  await h.ingest([...pair('a', '09:00:00', '09:30:00', 't1', { work_item_id: 'same' }), ...pair('b', '09:15:00', '09:45:00', 't1', { work_item_id: 'same' }),
    ...pair('a', '11:00:00', '11:10:00', 't2', { work_item_id: 'same' }), ...pair('a', '23:50:00', '2026-09-18T00:10:00Z', 't3', { work_item_id: 'same' })]);
  const range = '/calendar?start=2026-09-17T00:00:00Z&end=2026-09-19T00:00:00Z';
  const sessions = await h.manager(range + '&mode=sessions'), items = await h.manager(range + '&mode=items');
  assert.equal(sessions.length, 4); assert.equal(items.length, 3); assert.equal(items[0].session_ids.length, 2);
  assert.equal(items[0].end_at, '2026-09-17T09:45:00.000Z');
  const nextDay = await h.manager('/calendar?start=2026-09-18T00:00:00Z&end=2026-09-19T00:00:00Z');
  assert.equal(nextDay[0].id, sessions[3].id);
});
test('metadata editing is versioned and protected; invalid batch is atomic; unauthenticated API denied', async t => {
  const h = await scenario(t); await h.ingest(pair('a', '09:00:00', '09:05:00'));
  const [item] = await h.manager('/items');
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { title: '직접 편집', description: '보호할 설명', version: item.version } });
  await assert.rejects(h.manager(`/items/${item.id}`, { method: 'PATCH', body: { title: '오래된 제목', description: '', version: item.version } }), /다시 불러오세요/);
  await h.ingest(pair('a', '09:10:00', '09:15:00', 't2')); assert.equal((await h.manager(`/items/${item.id}`)).item.title, '직접 편집');
  await assert.rejects(h.ingest([event('b', 'input', '10:00:00'), { invalid: true }])); assert.equal((await h.manager('/items')).length, 1);
  const endpoint = JSON.parse(fs.readFileSync(path.join(h.dir, 'manager.endpoint.json')));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/api/items`); assert.equal(response.status, 401);
});
