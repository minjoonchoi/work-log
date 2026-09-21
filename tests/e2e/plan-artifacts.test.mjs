import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';
import { digest } from '../../src/shared.mjs';

const step = (id, task = 'prd.create', depends_on = [], extra = {}) => ({ id, task, depends_on,
  output_key: id, request_excerpt: id, input: { requirements: `${id}에 배정된 산출물만 작성하세요.` }, ...extra });
const submit = (h, workspace, steps, extra = {}) => h.runtime('/plans', { method: 'POST', body: {
  prompt: steps.map(value => value.id).join(' '), engine: 'fixture', workspace, steps, ...extra
} });
const finish = (h, plan) => eventually(() => h.runtime(`/plans/${plan.id}`), value => !['pending', 'running'].includes(value.status), 20000);
async function setup(t) {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const workspace = path.join(fs.realpathSync(h.dir), 'agent project'); fs.mkdirSync(workspace);
  return { h, workspace };
}
function filesIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

test('plan outputs publish in the agent workspace and downstream workers receive frozen file inputs and predecessor paths', async t => {
  const { h, workspace } = await setup(t);
  const source = path.join(workspace, 'requirements.md'), original = '# 원본 기준\n접수 당시 승인 정책입니다.\n';
  fs.writeFileSync(source, original);
  const input_files = [{ path: 'requirements.md', content_digest: digest(original) }];
  const accepted = await submit(h, workspace, [step('requirements', 'prd.create', [], { input_files }),
    step('entities', 'entity.design', ['requirements'], { input_files })], { fixture: { delayMs: 200 } });
  fs.writeFileSync(source, '# 접수 후 변경\n새로운 요청에만 적용할 내용입니다.\n');
  const plan = await finish(h, accepted);
  assert.equal(plan.status, 'completed', plan.message); assert.equal(plan.workspace, workspace);
  assert.equal(plan.artifacts.length, 2);
  for (const artifact of plan.artifacts) {
    assert.ok(artifact.output_file.startsWith(`${workspace}/output/`));
    assert.equal(digest(fs.readFileSync(artifact.output_file)), artifact.content_digest);
    assert.equal(digest(fs.readFileSync(artifact.file)), artifact.content_digest);
  }
  assert.equal(new Set(plan.artifacts.map(value => value.output_file)).size, 2);
  const child = await h.runtime(`/runs/${plan.steps[1].run_id}`);
  for (const attempt of child.attempts) {
    const inputFiles = filesIn(path.join(attempt.directory, 'inputs'));
    const contents = inputFiles.map(file => fs.readFileSync(file, 'utf8'));
    assert.ok(contents.includes(original), 'waiting work must use the source frozen at plan acceptance');
    assert.ok(contents.includes(fs.readFileSync(plan.artifacts[0].file, 'utf8')), 'approved upstream artifact must be available as a file');
    const prompt = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
    assert.ok(prompt.includes(plan.artifacts[0].output_file));
    assert.ok(inputFiles.some(file => prompt.includes(fs.realpathSync(file))), 'the worker prompt must identify its materialized input path');
  }
});

test('every referenced file is validated before registering a plan or child run', async t => {
  const { h, workspace } = await setup(t);
  fs.writeFileSync(path.join(workspace, 'source.md'), 'source');
  for (const input_files of [[{ path: 'missing.md' }], [{ path: 'source.md', content_digest: '0'.repeat(64) }]]) {
    await assert.rejects(submit(h, workspace, [step('valid'), step('invalid', 'entity.design', ['valid'], { input_files })]));
  }
  assert.deepEqual(await h.runtime('/plans'), []); assert.deepEqual(await h.runtime('/runs'), []);
  assert.deepEqual(filesIn(path.join(workspace, 'output')), []);
});

