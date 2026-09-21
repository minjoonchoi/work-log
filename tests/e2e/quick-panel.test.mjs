import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, event, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

async function setup(t) { const h = await new Harness().start('manager'); t.after(() => h.close()); return h; }
function update(agent, item, status, extra = {}) {
  return event(agent, 'run.updated', '09:03:00', 't1', { work_item_id: item,
    run: { id: `run-${agent}`, status, task: 'prd.create', internal: false, ...extra } });
}

test('real hook subprocess input/Stop updates current work without treating a native session as a controlled run', async t => {
  const h = await setup(t);
  const base = { session_id: 'quick-hooks', turn_id: 'turn-1' };
  h.hook('codex', { ...base, hook_event_name: 'UserPromptSubmit', prompt: '권한 관리 PRD 작성' });
  const during = await eventually(() => h.manager('/quick'), r => r.counts.current === 1);
  assert.equal(during.current[0].activity, 'agent_response_pending');
  assert.equal(during.current[0].state, 'tracked');
  assert.equal(during.health.runtime_connected, false);
  h.hook('codex', { ...base, hook_event_name: 'Stop', last_assistant_message: 'PRD 초안을 작성했습니다.' });
  const after = await eventually(() => h.manager('/quick'), r => r.counts.current === 0);
  assert.equal(after.recent[0].id, during.current[0].id);
  assert.equal(after.counts.total, 1);
});

test('overview caps rows but keeps exact counts and excludes metadata workers and prompt/response bodies', async t => {
  const h = await setup(t), events = [];
  for (let n = 0; n < 7; n++) events.push(event(`current-${n}`, 'input', '09:00:00', 't1', { work_item_id: `c${n}`, text: `진행 업무 ${n}` }));
  for (let n = 0; n < 4; n++) events.push(...pair(`blocked-${n}`, '09:00:00', '09:01:00', 't1', { work_item_id: `a${n}`, text: `확인 업무 ${n}` }), update(`blocked-${n}`, `a${n}`, 'blocked'));
  for (let n = 0; n < 6; n++) events.push(...pair(`recent-${n}`, '09:00:00', '09:01:00', 't1', { work_item_id: `r${n}`, text: `최근 업무 ${n}` }));
  events.push(event('private-worker', 'input', '09:02:00', 't1', { work_item_id: 'r0', role: 'worker', text: 'PRIVATE-WORKER-PROMPT', parent: { work_item_id: 'r0' } }),
    event('private-worker', 'run.updated', '09:03:00', 't1', { work_item_id: 'r0', role: 'worker', run: { id: 'metadata', status: 'running', internal: true } }));
  await h.ingest(events);
  const item = (await h.manager('/items')).find(w => w.id === 'r0');
  await h.manager('/items/r0', { method: 'PATCH', body: { title: item.title, description: 'PRIVATE-DESCRIPTION', version: item.version } });
  const overview = await h.manager('/quick');
  assert.deepEqual(overview.counts, { current: 7, recent: 10, notifications: 4, total: 17 });
  assert.deepEqual([overview.current.length, overview.notifications.length, overview.recent.length], [5, 3, 5]);
  assert.equal(new Set(overview.notifications.map(w => w.work_item_id)).size, 3);
  assert.ok(!JSON.stringify(overview).includes('PRIVATE-'));
  assert.deepEqual(Object.keys(overview.current[0]).sort(), ['activities', 'activity', 'id', 'last_activity', 'notification_count', 'state', 'title']);
});

test('merged concurrent agent sessions count as one work item; interrupted turns stop waiting; restart preserves overview', async t => {
  const h = await setup(t);
  await h.ingest([event('a', 'input', '09:00:00', 't1', { work_item_id: 'a' }), event('b', 'input', '09:01:00', 't1', { work_item_id: 'b' })]);
  assert.equal((await h.manager('/quick')).counts.current, 2);
  await h.manager('/merge', { method: 'POST', body: { ids: ['a', 'b'], target: 'a', operation_id: 'quick-merge' } });
  assert.equal((await h.manager('/quick')).counts.current, 1);
  await h.ingest([event('a', 'output', '09:02:00'), event('b', 'turn.interrupted', '09:03:00')]);
  const before = await h.manager('/quick');
  assert.equal(before.counts.current, 0); assert.equal(before.counts.total, 1);
  await h.stop('manager'); await h.start('manager');
  assert.deepEqual((await h.manager('/quick')).recent, before.recent);
});

test('run state changes drive current/attention/recent, and overview remains authenticated', async t => {
  const h = await setup(t);
  await h.ingest(pair('run-state', '09:00:00', '09:01:00', 't1', { work_item_id: 'run-item' }));
  for (const [status, group] of [['running', 'current'], ['blocked', 'notifications'], ['completed', 'recent']]) {
    await h.ingest([update('run-state', 'run-item', status)]);
    const overview = await h.manager('/quick');
    assert.equal(overview.counts[group], 1); assert.equal(overview[group][0][group === 'notifications' ? 'work_item_id' : 'id'], 'run-item');
  }
  const res = await fetch(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}/api/quick`);
  assert.equal(res.status, 401);
});
