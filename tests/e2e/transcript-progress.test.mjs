import { Harness, eventually } from '../helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managerStore } from '../../src/manager-store.mjs';
import { integrationStore } from '../../src/integration-store.mjs';
import { writingStore } from '../../src/writing-store.mjs';
import { transcriptProgress } from '../../src/transcript-progress.mjs';

function setup(t, engine = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-progress-')), file = path.join(dir, 'rollout.jsonl');
  const store = managerStore(dir), integrations = integrationStore(store), writings = writingStore(store, integrations);
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const append = row => fs.appendFileSync(file, JSON.stringify(row) + '\n');
  append({ type: 'session_meta', payload: { id: 'test-session', cli_version: '0.120.0', source: 'cli' } });
  const input = { id: 'prompt-one', engine, agent_session_id: 'test-session', kind: 'input', role: 'user',
    event_at: '2026-10-02T00:00:00Z', turn_id: 'turn-one', source_turn_id: engine === 'claude' ? null : 'turn-one', turn_source: engine === 'claude' ? 'local' : 'native',
    hook_schema: 2, source: 'system_hook', transcript_path: file, text: '작업 요청' };
  store.ingestMany([input]);
  append({ type: 'turn_context', payload: { turn_id: 'turn-one' } });
  const message = (phase, text, timestamp = '2026-10-02T00:01:00Z') => ({ type: 'response_item', timestamp,
    payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] } });
  return { store, integrations, writings, file, append, input, message, collector: transcriptProgress(store) };
}

test('live commentary belongs to its prompt, stays pending, enters summaries and never counts as final output', t => {
  const c = setup(t);
  c.append(c.message('commentary', '3/3: Sync 연결을 구현했습니다.'));
  c.append(c.message('final_answer', '최종 답변'));
  c.append({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: '비공개 추론' }] } });
  assert.equal(c.collector.collect(), 1);
  const session = c.store.sessionList()[0], events = c.store.sessionMessages(session.id);
  assert.deepEqual(events.map(e => e.kind), ['input', 'progress']);
  assert.equal(events[1].text, '3/3: Sync 연결을 구현했습니다.');
  assert.equal(events[1].turn_id, 'turn-one');
  assert.equal(events[1].resolution, 'matched'); assert.equal(session.pending, true);
  assert.equal(c.store.history(session.work_item_id, { session_id: session.id }).records.length, 2);
  c.writings.saveAutomationSettings({ initial_output_count: 1 });
  assert.equal(c.writings.scheduleAutomatic({ summaries: false, metadata: true }), false);
  const request = c.writings.enqueue('session-summary', session.id, { operation_id: 'progress-summary-test' });
  assert.equal(request.snapshot.input.sessions[0].events[1].kind, 'progress');
  assert.equal(c.collector.collect(), 0);
  c.store.ingestMany([{ ...c.input, id: 'stop-one', kind: 'output', text: '최종 답변', event_at: '2026-10-02T00:02:00Z' }]);
  assert.equal(c.store.sessionList()[0].pending, false);
  assert.equal(c.store.sessionMessages(session.id).filter(e => e.kind === 'output').length, 1);
});

test('partial UTF-8 records survive append and collector restart without duplicates', t => {
  const c = setup(t), bytes = Buffer.from(JSON.stringify(c.message('commentary', '진행 메시지')) + '\n');
  fs.appendFileSync(c.file, bytes.subarray(0, bytes.length - 5));
  assert.equal(c.collector.collect(), 0);
  fs.appendFileSync(c.file, bytes.subarray(bytes.length - 5));
  assert.equal(transcriptProgress(c.store).collect(), 1);
  assert.equal(transcriptProgress(c.store).collect(), 0);
  c.store.db.exec('DELETE FROM transcript_progress_cursors');
  assert.equal(transcriptProgress(c.store).collect(), 0, 'stable IDs deduplicate replay');
});

test('unknown turns and native background transcripts cannot attach commentary to a user prompt', t => {
  const c = setup(t);
  c.append({ type: 'turn_context', payload: { turn_id: 'unrelated' } });
  c.append(c.message('commentary', '다른 대화'));
  assert.equal(c.collector.collect(), 0);
  fs.writeFileSync(c.file, JSON.stringify({ type: 'session_meta', payload: { id: 'test-session', cli_version: '0.120.0', source: 'exec' } }) + '\n');
  c.append({ type: 'turn_context', payload: { turn_id: 'turn-one' } }); c.append(c.message('commentary', '내부 작업'));
  assert.equal(c.collector.collect(), 0);
});


test('commentary flushed before its prompt hook is retried after the hook arrives', t => {
  const c = setup(t);
  c.append({ type: 'turn_context', payload: { turn_id: 'turn-two' } });
  c.append(c.message('commentary', '두 번째 요청 진행', '2026-10-02T00:03:00Z'));
  assert.equal(c.collector.collect(), 0);
  c.store.ingestMany([{ ...c.input, id: 'prompt-two', turn_id: 'turn-two', source_turn_id: 'turn-two', event_at: '2026-10-02T00:02:00Z' }]);
  assert.equal(c.collector.collect(), 1);
  const events = c.store.sessionMessages(c.store.sessionList()[0].id);
  assert.equal(events.find(e => e.kind === 'progress').turn_id, 'turn-two');
});


