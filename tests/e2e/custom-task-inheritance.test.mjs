import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
import { resolveTask } from '../../src/intake.mjs';

async function setup(t) {
  const h = await new Harness().start('runtime'); t.after(() => h.close()); return h;
}
async function register(h, template_id, label, routing_terms) {
  const snapshot = await h.runtime('/execution-settings');
  const created = await h.runtime('/execution-settings/custom-tasks', { method: 'POST', body: {
    revision: snapshot.revision, template_id, label, description: `${label}의 지정된 범위만 수행한다.`, routing_terms,
    instruction: `# ${label}\n\n등록한 전용 작업 지시문을 따른다.`, backend: 'codex',
    backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } }
  } });
  return created.created_task_id;
}

test('custom scenario templates inherit input defaults and reject duplicate requirement IDs before execution', async t => {
  const h = await setup(t);
  const task = await register(h, 'test.scenarios.plan', '팀 시나리오 설계', ['팀 E2E 시나리오']);
  const requirements = [{ id: 'LOGIN', text: '로그인하면 사용자 이름을 표시한다.' }];
  const result = await h.finish(await h.run({ task, input: { requirements }, fixture: { scenario: 'scenario-missing-recovery-once' } }));
  assert.equal(result.status, 'completed', result.message);
  assert.deepEqual(result.request.input.categories, ['normal', 'failure', 'boundary', 'recovery']);
  assert.deepEqual(result.request.input.requirements, requirements);
  assert.deepEqual(result.attempts.map(attempt => attempt.stage), ['plan', 'repair', 'review']);
  const before = (await h.runtime('/runs')).length;
  for (const input of [
    { requirements: [{ id: 'SAME', text: '첫 요구' }, { id: 'SAME', text: '서로 다른 요구' }], categories: ['normal'] },
    { requirements, categories: null },
    { requirements, categories: ['normal', 'normal'] }
  ]) await assert.rejects(h.run({ task, input }), /중복|분류/);
  assert.equal((await h.runtime('/runs')).length, before);
  const promptOnly = await h.finish(await h.run({ task, prompt: '회원 로그인 성공과 실패의 시나리오를 설계한다.' }));
  assert.equal(promptOnly.status, 'completed', promptOnly.message);
  assert.deepEqual(promptOnly.request.input.requirements, [{ id: 'REQ-001', text: '회원 로그인 성공과 실패의 시나리오를 설계한다.' }]);
});

test('natural custom review and scenario requests execute their registered instruction and inherited workflow', async t => {
  const h = await setup(t);
  const review = await register(h, 'code.review', '팀 코드 검토', ['팀 코드 점검']);
  const scenario = await register(h, 'test.scenarios.plan', '팀 시나리오 작업', ['팀 E2E 시나리오']);
  for (const [task, prompt, heading] of [
    [review, '팀 코드 점검을 검토해줘', '# 팀 코드 검토'],
    [scenario, '팀 E2E 시나리오를 설계해줘', '# 팀 시나리오 작업']
  ]) {
    const result = await h.finish(await h.run({ task: undefined, prompt }));
    assert.equal(result.task, task); assert.equal(result.status, 'completed', result.message);
    assert.ok(result.attempts.some(attempt => attempt.stage === 'review'));
    for (const attempt of result.attempts) assert.ok(fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8').includes(heading));
  }
});

test('custom keyword routing preserves actions, source references, review-only requests and ambiguity boundaries', async t => {
  const h = await setup(t);
  const review = await register(h, 'code.review', '팀 검토 작업', ['팀 코드 점검']);
  const scenario = await register(h, 'test.scenarios.plan', '팀 시나리오 작업', ['팀 E2E 시나리오']);
  const create = await register(h, 'document.create', '맞춤 생성 작업', ['맞춤 기록']);
  const update = await register(h, 'document.update', '맞춤 갱신 작업', ['맞춤 기록']);
  const analysis = await register(h, 'feedback.analyze', '제품 반응 작업', ['제품 반응']);
  const plan = await register(h, 'project.plan', '출시 준비 작업', ['출시 준비']);
  await register(h, 'document.review', '일반 자료 검토 작업', ['업무 자료']);
  await register(h, 'document.create', '일반 PRD 문서 작업', ['PRD']);
  await register(h, 'test.create', '전용 테스트 작성 작업', ['E2E 테스트']);
  const catalog = async () => Object.fromEntries((await h.runtime('/catalog')).jobs.map(job => [job.id, job]));
  let jobs = await catalog();
  for (const [prompt, task] of [
    ['팀 코드 점검을 검토해줘', review],
    ['팀 E2E 시나리오를 작성해줘', scenario],
    ['맞춤 기록을 작성해줘', create],
    ['맞춤 기록을 수정해줘', update],
    ['제품 반응을 분석해줘', analysis],
    ['출시 준비 계획을 수립해줘', plan],
    ['맞춤 기록 문서를 검토해줘', 'document.review'],
    ['팀 E2E 시나리오를 검토해줘', 'document.review'],
    ['팀 코드 점검을 참고해서 API 설계해줘', 'api.design'],
    ['팀 코드 점검은 하지 말고 API 설계만 해줘', 'api.design'],
    ['팀 코드 점검 방법을 설명해줘', 'text.generate'],
    ['E2E 테스트를 실행해줘', 'checks.run']
  ]) assert.equal(resolveTask({ prompt }, jobs), task, prompt);
  for (const prompt of [
    '팀 코드 점검', '팀 코드 점검을 검토하고 수정해줘', '팀 E2E 시나리오 작성 후 검토해줘',
    '팀 코드 점검을 검토하고 API 설계해줘', '업무 자료의 보안을 검토해줘',
    'PRD를 작성해줘', '팀 코드 점검의 보안을 검토해줘'
  ]) assert.throws(() => resolveTask({ prompt }, jobs), /한 종류의 산출물/, prompt);
  await register(h, 'code.review', '겹치는 팀 검토 작업', ['팀 코드 점검']);
  jobs = await catalog();
  assert.throws(() => resolveTask({ prompt: '팀 코드 점검을 검토해줘' }, jobs), /한 종류의 산출물/);
  assert.equal(resolveTask({ task: review, prompt: '팀 코드 점검을 검토해줘' }, jobs), review, 'explicit task selection remains available for overlapping keywords');
  assert.deepEqual(await h.runtime('/runs'), [], 'routing checks never schedule work or local commands');
});
