import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Harness, eventually, pair } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

const events = [{ kind: 'input', event_at: '2026-09-19T01:00:00Z', text: '검토한 변경 사항을 정리해 주세요.' }];
const summary = { task: 'session.summarize', internal: true, input: { title: '작업 요약', events } };
const rewrite = format => ({ task: 'text.rewrite', internal: true, input: { format, sessions: [
  { id: 'session-1', engine: 'codex', start_at: events[0].event_at, end_at: '2026-09-19T01:05:00Z', summary: null, events }
] } });
async function setup(t) { const h = await new Harness().start('runtime'); t.after(() => h.close()); return h; }

test('ownerless internal metadata keeps runtime evidence without creating user work', async t => {
  const h = await setup(t); await h.start('manager');
  for (const input of [summary, rewrite('work-item-metadata')]) {
    const run = await h.finish(await h.run(input));
    assert.equal(run.internal, true); assert.equal(run.status, 'completed', run.message);
    assert.equal(run.attempts.length, 1); assert.ok(fs.existsSync(run.artifact.file));
    assert.deepEqual((await h.runtime('/events')).events, [], 'ownerless internal evidence must remain in the runtime');
  }
  assert.deepEqual(await h.manager('/items'), []);
  await h.ingest(pair('native-owner', '09:00:00', '09:05:00', 'one', { work_item_id: 'real-work' }));
  const before = await h.manager('/items/real-work');
  const request = { ...rewrite('work-item-metadata'), work_item_id: 'real-work' };
  const run = await h.finish(await h.run(request));
  assert.equal(run.internal, true); assert.equal(run.status, 'completed');
  const detail = await eventually(() => h.manager('/items/real-work'), item => item.runs.some(row => row.id === run.id && row.status === 'completed'));
  assert.deepEqual((await h.manager('/items')).map(item => item.id), ['real-work']);
  assert.deepEqual(detail.sessions, before.sessions);
  assert.equal(detail.agents.filter(agent => agent.role === 'user').length, 1);
  assert.equal(detail.events.filter(event => event.role === 'user' && event.kind === 'input').length, 1);
  assert.ok(detail.events.some(event => event.role === 'worker'));
});
function isolated(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-metadata-workflow-'));
  for (const folder of ['src', 'harness', 'contracts', 'tests/fixtures']) fs.cpSync(path.join(ROOT, folder), path.join(root, folder), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const h = new Harness(); h.serviceRoot = root;
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { h, root, jobs: path.join(root, 'harness/jobs.json') };
}

test('session summaries and metadata use one generation plus deterministic format validation only', async t => {
  const h = await setup(t);
  for (const task of (await h.runtime('/execution-settings')).tasks.filter(task => ['session.summarize', 'text.rewrite'].includes(task.id))) {
    assert.deepEqual(Object.keys(task.backends.codex.defaults), ['produce']);
    assert.deepEqual(Object.keys(task.backends.claude.defaults), ['produce']);
  }
  for (const input of [summary, rewrite('work-item-metadata'), rewrite('session-summary')]) {
    const run = await h.finish(await h.run(input));
    assert.equal(run.status, 'completed', run.message);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
    assert.deepEqual(run.steps.map(step => step.task), ['produce', 'verify', 'render']);
    assert.equal(run.round, 0); assert.equal(run.artifact.validation_scope, 'format');
    assert.equal(run.artifact.generation_attempt, run.attempts[0].id); assert.equal(run.artifact.review_attempt, undefined);
    assert.match(run.message, /형식 검사.*별도 모델 검토는 수행하지 않았/);
    const report = JSON.parse(fs.readFileSync(run.artifact.verify_report)); assert.equal(report.passed, true);
  }
  const prd = await h.finish(await h.run({ fixture: { scenario: 'revise-once' } }));
  assert.equal(prd.status, 'completed'); assert.deepEqual(prd.attempts.map(attempt => attempt.stage), ['produce', 'review', 'repair', 'review']);
  assert.ok(prd.artifact.review_attempt); assert.equal(prd.artifact.validation_scope, undefined);
});

test('invalid summary or metadata format fails without another model call or publication', async t => {
  const h = await setup(t);
  for (const [input, scenario] of [[summary, 'summary-too-long'], [summary, 'summary-plain'], [rewrite('session-summary'), 'rewrite-six-lines'],
    [rewrite('session-summary'), 'rewrite-summary-plain'], [rewrite('work-item-metadata'), 'rewrite-blank']]) {
    const run = await h.finish(await h.run({ ...input, fixture: { scenario } }));
    assert.equal(run.status, 'failed'); assert.match(run.message, /형식 검사에 실패/);
    assert.equal(run.artifact, null); assert.equal(run.round, 0);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
    assert.deepEqual(run.steps.map(step => step.task), ['produce', 'verify']);
  }
});

test('resumed legacy summary runs retain their frozen plain-text contract while new runs require bullets', async t => {
  const { h, jobs } = isolated(t), definitions = JSON.parse(fs.readFileSync(jobs));
  for (const task of ['session.summarize', 'text.rewrite']) delete definitions.jobs[task].summary_format;
  fs.writeFileSync(jobs, JSON.stringify(definitions)); await h.start('runtime');
  const requests = [[summary, 'summary-plain'], [rewrite('session-summary'), 'rewrite-summary-plain']];
  const legacy = [];
  for (const [input, scenario] of requests) legacy.push(await h.run({ ...input, fixture: { scenario, delayMs: 1500 } }));
  await eventually(async () => Promise.all(legacy.map(run => h.runtime(`/runs/${run.id}`))), runs => runs.every(run => run.attempts[0]?.pid));
  await h.stop('runtime');
  for (const task of ['session.summarize', 'text.rewrite']) definitions.jobs[task].summary_format = 'session-bullets-v1';
  fs.writeFileSync(jobs, JSON.stringify(definitions)); await h.start('runtime');
  for (const run of legacy) {
    await h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} });
    const restored = await h.finish(run); assert.equal(restored.status, 'completed', restored.message);
    const text = fs.readFileSync(restored.artifact.file, 'utf8');
    assert.match(text, /일반 문장/); assert.equal(restored.attempts.filter(attempt => attempt.stage === 'review').length, 0);
  }
  for (const [input, scenario] of requests) {
    const fresh = await h.finish(await h.run({ ...input, fixture: { scenario } }));
    assert.equal(fresh.status, 'failed'); assert.equal(fresh.artifact, null);
    assert.deepEqual(fresh.attempts.map(attempt => attempt.stage), ['produce']);
  }
});

