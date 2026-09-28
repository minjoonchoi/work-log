import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, pair, eventually } from '../helpers.mjs';

test('orphan metadata and internal worker records cannot create or reserve an item before the real user', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  for (const extra of [
    { role: 'metadata' },
    { role: 'worker', internal: true, parent: { engine:'harness-writing', agent_session_id:'title', work_item_id:'future-owner' } },
    { role: 'user', run: { id:'internal-run', internal:true } }
  ]) {
    await h.ingest(pair('title-' + extra.role, '09:00:00', '09:01:00', 'title', { ...extra, work_item_id:'future-owner' }));
  }
  assert.deepEqual(await h.manager('/items'), []);
  await h.ingest(pair('real-user', '09:02:00', '09:03:00', 'real', { work_item_id:'future-owner' }));
  assert.equal((await h.manager('/items')).length, 1);
  const detail = await h.manager('/items/future-owner');
  assert.deepEqual(detail.agents.map(a => a.source_id), ['real-user']);
});

test('internal runtime with an unknown owner stays in runtime; subsequent work with a real owner attaches normally', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('runtime'); await h.start('manager');
  const input = { title: '요약', events: [{ kind:'input', text:'작업 요청', event_at:'2026-09-17T09:00:00Z' }, {kind:'output',text:'작업 완료',event_at:'2026-09-17T09:01:00Z'}] };
  const run = await h.finish(await h.run({ task:'session.summarize', internal:true, work_item_id:'missing-owner', input }));
  assert.equal(run.status,'completed',run.message);
  await eventually(() => h.manager('/health'), health => health.runtime_connected);
  // Drain the manager cursor through all events without relying on wall-clock sleep.
  const feed = await h.runtime('/events?after=0');
  await h.ingest(feed.events);
  assert.deepEqual(await h.manager('/items'), []);
  assert.equal((await h.runtime('/runs/' + run.id)).status,'completed');
  await h.ingest(pair('real-user','10:00:00','10:01:00','t',{work_item_id:'real-owner'}));
  await h.ingest(pair('known-title','10:02:00','10:03:00','title',{role:'worker',internal:true,work_item_id:'real-owner'}));
  assert.deepEqual((await h.manager('/items')).map(x=>x.id),['real-owner']);
  assert.equal((await h.manager('/items/real-owner')).events.filter(x=>x.internal).length,2);
});
