import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, eventually, pair } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

const titlePrompt = 'Generate a concise, single-line task title at most 36 characters and return only the title.';
function transcript(h, id, source, extra = {}) {
  const file = path.join(h.dir, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, source, cli_version: '0.155.0', ...extra } }) + '\n');
  return file;
}
function emit(h, session, file, kind, extra = {}) {
  h.hook('codex', { session_id: session, transcript_path: file, cwd: ROOT, hook_event_name: kind,
    event_id: `${session}-${kind}-${extra.turn_id || 't'}`, turn_id: 't', prompt: titlePrompt,
    last_assistant_message: '간결한 업무 제목', ...extra }, { HARNESS_WORKER: '' });
}
async function drained(h) {
  await eventually(() => fs.readdirSync(path.join(h.dir, 'spool')).filter(name => name.endsWith('.json')).length, n => n === 0);
}

test('external title workers never create items; ambiguous title requests on interactive transport require explicit recovery', async t => {
  const h = new Harness(); t.after(() => h.close());
  for (const [session, source] of [['external-title', 'exec'], ['codex-title', { subagent: { other: 'title' } }],
    ['native-user', 'cli'], ['desktop-user', 'vscode']]) {
    const file = transcript(h, session, source);
    for (const kind of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) emit(h, session, file, kind);
    // Delivery must not depend on a temporary transcript surviving collection.
    fs.unlinkSync(file);
  }
  await h.start('manager'); await drained(h);
  assert.equal((await h.manager('/items')).length, 0);
  const held = (await h.manager('/held-sessions')).records; assert.equal(held.length, 2);
  for (const row of held) await h.manager('/held-sessions/'+row.id+'/promote', {method:'POST',body:{}});
  const items = await h.manager('/items'); assert.equal(items.length, 2);
  for (const item of items) {
    const detail = await h.manager(`/items/${item.id}`);
    assert.ok(['native-user', 'desktop-user'].includes(detail.agents[0].source_id));
    assert.equal(detail.sessions.length, 1);
    assert.equal(detail.events.filter(e => e.kind === 'input').length, 1);
    assert.equal(detail.events.find(e => e.kind === 'input').text, titlePrompt);
  }
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager('/items')).length, 2);
  assert.equal((await h.manager('/health')).quarantined, 0);
});

test('child hooks sharing the parent ID never poison the parent conversation or create a child item', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  const root = transcript(h, 'root', 'cli');
  const child = transcript(h, 'child', { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } });
  emit(h, 'root', root, 'UserPromptSubmit', { prompt: '코드 베이스 분석해', turn_id: 'user-1' });
  emit(h, 'root', child, 'UserPromptSubmit', { turn_id: 'child-turn' });
  emit(h, 'root', child, 'Stop', { turn_id: 'child-turn' });
  emit(h, 'root', root, 'Stop', { turn_id: 'user-1' });
  emit(h, 'root', root, 'UserPromptSubmit', { prompt: '다음 작업을 진행해', turn_id: 'user-2' });
  emit(h, 'root', root, 'Stop', { turn_id: 'user-2' });
  await drained(h);
  const items = await h.manager('/items'); assert.equal(items.length, 1);
  const detail = await h.manager(`/items/${items[0].id}`);
  assert.equal(detail.sessions.length, 1); assert.equal(detail.sessions[0].pending, false);
  assert.equal(detail.events.filter(e => e.kind === 'input').length, 2);
  assert.equal(detail.events.filter(e => e.kind === 'output').length, 2);
});

test('a confirmed external worker remains excluded when later hooks omit transcript metadata after restart', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  const file = transcript(h, 'external-worker', 'exec');
  emit(h, 'external-worker', file, 'SessionStart'); await drained(h);
  await h.stop('manager'); fs.unlinkSync(file); await h.start('manager');
  emit(h, 'external-worker', undefined, 'UserPromptSubmit');
  emit(h, 'external-worker', undefined, 'Stop'); await drained(h);
  assert.deepEqual(await h.manager('/items'), []);
});

test('unknown or invalid transcript metadata never drops ordinary prompts, even when they ask for a title', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  const cases = [
    ['missing', path.join(h.dir, 'absent.jsonl')],
    ['wrong-id', transcript(h, 'other-session', 'exec')],
    ['unknown-source', transcript(h, 'unknown-source', 'future-source')],
    ['wrong-version', transcript(h, 'wrong-version', 'exec', { cli_version: null })]
  ];
  const malformed = path.join(h.dir, 'malformed.jsonl'); fs.writeFileSync(malformed, '{invalid}\n');
  cases.push(['malformed', malformed]);
  const long = path.join(h.dir, 'large.jsonl'); fs.writeFileSync(long, ' '.repeat(256 * 1024) + '\n');
  cases.push(['oversize', long]);
  const partial = path.join(h.dir, 'partial.jsonl'); fs.writeFileSync(partial, '{"type":"session_meta"');
  cases.push(['partial', partial]);
  for (const [session, file] of cases) emit(h, session, file, 'UserPromptSubmit', {prompt:'이 업무의 제목을 작성해 주세요'});
  await drained(h); assert.equal((await h.manager('/items')).length, cases.length);
});

