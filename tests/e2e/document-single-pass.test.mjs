import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Harness, eventually } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

const tasks = ['document.create', 'document.share.create', 'document.update', 'document.review', 'text.generate'];
const input = task => task === 'document.share.create'
  ? { source_text: '문서에 요건과 확인되지 않은 항목을 기록했습니다.', audience: '팀원', purpose: '작업 내용을 공유합니다.' }
  : { requirements: '제공된 문서와 사실을 이 작업의 범위 안에서 처리하세요.' };
async function setup(t) { const h = await new Harness().start('runtime'); t.after(() => h.close()); return h; }
function isolated(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-document-policy-'));
  for (const directory of ['src', 'harness', 'contracts', 'tests/fixtures']) fs.cpSync(path.join(ROOT, directory), path.join(root, directory), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const h = new Harness(); h.serviceRoot = root;
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { h, root, jobs: path.join(root, 'harness/jobs.json') };
}

test('all document and text deliverables default to one generation without independent quality review or automatic repair', async t => {
  const h = await setup(t), catalog = await h.runtime('/catalog');
  for (const task of tasks) {
    const job = catalog.jobs.find(job => job.id === task);
    assert.equal(job.review_policy.default_required, false); assert.equal(job.review_policy.omission_allowed, true);
    assert.equal(job.worker_policy.max_agent_attempts, 1); assert.equal(job.worker_policy.max_repairs, 0);
    assert.equal(job.worker_policy.mode, 'direct');
    const run = await h.finish(await h.run({ task, prompt: undefined, input: input(task), fixture: { scenario: 'always-revise' } }));
    assert.equal(run.status, 'completed', `${task}: ${run.message}`);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
    assert.deepEqual(run.steps.map(step => step.task), ['produce', 'verify', 'render']);
    assert.equal(run.round, 0); assert.equal(run.review.required, false);
    assert.equal(run.artifact.review_attempt, undefined); assert.equal(run.artifact.validation_scope, 'artifact');
    assert.ok(run.artifact.generation_attempt); assert.match(run.message, /별도 모델 검토는 수행하지 않았/);
  }
});

test('invalid document structure or text response ends after one attempt and is never repaired or published silently', async t => {
  const h = await setup(t);
  for (const task of tasks) {
    const run = await h.finish(await h.run({ task, prompt: undefined, input: input(task),
      fixture: { scenario: task === 'text.generate' ? 'invalid' : 'missing-section' } }));
    assert.equal(run.status, 'failed', task); assert.equal(run.artifact, null);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
    assert.equal(run.round, 0); assert.ok(!run.steps.some(step => ['review', 'repair'].includes(step.task)));
  }
});

test('document.review still requests a substantive original-document review while preserving the original file', async t => {
  const h = await setup(t), workspace = path.join(h.dir, 'requesting-workspace');
  fs.mkdirSync(workspace);
  const original = '# 승인 절차\n거절 이후의 상태와 사용자 안내가 정의되지 않았습니다.\n';
  fs.writeFileSync(path.join(workspace, 'original.md'), original);
  const run = await h.finish(await h.run({ task: 'document.review', prompt: undefined, workspace,
    input_files: [{ path: 'original.md' }], input: { requirements: '원본 승인 절차의 상태 누락만 검토하세요. 수정하지 마세요.', criteria: '거절 이후 상태와 안내의 정의 여부' },
    fixture: { copyInputSnapshot: true } }));
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
  const prompt = fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8');
  assert.match(prompt, /이 생성 단계의 본 업무는 제공된 원본을 기준과 대조하는 실제 검토/);
  assert.match(prompt, /원본 위치·판정·지적·근거·미확인 항목/);
  assert.match(prompt, /단순 요약으로 대체하거나 원문을 수정하지/);
  assert.ok(prompt.includes('거절 이후의 상태와 사용자 안내가 정의되지 않았습니다.'));
  const report = fs.readFileSync(run.artifact.file, 'utf8');
  for (const heading of ['검토 대상', '판정', '지적', '근거', '미확인']) assert.ok(report.includes(`## ${heading}`));
  assert.equal(fs.readFileSync(path.join(workspace, 'original.md'), 'utf8'), original);
  assert.equal(run.artifact.review_attempt, undefined, 'the original-document review is not a second quality-review invocation');
});

test('document and text templates inherit single-pass defaults while a user can explicitly request quality review', async t => {
  const h = await setup(t);
  for (const template of tasks) {
    const settings = await h.runtime('/execution-settings');
    const created = await h.runtime('/execution-settings/custom-tasks', { method: 'POST', body: {
      revision: settings.revision, template_id: template, label: `맞춤 ${template}`, description: '선택한 문서 작업의 범위만 수행합니다.',
      routing_terms: [`맞춤 ${template}`], instruction: `# 맞춤 ${template}\n원본 사실과 요청한 범위를 보존합니다.`, backend: 'codex',
      backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } }
    } });
    const task = created.created_task_id, job = (await h.runtime('/catalog')).jobs.find(job => job.id === task);
    assert.equal(job.review_policy.default_required, false); assert.equal(job.review_policy.omission_allowed, true);
    for (const review of [undefined, { required: false, reason: '기본 단일 생성 흐름을 유지합니다.' }, { required: true, reason: '사용자가 결과물의 별도 품질 검토를 요청했습니다.' }]) {
      const run = await h.finish(await h.run({ task, prompt: undefined, input: input(template), ...(review ? { review } : {}) }));
      assert.equal(run.status, 'completed', `${template}: ${run.message}`);
      assert.deepEqual(run.attempts.map(attempt => attempt.stage), review?.required ? ['produce', 'review'] : ['produce']);
      assert.equal(!!run.artifact.review_attempt, !!review?.required);
    }
  }
});

