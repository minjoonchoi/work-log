import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, event, pair, eventually } from '../helpers.mjs';

async function setup(t, { runtime = false } = {}) {
  const h = new Harness();
  h.env = { HARNESS_TEST_WRITING_FIXTURE: JSON.stringify({ rewriteVariant: true }) };
  t.after(() => h.close());
  if (runtime) await h.start('runtime');
  await h.start('manager'); return h;
}

test('session list keeps agent-specific 20-minute windows, canonical merge ownership and deterministic recent activity', async t => {
  const h = await setup(t);
  await h.ingest([
    ...pair('author', '09:00:00', '09:05:00', 'first', { work_item_id: 'item-author', text: '첫 번째 계획\n상세 원문은 목록에 포함하지 않습니다.' }),
    ...pair('author', '09:25:00', '09:30:00', 'second', { work_item_id: 'item-author', text: '두 번째 구현' }),
    ...pair('reviewer', '09:02:00', '09:40:00', 'parallel', { engine: 'claude', work_item_id: 'item-review', text: '병렬 검토' }),
    ...pair('tie-one', '09:30:00', '09:40:00', 'tie', { work_item_id: 'item-tie', text: '같은 시각' }),
    ...pair('tie-two', '09:30:00', '09:40:00', 'tie', { work_item_id: 'item-tie', text: '같은 시각' }),
    ...pair('internal', '11:00:00', '11:20:00', 'worker', { role: 'worker', work_item_id: 'item-author',
      parent: { work_item_id: 'item-author', engine: 'codex', agent_session_id: 'author', turn_id: 'first' } })
  ]);
  const authorItem = (await h.manager('/items')).find(item => item.id === 'item-author');
  await h.manager('/items/item-author', { method: 'PATCH', body: { version: authorItem.version, title: '계획과 구현', description: '작업 흐름' } });
  const before = await h.manager('/sessions');
  assert.equal(before.length, 5);
  const author = before.filter(s => s.agent_session_id === 'author');
  assert.equal(author.length, 2, 'another agent output does not affect the author’s 20-minute boundary');
  assert.equal(author[0].title, '두 번째 구현'); assert.equal(author[1].title, '첫 번째 계획');
  assert.equal(author[1].closed, true); assert.equal(author[0].closed, false);
  assert.equal(author[1].description, ''); assert.equal(author[1].has_summary, false);
  assert.equal(before.some(s => s.agent_session_id === 'internal'), false);
  assert.equal(JSON.stringify(before).includes('상세 원문은 목록에 포함하지 않습니다.'), false);
  assert.equal(before.some(s => 'events' in s || 'history' in s || 'payload' in s), false);
  assert.deepEqual(before.map(s => s.id), [...before].sort((a, b) => b.end_at.localeCompare(a.end_at) || b.start_at.localeCompare(a.start_at) || a.id.localeCompare(b.id)).map(s => s.id));
  assert.equal(before[2].agent_session_id, 'reviewer');

  await h.manager('/merge', { method: 'POST', body: { ids: ['item-author', 'item-review'], target: 'item-author', operation_id: 'session-list-merge' } });
  const after = await h.manager('/sessions'), merged = after.find(s => s.agent_session_id === 'reviewer');
  assert.deepEqual(after.map(s => s.id), before.map(s => s.id));
  assert.equal(merged.work_item_id, 'item-author'); assert.equal(merged.work_item_title, author[0].work_item_title);
  const history = await h.manager(`/items/${merged.work_item_id}/history?session_id=${merged.id}`);
  assert.equal(history.records.length, 2);
  assert.ok(history.records.every(e => e.agent_session_id === 'reviewer'));
  assert.equal((await h.manager('/sessions?q=' + encodeURIComponent('병렬 검토'))).length, 3, 'merged aliases find every session of the surviving item');

  await h.ingest(pair('author', '09:45:00', '09:50:00', 'third', { work_item_id: 'item-author', text: '후속 확인' }));
  const updated = await h.manager('/sessions');
  assert.equal(updated[0].id, author[0].id, 'an input less than 20 minutes after output extends the same window');
  assert.equal(updated[0].last_activity, '2026-09-17T09:50:00.000Z');
  await h.stop('manager'); await h.start('manager');
  assert.deepEqual(await h.manager('/sessions'), updated);
});

