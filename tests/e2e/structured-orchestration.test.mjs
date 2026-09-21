import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Harness } from '../helpers.mjs';
import { ROOT, digest } from '../../src/shared.mjs';
import { canonicalJson } from '../../src/schema.mjs';

async function setup(t) { const h = await new Harness().start('runtime'); t.after(() => h.close()); return h; }
const submit = (h, data) => h.runtime('/runs', { method: 'POST', body: { engine: 'fixture', ...data } });
const trace = result => result.steps.map(s => [s.node, s.task, s.outcome?.status, s.next_node, s.reason]);

function isolatedCatalog(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-catalog-'));
  for (const folder of ['src', 'bin', 'harness', 'contracts', 'tests/fixtures']) fs.cpSync(path.join(ROOT, folder), path.join(root, folder), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const h = new Harness(); h.serviceRoot = root;
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, h, workflows: path.join(root, 'harness/workflows.json') };
}

test('structured task/input starts without a free-text prompt and records every workflow gate', async t => {
  const h = await setup(t), input = { requirements: '관리자는 초대하고 사용자는 수락·거절할 수 있다.' };
  const result = await h.finish(await submit(h, { task: 'prd.create', input }));
  assert.equal(result.status, 'completed', result.message);
  assert.deepEqual(result.request, { task: 'prd.create', input });
  assert.equal(result.request_digest, digest(canonicalJson(result.request)));
  const catalog = await h.runtime('/catalog');
  assert.deepEqual(catalog.jobs.find(j => j.id === 'prd.create').input_schema.required, ['requirements']);
  assert.deepEqual(result.steps.map(s => s.task), ['produce', 'verify', 'review', 'render']);
  assert.deepEqual(result.steps.map(s => s.next_node), ['verify', 'review', 'render', '$completed']);
  assert.ok(result.steps.every(s => s.status === 'completed' && s.outcome.status === 'done'));
  const prompt = fs.readFileSync(path.join(result.attempts[0].directory, 'prompt.txt'), 'utf8');
  assert.match(prompt, /검증된 작업 입력/); assert.match(prompt, /"requirements"/);
});

test('all job input contracts reject invalid types and unknown fields before a process or run is created', async t => {
  const h = await setup(t);
  for (const [task, input] of [
    ['prd.create', {}], ['entity.design', { requirements: ['wrong type'] }], ['text.generate', { requirements: 'x', arbitrary: true }],
    ['mockup.html.create', { requirements: '화면', browser_checks: [{ click: '#save', visible: '#result', text: 123 }] }],
    ['test.scenarios.plan', { requirements: [{ id: 'REQ-1', text: '세션 보존' }], categories: ['invented'] }],
    ['checks.run', { profile: 123 }], ['verification.report', { run_ids: [123] }]
  ]) await assert.rejects(submit(h, { task, input }));
  await assert.rejects(submit(h, { task: 'prd.create', input: null }));
  await assert.rejects(submit(h, { task: 'prd.create', input: { requirements: 'x' }, next: 'render' }));
  assert.deepEqual(await h.runtime('/runs'), []);
});

test('mixed prompt and structured instructions both survive normalization and reach the worker', async t => {
  const h = await setup(t), prompt = '한글로 작성하고 개인정보 저장 기간을 정의한다.';
  const result = await h.finish(await submit(h, { task: 'prd.create', prompt,
    input: { requirements: '팀원 초대 기능', instructions: '취소·거절 상태별 수용 기준을 표로 작성한다.' } }));
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.request.input.instructions, `${prompt}\n\n취소·거절 상태별 수용 기준을 표로 작성한다.`);
  assert.equal(result.request_digest, digest(canonicalJson(result.request)));
  const workerPrompt = fs.readFileSync(path.join(result.attempts[0].directory, 'prompt.txt'), 'utf8');
  assert.match(workerPrompt, /개인정보 저장 기간/); assert.match(workerPrompt, /취소·거절 상태별 수용 기준/);
  await assert.rejects(submit(h, { task: 'prd.create', prompt, input: { requirements: '팀원 초대 기능', instructions: '   ' } }));
});

