import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, event, eventually } from '../helpers.mjs';
import { managerStore } from '../../src/manager-store.mjs';

const at = minute => new Date(Date.parse('2026-09-17T00:00:00Z') + minute * 60000).toISOString();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = h => {
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'), { readOnly: true });
  try { return {
    requests: db.prepare("SELECT * FROM writing_requests WHERE format='session-summary' AND source='automatic' ORDER BY seq").all(),
    receipts: db.prepare('SELECT * FROM summary_prompt_receipts ORDER BY event_seq').all(),
    accepted: db.prepare("SELECT COUNT(*) AS n FROM session_summaries WHERE state='completed'").get().n
  }; } finally { db.close(); }
};
async function setup(t, closed = 12, fixture = {}) {
  const h = new Harness(); h.env = { HARNESS_TEST_SESSION_SUMMARIES: '1', HARNESS_TEST_WRITING_FIXTURE: JSON.stringify(fixture) };
  t.after(() => h.close());
  const store = managerStore(h.dir);
  store.ingestMany(Array.from({ length: closed + 1 }, (_, i) => pair('history', at(i * 30), at(i * 30 + 1), `turn-${i}`, { source: 'system_hook' })).flat());
  store.db.close();
  await h.start('runtime'); await h.start('manager'); return h;
}
function prompt(h, id, extra = {}) {
  return h.hook('codex', { session_id: 'trigger', hook_event_name: 'UserPromptSubmit', event_id: id, turn_id: id, prompt: '현재 작업을 이어갑니다.', ...extra });
}
const completed = (h, count) => eventually(() => snapshot(h), s => s.accepted === count && s.requests.every(row => !['pending','running'].includes(row.state)), 20000);

test('each real prompt takes at most five closed summaries; timer, restart and hook replay cannot drain history', async t => {
  const h = await setup(t);
  await pause(1250); assert.equal(snapshot(h).requests.length, 0);
  prompt(h, 'batch-one'); await completed(h, 5);
  const first = snapshot(h); assert.equal(first.requests.length, 5); assert.equal(first.receipts[0].selected_count, 5);
  await h.stop('manager'); await h.start('manager'); prompt(h, 'batch-one');
  await pause(1300); assert.equal(snapshot(h).requests.length, 5);
  prompt(h, 'batch-two'); await completed(h, 10);
  prompt(h, 'batch-three'); await completed(h, 12);
  const final = snapshot(h); assert.equal(final.requests.length, 12);
  assert.deepEqual(final.receipts.map(row => row.selected_count), [5, 5, 2]);
  const runs = await h.runtime('/runs'); assert.equal(runs.length, 12); assert.ok(runs.every(run => run.internal));
  for (const row of final.requests) assert.ok(JSON.parse(row.snapshot).summary_trigger.event_id);
});

test('rapid prompts do not exceed five in-flight automatic requests and do not leave future batch credit', async t => {
  const h = await setup(t, 9, { delayMs: 2000 });
  prompt(h, 'busy-one');
  await eventually(() => snapshot(h), s => s.requests.length === 5 && s.requests.every(row => row.state === 'running'));
  prompt(h, 'busy-two');
  await eventually(() => snapshot(h), s => s.receipts.length === 2);
  assert.equal(snapshot(h).requests.length, 5); assert.equal(snapshot(h).receipts[1].selected_count, 0);
  const active = await h.runtime('/health'); assert.ok(active.active <= 3);
  await completed(h, 5); await pause(1300); assert.equal(snapshot(h).requests.length, 5);
  prompt(h, 'busy-three'); await completed(h, 9);
});

test('failed summaries wait for a new prompt before retrying and a worker input is not a trigger', async t => {
  const h = await setup(t, 1, { scenario: 'rewrite-blank' });
  prompt(h, 'failed-one');
  await eventually(() => snapshot(h), s => s.requests.length === 1 && s.requests[0].state === 'failed');
  await h.ingest([event('internal-worker', 'input', at(90), 'worker-turn', { source: 'system_hook', role: 'worker' })]);
  await pause(1300); assert.equal(snapshot(h).requests.length, 1);
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = '{}'; await h.start('manager');
  await pause(1250); assert.equal(snapshot(h).requests.length, 1);
  prompt(h, 'failed-two'); await completed(h, 1);
  assert.deepEqual(snapshot(h).requests.map(row => row.state), ['failed','completed']);
});

test('a prompt that splits a window schedules its predecessor while excluding the new pending window', async t => {
  const h = await setup(t, 0);
  h.hook('codex', { session_id: 'history', hook_event_name: 'UserPromptSubmit', event_id: 'split', turn_id: 'split', prompt: '새 작업 구간' });
  await completed(h, 1);
  const detail = await h.manager(`/items/${(await h.manager('/items'))[0].id}`);
  assert.equal(detail.sessions.length, 2);
  assert.equal(detail.sessions.filter(session => session.summary?.state === 'completed').length, 1);
  assert.equal(detail.sessions.find(session => session.pending).summary, null);
});

test('spooled prompt survives unavailable services and is consumed once after restart', async t => {
  const h = await setup(t, 6); await h.stop('manager'); await h.stop('runtime');
  const started = performance.now(); const result = prompt(h, 'offline-spool');
  assert.equal(result.stdout, ''); assert.equal(result.status, 0); assert.ok(performance.now() - started < 1500);
  await h.start('manager');
  await eventually(() => snapshot(h), s => s.requests.length === 5);
  assert.ok(snapshot(h).requests.every(row => row.state === 'pending'));
  await h.stop('manager'); await h.start('runtime'); await h.start('manager');
  await completed(h, 5); await pause(1250); assert.equal(snapshot(h).requests.length, 5);
});
