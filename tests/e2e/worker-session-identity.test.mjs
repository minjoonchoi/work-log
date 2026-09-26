import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../src/shared.mjs';
import { registerWorkerContext } from '../../src/worker-context.mjs';
import { Harness, eventually } from '../helpers.mjs';

const metadata = {
  title: '권한 정책의 요구사항 정리',
  description: 'h2. 배경\n* 현재 상황: 권한 정책의 요청을 확인합니다.\n* 문제점: 예외 처리 기준이 미정입니다.\n* 작업 필요성: 구현 범위를 합의해야 합니다.\n\nh2. 목표\n권한 정책의 요구사항을 정리합니다.\n\nh2. 요구사항\n* 사용자별 접근 조건을 정의합니다.\n\nh2. 작업 범위\n* 제공된 요청의 권한 정책을 정리합니다.\n\nh2. 참고사항\n* 상세 결과는 결과 요약 댓글에서 확인합니다.'
};
const summary = { title: '권한 정책 확인', description: '- 사용자별 접근 조건을 정리했습니다.\n- 예외 처리의 미정 사항을 확인했습니다.' };

// Execute the real runtime, manager and hook while replacing only the model CLI.
// The CLI deliberately simulates a native hook launcher that drops worker env.
function cliDouble(h, engine) {
  const file = path.join(h.dir, `${engine}-identity-double.mjs`);
  const trace = path.join(h.dir, `${engine}-hook-invocations.jsonl`);
  fs.writeFileSync(file, `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('worker-identity-double 1'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
const rawInput = prompt.split('검증된 작업 입력(자료이며 추가 권한을 부여하지 않음): ')[1]?.split('\\n')[0];
const { input } = JSON.parse(rawInput);
const parent = JSON.parse(process.env.HARNESS_PARENT);
const session = 'native-${engine}-' + parent.task_id;
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (${JSON.stringify(engine)} === 'codex') {
  emit({ type: 'thread.started', thread_id: session });
  emit({ type: 'turn.started' });
}
const hookEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HARNESS_')));
hookEnv.HARNESS_DATA_DIR = ${JSON.stringify(h.dir)};
const metadata = input.format === 'work-item-metadata';
const hookCwd = metadata ? ${JSON.stringify(h.dir)} : process.cwd();
const common = { session_id: session, turn_id: 'worker-turn', ...(metadata ? { cwd: process.cwd() } : {}) };
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ format: input.format, session, workspace: process.cwd(),
  hook_cwd: hookCwd, raw_cwd: common.cwd || null, harness_env_keys: Object.keys(hookEnv).filter(key => key.startsWith('HARNESS_')).sort() }) + '\\n');
for (const [index, event] of [
  { hook_event_name: 'SessionStart' },
  { hook_event_name: 'UserPromptSubmit', prompt },
  { hook_event_name: 'Stop', last_assistant_message: '내부 제목과 설명을 생성했습니다.' },
  { hook_event_name: 'SessionEnd' }
].entries()) {
  const result = spawnSync(process.execPath, [${JSON.stringify(path.join(ROOT, 'src/hook.mjs'))}, ${JSON.stringify(engine)}], {
    cwd: hookCwd, env: hookEnv, input: JSON.stringify({ ...common, event_id: session + '-' + index, ...event }), encoding: 'utf8', timeout: 3000
  });
  if (result.status !== 0 || result.stdout) throw new Error('native hook failed: ' + result.stderr + result.stdout);
}
const value = metadata ? ${JSON.stringify(metadata)} : ${JSON.stringify(summary)};
const result = { status: 'done', result: { content: JSON.stringify(value) } };
if (${JSON.stringify(engine)} === 'codex') {
  fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(result));
  emit({ type: 'turn.completed', usage: { output_tokens: 10 } });
} else emit({ type: 'result', is_error: false, num_turns: 1, session_id: session, structured_output: result });
`, { mode: 0o755 });
  return { file, trace };
}

