import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, event, pair, eventually } from '../helpers.mjs';

async function setup(t) { const h = await new Harness().start('manager'); t.after(() => h.close()); return h; }
const questionTool = { tool_name: 'AskUserQuestion', tool_use_id: 'question-one', tool_input: { questions: [{ question: '승인자는 팀장인가요?', header: '승인자', options: [{ label: '팀장' }, { label: '프로젝트 관리자' }], multiSelect: false }] } };
const questionEvent = (agent, kind, at, extra = {}) => event(agent, kind, at, 't1', { engine: 'claude', source: 'system_hook', call_id: questionTool.tool_use_id,
  text: JSON.stringify({ name: questionTool.tool_name, input: questionTool.tool_input }), ...extra });

test('real question hooks distinguish agent response, user reply and answered-tool continuation without changing I/O history', async t => {
  const h = await setup(t), base = { session_id: 'question-hooks', turn_id: 't1' };
  h.hook('claude', { ...base, hook_event_name: 'UserPromptSubmit', prompt: '승인 화면을 기획해 주세요.' });
  await eventually(() => h.manager('/quick'), q => q.current[0]?.activity === 'agent_response_pending');
  h.hook('claude', { ...base, ...questionTool, hook_event_name: 'PreToolUse' });
  const waiting = await eventually(() => h.manager('/quick'), q => q.counts.waiting === 1);
  assert.equal(waiting.counts.current, 0);
  const itemId = waiting.waiting[0].id, before = await h.manager(`/items/${itemId}?view=summary`);
  assert.equal(before.questions[0].text, '승인자는 팀장인가요?');
  assert.equal(before.sessions[0].waiting_for_user, true); assert.equal(before.sessions[0].history.count, 1);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager('/quick')).counts.waiting, 1);
  h.hook('claude', { ...base, ...questionTool, hook_event_name: 'PostToolUse', tool_response: { answers: { '승인자는 팀장인가요?': '팀장' } } });
  await eventually(() => h.manager('/quick'), q => q.counts.waiting === 0 && q.current[0]?.activity === 'agent_response_pending');
  h.hook('claude', { ...base, hook_event_name: 'Stop', last_assistant_message: '팀장 승인 흐름을 반영했습니다.' });
  await eventually(() => h.manager('/quick'), q => q.counts.current === 0 && q.recent.length === 1);
  const after = await h.manager(`/items/${itemId}?view=summary`);
  assert.equal(after.questions.length, 0); assert.equal(after.sessions[0].history.count, 2);
  assert.equal(after.sessions[0].id, before.sessions[0].id);
});

test('generic blocked, ordinary tools and question-like output never imply a user question', async t => {
  const h = await setup(t);
  await h.ingest([
    ...pair('plain-question', '09:00:00', '09:01:00', 't1', { text: '어느 DB를 사용할까요?' }),
    event('ordinary', 'input', '09:00:00'),
    event('ordinary', 'tool.started', '09:01:00', 't1', { call_id: 'tool', source: 'system_hook', text: JSON.stringify({ name: 'Bash', input: { command: 'echo "질문"' } }) }),
    ...pair('blocked', '09:00:00', '09:01:00', 't1', { work_item_id: 'blocked' }),
    event('blocked', 'run.updated', '09:02:00', 't1', { work_item_id: 'blocked', run: { id: 'blocked-run', status: 'blocked', message: '대상 고객 정보가 필요합니다.' } })
  ]);
  const q = await h.manager('/quick');
  assert.equal(q.counts.waiting, 0); assert.equal(q.attention[0].id, 'blocked');
  assert.equal(q.current[0].activity, 'agent_response_pending');
});

test('failed question tool clears user reply without fabricating an answer or a Stop record', async t => {
  const h = await setup(t), base = { session_id: 'failed-question', turn_id: 't1' };
  h.hook('claude', { ...base, hook_event_name: 'UserPromptSubmit', prompt: '권한 설계' });
  h.hook('claude', { ...base, ...questionTool, hook_event_name: 'PreToolUse' });
  const waiting = await eventually(() => h.manager('/quick'), q => q.counts.waiting === 1);
  h.hook('claude', { ...base, ...questionTool, hook_event_name: 'PostToolUseFailure', error: '질문 도구 실행 실패' });
  await eventually(() => h.manager('/quick'), q => q.counts.waiting === 0 && q.current[0]?.activity === 'agent_response_pending');
  const detail = await h.manager(`/items/${waiting.waiting[0].id}`);
  assert.equal(detail.events.filter(e => e.kind === 'output').length, 0);
  assert.equal(detail.events.at(-1).hook_event_name, 'PostToolUseFailure');
});

