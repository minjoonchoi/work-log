import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, pair, event, eventually } from '../helpers.mjs';

async function setup(t) { const h = new Harness(); t.after(() => h.close()); await h.start('runtime'); await h.start('manager'); return h; }

test('results follow exact input turns across engines, 20-minute windows and merged items; legacy worker origins remain usable', async t => {
  const h = await setup(t);
  await h.ingest([...pair('shared', '09:00:00', '09:05:00', 'one', { text: '첫 업무' }),
    ...pair('shared', '09:25:00', '09:30:00', 'two'), ...pair('shared', '09:00:00', '09:05:00', 'one', { engine: 'claude', text: '다른 엔진 업무' })]);
  const items = await h.manager('/items'), a = items.find(i => i.title === '첫 업무'), b = items.find(i => i.title === '다른 엔진 업무');
  const first = (await h.manager(`/items/${a.id}`)).sessions, other = (await h.manager(`/items/${b.id}`)).sessions[0];
  const executed = [];
  for (const [engine, turn, owner, session] of [['codex', 'one', a.id, first[0].id], ['codex', 'two', a.id, first[1].id], ['claude', 'one', b.id, other.id]]) {
    const run = await h.finish(await h.run({ origin: { engine, agent_session_id: 'shared', turn_id: turn }, work_item_id: owner }));
    executed.push({ run, session });
  }
  await h.manager('/merge', { method: 'POST', body: { ids: [a.id, b.id], target: a.id, operation_id: 'merge-session-results' } });
  let d = await eventually(() => h.manager(`/items/${a.id}`), d => d.runs.length === 3 && d.runs.every(r => r.status === 'completed'));
  for (const { run, session } of executed) assert.equal(d.runs.find(r => r.id === run.id).session_id, session);
  assert.equal(d.sessions.length, 3); assert.equal(d.sessions[0].end_at, '2026-09-17T09:05:00.000Z');
  const { origin, ...legacy } = executed[0].run;
  await h.ingest([event('shared', 'run.updated', '09:06:00', 'one', { run: legacy, work_item_id: a.id })]);
  d = await h.manager(`/items/${a.id}`);
  assert.equal(d.runs.find(r => r.id === legacy.id).session_id, first[0].id);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager(`/items/${a.id}`)).runs.find(r => r.id === legacy.id).session_id, first[0].id);
});

test('late input resolves an unlinked result; duplicate input turn remains unresolved instead of guessing a session', async t => {
  const h = await setup(t), origin = { engine: 'codex', agent_session_id: 'late-result', turn_id: 'one' };
  const run = await h.finish(await h.run({ origin, work_item_id: 'late-item' }));
  let d = await eventually(() => h.manager('/items/late-item'), d => d.runs[0]?.status === 'completed');
  assert.equal(d.runs[0].session_id, null); assert.equal(d.sessions.length, 0);
  await h.ingest(pair('late-result', '09:00:00', '09:05:00', 'one', { work_item_id: 'late-item' }));
  d = await h.manager('/items/late-item'); assert.equal(d.runs[0].session_id, d.sessions[0].id);
  assert.ok(d.events.filter(e => e.parent?.run_id === run.id).every(e => e.session_id === d.sessions[0].id));
  await h.ingest([event('late-result', 'input', '09:25:00', 'one', { work_item_id: 'late-item', text: '동일 turn을 재사용한 모호한 입력' })]);
  d = await h.manager('/items/late-item'); assert.equal(d.runs[0].session_id, null);
});

test('legacy deterministic CLI check results retain their session through the original input event ID', async t => {
  const h = await setup(t);
  const run = await h.finish(await h.run({ task: 'checks.run', input: { profile: 'fixture.mixed' } }));
  const items = await eventually(() => h.manager('/items'), rows => rows[0]?.notification_count > 0), item = items[0];
  const before = await h.manager(`/items/${item.id}`), { origin, ...legacy } = run;
  assert.ok(before.runs[0].session_id); assert.equal(before.events.filter(e => e.parent?.run_id === run.id).length, 0);
  await h.ingest([event(origin.agent_session_id, 'run.updated', '09:00:00', undefined, { engine: origin.engine, run: legacy, work_item_id: item.id })]);
  assert.equal((await h.manager(`/items/${item.id}`)).runs[0].session_id, before.runs[0].session_id);
});

for (const [profile, status] of [['fixture.pass', 'completed'], ['fixture.mixed', 'failed']]) {
  test(`deferred ${status} local check results attach to the first input and survive manager restarts`, async t => {
    const h = await setup(t), origin = { engine: 'codex', agent_session_id: `deferred-check-${status}`, turn_id: 'native-turn' };
    const requestedOwner = `before-input-${status}`, owner = `first-input-${status}`;
    const run = await h.finish(await h.run({ task: 'checks.run', input: { profile }, origin, work_item_id: requestedOwner }));
    assert.equal(run.status, status);
    assert.equal(run.engine, 'local');
    const batch = await h.runtime('/events?after=0');
    assert.ok(batch.events.length > 1);
    assert.ok(batch.events.every(event => event.kind === 'run.updated' && event.role === 'user'));
    assert.equal(batch.events.at(-1).run.status, status);
    await eventually(() => h.manager('/health'), health => health.events === batch.events.length);
    assert.deepEqual(await h.manager('/items'), [], 'execution observations must wait for the first user input');
    await h.stop('manager'); await h.start('manager');
    assert.deepEqual(await h.manager('/items'), [], 'unattached execution evidence must remain deferred across restart');

    // The first real input chooses the durable owner. Earlier unbound hints
    // must not create another item or keep the check result on a phantom item.
    const input = pair(origin.agent_session_id, '09:00:00', '09:05:00', origin.turn_id, {
      source: 'system_hook', work_item_id: owner, text: '등록된 로컬 검사를 수행해 주세요.'
    });
    await h.ingest(input);
    assert.deepEqual((await h.manager('/items')).map(item => item.id), [owner]);
    const detail = await h.manager(`/items/${owner}`);
    assert.equal(detail.sessions.length, 1);
    assert.equal(detail.runs.length, 1, 'all deferred run.updated events must rebuild the execution view');
    const retained = detail.runs[0];
    assert.equal(retained.id, run.id); assert.equal(retained.status, status);
    assert.equal(retained.work_item_id, owner); assert.equal(retained.session_id, detail.sessions[0].id);
    assert.deepEqual(retained.evidence, run.evidence);
    const stored = detail.events.filter(event => event.kind === 'run.updated');
    assert.equal(stored.length, batch.events.length);
    assert.deepEqual(stored.map(event => event.id).sort(), batch.events.map(event => event.id).sort());
    assert.ok(stored.every(event => event.work_item_id === owner && event.requested_work_item_id === requestedOwner));
    assert.deepEqual(await h.ingest(input), { inserted: 0, duplicates: input.length });
    await h.stop('manager'); await h.start('manager');
    const restarted = await h.manager(`/items/${owner}`);
    assert.deepEqual(restarted.runs, detail.runs);
    assert.deepEqual(restarted.sessions, detail.sessions);
    assert.equal(restarted.events.length, detail.events.length);
    assert.deepEqual((await h.manager('/items')).map(item => item.id), [owner]);
  });
}
