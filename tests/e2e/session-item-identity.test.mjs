import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, event, pair, eventually } from '../helpers.mjs';

const post = body => ({ method: 'POST', body });
async function setup(t, runtime = false) {
  const h = new Harness(); h.env = { HARNESS_TEST_WRITING_FIXTURE: '{}' };
  t.after(() => h.close());
  if (runtime) await h.start('runtime');
  await h.start('manager'); return h;
}
function rows(h, sql) {
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); }
}
async function onlyItem(h, owner) {
  assert.deepEqual((await h.manager('/items')).map(item => item.id), [owner]);
  assert.deepEqual(rows(h, 'SELECT id FROM work_items ORDER BY id').map(row => row.id), [owner], 'conflicting references must not create empty items');
  return h.manager(`/items/${owner}`);
}

test('first input binding wins over lifecycle hints, out-of-order timestamps and idle gaps', async t => {
  const h = await setup(t), owner = 'first-session-owner';
  await h.ingest([event('native-fixed', 'session.started', '09:00:00', null, { work_item_id: 'ignored-start-owner' })]);
  assert.deepEqual(await h.manager('/items'), []);
  const events = [
    ...pair('native-fixed', '09:01:00', '09:05:00', 'one', { work_item_id: owner, text: '첫 사용자 원문' }),
    ...pair('native-fixed', '09:25:00', '09:26:00', 'two', { work_item_id: 'ignored-gap-owner', parent: { work_item_id: 'ignored-parent-owner' }, text: '20분 뒤 사용자 원문' })
  ];
  await h.ingest(events);
  const initial = await onlyItem(h, owner);
  assert.equal(initial.sessions.length, 2); assert.ok(initial.sessions.every(session => session.work_item_id === owner));
  const late = pair('native-fixed', '08:00:00', '08:01:00', 'earlier', { work_item_id: 'ignored-older-owner', observed_at: '2026-09-17T12:00:00.000Z', text: '늦게 도착한 과거 원문' });
  await h.ingest(late);
  const detail = await onlyItem(h, owner); assert.equal(detail.sessions.length, 3);
  for (const original of [...events, ...late]) {
    const stored = detail.events.find(row => row.id === original.id);
    assert.equal(stored.text, original.text); assert.equal(stored.event_at, new Date(original.event_at).toISOString());
    assert.equal(stored.work_item_id, owner); assert.equal(stored.agent_session_id, original.agent_session_id);
    assert.equal(stored.requested_work_item_id, original.work_item_id !== owner ? original.work_item_id : undefined);
    if (original.observed_at) assert.equal(stored.observed_at, original.observed_at);
  }
  assert.deepEqual(await h.ingest(events), { inserted: 0, duplicates: events.length });
});

test('worker and metadata references use an already bound parent without adding user windows', async t => {
  const h = await setup(t), owner = 'known-parent-owner';
  await h.ingest(pair('known-parent', '09:00:00', '09:05:00', 'parent-turn', { work_item_id: owner }));
  const before = await h.manager(`/items/${owner}`), session = before.sessions[0];
  for (const role of ['worker', 'metadata']) await h.ingest(pair(`${role}-child`, '10:00:00', '10:20:00', `${role}-turn`, {
    role, work_item_id: `${role}-incorrect-owner`, parent: { engine: 'codex', agent_session_id: 'known-parent', turn_id: 'parent-turn', work_item_id: `${role}-incorrect-parent` }
  }));
  const detail = await onlyItem(h, owner);
  assert.deepEqual(detail.sessions, before.sessions);
  const internal = detail.events.filter(row => row.role !== 'user');
  assert.equal(internal.length, 4); assert.ok(internal.every(row => row.work_item_id === owner && row.session_id === session.id && row.resolution === 'parent'));
  assert.ok(internal.every(row => row.parent.work_item_id === owner && row.requested_work_item_id === `${row.role}-incorrect-owner`
    && row.parent.requested_work_item_id === `${row.role}-incorrect-parent`));
  assert.ok(detail.agents.every(agent => agent.work_item_id === owner));
});