test('generated summary supplies list and calendar labels and search, while item ranges keep work item labels', async t => {
  const h = await setup(t, { runtime: true });
  await h.ingest([
    event('summary-author', 'input', '09:00:00', 'one', { work_item_id: 'summary-item', text: '화면 설계' }),
    event('summary-author', 'output', '09:10:00', 'one', { work_item_id: 'summary-item', text: '접근성 분석 결과를 정리했습니다.' }),
    ...pair('summary-parallel', '09:05:00', '09:15:00', 'two', { work_item_id: 'summary-item', text: '병렬 결과' })
  ]);
  const initial = await h.manager('/sessions'), sid = initial.find(s => s.agent_session_id === 'summary-author').id;
  const item = (await h.manager('/items'))[0];
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: '대표 업무', description: '출시 준비 범위' } });
  await h.manager(`/sessions/${sid}/summary/regenerate`, { method: 'POST', body: { operation_id: 'session-list-summary' } });
  const done = await eventually(() => h.manager('/writing/session-list-summary'), r => !['pending', 'running'].includes(r.state), 20000);
  assert.equal(done.state, 'completed');
  const detail = await h.manager(`/items/${item.id}`), text = detail.sessions.find(s => s.id === sid).summary.text;
  const [title, ...body] = text.split('\n'), row = (await h.manager('/sessions')).find(s => s.id === sid);
  assert.equal(row.title, title); assert.equal(row.description, body.join('\n').trim());
  assert.equal(row.work_item_title, '대표 업무'); assert.equal(row.has_summary, true); assert.equal(row.summary_state, 'completed');
  assert.equal((await h.manager('/sessions?q=' + encodeURIComponent('접근성 분석')))[0].id, sid);
  assert.equal((await h.manager('/sessions?q=' + encodeURIComponent('작업 기록')))[0].id, sid);
  assert.equal((await h.manager('/sessions?q=' + encodeURIComponent('출시 준비'))).length, 2);
  const range = '/calendar?start=2026-09-17T00:00:00Z&end=2026-09-18T00:00:00Z';
  const sessionCalendar = await h.manager(`${range}&mode=sessions`), itemCalendar = await h.manager(`${range}&mode=items`);
  assert.equal(sessionCalendar.find(s => s.id === sid).title, title);
  assert.equal(sessionCalendar.find(s => s.id === sid).work_item_title, '대표 업무');
  assert.equal(itemCalendar.length, 1); assert.equal(itemCalendar[0].title, '대표 업무');
  assert.equal(itemCalendar[0].session_ids.length, 2);
});

test('real hooks update session listing from agent response through user question to response completion', async t => {
  const h = await setup(t), base = { session_id: 'session-list-hooks', turn_id: 'first' };
  h.hook('claude', { ...base, hook_event_name: 'SessionStart' });
  await eventually(() => h.manager('/health'), result => result.events === 1);
  assert.deepEqual(await h.manager('/sessions'), [], 'agent startup is not itself a work item session');
  h.hook('claude', { ...base, hook_event_name: 'UserPromptSubmit', prompt: '승인 화면을 작성하세요.' });
  const [pending] = await eventually(() => h.manager('/sessions'), rows => rows.length === 1);
  assert.equal(pending.pending, true); assert.equal('waiting_for_user' in pending, false); assert.equal(pending.engine, 'claude');
  const tool = { tool_name: 'AskUserQuestion', tool_use_id: 'approval-question', tool_input: { questions: [{ question: '승인자는 누구인가요?' }] } };
  h.hook('claude', { ...base, ...tool, hook_event_name: 'PreToolUse' });
  await eventually(() => h.manager('/health'), result => result.events === 3);
  const [waiting] = await h.manager('/sessions');
  assert.deepEqual(await h.manager('/notifications'), []);
  assert.equal(waiting.id, pending.id); assert.equal(waiting.pending, true);
  h.hook('claude', { ...base, ...tool, hook_event_name: 'PostToolUse', tool_response: { answers: { '승인자는 누구인가요?': '팀장' } } });
  await eventually(() => h.manager('/health'), result => result.events === 4);
  h.hook('claude', { ...base, hook_event_name: 'Stop', last_assistant_message: '승인 화면을 작성했습니다.' });
  const [completed] = await eventually(() => h.manager('/sessions'), rows => rows[0]?.pending === false);
  assert.equal(completed.id, pending.id); assert.equal('waiting_for_user' in completed, false);
  assert.equal(completed.has_summary, false); assert.equal(completed.description, '');
});

test('session list validates search parameters and returns empty results without changing tracked data', async t => {
  const h = await setup(t);
  assert.deepEqual(await h.manager('/sessions'), []);
  for (const query of ['q=' + 'a'.repeat(501), 'q=a&q=b', 'limit=4']) {
    await assert.rejects(h.manager(`/sessions?${query}`), error => error.status === 400);
  }
  await h.ingest(pair('bounded', '09:00:00', '09:05:00', 'first', { text: 'x'.repeat(400) }));
  assert.equal((await h.manager('/sessions'))[0].title.length, 200);
  assert.deepEqual(await h.manager('/sessions?q=not-present'), []);
  assert.equal((await h.manager('/sessions?q=%20%20')).length, 1);
  assert.equal((await h.manager('/health')).events, 2);
});