const claudeRow = (uuid, content, extra = {}) => ({ type: 'assistant', sessionId: 'test-session', uuid,
  timestamp: '2026-10-02T00:01:00Z', message: { id: 'msg-one', role: 'assistant', stop_reason: null, content }, ...extra });
test('Claude defers text until tool continuation, matches local hook turn, and deduplicates after restart', t => {
  const c = setup(t, 'claude');
  c.append(claudeRow('text-one', [{ type: 'text', text: '파일을 확인하겠습니다.' }, { type: 'thinking', thinking: '수집 제외' }]));
  assert.equal(c.collector.collect(), 0);
  c.append(claudeRow('tool-one', [{ type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: 'private' } }]));
  assert.equal(c.collector.collect(), 1);
  const session = c.store.sessionList()[0], progress = c.store.sessionMessages(session.id).find(e => e.kind === 'progress');
  assert.equal(progress.text, '파일을 확인하겠습니다.'); assert.equal(progress.turn_id, 'turn-one');
  assert.equal(progress.resolution, 'matched'); assert.equal(session.pending, true);
  assert.equal(transcriptProgress(c.store).collect(), 0);
  c.store.db.exec('DELETE FROM transcript_progress_cursors');
  assert.equal(transcriptProgress(c.store).collect(), 0);
});
test('Claude final text is owned only by Stop, and child or foreign transcript text is excluded', t => {
  const c = setup(t, 'claude');
  const text = [{ type: 'text', text: '최종 결과' }];
  c.append(claudeRow('child', text, { isSidechain: true }));
  c.append(claudeRow('foreign', text, { sessionId: 'another-session' }));
  c.append(claudeRow('final', text));
  assert.equal(c.collector.collect(), 0);
  c.store.ingestMany([{ ...c.input, id: 'stop', kind: 'output', event_at: '2026-10-02T00:02:00Z', text: '최종 결과' }]);
  assert.equal(c.collector.collect(), 0);
  assert.deepEqual(c.store.sessionMessages(c.store.sessionList()[0].id).map(e => e.kind), ['input', 'output']);
});
test('Claude refuses ambiguous overlapping prompts and collects distinct text messages when continuation is proven', t => {
  const c = setup(t, 'claude');
  c.append(claudeRow('first', [{ type: 'text', text: '첫 진행 안내' }]));
  c.append(claudeRow('second', [{ type: 'text', text: '다음 진행 안내' }], { message: { id: 'msg-two', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: '다음 진행 안내' }] } }));
  assert.equal(c.collector.collect(), 2);
  c.store.ingestMany([{ ...c.input, id: 'overlap', turn_id: 'second-turn', event_at: '2026-10-02T00:00:30Z' }]);
  c.append(claudeRow('ambiguous', [{ type: 'text', text: '불확실한 연결' }, { type: 'tool_use' }]));
  assert.equal(c.collector.collect(), 0);
});


test('real Claude hook registers transcript, tool hook confirms progress, Stop remains single final response', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  const file = path.join(h.dir, 'claude.jsonl'); fs.writeFileSync(file, '');
  const hook = { session_id: 'claude-hook-progress', transcript_path: file };
  h.hook('claude', { ...hook, event_id: 'prompt', hook_event_name: 'UserPromptSubmit', prompt: '훅 연동 확인' });
  const item = (await eventually(() => h.manager('/items'), rows => rows.length === 1))[0];
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', sessionId: hook.session_id, uuid: 'live-progress', timestamp: new Date().toISOString(),
    message: { id: 'msg-live', role: 'assistant', stop_reason: null, content: [{ type: 'text', text: '파일을 확인 중입니다.' }] } }) + '\n');
  h.hook('claude', { ...hook, event_id: 'tool', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'read-one', tool_input: {} });
  const read = async () => {
    const detail = await h.manager(`/items/${item.id}`);
    return h.manager(`/items/${item.id}/history?session_id=${detail.sessions[0].id}`);
  };
  const progress = await eventually(read, page => page.records.some(e => e.kind === 'progress'));
  assert.equal(progress.records.find(e => e.kind === 'progress').text, '파일을 확인 중입니다.');
  h.hook('claude', { ...hook, event_id: 'stop', hook_event_name: 'Stop', last_assistant_message: '작업 완료' });
  await eventually(read, page => page.records.some(e => e.kind === 'output'));
  await h.stop('manager'); await h.start('manager');
  const result = await read();
  assert.equal(result.records.filter(e => e.kind === 'progress').length, 1);
  assert.equal(result.records.filter(e => e.kind === 'output').length, 1);
});