test('a worker delivered before its native parent reserves the parent binding for later real hooks', async t => {
  const h = await setup(t), owner = 'worker-first-owner';
  const first = pair('first-worker', '09:00:00', '09:02:00', 'attempt', {
    role: 'worker', work_item_id: owner, parent: { engine: 'claude', agent_session_id: 'late-native', turn_id: 'native-turn', work_item_id: owner }
  });
  await h.ingest(first);
  const pending = await onlyItem(h, owner); assert.equal(pending.sessions.length, 0);
  assert.equal(pending.events.filter(row => row.role === 'user').length, 0, 'reserving a parent binding must not fabricate native history');
  const contextPath = '/agent-context?engine=claude&session_id=late-native';
  assert.deepEqual(await h.manager(contextPath), { work_item_id: owner, origin: null });
  h.hook('claude', { session_id: 'late-native', turn_id: 'native-turn', hook_event_name: 'UserPromptSubmit', prompt: '뒤늦게 전달된 실제 입력' });
  await eventually(() => h.manager('/health'), health => health.events === 3);
  assert.deepEqual(await h.manager(contextPath), { work_item_id: owner,
    origin: { engine: 'claude', agent_session_id: 'late-native', turn_id: 'native-turn' } });
  h.hook('claude', { session_id: 'late-native', turn_id: 'native-turn', hook_event_name: 'Stop', last_assistant_message: '실제 출력' });
  await eventually(() => h.manager('/health'), health => health.events === 4);
  const detail = await onlyItem(h, owner);
  assert.equal(detail.sessions.length, 1); assert.equal(detail.sessions[0].pending, false);
  assert.ok(detail.events.filter(row => row.role === 'worker').every(row => row.session_id === detail.sessions[0].id));
  assert.deepEqual(detail.events.filter(row => row.role === 'user').map(row => row.text), ['뒤늦게 전달된 실제 입력', '실제 출력']);
  await h.ingest([event('late-native', 'session.started', '08:00:00', null, { engine: 'claude', work_item_id: 'ignored-late-start' })]);
  assert.equal((await onlyItem(h, owner)).sessions.length, 1);
});

test('merged aliases keep continuous session identity when later events name the representative or an unrelated item', async t => {
  const h = await setup(t);
  await h.ingest([...pair('alias-agent', '09:00:00', '09:05:00', 'one', { work_item_id: 'alias-owner' }),
    ...pair('target-agent', '09:00:00', '09:05:00', 'other', { work_item_id: 'representative' })]);
  const original = (await h.manager('/items/alias-owner')).sessions[0];
  await h.manager('/merge', post({ ids: ['alias-owner', 'representative'], target: 'representative', operation_id: 'merge-session-owner' }));
  await h.ingest([...pair('alias-agent', '09:10:00', '09:12:00', 'two', { work_item_id: 'representative' }),
    ...pair('alias-agent', '09:15:00', '09:17:00', 'three', { work_item_id: 'must-not-split-alias' })]);
  assert.deepEqual((await h.manager('/items')).map(item => item.id), ['representative']);
  const detail = await h.manager('/items/alias-owner');
  assert.equal(detail.item.id, 'representative'); assert.equal(detail.sessions.length, 2);
  const continued = detail.sessions.find(session => session.id === original.id);
  assert.equal(continued.end_at, '2026-09-17T09:17:00.000Z'); assert.equal(continued.original_work_item_id, 'alias-owner');
  assert.ok(detail.events.filter(row => row.agent_session_id === 'alias-agent').every(row => row.work_item_id === 'alias-owner'));
  assert.deepEqual(rows(h, 'SELECT id FROM work_items ORDER BY id').map(row => row.id), ['alias-owner', 'representative']);
});

