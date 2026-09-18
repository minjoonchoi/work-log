import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, event, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

async function setup(t) { const h = new Harness(); t.after(() => h.close()); await h.start('manager'); return h; }
const query = (item, session, values = {}) => `/items/${item}/history?${new URLSearchParams({ ...(session ? { session_id: session } : {}), ...values })}`;

test('record pages preserve timestamp ties and a fixed snapshot while newer and delayed hook records arrive', async t => {
  const h = await setup(t), originals = Array.from({ length: 61 }, (_, n) => pair('pages', '09:00:00', '09:00:00', `t${n}`,
    { text: n < 2 ? '같은 내용을 다시 제출한 기록' : `원문 ${n}`, source: 'system_hook' })).flat();
  await h.ingest(originals);
  const item = (await h.manager('/items'))[0], summary = await h.manager(`/items/${item.id}?view=summary`), session = summary.sessions[0].id;
  assert.deepEqual(summary.events, []); assert.equal(summary.sessions[0].history.count, 122);
  let page = await h.manager(query(item.id, session)); const first = page, records = [...page.records];
  assert.equal(page.records.length, 40); assert.equal(page.records[0].id, originals.at(-1).id);
  const added = [...pair('pages', '09:02:00', '09:03:00', 'new', { source: 'system_hook' }),
    event('pages', 'output', '09:00:00', 't0', { source: 'system_hook', text: null })];
  await h.ingest([...added, event('pages', 'tool.finished', '09:03:00', 'new', { text: '도구 실행 결과' })]);
  while (page.next_cursor) {
    page = await h.manager(query(item.id, session, { cursor: page.next_cursor }));
    assert.ok(page.records.length <= 40); records.push(...page.records);
  }
  assert.deepEqual(records.map(e => e.id), originals.map(e => e.id).reverse());
  assert.equal(new Set(records.map(e => e.uid)).size, originals.length);
  assert.ok(records.every(e => e.source === 'system_hook'));
  let delta = await h.manager(query(item.id, session, { after: first.watermark, limit: 2 }));
  const fresh = [...delta.records]; assert.ok(delta.next_cursor);
  while (delta.next_cursor) { delta = await h.manager(query(item.id, session, { cursor: delta.next_cursor, limit: 2 })); fresh.push(...delta.records); }
  assert.deepEqual(fresh.map(e => e.id), added.map(e => e.id));
  assert.equal(fresh.at(-1).text, null);
  assert.deepEqual((await h.manager(query(item.id, session, { after: delta.watermark }))).records, []);
});

test('actual system hooks retain their record source and body; replay, restart and auth do not corrupt paging', async t => {
  const h = await setup(t), raw = { session_id: 'actual-hook-pages', turn_id: 't1' };
  h.hook('codex', { ...raw, hook_event_name: 'UserPromptSubmit', event_id: 'in', prompt: '기록 원문 <b>보존</b>' });
  const output = { ...raw, hook_event_name: 'Stop', event_id: 'out', last_assistant_message: '응답 그대로' };
  h.hook('codex', output);
  await eventually(() => h.manager('/health'), s => s.events === 2);
  const item = (await h.manager('/items'))[0], session = (await h.manager(`/items/${item.id}`)).sessions[0].id;
  const page = await h.manager(query(item.id, session, { limit: 1 }));
  assert.equal(page.records[0].hook_event_name, 'Stop'); assert.equal(page.records[0].text, '응답 그대로');
  assert.equal(page.records[0].time_source, 'hook_observed');
  h.hook('codex', output); await h.stop('manager'); await h.start('manager');
  const next = await h.manager(query(item.id, session, { cursor: page.next_cursor }));
  assert.equal(next.records.length, 1); assert.equal(next.records[0].hook_event_name, 'UserPromptSubmit');
  assert.equal(next.records[0].text, '기록 원문 <b>보존</b>');
  assert.equal((await h.manager('/health')).events, 2);
  const denied = await fetch(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}/api${query(item.id, session)}`);
  assert.equal(denied.status, 401);
});

test('changed session boundaries invalidate old cursors; another item and malformed queries cannot reuse them', async t => {
  const h = await setup(t);
  await h.ingest([event('boundary-pages', 'input', '09:00:00', 'first'), ...pair('boundary-pages', '09:30:00', '09:31:00', 'second')]);
  const item = (await h.manager('/items'))[0], initial = await h.manager(`/items/${item.id}?view=summary`), session = initial.sessions[0].id;
  const old = await h.manager(query(item.id, session, { limit: 1 }));
  await h.ingest([event('boundary-pages', 'output', '09:05:00', 'first')]);
  const changed = await h.manager(`/items/${item.id}?view=summary`);
  assert.equal(changed.sessions.length, 2); assert.notEqual(changed.sessions[0].history.revision, initial.sessions[0].history.revision);
  await assert.rejects(h.manager(query(item.id, session, { cursor: old.next_cursor })), e => e.status === 409);
  assert.deepEqual((await h.manager(query(item.id, session))).records.map(e => e.kind), ['output', 'input']);
  await h.ingest(pair('other-pages', '09:00:00', '09:01:00'));
  const other = (await h.manager('/items')).find(i => i.id !== item.id);
  await assert.rejects(h.manager(query(other.id, session)), e => e.status === 404);
  for (const values of [{ limit: 0 }, { limit: 101 }, { cursor: 'broken' }, { after: '-1' }, { after: 'NaN' }])
    await assert.rejects(h.manager(query(item.id, session, values)), e => e.status === 400);
});

test('unresolved outputs page independently and leave that feed when their original input is collected', async t => {
  const h = await setup(t);
  await h.ingest([event('orphan-pages', 'output', '09:05:00', 'late', { text: null }), event('orphan-pages', 'output', '09:06:00', null)]);
  const item = (await h.manager('/items'))[0], old = await h.manager(query(item.id, null, { limit: 1 }));
  assert.equal(old.records[0].resolution, 'unresolved'); assert.ok(old.next_cursor);
  await h.ingest([event('orphan-pages', 'input', '09:00:00', 'late')]);
  await assert.rejects(h.manager(query(item.id, null, { cursor: old.next_cursor })), e => e.status === 409);
  const summary = await h.manager(`/items/${item.id}?view=summary`);
  assert.equal(summary.unlinked_history.count, 1); assert.equal(summary.sessions[0].history.count, 2);
  assert.equal((await h.manager(query(item.id, summary.sessions[0].id))).records[0].resolution, 'missing_body');
});
