import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, pair } from '../helpers.mjs';

test('session-focused app collects history and runs summaries while rejecting new delegated work', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('runtime'); await h.start('manager');
  const tasks = (await h.manager('/execution-settings')).tasks.map(t => t.id).sort();
  assert.deepEqual(tasks, ['session.summarize', 'text.rewrite', 'work-item.result.summarize', 'work.report.create'].sort());
  for (const [route, body] of [['/runs', { task: 'prd.create', engine: 'fixture', input: { requirements: 'new task' } }], ['/plans', {}], ['/execution-settings/custom-tasks', {}]]) {
    await assert.rejects(h.runtime(route, { method: 'POST', body }), e => e.status === 410);
  }
  for (const route of ['/harness-packages', '/task-queue']) await assert.rejects(h.manager(route), e => e.status === 410);
  await h.ingest(pair('history-only', '09:00:00', '09:01:00', 't1', { source: 'system_hook' }));
  assert.equal((await h.manager('/items')).length, 1);
  const run = await h.finish(await h.run({ task: 'session.summarize', internal: true, input: { title: '세션', events: [{ kind: 'input', event_at: '2026-09-29T00:00:00Z', text: '요청 기록' }] } }));
  assert.equal(run.status, 'completed', run.message);
  assert.equal((await h.manager('/items')).length, 1);
});