test('late conflicting hints cannot resurrect a deleted item or escape its hidden parent through a worker', async t => {
  const h = await setup(t), owner = 'deleted-owner';
  await h.ingest(pair('deleted-native', '09:00:00', '09:05:00', 'one', { work_item_id: owner }));
  await h.manager('/items/delete', post({ ids: [owner], operation_id: 'hide-fixed-session' }));
  const late = pair('deleted-native', '10:00:00', '10:05:00', 'two', { work_item_id: 'would-resurrect' });
  await h.ingest([...late, ...pair('hidden-worker', '10:01:00', '10:02:00', 'attempt', { role: 'worker', work_item_id: 'worker-escape',
    parent: { engine: 'codex', agent_session_id: 'deleted-native', turn_id: 'two', work_item_id: 'parent-escape' } })]);
  await h.stop('manager'); await h.start('manager');
  assert.deepEqual(await h.manager('/items'), []);
  assert.deepEqual((await h.manager('/items?trash=true')).map(item => item.id), [owner]);
  assert.deepEqual(rows(h, 'SELECT id FROM work_items').map(row => row.id), [owner]);
  await assert.rejects(h.manager(`/items/${owner}`), error => error.status === 404);
  await h.manager('/items/restore', post({ ids: [owner], operation_id: 'restore-fixed-session' }));
  const detail = await onlyItem(h, owner); assert.equal(detail.sessions.length, 2);
  assert.ok(detail.events.every(row => row.work_item_id === owner));
  assert.deepEqual(await h.ingest(late), { inserted: 0, duplicates: 2 });
});

test('identical native session and event IDs from different engines keep separate bindings', async t => {
  const h = await setup(t), common = pair('same-native-id', '09:00:00', '09:05:00', 'same-turn');
  await h.ingest([...common, ...common.map(row => ({ ...row, engine: 'claude' }))]);
  const items = await h.manager('/items'); assert.equal(items.length, 2);
  const details = await Promise.all(items.map(item => h.manager(`/items/${item.id}`)));
  const byEngine = Object.fromEntries(details.map(detail => [detail.agents[0].engine, detail.item.id]));
  assert.notEqual(byEngine.codex, byEngine.claude);
  for (const engine of ['codex', 'claude']) await h.ingest(pair('same-native-id', '09:10:00', '09:12:00', 'second-turn', {
    engine, work_item_id: byEngine[engine === 'codex' ? 'claude' : 'codex']
  }));
  assert.equal((await h.manager('/items')).length, 2);
  for (const engine of ['codex', 'claude']) {
    const detail = await h.manager(`/items/${byEngine[engine]}`);
    assert.equal(detail.sessions.length, 1); assert.equal(detail.events.length, 4);
    assert.ok(detail.events.every(row => row.engine === engine && row.work_item_id === byEngine[engine]));
  }
});

test('concurrent first inputs choose one durable binding and retries after restart keep original records', async t => {
  const h = await setup(t);
  const inputs = ['alpha', 'beta', 'gamma'].map((name, index) => event('parallel-native', 'input', `09:0${index}:00`, name, {
    work_item_id: `parallel-${name}`, text: `동시 입력 ${name}`
  }));
  const accepted = await Promise.all(inputs.map(row => h.ingest([row])));
  assert.ok(accepted.every(result => result.inserted === 1));
  const items = await h.manager('/items'); assert.equal(items.length, 1); const owner = items[0].id;
  assert.ok(inputs.some(row => row.work_item_id === owner));
  const before = await onlyItem(h, owner); assert.equal(before.events.length, 3);
  await h.stop('manager'); await h.start('manager');
  const retried = inputs.map(row => ({ ...row, work_item_id: 'retry-reference-must-not-create' }));
  assert.deepEqual(await h.ingest(retried), { inserted: 0, duplicates: 3 });
  await h.ingest(inputs.map((row, index) => event('parallel-native', 'output', `09:1${index}:00`, row.turn_id, {
    work_item_id: `output-${index}`, text: `출력 ${row.turn_id}`
  })));
  const detail = await onlyItem(h, owner); assert.equal(detail.events.length, 6);
  for (const prior of before.events) assert.deepEqual(detail.events.find(row => row.id === prior.id), prior);
  await assert.rejects(h.ingest([{ ...inputs[0], text: '같은 원본 ID의 다른 본문' }]), error => error.status === 409);
  assert.equal((await onlyItem(h, owner)).events.length, 6);
});