test('filesystem names that resemble credential labels remain exact while prompt logs stay redacted', async t => {
  const { h, workspace: parent } = await setup(t);
  const workspace = path.join(parent, 'api_key=project'); fs.mkdirSync(workspace);
  const name = 'access_token=reference.md', original = '파일명은 자격증명이 아니라 원본 자료의 식별자입니다.\n';
  fs.writeFileSync(path.join(workspace, name), original);
  const plan = await finish(h, await submit(h, workspace, [step('source', 'prd.create', [], {
    input_files: [{ path: name, content_digest: digest(original) }]
  })]));
  assert.equal(plan.status, 'completed', plan.message); assert.equal(plan.workspace, workspace);
  const run = await h.runtime(`/runs/${plan.steps[0].run_id}`);
  assert.equal(run.request.input_files[0].path, path.join(workspace, name));
  assert.ok(run.artifact.output_file.startsWith(`${workspace}/output/`));
  for (const attempt of run.attempts) {
    assert.ok(filesIn(path.join(attempt.directory, 'inputs')).some(file => fs.readFileSync(file, 'utf8') === original));
    const log = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
    assert.ok(log.includes('[REDACTED]')); assert.ok(!log.includes('api_key=project'));
    assert.ok(!log.includes('access_token=reference.md'));
  }
});

test('identical task instructions may own distinct outputs when their referenced source files differ', async t => {
  const { h, workspace } = await setup(t);
  fs.writeFileSync(path.join(workspace, 'left.md'), '왼쪽 제품 요구사항');
  fs.writeFileSync(path.join(workspace, 'right.md'), '오른쪽 제품 요구사항');
  const input = { requirements: '제공한 제품의 PRD만 작성하세요.' };
  const plan = await finish(h, await submit(h, workspace, [
    step('left', 'prd.create', [], { input, input_files: [{ path: 'left.md' }] }),
    step('right', 'prd.create', [], { input, input_files: [{ path: 'right.md' }] })
  ]));
  assert.equal(plan.status, 'completed', plan.message);
  assert.equal(new Set(plan.artifacts.map(value => value.output_file)).size, 2);
});

test('failed plan work never exports its unapproved candidate to the agent output directory', async t => {
  const { h, workspace } = await setup(t);
  const plan = await finish(h, await submit(h, workspace, [step('blocked'), step('never-start', 'entity.design', ['blocked'])],
    { fixture: { scenario: 'always-revise' } }));
  assert.equal(plan.status, 'blocked'); assert.equal(plan.artifacts.length, 0);
  assert.equal(plan.steps[1].run_id, null); assert.deepEqual(filesIn(path.join(workspace, 'output')), []);
});

test('tampering only with a published predecessor blocks later dependencies and plan resume', async t => {
  const { h, workspace } = await setup(t);
  const accepted = await submit(h, workspace, [step('source'), step('gate', 'screen.specify', ['source']),
    step('dependent', 'entity.design', ['gate'])], { fixture: { delayMs: 300 } });
  const active = await eventually(() => h.runtime(`/plans/${accepted.id}`), value =>
    value.steps[0].status === 'completed' && value.steps[1].status === 'running');
  const source = active.artifacts[0];
  fs.appendFileSync(source.output_file, '\n공개 파일만 외부에서 변경됨');
  assert.equal(digest(fs.readFileSync(source.file)), source.content_digest, 'managed evidence stays intact');
  const plan = await finish(h, accepted);
  assert.equal(plan.status, 'blocked'); assert.equal(plan.steps[2].run_id, null);
  assert.match(plan.steps[2].message, /선행 산출물이 검증 후 변경/);
  await assert.rejects(h.runtime(`/plans/${plan.id}/resume`, { method: 'POST', body: {} }), /완료 산출물이 변경/);
});

test('final completion rechecks public artifacts after all dependent workers have already started', async t => {
  const { h, workspace } = await setup(t);
  const accepted = await submit(h, workspace, [step('source'), step('last', 'entity.design', ['source'])], { fixture: { delayMs: 300 } });
  const active = await eventually(() => h.runtime(`/plans/${accepted.id}`), value =>
    value.steps[0].status === 'completed' && value.steps[1].status === 'running');
  fs.unlinkSync(active.artifacts[0].output_file);
  const plan = await finish(h, accepted);
  assert.equal(plan.progress.completed, 2); assert.equal(plan.status, 'blocked');
  assert.match(plan.message, /최종 산출물이 검증 후 변경되었거나 없어/);
  await assert.rejects(h.runtime(`/plans/${plan.id}/resume`, { method: 'POST', body: {} }), /완료 산출물이 변경/);
});