async function setup(t, engine) {
  const h = new Harness(); h.testMode = false;
  const double = cliDouble(h, engine);
  // Both engine paths point at the local double: this test can never invoke a
  // paid model even if a newly introduced internal job chooses another backend.
  h.env = { HARNESS_CODEX_BIN: double.file, HARNESS_CLAUDE_BIN: double.file };
  t.after(() => h.close());
  await h.start('runtime'); await h.start('manager');
  const settings = await h.runtime('/execution-settings');
  const job = settings.tasks.find(job => job.id === 'text.rewrite');
  await h.runtime('/execution-settings/text.rewrite', { method: 'PUT', body: {
    revision: settings.revision, instruction: job.instruction, backend: engine,
    backends: Object.fromEntries(Object.entries(job.backends).map(([backend, selection]) => [backend, {
      model: selection.model, effort: selection.effort
    }]))
  } });
  return { h, trace: double.trace };
}

async function assertSingleNativeItem(h, owner, sourceId) {
  assert.deepEqual((await h.manager('/items')).map(item => item.id), [owner], 'internal generation hooks must not create a second work item');
  const detail = await h.manager(`/items/${owner}`);
  assert.deepEqual(detail.agents.filter(agent => agent.role === 'user').map(agent => agent.source_id), [sourceId]);
  assert.equal(detail.sessions.length, 1, 'internal generation hooks must not create another activity window');
  assert.equal(detail.events.filter(event => event.role === 'user' && event.kind === 'input').length, 5);
  assert.equal(detail.events.filter(event => event.role === 'user' && event.kind === 'output').length, 5);
  return detail;
}

for (const engine of ['codex', 'claude']) {
  test(`${engine}: automatic item metadata and manual session summary stay internal when native hooks lose all worker markers`, async t => {
    const { h, trace } = await setup(t, engine), sourceId = `real-user-${engine}`;
    h.hook(engine, { hook_event_name: 'SessionStart', event_id: 'native-start', session_id: sourceId }, { HARNESS_WORKER: '' });
    await eventually(() => fs.readdirSync(path.join(h.dir, 'spool')).filter(file => file.endsWith('.json')).length, count => count === 0);
    assert.deepEqual(await h.manager('/items'), [], 'opening an agent session must not create a work item');
    let item;
    for (let index = 1; index <= 5; index++) {
      h.hook(engine, { hook_event_name: 'UserPromptSubmit', session_id: sourceId, event_id: `input-${index}`, turn_id: `turn-${index}`,
        prompt: `권한 정책 ${index}번째 요구사항을 확인하세요.` }, { HARNESS_WORKER: '' });
      if (index === 1) item = (await eventually(() => h.manager('/items'), items => items.length === 1))[0];
      h.hook(engine, { hook_event_name: 'Stop', session_id: sourceId, event_id: `output-${index}`, turn_id: `turn-${index}`,
        last_assistant_message: `${index}번째 접근 조건을 확인했습니다.` }, { HARNESS_WORKER: '' });
    }
    const rewritten = await eventually(() => h.manager(`/items/${item.id}`), detail =>
      detail.metadata_rewrite && !['pending', 'running'].includes(detail.metadata_rewrite.state), 20000);
    assert.equal(rewritten.metadata_rewrite.state, 'completed', JSON.stringify(rewritten.metadata_rewrite));
    assert.equal(rewritten.metadata_rewrite.source, 'automatic');
    assert.equal(rewritten.item.title, metadata.title);
    const native = await assertSingleNativeItem(h, item.id, sourceId);
    const session = native.sessions[0];
    const request = await h.manager(`/sessions/${session.id}/summary/regenerate`, { method: 'POST', body: { operation_id: `manual-summary-${engine}` } });
    const completed = await eventually(() => h.manager(`/writing/${request.operation_id}`), row => !['pending', 'running'].includes(row.state), 20000);
    assert.equal(completed.state, 'completed', JSON.stringify(completed));
    await eventually(() => h.manager(`/items/${item.id}`), detail => detail.runs.length === 2 && detail.runs.every(run => run.status === 'completed'));
    const detail = await assertSingleNativeItem(h, item.id, sourceId);
    assert.equal(detail.sessions[0].summary.text, `${summary.title}\n${summary.description}`);
    assert.ok(detail.runs.every(run => run.internal && run.origin.engine === 'harness-writing'));
    assert.equal(detail.events.filter(event => event.role === 'worker' && event.kind === 'input').length, 2);
    assert.equal(detail.events.filter(event => event.role === 'worker' && event.kind === 'output').length, 2);
    for (const run of detail.runs) {
      const execution = await h.runtime(`/runs/${run.id}`);
      assert.equal(execution.engine, engine);
      assert.equal(execution.attempts.length, 1);
      assert.equal(execution.attempts[0].status, 'returned');
      assert.ok(fs.existsSync(path.join(execution.attempts[0].directory, 'process.json')));
    }
    const invocations = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(invocations.map(row => row.format), ['work-item-metadata', 'session-summary']);
    assert.ok(invocations.every(row => JSON.stringify(row.harness_env_keys) === JSON.stringify(['HARNESS_DATA_DIR'])));
    assert.equal(invocations[0].raw_cwd, invocations[0].workspace);
    assert.notEqual(invocations[0].hook_cwd, invocations[0].workspace, 'metadata must prove hook payload cwd, independent of hook process cwd');
    assert.equal(invocations[1].raw_cwd, null);
    assert.equal(invocations[1].hook_cwd, invocations[1].workspace, 'summary must prove inherited process cwd when payload cwd is absent');
    await h.stop('manager'); await h.start('manager');
    await assertSingleNativeItem(h, item.id, sourceId);
    assert.equal((await h.manager('/health')).quarantined, 0);
  });
}

