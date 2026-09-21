import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';
import { digest } from '../../src/shared.mjs';

const body = { method: 'POST' };
const step = (id, task = 'prd.create', deps = []) => ({ id, task, output_key: id, request_excerpt: id,
  input: { requirements: `${id}에 배정된 결과만 작성한다.` }, depends_on: deps });
const request = steps => ({ prompt: steps.map(value => value.id).join(' '), engine: 'fixture', steps });
const create = (h, value) => h.runtime('/plans', { ...body, body: value });
const finish = (h, plan) => eventually(() => h.runtime(`/plans/${plan.id}`), value => !['pending', 'running'].includes(value.status), 20000);
async function setup(t, manager = false) { const h = await new Harness().start('runtime'); if (manager) await h.start('manager'); t.after(() => h.close()); return h; }

test('compound request forks after reviewed input, joins immutable outputs and uses one work item', async t => {
  const h = await setup(t, true);
  const steps = [step('requirements'), step('screen', 'screen.specify', ['requirements']), step('model', 'entity.design', ['requirements']),
    step('handoff', 'handoff.create', ['screen', 'model'])];
  const plan = await finish(h, await create(h, { ...request(steps), fixture: { delayMs: 80 } }));
  assert.equal(plan.status, 'completed', plan.message); assert.equal(plan.progress.completed, 4); assert.equal(plan.artifacts.length, 4);
  const runs = await Promise.all(plan.steps.map(value => h.runtime(`/runs/${value.run_id}`)));
  const first = runs[0].steps.at(-1).ended_at;
  assert.ok(Date.parse(runs[1].attempts[0].started_at) >= Date.parse(first));
  assert.ok(Date.parse(runs[2].attempts[0].started_at) >= Date.parse(first));
  const joinPrompt = fs.readFileSync(path.join(runs[3].attempts[0].directory, 'prompt.txt'), 'utf8');
  for (const artifact of plan.artifacts.slice(0, 3)) { assert.ok(joinPrompt.includes(artifact.content_digest)); assert.equal(digest(fs.readFileSync(artifact.file)), artifact.content_digest); }
  assert.ok(joinPrompt.includes('자료 파일 참조') && joinPrompt.includes('읽기 전용'));
  assert.ok(joinPrompt.includes('이 작업에 배정된 원래 요청 범위'));
  const item = await eventually(() => h.manager(`/items/${plan.work_item_id}`), value => value.runs?.length === 4);
  assert.equal(item.runs.length, 4);
});

test('all plan contracts are validated before scheduling any child', async t => {
  const h = await setup(t);
  const invalid = [
    request([step('same'), step('same')]),
    request([step('first'), { ...step('second'), output_key: 'first' }]),
    request([step('cycle-a', 'prd.create', ['cycle-b']), step('cycle-b', 'entity.design', ['cycle-a'])]),
    request([step('missing', 'prd.create', ['absent'])]),
    request([step('first'), { ...step('bad'), request_excerpt: 'not in request' }]),
    request([step('first'), { ...step('bad'), input: { requirements: 7 } }]),
    request([step('first'), step('unknown', 'not.registered')]),
    request([step('first'), step('internal', 'session.summarize')]),
    request([step('first'), { ...step('duplicate'), input: step('first').input }]),
    request([step('first'), step('checks', 'checks.run')])
  ];
  for (const value of invalid) await assert.rejects(create(h, value));
  assert.deepEqual(await h.runtime('/runs'), []); assert.deepEqual(await h.runtime('/plans'), []);
});

test('a failed predecessor prevents descendants while independent requested work completes', async t => {
  const h = await setup(t);
  const steps = [step('blocked-source'), step('descendant', 'entity.design', ['blocked-source']), step('independent', 'screen.specify')];
  const accepted = await create(h, { ...request(steps), fixture: { delayMs: 250 } });
  const active = await eventually(() => h.runtime(`/plans/${accepted.id}`), value => value.steps[0].run_id && value.steps[2].run_id);
  await h.runtime(`/runs/${active.steps[0].run_id}/cancel`, { ...body, body: {} });
  const plan = await finish(h, accepted);
  assert.equal(plan.status, 'blocked'); assert.equal(plan.steps[1].status, 'blocked'); assert.equal(plan.steps[1].run_id, null);
  assert.equal(plan.steps[2].status, 'completed'); assert.equal(plan.progress.completed, 1); assert.equal(plan.artifacts.length, 1);
});

