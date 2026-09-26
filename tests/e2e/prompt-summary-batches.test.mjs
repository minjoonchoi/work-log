import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, event, eventually } from '../helpers.mjs';
import { managerStore } from '../../src/manager-store.mjs';

const at = minute => new Date(Date.parse('2026-09-17T00:00:00Z') + minute * 60000).toISOString();
const ago = minute => new Date(Date.now() - minute * 60000).toISOString();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = h => {
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'), { readOnly: true });
  try { return {
    requests: db.prepare("SELECT * FROM writing_requests WHERE format='session-summary' AND source='automatic' ORDER BY seq").all(),
    accepted: db.prepare("SELECT COUNT(*) AS n FROM session_summaries WHERE state='completed'").get().n
  }; } finally { db.close(); }
};
async function setup(t, closed = 12, fixture = {}, { runtime = true, events } = {}) {
  const h = new Harness(); h.env = { HARNESS_TEST_SESSION_SUMMARIES: '1', HARNESS_TEST_WRITING_FIXTURE: JSON.stringify(fixture) };
  t.after(() => h.close());
  const store = managerStore(h.dir);
  store.ingestMany(events || [...Array.from({ length: closed }, (_, i) => pair('history', at(i * 30), at(i * 30 + 1), `turn-${i}`, { source: 'system_hook' })).flat(),
    event('history', 'input', at(closed * 30), 'pending-window', { source: 'system_hook' })]);
  store.db.close();
  if (runtime) await h.start('runtime');
  await h.start('manager'); return h;
}
function prompt(h, id, extra = {}) {
  return h.hook('codex', { session_id: 'trigger', hook_event_name: 'UserPromptSubmit', event_id: id, turn_id: id, prompt: '현재 작업을 이어갑니다.', ...extra });
}
const completed = (h, count) => eventually(() => snapshot(h), s => s.accepted === count && s.requests.every(row => !['pending','running'].includes(row.state)), 30000);

test('the manager timer drains closed history in bounded batches without another prompt and does not repeat it after restart', async t => {
  const h = await setup(t);
  await completed(h, 12);
  const final = snapshot(h); assert.equal(final.requests.length, 12);
  const runs = await h.runtime('/runs'); assert.equal(runs.length, 12); assert.ok(runs.every(run => run.internal));
  for (const row of final.requests) assert.deepEqual(Object.keys(JSON.parse(row.snapshot).summary_trigger).sort(), ['kind', 'observed_at', 'reason']);
  assert.ok(final.requests.every(row => JSON.parse(row.snapshot).summary_trigger.reason === 'closed'));
  await h.stop('manager'); await h.start('manager'); prompt(h, 'replayed-prompt'); prompt(h, 'replayed-prompt');
  await pause(1300); assert.equal(snapshot(h).requests.length, 12);
});

test('unavailable runtime and rapid prompts preserve five admitted requests; recovery fills slots without new input', async t => {
  const h = await setup(t, 9, { delayMs: 300 }, { runtime: false });
  await eventually(() => snapshot(h), s => s.requests.length === 5);
  assert.ok(snapshot(h).requests.every(row => row.state === 'pending'));
  prompt(h, 'busy-one'); prompt(h, 'busy-two');
  await pause(1200); assert.equal(snapshot(h).requests.length, 5);
  await h.stop('manager'); await h.start('manager');
  await pause(1200); assert.equal(snapshot(h).requests.length, 5);
  await h.start('runtime');
  await eventually(async () => {
    const state = snapshot(h), health = await h.runtime('/health');
    assert.ok(state.requests.filter(row => ['pending', 'running'].includes(row.state)).length <= 5);
    assert.ok(health.active <= 3);
    return state;
  }, state => state.accepted === 9, 30000);
  assert.equal(snapshot(h).requests.length, 9);
});