test('specialized jobs still reject quality review omission before scheduling any worker', async t => {
  const h = await setup(t);
  for (const task of ['prd.create', 'entity.design', 'api.design', 'backend.implement', 'research.compare', 'code.review']) {
    await assert.rejects(h.run({ task, review: { required: false, reason: '문서 종류와 같은 방식으로 생략합니다.' } }), /독립 검토를 생략할 수 없습니다/);
  }
  assert.deepEqual(await h.runtime('/runs'), []);
});

test('catalog startup cannot silently apply the document exception to a specialized PRD', t => {
  const { h, root, jobs } = isolated(t), definitions = JSON.parse(fs.readFileSync(jobs));
  definitions.jobs['prd.create'].workflow = 'create-checked'; fs.writeFileSync(jobs, JSON.stringify(definitions));
  const child = spawnSync(process.execPath, [path.join(root, 'src/runtime.mjs')], {
    env: { ...process.env, HARNESS_DATA_DIR: h.dir, HARNESS_TEST_MODE: '1' }, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /독립 검토 생략은 등록된/); assert.doesNotMatch(child.stdout, /"ready":true/);
});

test('an accepted document keeps its frozen reviewed workflow after the catalog defaults switch to single-pass', async t => {
  const { h, jobs } = isolated(t), definitions = JSON.parse(fs.readFileSync(jobs));
  definitions.jobs['document.create'].workflow = 'create-reviewed'; fs.writeFileSync(jobs, JSON.stringify(definitions));
  await h.start('runtime');
  const legacy = await h.run({ task: 'document.create', prompt: undefined, input: input('document.create'), fixture: { delayMs: 350 } });
  await eventually(() => h.runtime(`/runs/${legacy.id}`), run => run.attempts[0]?.pid);
  await h.stop('runtime');
  definitions.jobs['document.create'].workflow = 'create-checked'; fs.writeFileSync(jobs, JSON.stringify(definitions));
  await h.start('runtime'); await h.runtime(`/runs/${legacy.id}/resume`, { method: 'POST', body: {} });
  const restored = await h.finish(legacy);
  assert.equal(restored.status, 'completed', restored.message); assert.equal(restored.review.required, true); assert.ok(restored.artifact.review_attempt);
  assert.equal(restored.attempts.filter(attempt => attempt.stage === 'review').length, 1);
  const fresh = await h.finish(await h.run({ task: 'document.create', prompt: undefined, input: input('document.create') }));
  assert.equal(fresh.status, 'completed'); assert.deepEqual(fresh.attempts.map(attempt => attempt.stage), ['produce']);
  assert.equal(fresh.review.required, false);
});
