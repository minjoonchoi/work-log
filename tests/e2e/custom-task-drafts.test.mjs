import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

const route = '/execution-settings/custom-task-drafts';
const request = '매주 팀원에게 공유할 운영 회고 문서를 작성하는 작업을 추가한다. 입력은 장애 기록과 조치 내역이며, 배경·원인·대응·남은 일을 정리한다. 근거 없는 수치는 만들지 않는다.';
const defaults = () => ({ codex: { model: null, effort: null }, claude: { model: null, effort: null } });
const create = (h, idempotency_key = 'draft-request-001', text = request) => h.manager(route, { method: 'POST', body: { request: text, idempotency_key } });
const finish = (h, draft) => eventually(() => h.manager(`${route}/${draft.id}`), value => !['pending', 'running'].includes(value.status));
async function setup(t, env = {}) {
  const h = new Harness(); h.env = env; t.after(() => h.close());
  await h.start('runtime'); await h.start('manager'); return h;
}
const register = (h, snapshot, draft) => h.manager('/execution-settings/custom-tasks', { method: 'POST', body: {
  ...draft, revision: snapshot.revision, backend: 'codex', backends: defaults()
} });

test('guided draft uses one headless task and only explicit registration changes the persistent registry', async t => {
  const h = await setup(t), before = await h.manager('/execution-settings');
  const generator = before.tasks.find(value => value.id === 'task.type.draft');
  assert.ok(generator.internal); assert.equal(generator.backend, 'codex'); assert.equal(generator.profile, 'metadata');
  assert.deepEqual(generator.backends.codex.defaults.produce, { model: 'gpt-5.6-luna', effort: 'high' });
  const started = await create(h), result = await finish(h, started);
  assert.equal(result.status, 'completed', result.message);
  assert.ok(before.templates.includes(result.draft.template_id));
  for (const heading of ['목적', '입력', '범위', '수행 절차', '완료 기준']) assert.ok(result.draft.instruction.includes(`## ${heading}\n`));
  assert.deepEqual(await h.manager('/execution-settings'), before);
  assert.equal(fs.existsSync(path.join(h.dir, 'execution-settings.json')), false);
  assert.deepEqual(await h.manager('/items'), [], 'setup generation does not create a work item');
  assert.deepEqual((await h.runtime('/events')).events, []);
  const run = await h.runtime(`/runs/${started.id}`);
  assert.equal(run.task, 'task.type.draft'); assert.equal(run.internal, true);
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
  assert.equal(run.artifact.validation_scope, 'format');
  assert.ok(run.request.input.templates.every(value => before.templates.includes(value.id)));
  assert.ok(!run.request.input.templates.some(value => value.id === 'task.type.draft'));
  const next = await register(h, before, result.draft), added = next.tasks.find(value => value.id === next.created_task_id);
  assert.equal(added.source, 'user'); assert.equal(added.instruction, result.draft.instruction);
  assert.equal(added.label, result.draft.label); assert.deepEqual(added.routing_terms, result.draft.routing_terms);
  assert.equal(added.template_id, result.draft.template_id); assert.equal(added.backend, 'codex');
  const bytes = fs.readFileSync(path.join(h.dir, 'execution-settings.json'));
  await h.stop('runtime'); await h.start('runtime');
  const restored = (await h.manager('/execution-settings')).tasks.find(value => value.id === added.id);
  assert.deepEqual(restored, added); assert.deepEqual(fs.readFileSync(path.join(h.dir, 'execution-settings.json')), bytes);
  assert.deepEqual(await h.manager(`${route}/${started.id}`), result);
  const executed = await h.finish(await h.run({ task: added.id, prompt: '확인된 장애 기록으로 팀 공유 회고를 작성한다.', input: {
    source_text: '알림 지연을 로그로 확인했고 재시도 설정을 수정했다. 재발 여부는 관찰 중이다.',
    audience: '해당 장애 맥락을 모르는 팀원', purpose: '문제의 배경과 확인된 조치 및 남은 확인 사항을 공유한다.'
  } }));
  assert.equal(executed.status, 'completed', executed.message);
  assert.deepEqual(executed.attempts.map(attempt => attempt.stage), ['produce'], 'the registered shared-document template retains single-pass writing');
  assert.equal(executed.review.required, false);
  assert.ok(fs.readFileSync(path.join(executed.attempts[0].directory, 'prompt.txt'), 'utf8').includes(result.draft.instruction.trim()));
  assert.ok(fs.existsSync(executed.artifact.file));
  assert.deepEqual(fs.readFileSync(path.join(h.dir, 'execution-settings.json')), bytes);
});

test('retries reuse the accepted snapshot after catalog changes and edited requests require a new key', async t => {
  const h = await setup(t), initial = await h.manager('/execution-settings');
  const first = await finish(h, await create(h));
  await register(h, initial, first.draft);
  const repeated = await create(h); assert.equal(repeated.id, first.id); assert.deepEqual(repeated.draft, first.draft);
  assert.equal((await h.runtime('/runs')).length, 1);
  await assert.rejects(create(h, 'draft-request-001', `${request} 바뀐 범위`), error => error.status === 409);
  const second = await finish(h, await create(h, 'draft-request-002'));
  assert.equal(second.status, 'completed', second.message); assert.notEqual(second.draft.label, first.draft.label);
  const run = await h.runtime(`/runs/${second.id}`);
  assert.ok(run.request.input.existing_tasks.some(value => value.label === first.draft.label));
  assert.equal((await h.manager('/execution-settings')).tasks.filter(value => value.source === 'user').length, 1);
});