test('canonical inputs and validated decisions yield the same bounded orchestration trace', async t => {
  const h = await setup(t);
  const first = await h.finish(await submit(h, { task: 'prd.create', input: { requirements: '초대·거절 상태', instructions: '수용 기준을 포함한다.' }, fixture: { scenario: 'revise-once' } }));
  const second = await h.finish(await submit(h, { task: 'prd.create', input: { instructions: '수용 기준을 포함한다.', requirements: '초대·거절 상태' }, fixture: { scenario: 'revise-once' } }));
  assert.equal(first.status, 'completed'); assert.equal(second.status, 'completed');
  assert.equal(first.request_digest, second.request_digest); assert.deepEqual(trace(first), trace(second));
  assert.deepEqual(first.steps.map(s => s.task), ['produce', 'verify', 'review', 'repair', 'verify', 'review', 'render']);
  const limited = await h.finish(await submit(h, { task: 'prd.create', input: { requirements: '초대·거절 상태' }, fixture: { scenario: 'always-revise' } }));
  assert.equal(limited.status, 'blocked'); assert.equal(limited.steps.at(-1).reason, 'repair_limit');
  assert.equal(limited.steps.at(-1).next_node, '$blocked'); assert.equal(limited.steps.filter(s => s.task === 'repair').length, 2);
});

test('a worker cannot add a next node to bypass required gates', async t => {
  const h = await setup(t);
  const result = await h.finish(await submit(h, { task: 'prd.create', input: { requirements: '초대 기능' }, fixture: { scenario: 'illegal-transition' } }));
  assert.equal(result.status, 'failed'); assert.match(result.message, /protocol_failure/);
  assert.equal(result.steps.length, 1); assert.equal(result.steps[0].next_node, '$failed'); assert.equal(result.artifact, null);
});

test('independent review accepts exactly the effective rules supplied in its prompt, including common gates', async t => {
  const h = await setup(t);
  const result = await h.finish(await submit(h, { task: 'prd.create', input: { requirements: '관리자만 팀원을 초대한다.' }, fixture: { scenario: 'prompted-rules' } }));
  assert.equal(result.status, 'completed', result.message);
  const review = result.attempts.find(a => a.stage === 'review');
  const response = JSON.parse(fs.readFileSync(path.join(review.directory, 'result.json')));
  const prompt = fs.readFileSync(path.join(review.directory, 'prompt.txt'), 'utf8');
  const effectiveRules = Object.keys(JSON.parse(prompt.match(/\n규칙: ([^\n]+)\n/)[1]));
  assert.deepEqual(response.result.evaluations.map(e => e.rule), effectiveRules);
  assert.ok(['REQ-001', 'PRD-AC-001', 'OUTPUT-001', 'SCOPE-001', 'JOB-BOUNDARY-001'].every(rule => effectiveRules.includes(rule)));
});

test('common review evidence is mandatory even after automatic file checks pass', async t => {
  const h = await setup(t);
  const result = await h.finish(await submit(h, { task: 'prd.create', input: { requirements: '관리자만 팀원을 초대한다.' }, fixture: { scenario: 'omit-common-rule' } }));
  assert.equal(result.status, 'failed'); assert.match(result.message, /필수 검토 규칙이 누락/);
  assert.equal(result.steps.find(s => s.task === 'verify').outcome.status, 'done');
  assert.equal(result.artifact, null);
});

test('live verification refuses more calls when a previous batch consumed the approved budget', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-live-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = path.join(root, 'previous.json'), output = path.join(root, 'next');
  fs.writeFileSync(previous, JSON.stringify({ engine: 'codex', finished_at: new Date().toISOString(), runs: [{ attempts: Array.from({ length: 18 }, () => ({ status: 'returned' })) }] }));
  const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts/live-smoke.mjs')], {
    env: { ...process.env, HARNESS_LIVE_APPROVED: '1', HARNESS_LIVE_ENGINE: 'codex', HARNESS_LIVE_PREVIOUS_REPORT: previous,
      HARNESS_LIVE_OUTPUT_DIR: output, HARNESS_CODEX_BIN: path.join(ROOT, 'tests/fixtures/cli-double.mjs') }, encoding: 'utf8', timeout: 15000 });
  assert.ok(!child.error, child.error?.message); assert.equal(child.status, 1);
  const result = JSON.parse(fs.readFileSync(path.join(output, 'report.json')));
  assert.equal(result.budget.total_calls, 18); assert.equal(result.budget.current_calls, 0);
  assert.equal(result.runs.length, 3); assert.ok(result.runs.every(run => run.status === 'not_run' && run.attempts.length === 0));
});

