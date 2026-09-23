import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, eventually } from '../helpers.mjs';
import { digest } from '../../src/shared.mjs';

const noReview = { required: false, reason: '제공된 사내 행사 사실을 한 문장의 안내 문구로 바꾸며 외부 조사나 전문 판단이 없습니다.' };
const required = { required: true, reason: '사용자가 검토를 명시해 원문과 결과를 독립 대조해야 합니다.' };
const simple = { task: 'text.generate', input: { requirements: '제공 사실: 행사 시작은 오전 10시입니다. 이 사실만 사용해 한 문장으로 안내하세요.' } };
const step = (id, review, depends_on = []) => ({ id, task: 'text.generate', input: { requirements: `${id}: 제공된 행사 시작 시각만 사용해 한 문장 안내를 작성하세요.` },
  review, depends_on, output_key: id, request_excerpt: id });
const planInput = { prompt: '안내 문구를 작성하고 요청한 검토본을 작성하세요.', engine: 'fixture', idempotency_key: 'selected-review-plan',
  steps: [step('안내', noReview), step('검토본', required, ['안내'])] };
// Step IDs are transport identifiers; the excerpt remains the exact source text.
planInput.steps[0].id = 'notice'; planInput.steps[1].id = 'reviewed-copy'; planInput.steps[1].depends_on = ['notice'];
async function setup(t) { const h = await new Harness().start('runtime'); t.after(() => h.close()); return h; }
const plan = (h, input) => h.runtime('/plans', { method: 'POST', body: input });
const finishPlan = (h, id) => eventually(() => h.runtime(`/plans/${id}`), result => !['pending', 'running'].includes(result.status), 15000);

test('explicit short-text review decisions compile into different real worker graphs and are retained as evidence', async t => {
  const h = await setup(t);
  const catalog = await h.runtime('/catalog');
  assert.deepEqual(catalog.jobs.filter(job => job.review_policy.omission_allowed).map(job => job.id).sort(), ['meeting.summarize', 'progress.summarize', 'text.generate']);
  assert.equal(catalog.jobs.find(job => job.id === 'text.generate').review_policy.default_required, true);
  for (const review of [undefined, required, noReview]) {
    const run = await h.finish(await h.run({ ...simple, ...(review ? { review } : {}) }));
    assert.equal(run.status, 'completed', run.message);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), review?.required === false ? ['produce'] : ['produce', 'review']);
    assert.equal(run.review.required, review?.required !== false);
    if (review) { assert.deepEqual(run.review, review); assert.deepEqual(run.request.review, review); }
    if (review?.required === false) {
      assert.equal(run.artifact.validation_scope, 'artifact'); assert.equal(run.artifact.review_attempt, undefined);
      assert.match(run.message, /기본 산출물 검사.*별도 모델 검토는 수행하지 않았/);
    } else assert.ok(run.artifact.review_attempt);
  }
  const prd = await h.finish(await h.run({ review: required }));
  assert.equal(prd.status, 'completed'); assert.deepEqual(prd.attempts.map(attempt => attempt.stage), ['produce', 'review']);
});

test('profile ceilings reject review omission and validate every plan decision before creating any work', async t => {
  const h = await setup(t);
  for (const task of ['prd.create', 'entity.design', 'backend.implement', 'research.compare', 'document.review', 'code.review', 'architecture.review']) {
    await assert.rejects(h.run({ task, input: {}, review: noReview }), /독립 검토를 생략할 수 없습니다/);
  }
  await assert.rejects(h.run({ task: 'session.summarize', input: {}, review: required }), /프로필에 고정된/);
  await assert.rejects(h.run({ task: 'checks.run', input: {}, review: noReview }), /프로필에 고정된/);
  for (const review of [{ required: false }, { required: false, reason: '   ' }, { required: 'false', reason: '확인' }, { ...noReview, engine: 'fixture' }]) {
    await assert.rejects(h.run({ ...simple, review }), /위반/);
  }
  await assert.rejects(plan(h, { ...planInput, steps: [planInput.steps[0], { ...planInput.steps[1], task: 'prd.create', review: noReview }] }), /독립 검토를 생략할 수 없습니다/);
  assert.deepEqual(await h.runtime('/runs'), []); assert.deepEqual(await h.runtime('/plans'), []);
});