test('metadata workflow changes preserve existing user instructions and backend preferences', async t => {
  const h = new Harness(); t.after(() => h.close());
  const instruction = '사용자가 정한 지시문입니다.\n  기존 표현과 공백을 유지합니다.\n';
  const file = path.join(h.dir, 'execution-settings.json');
  const custom = { instruction, backend: 'claude', backends: { codex: { model: 'gpt-5.5', effort: 'low' }, claude: { model: 'claude-opus-4-6', effort: 'high' } } };
  fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 3, tasks: { 'session.summarize': custom, 'text.rewrite': custom } }));
  const original = fs.readFileSync(file); await h.start('runtime');
  for (const input of [summary, rewrite('work-item-metadata')]) {
    const run = await h.finish(await h.run(input)); assert.equal(run.status, 'completed', run.message);
    assert.equal(run.attempts.length, 1);
    assert.ok(fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8').includes(instruction));
    const setting = (await h.runtime('/execution-settings')).tasks.find(task => task.id === input.task);
    assert.equal(setting.backend, 'claude'); assert.equal(setting.backends.codex.model, 'gpt-5.5');
    assert.equal(setting.backends.claude.effort, 'high');
  }
  assert.deepEqual(fs.readFileSync(file), original);
});

test('format-checked publication recovery reuses the generation proof without adding a review call', async t => {
  const h = await setup(t), exit = new Promise(resolve => h.processes.runtime.once('exit', resolve));
  const run = await h.run({ ...summary, fixture: { crashAfterPublish: true } });
  assert.equal(await exit, 73); await h.start('runtime');
  const interrupted = await h.runtime(`/runs/${run.id}`);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.attempts.length, 1);
  const resumed = await h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.artifact.validation_scope, 'format');
  assert.equal((await h.runtime(`/runs/${run.id}`)).attempts.length, 1);
  assert.match(resumed.message, /별도 모델 검토는 수행하지 않았/);
});

test('accepted reviewed metadata retains its frozen workflow after new requests switch to format checks', async t => {
  const { h, jobs } = isolated(t), definitions = JSON.parse(fs.readFileSync(jobs));
  definitions.jobs['session.summarize'].workflow = 'create-reviewed'; fs.writeFileSync(jobs, JSON.stringify(definitions));
  await h.start('runtime');
  const legacy = await h.run({ ...summary, fixture: { scenario: 'slow', delayMs: 300 } });
  await eventually(() => h.runtime(`/runs/${legacy.id}`), run => run.attempts[0]?.pid);
  await h.stop('runtime');
  definitions.jobs['session.summarize'].workflow = 'create-checked'; fs.writeFileSync(jobs, JSON.stringify(definitions));
  await h.start('runtime');
  await h.runtime(`/runs/${legacy.id}/resume`, { method: 'POST', body: {} });
  const restored = await h.finish(legacy); assert.equal(restored.status, 'completed', restored.message);
  assert.deepEqual(restored.attempts.map(attempt => attempt.stage), ['produce', 'produce', 'review']);
  assert.ok(restored.artifact.review_attempt); assert.equal(restored.artifact.validation_scope, undefined);
  const fresh = await h.finish(await h.run(summary)); assert.equal(fresh.status, 'completed');
  assert.deepEqual(fresh.attempts.map(attempt => attempt.stage), ['produce']);
});

test('format-only workflow cannot weaken ordinary artifact jobs', t => {
  const { h, root, jobs } = isolated(t), definitions = JSON.parse(fs.readFileSync(jobs));
  definitions.jobs['prd.create'].workflow = 'create-checked'; fs.writeFileSync(jobs, JSON.stringify(definitions));
  const child = spawnSync(process.execPath, [path.join(root, 'src/runtime.mjs')], {
    env: { ...process.env, HARNESS_DATA_DIR: h.dir, HARNESS_TEST_MODE: '1' }, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /독립 검토 생략은 등록된/);
  assert.doesNotMatch(child.stdout, /"ready":true/);
});