const codeStep = (id, file, deps = []) => ({ ...step(id, 'bug.fix', deps),
  input: { requirements: `변경 ${id}`, source_files: [{ path: file, content: 'export const value = 1;\n' }], allowed_paths: [file] } });

test('independent code tasks cannot own the same or conflicting paths', async t => {
  const h = await setup(t);
  for (const files of [['src/main.mjs', 'src/main.mjs'], ['src/Main.mjs', 'src/main.mjs'], ['src/domain', 'src/domain/main.mjs']])
    await assert.rejects(create(h, request([codeStep('first', files[0]), codeStep('second', files[1])])), /경로/);
  assert.deepEqual(await h.runtime('/runs'), []);
});

test('ordered code edits reject path spelling aliases before any worker starts', async t => {
  const h = await setup(t);
  for (const files of [['src/Main.mjs', 'src/main.mjs'], ['src/café.mjs', 'src/cafe\u0301.mjs']]) {
    await assert.rejects(create(h, request([
      codeStep('first', files[0]), codeStep('second', files[1], ['first'])
    ])), /대소문자|정규화/);
  }
  assert.deepEqual(await h.runtime('/plans'), []);
  assert.deepEqual(await h.runtime('/runs'), []);
});

test('ordered edits consume the preceding reviewed source instead of the stale original', async t => {
  const h = await setup(t);
  const plan = await finish(h, await create(h, request([codeStep('first', 'src/main.mjs'), codeStep('second', 'src/main.mjs', ['first'])])));
  assert.equal(plan.status, 'completed', plan.message);
  const prior = JSON.parse(fs.readFileSync(plan.artifacts[0].file)).files[0];
  const child = await h.runtime(`/runs/${plan.steps[1].run_id}`);
  assert.equal(child.request.input.source_files[0].content, prior.content);
  const second = JSON.parse(fs.readFileSync(plan.artifacts[1].file)).files[0];
  assert.ok(second.content.startsWith(prior.content)); assert.notEqual(second.content, prior.content);
});

test('model preferences and boundary definitions are frozen for waiting work at plan acceptance', async t => {
  const h = await setup(t);
  const snapshot = await h.runtime('/execution-settings'), old = snapshot.tasks.find(value => value.id === 'entity.design');
  const accepted = await create(h, { ...request([step('source'), step('next', 'entity.design', ['source'])]), fixture: { delayMs: 250 } });
  await h.runtime('/execution-settings/entity.design', { method: 'PUT', body: { revision: snapshot.revision, backend: 'claude', instruction: '새 설정에서만 사용할 지시문',
    backends: { codex: { model: 'gpt-5.5', effort: 'low' }, claude: { model: null, effort: null } } } });
  const done = await finish(h, accepted); assert.equal(done.status, 'completed', done.message);
  const run = await h.runtime(`/runs/${done.steps[1].run_id}`), prompt = fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8');
  assert.ok(prompt.includes(old.instruction)); assert.ok(!prompt.includes('새 설정에서만'));
  assert.ok(prompt.includes('고정된 업무 경계')); assert.ok(prompt.includes('JOB-BOUNDARY-001'));
});

test('tampered predecessor artifacts block waiting work before a worker starts', async t => {
  const h = await setup(t);
  const accepted = await create(h, { ...request([step('source'), step('gate', 'screen.specify', ['source']),
    step('downstream', 'entity.design', ['gate'])]), fixture: { delayMs: 300 } });
  const active = await eventually(() => h.runtime(`/plans/${accepted.id}`), value => value.steps[0].status === 'completed' && value.steps[1].status === 'running');
  fs.appendFileSync(active.artifacts[0].file, '\nchanged');
  const done = await finish(h, accepted); assert.equal(done.status, 'blocked', done.message);
  assert.equal(done.steps[2].run_id, null); assert.match(done.steps[2].message, /검증 후 변경/);
  await assert.rejects(h.runtime(`/plans/${accepted.id}/resume`, { ...body, body: {} }), /산출물이 변경/);
});