for (const scenario of ['draft-unknown-template', 'draft-extra-field', 'draft-empty-section', 'blocked', 'crash']) {
  test(`draft ${scenario} is visible and cannot register or overwrite settings`, async t => {
    const h = await setup(t, { HARNESS_TEST_TASK_DRAFT_SCENARIO: scenario }), initial = await h.manager('/execution-settings');
    const result = await finish(h, await create(h));
    assert.equal(result.status, scenario === 'blocked' ? 'blocked' : 'failed', result.message);
    assert.equal(result.draft, null); assert.ok(result.message);
    const run = await h.runtime(`/runs/${result.id}`); assert.equal(run.attempts.length, 1);
    assert.equal(run.artifact, null); assert.deepEqual(await h.manager('/execution-settings'), initial);
    assert.deepEqual(await h.manager('/items'), []);
  });
}

test('cancelled and interrupted draft generation remains unregistered after service restart', async t => {
  const h = await setup(t, { HARNESS_TEST_TASK_DRAFT_SCENARIO: 'slow', HARNESS_TEST_TASK_DRAFT_DELAY_MS: '5000' });
  const first = await create(h);
  await eventually(() => h.runtime(`/runs/${first.id}`), value => value.attempts[0]?.pid);
  const cancelled = await h.manager(`${route}/${first.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.draft, null);
  const second = await create(h, 'draft-request-002');
  await eventually(() => h.runtime(`/runs/${second.id}`), value => value.attempts[0]?.pid);
  await h.stop('runtime'); await h.start('runtime');
  const interrupted = await h.manager(`${route}/${second.id}`);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.draft, null);
  assert.equal(fs.existsSync(path.join(h.dir, 'execution-settings.json')), false);
  assert.deepEqual(await h.manager('/items'), []);
});

test('invalid intake cannot choose worker permissions or templates, and draft routes cannot access unrelated runs', async t => {
  const h = await setup(t);
  for (const body of [null, [], {}, { request: ' ', idempotency_key: 'draft-request-001' },
    { request: 'x'.repeat(12001), idempotency_key: 'draft-request-001' }, { request, idempotency_key: '../other' },
    { request, idempotency_key: 'draft-request-001', engine: 'claude' }, { request, idempotency_key: 'draft-request-001', templates: [] }])
    await assert.rejects(h.manager(route, { method: 'POST', body }), error => error.status === 400);
  assert.deepEqual(await h.runtime('/runs'), []);
  const unrelated = await h.finish(await h.run());
  await assert.rejects(h.manager(`${route}/${unrelated.id}`), error => error.status === 404);
  await assert.rejects(h.manager(`${route}/${unrelated.id}/cancel`, { method: 'POST', body: {} }), error => error.status === 404);
  assert.equal((await h.runtime(`/runs/${unrelated.id}`)).status, 'completed');
});

test('output changed after validation is never returned as a draft', async t => {
  const h = await setup(t), result = await finish(h, await create(h));
  assert.equal(result.status, 'completed', result.message);
  const run = await h.runtime(`/runs/${result.id}`);
  fs.appendFileSync(run.artifact.file, '\nchanged');
  const changed = await h.manager(`${route}/${result.id}`);
  assert.equal(changed.status, 'failed'); assert.equal(changed.draft, null); assert.match(changed.message, /변경/);
  assert.equal(fs.existsSync(path.join(h.dir, 'execution-settings.json')), false);
});

test('generator backend preferences reach the standard CLI adapter without extra review calls', async t => {
  const h = new Harness(); t.after(() => h.close()); h.testMode = false;
  const cli = path.join(ROOT, 'tests/fixtures/cli-double.mjs'); fs.chmodSync(cli, 0o755);
  h.env = { HARNESS_CODEX_BIN: cli, HARNESS_CLAUDE_BIN: cli };
  await h.start('runtime'); await h.start('manager');
  const initial = await h.manager('/execution-settings'), generator = initial.tasks.find(value => value.id === 'task.type.draft');
  await h.manager('/execution-settings/task.type.draft', { method: 'PUT', body: {
    revision: initial.revision, instruction: generator.instruction, backend: 'claude',
    backends: { ...defaults(), claude: { model: 'haiku', effort: null } }
  } });
  const result = await finish(h, await create(h)); assert.equal(result.status, 'completed', result.message);
  const run = await h.runtime(`/runs/${result.id}`); assert.equal(run.engine, 'claude'); assert.equal(run.attempts.length, 1);
  const attempt = run.attempts[0], argv = JSON.parse(fs.readFileSync(path.join(attempt.directory, 'invocation.json')));
  assert.equal(argv[argv.indexOf('--model') + 1], 'haiku'); assert.ok(!argv.includes('--effort'));
  const prompt = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
  assert.ok(prompt.includes(generator.instruction.trim())); assert.ok(prompt.includes('실제 유형 등록'));
  assert.equal((await h.manager('/execution-settings')).tasks.filter(value => value.source === 'user').length, 0);
  assert.deepEqual(await h.manager('/items'), []);
});