test('late hook completion, superseding input and session end remove only the matching outstanding questions', async t => {
  const h = await setup(t);
  const a = event('a', 'input', '09:00:00', 't1', { engine: 'claude' }), b = event('b', 'input', '09:00:00', 't1', { engine: 'claude' });
  await h.ingest([a, b, questionEvent('a', 'tool.started', '09:01:00'), questionEvent('b', 'tool.started', '09:01:00')]);
  assert.equal((await h.manager('/quick')).counts.waiting, 2);
  await h.ingest([questionEvent('a', 'tool.finished', '09:02:00')]);
  assert.equal((await h.manager('/quick')).counts.waiting, 1);
  // Reordered collection is reconstructed by original event time, never by receipt time.
  await h.ingest([questionEvent('a', 'tool.started', '09:01:30')]);
  assert.equal((await h.manager('/quick')).counts.waiting, 1);
  await h.ingest([event('b', 'input', '09:03:00', 't2', { engine: 'claude' })]);
  assert.equal((await h.manager('/quick')).counts.waiting, 0);
  await h.ingest([questionEvent('b', 'tool.started', '09:04:00', { turn_id: 't2' }), event('b', 'session.ended', '09:05:00', null, { engine: 'claude' })]);
  assert.equal((await h.manager('/quick')).counts.waiting, 0);
});

test('merged work prioritizes user reply without losing another agent running; missing call correlation and internal workers do not add questions', async t => {
  const h = await setup(t);
  await h.ingest([event('a', 'input', '09:00:00', 't1', { engine: 'claude', work_item_id: 'a' }), questionEvent('a', 'tool.started', '09:01:00'),
    event('b', 'input', '09:00:00', 't1', { work_item_id: 'b' }), event('b', 'run.updated', '09:01:00', 't1', { run: { id: 'other-run', status: 'running' } })]);
  await h.manager('/merge', { method: 'POST', body: { ids: ['a', 'b'], target: 'a', operation_id: 'merge-waits' } });
  const q = await h.manager('/quick'); assert.equal(q.counts.total, 1); assert.equal(q.counts.waiting, 1);
  assert.deepEqual(q.waiting[0].activities, ['waiting_for_user', 'running']);
  const before = await h.manager('/items/a?view=summary');
  assert.equal(before.questions.length, 1); assert.equal(before.questions[0].work_item_id, 'a');
  await h.ingest([questionEvent('internal', 'tool.started', '09:01:00', { role: 'worker', work_item_id: 'a' }),
    questionEvent('b', 'tool.started', '09:01:00', { engine: 'codex' }), questionEvent('a', 'tool.started', '09:01:00', { call_id: null })]);
  assert.equal((await h.manager('/items/a?view=summary')).questions.length, 1);
});

test('existing stored hook events rebuild the question projection on upgrade without altering session history', async t => {
  const h = await setup(t);
  await h.ingest([event('upgrade', 'input', '09:00:00', 't1', { engine: 'claude' }), questionEvent('upgrade', 'tool.started', '09:01:00')]);
  const [item] = await h.manager('/items'), before = await h.manager(`/items/${item.id}`);
  await h.stop('manager');
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  db.exec("DROP TABLE user_questions; DELETE FROM cursors WHERE source='projection.user-questions.v1'"); db.close();
  await h.start('manager');
  const after = await h.manager(`/items/${item.id}`);
  assert.deepEqual(after.questions, before.questions); assert.deepEqual(after.events, before.events); assert.deepEqual(after.sessions, before.sessions);
});

test('dispatcher concurrency queue is separate from running work and agent response; cancellation releases the queued run', async t => {
  const h = await setup(t); await h.start('runtime');
  const runs = [];
  for (let n = 0; n < 4; n++) runs.push(await h.run({ fixture: { scenario: 'slow', delayMs: 15000 } }));
  const q = await eventually(() => h.manager('/quick'), v => v.current.some(i => i.activity === 'queued') && v.current.filter(i => i.activity === 'running').length === 3);
  assert.equal(q.counts.waiting, 0); assert.equal(q.current.filter(i => i.activity === 'agent_response_pending').length, 0);
  const queuedRun = runs.at(-1);
  await h.runtime(`/runs/${runs[0].id}/cancel`, { method: 'POST', body: {} });
  await eventually(() => h.runtime(`/runs/${queuedRun.id}`), r => r.status === 'running');
  await eventually(() => h.manager('/quick'), v => v.current.every(i => i.activity === 'running'));
  for (const run of runs) await h.runtime(`/runs/${run.id}/cancel`, { method: 'POST', body: {} });
});
