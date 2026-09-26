import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';
import { digest } from '../../src/shared.mjs';

// Protocol-fixture scenarios exercise admission, single-pass writing, optional review and publication.
// They do not measure a live model's factual accuracy or reader comprehension.
const task = 'document.share.create';
const source = 'SUP-17: 중복 초대가 거절되어도 화면에 이유가 표시되지 않아 고객지원 문의가 발생했다. '
  + 'INV-42: 관리자용 오류 안내 목업을 작성하고 샘플 동작을 확인했다. 실제 서비스 배포와 문의 감소 효과는 아직 확인하지 않았다. '
  + '제품팀은 고객지원팀에 안내 문구의 이해 가능성 검토를 요청했다. 담당자와 회신 기한은 미정이다.';
const input = {
  source_text: source,
  audience: '기능 개발에 참여하지 않은 고객지원팀. 내부 개발 약어와 기존 논의를 알지 못한다.',
  purpose: '초대 오류 안내 변경의 배경과 현재 결과를 공유하고 고객 안내 문구 검토를 요청한다.',
  constraints: '샘플 확인과 실제 배포를 구분하고 없는 성과·일정·담당자를 만들지 않는다.'
};
async function setup(t) {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const workspace = path.join(fs.realpathSync(h.dir), 'agent-workspace'); fs.mkdirSync(workspace);
  return { h, workspace };
}
const submit = (h, extra = {}) => h.runtime('/runs', { method: 'POST', body: { task, input, engine: 'fixture', ...extra } });
const finishPlan = (h, plan) => eventually(() => h.runtime(`/plans/${plan.id}`), value => !['pending', 'running'].includes(value.status), 20000);

test('sharing requires source, audience and purpose before any worker starts', async t => {
  const { h } = await setup(t);
  for (const key of ['source_text', 'audience', 'purpose']) {
    const missing = { ...input }; delete missing[key];
    await assert.rejects(submit(h, { input: missing }), /위반/);
    await assert.rejects(submit(h, { input: { ...input, [key]: '  ' } }), /위반/);
  }
  await assert.rejects(submit(h, { input: { ...input, publish: true } }), /위반/);
  assert.deepEqual(await h.runtime('/runs'), []);
});

test('team and cross-department sharing requests route to one owner and publish a format-checked document with one invocation', async t => {
  const { h, workspace } = await setup(t);
  const sourceFile = path.join(workspace, 'source.md'); fs.writeFileSync(sourceFile, source);
  const catalog = await h.runtime('/catalog'), job = catalog.jobs.find(job => job.id === task);
  for (const [prompt, audience] of [
    ['팀 내 공유 문서를 작성해 줘', '팀에 새로 합류하여 이전 논의를 모르는 개발자'],
    ['기존 PRD를 참고해서 유관 부서 공유 문서를 작성해 줘', input.audience]
  ]) {
    const requestInput = { ...input, audience };
    const result = await h.finish(await submit(h, { task: undefined, prompt, input: requestInput, workspace,
      input_files: [{ path: 'source.md', content_digest: digest(source) }], fixture: { scenario: 'prompted-rules' } }));
    assert.equal(result.status, 'completed', result.message); assert.equal(result.task, task);
    assert.deepEqual(result.attempts.map(value => value.stage), ['produce']);
    assert.equal(result.review.required, false); assert.equal(result.worker_policy.max_repairs, 0);
    assert.ok(result.artifact.output_file.startsWith(`${workspace}/output/worklog/`));
    assert.equal(path.basename(result.artifact.output_file), 'sharing-document.md');
    const published = fs.readFileSync(result.artifact.output_file, 'utf8');
    assert.equal(digest(published), result.artifact.content_digest);
    for (const heading of ['공유 목적', '배경과 맥락', '핵심 내용', '결과와 영향', '요청과 다음 단계', '참고 자료와 미확인 사항'])
      assert.ok(published.includes(`## ${heading}`));
    for (const attempt of result.attempts) {
      const text = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
      const delivered = JSON.parse(text.match(/\n검증된 작업 입력[^:]+: ([^\n]+)\n/)[1]);
      assert.deepEqual(delivered.input, requestInput);
      assert.ok(text.includes(JSON.stringify(job.boundary)));
      assert.ok(text.includes('JOB-DOCUMENT-SHARE-CREATE'));
      assert.ok(text.includes(digest(source)), 'each stage must receive the pinned source');
    }
    assert.equal(result.artifact.review_attempt, undefined);
    assert.equal(result.artifact.validation_scope, 'artifact');
  }
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
  assert.deepEqual((await h.runtime('/runs')).map(value => value.task), [task, task]);
});

test('an explicitly requested decision document feeds sharing through a reviewed immutable predecessor path', async t => {
  const { h, workspace } = await setup(t);
  const accepted = await h.runtime('/plans', { method: 'POST', body: {
    prompt: '결정 기록을 작성하고 그 결과로 업무 공유 문서를 작성해 줘', engine: 'fixture', workspace,
    steps: [
      { id: 'decision', task: 'decision.record', output_key: 'decision', request_excerpt: '결정 기록을 작성', depends_on: [],
        input: { requirements: '제공된 결정 D-01: 오류 안내 목업부터 확인한다. 배포와 실제 성과는 미확인이다.' } },
      { id: 'sharing', task, output_key: 'sharing', request_excerpt: '그 결과로 업무 공유 문서를 작성', depends_on: ['decision'],
        input: { ...input, source_text: '제공된 선행 결정 기록 파일만 기준으로 사용한다.' },
        review: { required: true, reason: '사용자가 공유 문서에 대한 별도 독립 검토를 명시적으로 추가 요청했다.' } }
    ]
  } });
  const plan = await finishPlan(h, accepted);
  assert.equal(plan.status, 'completed', plan.message); assert.equal(plan.artifacts.length, 2);
  const first = plan.steps[0].artifact, child = await h.runtime(`/runs/${plan.steps[1].run_id}`);
  for (const attempt of child.attempts) {
    const prompt = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
    const refs = JSON.parse(prompt.match(/\n고정된 자료 본문[^:]+: ([^\n]+)\n/)[1]);
    const upstream = refs.find(ref => ref.content_digest === first.content_digest);
    assert.ok(upstream); assert.equal(digest(upstream.content), first.content_digest);
    assert.ok(prompt.includes(first.output_file));
  }
  assert.equal(digest(fs.readFileSync(first.output_file)), first.content_digest);
  assert.deepEqual((await h.runtime('/runs')).map(run => run.task).sort(), ['decision.record', task].sort());
});

test('missing structure fails once; only explicitly requested review enables repairs for sharing documents', async t => {
  const { h, workspace } = await setup(t);
  for (const scenario of ['missing-section', 'always-revise']) {
    const result = await h.finish(await submit(h, { workspace, fixture: { scenario }, ...(scenario === 'always-revise'
      ? { review: { required: true, reason: '사용자가 문서 작성 후 별도 검토를 명시적으로 요청했다.' } } : {}) }));
    assert.equal(result.artifact, null);
    if (scenario === 'missing-section') {
      assert.equal(result.status, 'failed', result.message); assert.match(result.message, /검사에 실패/);
      assert.deepEqual(result.attempts.map(attempt => attempt.stage), ['produce']);
    } else {
      assert.equal(result.status, 'blocked', result.message); assert.match(result.message, /수정 한도|같은 지적/);
      assert.ok(result.attempts.some(attempt => attempt.stage === 'repair'));
      assert.ok(result.steps.some(step => step.task === 'review' && step.outcome.status === 'revise'));
    }
  }
  assert.equal(fs.existsSync(path.join(workspace, 'output')), false);
});