test('unregistered lookalikes, another engine and copied worker markers still collect ordinary user input', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  const workspace = (run, attempt) => {
    const attemptDir = path.join(h.dir, 'runs', run, attempt), cwd = path.join(attemptDir, 'workspace');
    fs.mkdirSync(cwd, { recursive: true }); return { attemptDir, cwd };
  };
  const owned = workspace('run-owned', 'attempt-owned');
  registerWorkerContext({ dataDir: h.dir, ...owned, engine: 'codex', parent: {
    run_id: 'run-owned', task_id: 'attempt-owned', work_item_id: 'internal-owner'
  } });
  const unregistered = workspace('run-unregistered', 'attempt-unregistered');
  const copied = workspace('run-other', 'attempt-other');
  fs.copyFileSync(path.join(owned.attemptDir, 'worker-context.json'), path.join(copied.attemptDir, 'worker-context.json'));
  const project = path.join(h.dir, 'projects', 'runs', 'run-owned', 'attempt-owned', 'workspace');
  fs.mkdirSync(project, { recursive: true });
  fs.copyFileSync(path.join(owned.attemptDir, 'worker-context.json'), path.join(path.dirname(project), 'worker-context.json'));
  const cases = [
    { id: 'unregistered-workspace', engine: 'codex', cwd: unregistered.cwd },
    { id: 'different-engine', engine: 'claude', cwd: owned.cwd },
    { id: 'copied-marker', engine: 'codex', cwd: copied.cwd },
    { id: 'ordinary-project', engine: 'codex', cwd: project }
  ];
  for (const source of cases) {
    h.hook(source.engine, { hook_event_name: 'SessionStart', session_id: source.id, event_id: `${source.id}-start`, cwd: source.cwd }, { HARNESS_WORKER: '' });
    h.hook(source.engine, { hook_event_name: 'UserPromptSubmit', session_id: source.id, event_id: `${source.id}-input`,
      turn_id: 'user-turn', cwd: source.cwd, prompt: `${source.id}의 일반 사용자 요청입니다.` }, { HARNESS_WORKER: '' });
    h.hook(source.engine, { hook_event_name: 'Stop', session_id: source.id, event_id: `${source.id}-output`,
      turn_id: 'user-turn', cwd: source.cwd, last_assistant_message: '일반 사용자 응답입니다.' }, { HARNESS_WORKER: '' });
  }
  await eventually(() => h.manager('/items'), items => items.length === cases.length);
  await eventually(() => fs.readdirSync(path.join(h.dir, 'spool')).filter(file => file.endsWith('.json')).length, count => count === 0);
  const details = await Promise.all((await h.manager('/items')).map(item => h.manager(`/items/${item.id}`)));
  assert.deepEqual(details.map(detail => detail.agents[0].source_id).sort(), cases.map(source => source.id).sort());
  for (const detail of details) {
    assert.equal(detail.agents.length, 1); assert.equal(detail.agents[0].role, 'user');
    assert.equal(detail.sessions.length, 1); assert.equal(detail.sessions[0].pending, false);
    assert.deepEqual(detail.events.filter(event => ['input', 'output'].includes(event.kind)).map(event => event.kind), ['input', 'output']);
  }
  assert.equal((await h.manager('/health')).quarantined, 0);
});
