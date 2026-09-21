import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, event, pair, eventually } from '../helpers.mjs';

async function setup(t) { const h = await new Harness().start('manager'); t.after(() => h.close()); return h; }
const question = { tool_name: 'AskUserQuestion', tool_use_id: 'question-one', tool_input: { questions: [{ question: '승인자는 누구인가요?' }] } };

test('native question hooks remain raw history without GUI question state or notifications', async t => {
  const h = await setup(t), base = { session_id: 'question-history', turn_id: 'first' };
  h.hook('claude', { ...base, hook_event_name: 'UserPromptSubmit', prompt: '승인 화면을 기획해 주세요.' });
  h.hook('claude', { ...base, ...question, hook_event_name: 'PreToolUse' });
  await eventually(() => h.manager('/health'), health => health.events === 2);
  const item = (await h.manager('/items'))[0], before = await h.manager(`/items/${item.id}`);
  assert.equal('questions' in before, false); assert.equal('waiting_for_user' in before.sessions[0], false);
  assert.equal(before.sessions[0].pending, true); assert.equal(before.events[1].hook_event_name, 'PreToolUse');
  assert.match(before.events[1].text, /승인자는 누구인가요/);
  const overview = await h.manager('/quick');
  assert.deepEqual(overview.counts, { current: 1, recent: 0, total: 1, notifications: 0 });
  assert.equal('waiting' in overview, false); assert.equal('attention' in overview, false);
  assert.deepEqual(await h.manager('/notifications'), []);
  h.hook('claude', { ...base, ...question, hook_event_name: 'PostToolUse', tool_response: { answers: { '승인자는 누구인가요?': '팀장' } } });
  h.hook('claude', { ...base, hook_event_name: 'Stop', last_assistant_message: '팀장 승인 흐름을 반영했습니다.' });
  await eventually(() => h.manager('/health'), health => health.events === 4);
  const after = await h.manager(`/items/${item.id}`);
  assert.equal(after.sessions[0].id, before.sessions[0].id); assert.equal(after.sessions[0].pending, false);
  assert.equal(after.events.length, 4); assert.deepEqual(await h.manager('/notifications'), []);
});

test('old question projections are ignored and preserved, while new hooks keep original session boundaries', async t => {
  const h = await setup(t); await h.ingest(pair('legacy-question', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0], before = await h.manager(`/items/${item.id}`);
  await h.stop('manager');
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS user_questions(id TEXT PRIMARY KEY, text TEXT NOT NULL)');
  db.prepare('INSERT INTO user_questions VALUES(?,?)').run('legacy', '이전 질문 원문'); db.close();
  await h.start('manager');
  await h.ingest([event('legacy-question', 'input', '09:10:00', 'next')]);
  const after = await h.manager(`/items/${item.id}`);
  assert.equal(after.sessions[0].id, before.sessions[0].id); assert.equal('questions' in after, false);
  assert.deepEqual(await h.manager('/notifications'), []);
  const saved = new DatabaseSync(path.join(h.dir, 'memory.sqlite'), { readOnly: true });
  assert.equal(saved.prepare('SELECT text FROM user_questions WHERE id=?').get('legacy').text, '이전 질문 원문'); saved.close();
});

test('ordinary errors and native failures never become managed work notifications', async t => {
  const h = await setup(t);
  await h.ingest([...pair('ordinary', '09:00:00', '09:05:00', 'first', { text: '작업 중 오류가 있었지만 응답을 마쳤습니다.' }),
    event('native-failed', 'input', '10:00:00'), event('native-failed', 'turn.failed', '10:01:00', 't1', { text: '도구 실행 실패' })]);
  assert.deepEqual(await h.manager('/notifications'), []);
  assert.equal((await h.manager('/quick')).counts.notifications, 0);
});