test('idempotent plan retries return the existing plan and reject changed inputs', async t => {
  const h = await setup(t), input = { ...request([step('once')]), idempotency_key: 'same-turn' };
  const done = await finish(h, await create(h, input));
  assert.equal((await create(h, input)).id, done.id); assert.equal((await h.runtime('/runs')).length, 1);
  await assert.rejects(create(h, { ...input, prompt: `${input.prompt} changed` }), /같은 계획 요청 키/);
  assert.equal((await h.runtime('/runs')).length, 1);
});

test('the same job instructions can consume distinct requested predecessor artifacts without duplicate rejection', async t => {
  const h = await setup(t);
  const left = step('left-model', 'entity.design', ['left-prd']), right = step('right-model', 'entity.design', ['right-prd']);
  left.input = right.input = { requirements: '선행 PRD의 엔티티와 관계만 설계한다.' };
  const plan = await finish(h, await create(h, request([step('left-prd'), step('right-prd'), left, right])));
  assert.equal(plan.status, 'completed', plan.message); assert.equal(plan.artifacts.length, 4);
  for (const [childId, parentId] of [['left-model', 'left-prd'], ['right-model', 'right-prd']]) {
    const child = plan.steps.find(item => item.id === childId), parent = plan.steps.find(item => item.id === parentId);
    const run = await h.runtime(`/runs/${child.run_id}`), prompt = fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8');
    assert.ok(prompt.includes(`"step_id":"${parentId}"`)); assert.ok(prompt.includes(parent.artifact.content_digest));
  }
});

test('synthetic plan cancellation is recorded as an interruption and native-origin plans never invent hook output', async t => {
  const h = await setup(t), first = await create(h, { ...request([step('cancel-me')]), fixture: { delayMs: 1000 } });
  await h.runtime(`/plans/${first.id}/cancel`, { ...body, body: {} });
  const events = (await h.runtime('/events')).events;
  assert.ok(events.some(event => event.kind === 'turn.interrupted' && event.work_item_id === first.work_item_id));
  assert.ok(!events.some(event => event.kind === 'turn.failed' && event.role === 'user' && event.work_item_id === first.work_item_id));
  const native = await finish(h, await create(h, { ...request([step('native')]),
    origin: { engine: 'codex', agent_session_id: 'native-agent-session', turn_id: 'user-turn' } }));
  assert.equal(native.status, 'completed');
  const nativeEvents = (await h.runtime('/events')).events.filter(event => event.agent_session_id === 'native-agent-session');
  assert.ok(nativeEvents.length > 0); assert.ok(nativeEvents.every(event => event.kind === 'run.updated'));
});

test('restart holds already registered queued roots until the whole interrupted plan resumes', async t => {
  const h = await setup(t);
  const accepted = await create(h, { ...request(Array.from({ length: 5 }, (_, i) => step(`parallel-${i}`))), fixture: { delayMs: 500 } });
  const started = await eventually(() => h.runtime(`/plans/${accepted.id}`), value => value.progress.running === 3 && value.steps.every(item => item.run_id));
  const queued = started.steps.filter(item => item.status === 'pending'); assert.equal(queued.length, 2);
  await h.stop('runtime'); await h.start('runtime');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await h.runtime(`/plans/${accepted.id}`)).status, 'interrupted');
  for (const item of queued) {
    const run = await h.runtime(`/runs/${item.run_id}`);
    assert.equal(run.status, 'pending'); assert.equal(run.attempts.length, 0);
  }
  const interrupted = started.steps.find(item => item.status === 'running');
  // Existing GUI run controls must resume the parent plan, not orphan a child outside its DAG.
  await h.runtime(`/runs/${interrupted.run_id}/resume`, { ...body, body: {} });
  const done = await finish(h, accepted); assert.equal(done.status, 'completed', done.message);
  assert.equal(done.progress.completed, 5);
});