test('manager replays transcript-referenced background hooks without hiding runtime results under their explicit owner', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  const file = transcript(h, 'background', 'exec');
  const hooks = pair('background', '09:00:00', '09:01:00', 't', { source: 'system_hook', role: 'user', transcript_path: file, cwd: ROOT });
  const ignored = await h.ingest(hooks);
  assert.equal(ignored.inserted, 0); assert.equal(ignored.ignored_internal, 2);
  await h.ingest(pair('owner', '09:00:00', '09:01:00', 't', { work_item_id: 'real-work' }));
  await h.ingest(pair('background', '09:00:10', '09:00:50', 't', {
    source: 'runtime', role: 'worker', transcript_path: file, work_item_id: 'real-work',
    parent: { engine: 'codex', agent_session_id: 'owner', turn_id: 't', work_item_id: 'real-work' }
  }));
  assert.equal((await h.manager('/items')).length, 1);
  const detail = await h.manager('/items/real-work');
  assert.equal(detail.events.filter(e => e.role === 'worker').length, 2);
});

function emitClaude(h, session, entrypoint, kind, extra = {}) {
  h.hook('claude', { session_id: session, cwd: ROOT, hook_event_name: kind,
    event_id: `${session}-${kind}-${extra.turn_id || 't'}`, turn_id: 't', prompt: titlePrompt,
    last_assistant_message: '간결한 업무 제목', ...extra }, { HARNESS_WORKER: '', CLAUDE_CODE_ENTRYPOINT: entrypoint });
}

test('Claude print workers never create items; interactive title templates remain recoverable', async t => {
  const h = new Harness(); t.after(() => h.close());
  for (const [session, entrypoint] of [['external-print', 'sdk-cli'], ['external-ts', 'sdk-ts'], ['external-py', 'sdk-py'],
    ['claude-user', 'cli'], ['claude-vscode-user', 'claude-vscode'], ['claude-local-user', 'local-agent'], ['unknown-user', 'future-mode']]) {
    for (const kind of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) emitClaude(h, session, entrypoint, kind, session === 'unknown-user' ? { prompt: '제목 작성 업무를 진행해 주세요' } : {});
  }
  await h.start('manager'); await drained(h);
  const held = (await h.manager('/held-sessions')).records; assert.equal(held.length, 3);
  for (const row of held) await h.manager('/held-sessions/'+row.id+'/promote', {method:'POST',body:{}});
  const items = await h.manager('/items'); assert.equal(items.length, 4);
  for (const item of items) {
    const detail = await h.manager(`/items/${item.id}`);
    assert.ok(!detail.agents[0].source_id.startsWith('external-'));
    assert.equal(detail.sessions.length, 1); assert.equal(detail.sessions[0].pending, false);
    assert.equal(detail.events.find(e => e.kind === 'input').text, detail.agents[0].source_id === 'unknown-user' ? '제목 작성 업무를 진행해 주세요' : titlePrompt);
  }
  assert.equal((await h.manager('/health')).quarantined, 0);
});

test('confirmed Claude print identity survives spool replay, restart and later missing entrypoint without suppressing Codex', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  emitClaude(h, 'shared-id', 'sdk-cli', 'SessionStart'); await drained(h);
  await h.stop('manager'); await h.start('manager');
  emitClaude(h, 'shared-id', '', 'UserPromptSubmit'); emitClaude(h, 'shared-id', '', 'Stop');
  // A real Codex session with the same ID belongs to a different engine.
  emit(h, 'shared-id', undefined, 'UserPromptSubmit', { prompt: '일반 사용자 작업' }); emit(h, 'shared-id', undefined, 'Stop');
  await drained(h);
  const items = await h.manager('/items'); assert.equal(items.length, 1);
  assert.equal((await h.manager(`/items/${items[0].id}`)).agents[0].engine, 'codex');
});