test('real fixture orchestration with a conflicting item hint remains linked to the original native task', async t => {
  const h = await setup(t, true), owner = 'native-orchestration-owner';
  const origin = { engine: 'codex', agent_session_id: 'orchestration-native', turn_id: 'native-turn' };
  await h.ingest([event(origin.agent_session_id, 'input', '09:00:00', origin.turn_id, { work_item_id: owner, text: '요구사항을 작성하고 엔티티를 설계하세요.' })]);
  const body = { prompt: '요구사항 작성 후 엔티티 설계', engine: 'fixture', idempotency_key: 'session-identity-orchestration',
    origin, work_item_id: 'conflicting-plan-item', steps: [
      { id: 'prd', task: 'prd.create', output_key: 'prd', request_excerpt: '요구사항 작성', input: { requirements: '가입 초대 요구사항을 작성하세요.' }, depends_on: [] },
      { id: 'entity', task: 'entity.design', output_key: 'entity', request_excerpt: '엔티티 설계', input: { requirements: '선행 요구사항을 근거로 초대 엔티티를 설계하세요.' }, depends_on: ['prd'] }
    ] };
  const plan = await h.runtime('/plans', post(body));
  const done = await eventually(() => h.runtime(`/plans/${plan.id}`), value => !['pending', 'running'].includes(value.status), 20000);
  assert.equal(done.status, 'completed', done.message);
  await eventually(() => h.manager(`/items/${owner}`), detail => detail.runs.length === 2 && detail.runs.every(run => run.status === 'completed'));
  await h.ingest([event(origin.agent_session_id, 'output', '09:10:00', origin.turn_id, { work_item_id: 'conflicting-stop-item', text: '검증한 결과를 전달합니다.' })]);
  const detail = await onlyItem(h, owner); assert.equal(detail.sessions.length, 1); assert.equal(detail.sessions[0].pending, false);
  assert.equal(detail.events.filter(row => row.role === 'user' && ['input', 'output'].includes(row.kind)).length, 2);
  assert.ok(detail.events.some(row => row.role === 'worker'));
  assert.ok(detail.events.every(row => row.work_item_id === owner));
  assert.ok(detail.runs.every(run => run.work_item_id === owner && run.session_id === detail.sessions[0].id));
  assert.equal((await h.runtime('/plans', post(body))).id, plan.id);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await onlyItem(h, owner)).runs.length, 2);
});

test('preexisting split history is retained while subsequent input returns to the original session binding', async t => {
  const h = await setup(t), owner = 'legacy-first-owner';
  await h.ingest([...pair('legacy-native', '09:00:00', '09:05:00', 'first', { work_item_id: owner }),
    ...pair('legacy-native', '10:00:00', '10:05:00', 'second', { work_item_id: owner })]);
  const before = await h.manager(`/items/${owner}`), second = before.sessions[1];
  await h.stop('manager');
  // Seed the exact persisted shape older versions allowed: the agent remains
  // bound to the first item while its later input/session points at another.
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  try {
    db.prepare('INSERT INTO work_items(id,title,created_at) VALUES(?,?,?)').run('legacy-split-owner', '이전 버전 분리 이력', '2026-09-17T10:00:00.000Z');
    db.prepare('UPDATE work_item_sessions SET work_item_id=? WHERE id=?').run('legacy-split-owner', second.id);
    for (const row of db.prepare("SELECT id,payload FROM events WHERE json_extract(payload,'$.turn_id')='second'").all()) {
      db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.payload), work_item_id: 'legacy-split-owner' }), row.id);
    }
    db.exec('DROP TABLE agent_item_bindings');
  } finally { db.close(); }
  const original = rows(h, 'SELECT id,payload FROM events ORDER BY seq');
  await h.start('manager');
  assert.deepEqual(rows(h, `SELECT b.work_item_id FROM agent_item_bindings b JOIN agent_sessions a ON a.id=b.agent_id
    WHERE a.engine='codex' AND a.source_id='legacy-native'`), [{ work_item_id: owner }]);
  assert.deepEqual(new Set((await h.manager('/items')).map(item => item.id)), new Set([owner, 'legacy-split-owner']));
  assert.equal((await h.manager('/items/legacy-split-owner')).sessions[0].id, second.id);
  await h.ingest(pair('legacy-native', '11:00:00', '11:05:00', 'third', { work_item_id: 'new-split-forbidden' }));
  assert.deepEqual(rows(h, 'SELECT id,payload FROM events ORDER BY seq').slice(0, original.length), original);
  assert.equal((await h.manager(`/items/${owner}`)).sessions.length, 2);
  assert.equal((await h.manager('/items/legacy-split-owner')).sessions[0].id, second.id);
  assert.deepEqual(rows(h, 'SELECT id FROM work_items ORDER BY id').map(row => row.id), [owner, 'legacy-split-owner']);
});