test('idempotency cannot reuse a completed artifact for a changed review decision or reason', async t => {
  const h = await setup(t), input = { ...simple, idempotency_key: 'review-decision', review: noReview };
  const run = await h.finish(await h.run(input)); assert.equal(run.attempts.length, 1);
  assert.equal((await h.run(input)).id, run.id);
  for (const review of [required, { ...noReview, reason: '다른 근거' }]) await assert.rejects(h.run({ ...input, review }), /다른 입력 선언/);
  const completed = await finishPlan(h, (await plan(h, planInput)).id);
  assert.equal(completed.status, 'completed'); assert.equal((await plan(h, planInput)).id, completed.id);
  await assert.rejects(plan(h, { ...planInput, steps: [{ ...planInput.steps[0], review: required }, planInput.steps[1]] }), /다른 입력/);
});

test('a mixed plan freezes review choices and reuses completed unreviewed evidence across restart', async t => {
  const h = await setup(t), accepted = await plan(h, { ...planInput, fixture: { delayMs: 450 } });
  assert.deepEqual(accepted.steps.map(step => step.review), [noReview, required]);
  const active = await eventually(() => h.runtime(`/plans/${accepted.id}`), result => result.steps[0].status === 'completed' && result.steps[1].status === 'running');
  const first = await h.runtime(`/runs/${active.steps[0].run_id}`);
  assert.equal(first.attempts.length, 1); assert.equal(first.artifact.validation_scope, 'artifact');
  await h.stop('runtime'); await h.start('runtime');
  await h.runtime(`/plans/${accepted.id}/resume`, { method: 'POST', body: {} });
  const completed = await finishPlan(h, accepted.id); assert.equal(completed.status, 'completed', completed.message);
  assert.deepEqual(completed.steps.map(step => step.review), [noReview, required]);
  const reused = await h.runtime(`/runs/${completed.steps[0].run_id}`), reviewed = await h.runtime(`/runs/${completed.steps[1].run_id}`);
  assert.equal(reused.attempts.length, 1); assert.deepEqual(reused.artifact, first.artifact);
  assert.equal(digest(fs.readFileSync(reused.artifact.file)), reused.artifact.content_digest);
  assert.deepEqual(reviewed.attempts.slice(-2).map(attempt => attempt.stage), ['produce', 'review']);
  assert.ok(reviewed.artifact.review_attempt);
  const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'), { readOnly: true });
  const definitions = db.prepare('SELECT prepared FROM plan_steps WHERE plan_id=? ORDER BY position').all(accepted.id).map(row => JSON.parse(row.prepared).definition);
  db.close();
  assert.equal(definitions[0].workflow.review_required, false); assert.notEqual(definitions[1].workflow.review_required, false);
  assert.equal(definitions[1].upstream[0].content_digest, reused.artifact.content_digest);
});

test('changing a completed unchecked predecessor still blocks plan evidence reuse', async t => {
  const h = await setup(t), accepted = await plan(h, { ...planInput, fixture: { delayMs: 450 } });
  const active = await eventually(() => h.runtime(`/plans/${accepted.id}`), result => result.steps[0].status === 'completed' && result.steps[1].status === 'running');
  await h.runtime(`/plans/${accepted.id}/cancel`, { method: 'POST', body: {} });
  await eventually(() => h.runtime('/health'), health => health.active === 0);
  fs.appendFileSync(active.steps[0].artifact.file, '\n검증 이후 변경\n');
  await assert.rejects(h.runtime(`/plans/${accepted.id}/resume`, { method: 'POST', body: {} }), /완료 산출물이 변경/);
});

test('publication recovery preserves an explicit no-review decision and never invents review evidence', async t => {
  const h = await setup(t), exit = new Promise(resolve => h.processes.runtime.once('exit', resolve));
  const run = await h.run({ ...simple, review: noReview, fixture: { crashAfterPublish: true } });
  assert.equal(await exit, 73); await h.start('runtime');
  const resumed = await h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} });
  assert.equal(resumed.status, 'completed', resumed.message); assert.deepEqual(resumed.review, noReview);
  assert.equal(resumed.artifact.validation_scope, 'artifact'); assert.equal(resumed.artifact.review_attempt, undefined);
  assert.match(resumed.message, /기본 산출물 검사.*별도 모델 검토는 수행하지 않았/);
  assert.equal((await h.runtime(`/runs/${run.id}`)).attempts.length, 1);
});