test('Claude child hook identity excludes only the child; --agent main sessions remain ordinary user sessions', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  emitClaude(h, 'claude-root', 'cli', 'UserPromptSubmit', { agent_type: 'reviewer', turn_id: 'user-1', prompt:'사용자 업무 분석' });
  emitClaude(h, 'claude-root', 'cli', 'UserPromptSubmit', { agent_type: 'reviewer', agent_id: 'child', turn_id: 'child-turn' });
  emitClaude(h, 'claude-root', 'cli', 'Stop', { agent_id: 'child', turn_id: 'child-turn' });
  emitClaude(h, 'claude-root', 'cli', 'Stop', { agent_type: 'reviewer', turn_id: 'user-1', prompt:'사용자 업무 분석' });
  await drained(h); await h.stop('manager'); await h.start('manager');
  emitClaude(h, 'claude-root', '', 'UserPromptSubmit', { agent_type: 'reviewer', turn_id: 'user-2', prompt:'분석을 계속해' });
  emitClaude(h, 'claude-root', '', 'Stop', { agent_type: 'reviewer', turn_id: 'user-2', prompt:'분석을 계속해' });
  await drained(h);
  const items = await h.manager('/items'); assert.equal(items.length, 1);
  const detail = await h.manager(`/items/${items[0].id}`);
  assert.equal(detail.events.filter(e => e.kind === 'input').length, 2);
  assert.equal(detail.events.filter(e => e.kind === 'output').length, 2);
  assert.equal(detail.sessions.length, 1); assert.equal(detail.sessions[0].pending, false);
});

test('Claude background hook filtering retains executor results under an existing work item', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  await h.ingest(pair('owner', '09:00:00', '09:01:00', 't', { engine: 'claude', work_item_id: 'claude-work' }));
  emitClaude(h, 'external-worker', 'sdk-cli', 'UserPromptSubmit'); await drained(h);
  await h.ingest(pair('external-worker', '09:00:10', '09:00:50', 't', { engine: 'claude',
    source: 'runtime', role: 'worker', work_item_id: 'claude-work',
    parent: { engine: 'claude', agent_session_id: 'owner', turn_id: 't', work_item_id: 'claude-work' }
  }));
  assert.equal((await h.manager('/items')).length, 1);
  assert.equal((await h.manager('/items/claude-work')).events.filter(e => e.role === 'worker').length, 2);
});

test('manager rechecks metadata written after the prompt hook before admitting an item', async t => {
  const h = new Harness(); t.after(() => h.close());
  const file = path.join(h.dir, 'late-metadata.jsonl');
  emit(h, 'late-metadata', file, 'UserPromptSubmit');
  transcript(h, 'late-metadata', 'exec');
  await h.start('manager'); await drained(h);
  assert.deepEqual(await h.manager('/items'), []);
});

test('background identity applies to every event in a batch regardless of delivery order', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  const [input, output] = pair('reordered-worker', '09:00:00', '09:01:00', 't', { source: 'system_hook', role: 'user' });
  output.native_session = { adapter: 'codex-session-meta-v1', session_id: 'reordered-worker',
    hook_session_id: 'reordered-worker', kind: 'exec', cli_version: '0.155.0' };
  const result = await h.ingest([input, output]);
  assert.equal(result.ignored_internal, 2);
  assert.deepEqual(await h.manager('/items'), []);
});

test('spool collection preflights later identities and isolates malformed records for both engines', async t => {
  const h = new Harness(); t.after(() => h.close());
  fs.mkdirSync(path.join(h.dir, 'spool'), { recursive: true });
  const write = (name, event) => fs.writeFileSync(path.join(h.dir, 'spool', name + '.json'), JSON.stringify(event));
  for (const engine of ['codex', 'claude']) {
    const session = 'spooled-' + engine;
    const [input, output] = pair(session, '09:00:00', '09:01:00', 't', { engine, source: 'system_hook', role: 'user', text: titlePrompt });
    output.native_session = engine === 'codex'
      ? { adapter: 'codex-session-meta-v1', session_id: session, hook_session_id: session, kind: 'exec', cli_version: '0.155.0' }
      : { adapter: 'claude-hook-origin-v1', session_id: session, hook_session_id: session, kind: 'print', entrypoint: 'sdk-cli' };
    write('001-' + engine, input); write('999-' + engine, output);
  }
  write('000-bad', null);
  const ordinary = pair('ordinary', '09:00:00', '09:01:00', 't', { source: 'system_hook', role: 'user', text: '일반 사용자 작업' });
  write('002-user', ordinary[0]); write('998-user', ordinary[1]);
  await h.start('manager'); await drained(h);
  const items = await h.manager('/items'); assert.equal(items.length, 1);
  assert.equal((await h.manager('/items/' + items[0].id)).agents[0].source_id, 'ordinary');
  assert.ok(fs.existsSync(path.join(h.dir, 'quarantine', '000-bad.json')));
});