test('live verification waits for final management history before stopping its services, using a CLI protocol double', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-live-projection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'result');
  const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts/live-smoke.mjs')], {
    env: { ...process.env, HARNESS_LIVE_APPROVED: '1', HARNESS_LIVE_ENGINE: 'codex', HARNESS_LIVE_PREVIOUS_REPORT: '',
      HARNESS_LIVE_OUTPUT_DIR: output, HARNESS_CODEX_BIN: path.join(ROOT, 'tests/fixtures/cli-double.mjs') }, encoding: 'utf8', timeout: 20000 });
  assert.ok(!child.error, child.error?.message); assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(fs.readFileSync(path.join(output, 'report.json')));
  assert.equal(result.budget.current_calls, 6); assert.equal(result.passed, true);
  assert.ok(result.runs.every(run => run.management.state === 'completed' && run.management.sessions.every(session => !session.pending)));
  const db = new DatabaseSync(path.join(output, 'memory.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM run_views WHERE json_extract(payload,'$.status')='completed'").get().n, 3);
    assert.equal(db.prepare('SELECT count(*) n FROM work_item_sessions WHERE active=1 AND pending=1').get().n, 0);
  } finally { db.close(); }
});

test('renamed workflow nodes drive actual processes, gates and delivery without executor-specific branches', async t => {
  const { h, workflows } = isolatedCatalog(t), definitions = JSON.parse(fs.readFileSync(workflows));
  const aliases = { produce: 'draft', verify: 'validate', review: 'assess', repair: 'correct', render: 'deliver' };
  const workflow = definitions['create-reviewed']; workflow.initial = 'draft';
  workflow.nodes = Object.fromEntries(Object.entries(workflow.nodes).map(([id, node]) => [aliases[id], { ...node,
    on: Object.fromEntries(Object.entries(node.on).map(([status, next]) => [status, aliases[next] || next])) }]));
  fs.writeFileSync(workflows, JSON.stringify(definitions)); await h.start('runtime');
  const result = await h.finish(await submit(h, { task: 'prd.create', input: { requirements: '권한 요청' }, fixture: { scenario: 'revise-once' } }));
  assert.equal(result.status, 'completed', result.message);
  assert.deepEqual(result.steps.map(s => s.node), ['draft', 'validate', 'assess', 'correct', 'validate', 'assess', 'deliver']);
  assert.deepEqual(result.attempts.map(a => a.stage), ['produce', 'review', 'repair', 'review']);
});

test('invalid orchestration definitions fail service startup before accepting work', async t => {
  const { root, h, workflows } = isolatedCatalog(t), original = JSON.parse(fs.readFileSync(workflows));
  const mutations = [
    w => w.nodes.produce.on.done = 'render',
    w => w.nodes.verify.on.failed = '$completed',
    w => delete w.nodes.repair.budget,
    w => w.nodes.review.on.revise = 'review',
    w => w.nodes.produce.on.done = 'missing',
    w => w.max_steps = 0
  ];
  for (const mutate of mutations) {
    const modified = structuredClone(original); mutate(modified['create-reviewed']); fs.writeFileSync(workflows, JSON.stringify(modified));
    const child = spawnSync(process.execPath, [path.join(root, 'src/runtime.mjs')], {
      env: { ...process.env, HARNESS_DATA_DIR: h.dir, HARNESS_TEST_MODE: '1' }, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(child.status, 0); assert.ok(!child.error, child.error?.message);
    assert.doesNotMatch(child.stdout, /"ready":true/); assert.match(child.stderr, /Error:/);
    assert.ok(!fs.existsSync(path.join(h.dir, 'runtime.endpoint.json')));
  }
});
