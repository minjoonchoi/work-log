import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, pair, eventually } from '../helpers.mjs';

test('automatic summary toggle survives restart, preserves manual summaries and exposes queued/running work once', async t => {
  const h = new Harness(); h.env = { HARNESS_TEST_SESSION_SUMMARIES: '1', HARNESS_TEST_WRITING_FIXTURE: JSON.stringify({ delayMs: 1800 }) };
  t.after(() => h.close()); await h.start('manager');
  await h.manager('/automation/settings', { method: 'PATCH', body: { session_summary_enabled: false } });
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager('/automation/settings')).session_summary_enabled, false);
  await h.ingest(pair('queue-test', '09:00:00', '09:01:00', 't1', { source: 'system_hook' }));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await h.manager('/task-queue')).rows.length, 0);
  const item = (await h.manager('/items'))[0];
  const session = (await h.manager('/items/' + item.id)).sessions[0];
  await h.manager(`/sessions/${session.id}/summary/regenerate`, { method: 'POST', body: { operation_id: 'manual-queue-test' } });
  let queue = await h.manager('/task-queue');
  assert.equal(queue.runtime_connected, false); assert.equal(queue.rows.length, 1); assert.equal(queue.rows[0].status, 'pending');
  await h.start('runtime');
  await eventually(() => h.manager('/task-queue'), q => q.rows.some(row => row.status === 'running'), 15000);
  assert.equal((await h.manager('/task-queue')).rows.length, 1);
  await eventually(() => h.manager('/task-queue'), q => q.rows.length === 0, 15000);
  await h.ingest(pair('queue-second', '10:00:00', '10:01:00', 't2', { source: 'system_hook' }));
  await h.manager('/automation/settings', { method: 'PATCH', body: { session_summary_enabled: true } });
  await eventually(() => h.runtime('/runs'), runs => runs.length === 2, 15000);
});

test('queue includes dependent user steps and removes completed work', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('runtime'); await h.start('manager');
  const plan = await h.runtime('/plans', { method: 'POST', body: { prompt: '요구 정리 후 화면 명세', engine: 'fixture', fixture: { delayMs: 1000 }, steps: [
    { id: 'requirements', task: 'prd.create', output_key: 'requirements', request_excerpt: '요구 정리', input: { requirements: '제품 요구 정리' }, depends_on: [] },
    { id: 'screen', task: 'screen.specify', output_key: 'screen', request_excerpt: '화면 명세', input: { requirements: '선행 요구의 화면 명세 작성' }, depends_on: ['requirements'] }
  ] } });
  const queue = await eventually(() => h.manager('/task-queue'), q => q.rows.some(r => r.status === 'running'));
  assert.equal(queue.rows.length, 2); assert.ok(queue.rows.every(r => r.kind === 'user'));
  assert.equal(queue.rows.find(r => r.task === 'screen.specify').message, '선행 작업 완료 대기');
  await eventually(() => h.runtime(`/plans/${plan.id}`), p => p.status === 'completed', 20000);
  assert.equal((await h.manager('/task-queue')).rows.length, 0);
});

test('switching automatic summaries off pauses already admitted requests until reenabled', async t => {
  const h = new Harness(); h.env = { HARNESS_TEST_SESSION_SUMMARIES: '1' }; t.after(() => h.close()); await h.start('manager');
  await h.ingest(pair('paused-summary', '09:00:00', '09:01:00', 't1', { source: 'system_hook' }));
  await eventually(() => h.manager('/task-queue'), q => q.rows.length === 1);
  await h.manager('/automation/settings', { method: 'PATCH', body: { session_summary_enabled: false } });
  await h.start('runtime'); await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await h.runtime('/runs')).length, 0);
  assert.match((await h.manager('/task-queue')).rows[0].message, /자동 요약 꺼짐/);
  await h.manager('/automation/settings', { method: 'PATCH', body: { session_summary_enabled: true } });
  await eventually(() => h.runtime('/runs'), runs => runs.length === 1);
});