test('failed source is not retried by timer, restart, worker or user prompts; explicit regenerate can recover it', async t => {
  const h = await setup(t, 1, { scenario: 'rewrite-blank' });
  await eventually(() => snapshot(h), s => s.requests.length === 1 && s.requests[0].state === 'failed');
  const sid = snapshot(h).requests[0].target_id;
  await h.ingest([event('internal-worker', 'input', at(90), 'worker-turn', { source: 'system_hook', role: 'worker' })]);
  prompt(h, 'failed-source-prompt'); await pause(1300); assert.equal(snapshot(h).requests.length, 1);
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = '{}'; await h.start('manager');
  await pause(1250); assert.equal(snapshot(h).requests.length, 1);
  await h.manager(`/sessions/${sid}/summary/regenerate`, { method: 'POST', body: { operation_id: 'manual-failed-source-retry' } });
  await eventually(() => h.manager('/writing/manual-failed-source-retry'), row => row.state === 'completed');
  await pause(1250); assert.equal(snapshot(h).requests.length, 1); assert.equal(snapshot(h).accepted, 1);
});

test('a changed failed source becomes eligible again without a new prompt trigger', async t => {
  const h = await setup(t, 1, { scenario: 'rewrite-blank' });
  await eventually(() => snapshot(h), s => s.requests[0]?.state === 'failed');
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = '{}'; await h.start('manager');
  await h.ingest([event('history', 'output', at(2), 'turn-0', { source: 'system_hook', text: '늦게 수집된 실제 추가 응답' })]);
  await completed(h, 1);
  assert.deepEqual(snapshot(h).requests.map(row => row.state), ['failed', 'completed']);
});

test('a last session idle after an observed output is summarized without closing the session or completing the item', async t => {
  const h = await setup(t, 0, {}, { events: pair('idle-current', ago(23), ago(21), 'last-output', { source: 'system_hook' }) });
  await completed(h, 1);
  const detail = await h.manager(`/items/${(await h.manager('/items'))[0].id}`);
  assert.equal(detail.sessions.length, 1); assert.equal(detail.sessions[0].closed, false);
  assert.equal(detail.sessions[0].pending, false); assert.equal(detail.sessions[0].summary.state, 'completed');
  assert.equal(detail.item.state, 'tracked');
  assert.equal(JSON.parse(snapshot(h).requests[0].snapshot).summary_trigger.reason, 'idle');
});

test('pending, interrupted, recent and externally delegated running sessions are not mistaken for idle completed responses', async t => {
  const delegated = pair('delegated-running', ago(25), ago(23), 'delegated', { source: 'system_hook', work_item_id: 'delegated-item' });
  const h = await setup(t, 0, {}, { events: [
    ...pair('still-answering', ago(60), ago(58), 'old'), event('still-answering', 'input', ago(57), 'awaiting-stop'),
    event('interrupted', 'input', ago(60), 'interrupted'), event('interrupted', 'turn.interrupted', ago(59), 'interrupted'),
    ...pair('recent-response', ago(5), ago(3), 'recent'),
    ...delegated,
    event('delegated-running', 'run.updated', ago(22), 'delegated', { work_item_id: 'delegated-item', run: {
      id: 'run-delegated-running', internal: false, status: 'running', origin: { engine: 'codex', agent_session_id: 'delegated-running', turn_id: 'delegated' }
    } })
  ] });
  await pause(2200); assert.equal(snapshot(h).requests.length, 0);
});

test('new input invalidates an in-flight idle summary and a later observed response creates one fresh summary', async t => {
  const h = await setup(t, 0, { delayMs: 1800 }, { events: pair('idle-resumed', ago(63), ago(61), 'original', { source: 'system_hook' }) });
  const before = await eventually(() => snapshot(h), s => s.requests[0]?.state === 'running');
  const original = before.requests[0];
  await h.ingest([event('idle-resumed', 'input', ago(60), 'late-input', { source: 'system_hook' })]);
  await eventually(() => snapshot(h), s => s.requests[0].state === 'superseded');
  await pause(1250); assert.equal(snapshot(h).requests.length, 1); assert.equal(snapshot(h).accepted, 0);
  const oldRun = await h.runtime(`/runs/${original.run_id}`); assert.ok(['cancelled', 'completed'].includes(oldRun.status));
  await h.ingest([event('idle-resumed', 'output', ago(59), 'late-input', { source: 'system_hook' })]);
  await completed(h, 1);
  const final = snapshot(h); assert.deepEqual(final.requests.map(row => row.state), ['superseded', 'completed']);
  assert.notEqual(final.requests[1].run_key, original.run_key);
  assert.equal(JSON.parse(final.requests[1].snapshot).input.sessions[0].events.length, 4);
});
