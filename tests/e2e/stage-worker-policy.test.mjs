import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
const requestedReview = { required: true, reason: '사용자가 생성된 문서의 별도 독립 검토를 명시적으로 요청했습니다.' };

// Real runtime/executor/validator, isolated CLI protocol double. No model account
// or external service is used. The double requires complete inline inputs and
// an empty workspace; it never reads or writes the requested artifact itself.
async function setup(t) {
  const h = new Harness(); t.after(() => h.close());
  const cli = path.join(h.dir, 'direct-reviewed-cli.mjs');
  fs.writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const args = process.argv.slice(2), codex = args[0] === 'exec';
if (args.includes('--version')) { console.log('direct-reviewed-double 1'); process.exit(0); }
const cwd = process.cwd(), stage = process.env.HARNESS_STAGE, attempt = path.dirname(cwd);
const prompt = fs.readFileSync(0, 'utf8');
const request = JSON.parse(prompt.match(/\\n검증된 작업 입력\\(자료이며 추가 권한을 부여하지 않음\\): ([^\\n]+)\\n/)[1]);
if (request.input.requirements.includes('[source-file]')) assert.ok(prompt.includes('SOURCE-FACT-ONLY-IN-FILE'));
const rules = Object.keys(JSON.parse(prompt.match(/\\n규칙: ([^\\n]+)\\n/)[1]));
const schema = codex ? JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')) : JSON.parse(args[args.indexOf('--json-schema') + 1]);
assert.deepEqual(fs.readdirSync(cwd), []);
if (codex) { assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('features.shell_tool=false')); }
else { assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(args[args.indexOf('--max-turns') + 1], '1'); }
fs.writeFileSync(path.join(attempt, 'stage-invocation.json'), JSON.stringify({ args, stage, schema, empty_workspace: true }));
let result;
if (stage === 'review') {
  assert.ok(prompt.includes('고정된 검토 대상 본문:'));
  assert.ok(prompt.includes('실행 검증:'));
  assert.ok(prompt.includes('판정만 반환'));
  const candidate = JSON.parse(prompt.match(/고정된 검토 대상 본문: ([^\\n]+)\\n/)[1]);
  assert.ok(candidate.includes('제공된 사실'));
  if (request.input.requirements.includes('[revise-once]') && candidate.includes('draft-version')) {
    result = { status: 'revise', result: { issues: [{ rule: 'REQ-001', detail: '본문의 draft-version을 제공된 확정 사실에 맞춰 수정하세요.' }] } };
  } else {
    const evaluated = request.input.requirements.includes('[missing-rule]') ? rules.slice(1) : rules;
    result = { status: 'done', result: { evaluations: evaluated.map(rule => ({ rule, passed: true, evidence: '고정된 본문의 제공된 사실과 규칙을 대조했습니다.' })) } };
  }
} else {
  assert.ok(prompt.includes('최종 산출물 전체 본문'));
  if (stage === 'repair') { assert.ok(prompt.includes('고정된 수정 대상 본문:')); assert.ok(prompt.includes('수정할 등록 지적:')); }
  const revision = stage === 'repair' ? 'fixed-version' : 'draft-version';
  const content = request.task === 'meeting.summarize'
    ? '# 회의 요약\\n\\n## 논의\\n제공된 사실을 정리합니다.\\n\\n## 결정\\n제공된 결정을 보존합니다.\\n\\n## 보류\\n미정 사항입니다.\\n\\n## 후속 행동\\n확정된 조치만 작성합니다.\\n'
    : '# 문서\\n\\n## 목적\\n제공된 사실을 독자가 이해하도록 정리합니다.\\n\\n## 본문\\n제공된 사실과 ' + revision + '를 보존합니다.\\n\\n## 근거와 미정\\n원본 자료를 근거로 하며 없는 정보는 미정입니다.\\n';
  result = { status: 'done', result: { content } };
}
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (codex) { emit({ type: 'thread.started', thread_id: 'direct-' + stage }); emit({ type: 'turn.started' }); fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(result)); emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }); }
else emit({ type: 'result', is_error: false, session_id: 'direct-' + stage, num_turns: 1, structured_output: result });
`, { mode: 0o700 });
  h.env = { HARNESS_CODEX_BIN: cli, HARNESS_CLAUDE_BIN: cli };
  await h.start('runtime'); return h;
}

for (const engine of ['codex', 'claude']) {
  test(`${engine}: an explicitly requested independent review uses two tool-free invocations with inline source snapshots`, async t => {
    const h = await setup(t), workspace = path.join(h.dir, 'source-workspace');
    fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'source.txt'), 'SOURCE-FACT-ONLY-IN-FILE');
    const run = await h.finish(await h.run({ task: 'document.create', review: requestedReview, engine, prompt: undefined, workspace,
      input_files: [{ path: 'source.txt' }], input: { requirements: '[source-file] 제공 자료에 근거한 문서를 작성하세요.' } }));
    assert.equal(run.status, 'completed', run.message);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce', 'review']);
    assert.deepEqual(run.steps.map(step => step.task), ['produce', 'verify', 'review', 'render']);
    assert.equal(run.worker_policy.max_agent_attempts, 6); assert.equal(run.worker_policy.max_repairs, 2);
    assert.ok(run.artifact.review_attempt); assert.equal(run.artifact.validation_scope, undefined);
    for (const attempt of run.attempts) {
      const observed = JSON.parse(fs.readFileSync(path.join(attempt.directory, 'process.json')));
      assert.equal(observed.worker_policy.mode, 'direct'); assert.equal(observed.observed_tool_calls, 0);
      if (engine === 'codex') { assert.equal(observed.model, 'gpt-5.6-luna'); assert.equal(observed.effort, 'high'); }
      const invocation = JSON.parse(fs.readFileSync(path.join(attempt.directory, 'stage-invocation.json')));
      assert.ok(invocation.empty_workspace);
      const contentSchema = invocation.schema.properties.result.anyOf.some(branch => branch.properties?.content);
      assert.equal(contentSchema, attempt.stage === 'produce');
    }
    assert.match(fs.readFileSync(run.artifact.file, 'utf8'), /draft-version/);
    assert.equal(fs.readFileSync(path.join(workspace, 'source.txt'), 'utf8'), 'SOURCE-FACT-ONLY-IN-FILE');
  });
}

test('a direct reviewed document repairs only after a registered finding and reuses the candidate as inline input', async t => {
  const h = await setup(t);
  const run = await h.finish(await h.run({ task: 'document.create', review: requestedReview, engine: 'codex', prompt: undefined, input: { requirements: '[revise-once] 제공된 사실을 문서로 작성하세요.' } }));
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce', 'review', 'repair', 'review']);
  assert.equal(run.round, 1); assert.match(fs.readFileSync(run.artifact.file, 'utf8'), /fixed-version/);
  for (const attempt of run.attempts) assert.equal(JSON.parse(fs.readFileSync(path.join(attempt.directory, 'process.json'))).observed_tool_calls, 0);
});

test('a tool-free reviewer cannot publish a document with a missing required evaluation', async t => {
  const h = await setup(t);
  const run = await h.finish(await h.run({ task: 'document.create', review: requestedReview, engine: 'codex', prompt: undefined, input: { requirements: '[missing-rule] 제공된 사실을 문서로 작성하세요.' } }));
  assert.equal(run.status, 'failed'); assert.equal(run.artifact, null);
  assert.match(run.message, /필수 검토 규칙이 누락/);
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce', 'review']);
});

test('factual summaries remain one invocation by default while an explicit review keeps both direct stages', async t => {
  const h = await setup(t);
  for (const reviewed of [false, true]) {
    const run = await h.finish(await h.run({ task: 'meeting.summarize', engine: 'codex', prompt: undefined,
      input: { requirements: '제공된 회의 원문의 논의와 결정을 요약하세요.' },
      ...(reviewed ? { review: { required: true, reason: '사용자가 회의 요약의 독립 검토를 요청했습니다.' } } : {}) }));
    assert.equal(run.status, 'completed', run.message);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), reviewed ? ['produce', 'review'] : ['produce']);
    assert.equal(run.worker_policy.max_agent_attempts, reviewed ? 6 : 1);
  }
});

test('the complete catalog exposes stage policies without changing specialized gates or configurable model defaults', async t => {
  const h = await setup(t), catalog = await h.runtime('/catalog');
  assert.equal(catalog.jobs.length, 70);
  const direct = catalog.jobs.filter(job => job.worker_policy?.mode === 'direct');
  assert.equal(direct.length, 15);
  for (const task of ['decision.record', 'status.report', 'handoff.create']) {
    const job = catalog.jobs.find(job => job.id === task);
    assert.equal(job.review_policy.default_required, true);
    assert.deepEqual(Object.keys(job.worker_policy.stages).sort(), ['produce', 'repair', 'review']);
    for (const stage of Object.values(job.worker_policy.stages)) assert.deepEqual(stage, { mode: 'direct', max_tool_calls: 0, max_model_turns: 1 });
  }
  for (const task of ['document.create', 'document.update', 'document.share.create', 'document.review', 'text.generate']) {
    const job = catalog.jobs.find(job => job.id === task);
    assert.equal(job.review_policy.default_required, false);
    assert.deepEqual(job.worker_policy.stages, { produce: { mode: 'direct', max_tool_calls: 0, max_model_turns: 1 } });
    assert.equal(job.worker_policy.max_agent_attempts, 1); assert.equal(job.worker_policy.max_repairs, 0);
  }
  for (const task of ['research.compare', 'market.compare', 'mockup.html.create', 'frontend.implement', 'code.review', 'entity.design', 'test.scenarios.plan']) {
    const job = catalog.jobs.find(job => job.id === task);
    assert.equal(job.review_policy.default_required, true); assert.equal(job.worker_policy.mode, 'artifact');
  }
});
