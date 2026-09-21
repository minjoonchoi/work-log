import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Harness, eventually } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

const settingsFile = h => path.join(h.dir, 'execution-settings.json');
const preferences = {
  instruction: '# 운영 공유 문서\n\n## 목적\n운영 배경과 결정, 후속 작업을 근거에 따라 정리한다.', backend: 'codex',
  backends: { codex: { model: 'test-model', effort: 'low' }, claude: { model: null, effort: null } }
};
const definition = revision => ({ revision, template_id: 'document.create', label: '운영 인수인계',
  description: '운영 인수인계의 배경, 결정, 미완료 항목만 공유 문서로 작성한다.', routing_terms: ['운영 인수인계'], ...preferences });
async function setup(t) {
  const h = await new Harness().start('runtime'); t.after(() => h.close()); await h.start('manager'); return h;
}
async function register(h) {
  return h.manager('/execution-settings/custom-tasks', { method: 'POST', body: definition((await h.runtime('/execution-settings')).revision) });
}

test('GUI API registration immediately joins the live CLI catalog and executes the inherited artifact and review contract', async t => {
  const h = await setup(t), before = await h.runtime('/catalog'), created = await register(h), id = created.created_task_id;
  assert.match(id, /^user\.[a-f0-9]+$/);
  const catalog = await h.runtime('/catalog'), custom = catalog.jobs.find(job => job.id === id), builtin = before.jobs.find(job => job.id === 'document.create');
  assert.equal(custom.source, 'user'); assert.equal(custom.template_id, builtin.id);
  for (const field of ['kind', 'input_schema', 'workflow', 'execution_profile', 'review_policy']) assert.deepEqual(custom[field], builtin[field]);
  assert.deepEqual(custom.boundary.excludes, builtin.boundary.excludes);
  assert.match(custom.boundary.owns, /운영 인수인계/);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), 'catalog', '--summary'], {
    env: { ...process.env, HARNESS_DATA_DIR: h.dir }, encoding: 'utf8'
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).jobs.find(job => job.id === id).description, custom.description);
  await assert.rejects(h.run({ task: id, input: { requirements: 7 } }));
  await assert.rejects(h.run({ task: id, review: { required: false, reason: '빠르게 작성' } }), /검토/);
  const run = await h.finish(await h.run({ task: id, input: { requirements: '승인된 운영 결정과 미정 사항을 문서로 작성한다.' } }));
  assert.equal(run.status, 'completed', run.message); assert.equal(run.task, id);
  assert.ok(fs.existsSync(run.artifact.file));
  assert.ok(run.attempts.some(attempt => attempt.task === 'review' || attempt.stage === 'review'));
  for (const attempt of run.attempts) assert.ok(fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8').includes(preferences.instruction));
  const bytes = fs.readFileSync(settingsFile(h));
  await h.stop('runtime'); await h.start('runtime');
  assert.equal((await h.runtime('/execution-settings')).tasks.find(task => task.id === id).backends.codex.model, 'test-model');
  assert.deepEqual(fs.readFileSync(settingsFile(h)), bytes);
  assert.equal((await h.finish(await h.run({ task: id }))).status, 'completed');
});

test('accepted dependent work keeps its custom definition after edits and deletion, while new submissions reject the removed type', async t => {
  const h = await setup(t), created = await register(h), id = created.created_task_id;
  const accepted = await h.runtime('/plans', { method: 'POST', body: {
    prompt: '요구 정리 후 운영 인수인계', engine: 'fixture', fixture: { delayMs: 180 }, steps: [
      { id: 'requirements', task: 'prd.create', output_key: 'requirements', request_excerpt: '요구 정리', input: { requirements: '운영 요구를 정리한다.' }, depends_on: [] },
      { id: 'handoff', task: id, output_key: 'handoff', request_excerpt: '운영 인수인계', input: { requirements: '선행 요구로 운영 인수인계 문서를 작성한다.' }, depends_on: ['requirements'] }
    ]
  } });
  const edited = await h.manager(`/execution-settings/${id}`, { method: 'PUT', body: {
    ...preferences, revision: created.revision, label: '새 운영 인수인계', description: '새 범위 설명', routing_terms: ['새 운영 문서'], instruction: '# 이후 작업에만 적용' }
  });
  const reset = await h.manager(`/execution-settings/${id}`, { method: 'DELETE', body: { revision: edited.revision } });
  assert.ok(reset.tasks.some(task => task.id === id && task.source === 'user' && !task.overridden));
  await h.manager(`/execution-settings/custom-tasks/${id}`, { method: 'DELETE', body: { revision: reset.revision } });
  await assert.rejects(h.run({ task: id }), /지원하지 않는 업무/);
  const done = await eventually(() => h.runtime(`/plans/${accepted.id}`), plan => plan.status !== 'running' && plan.status !== 'pending', 20000);
  assert.equal(done.status, 'completed', done.message); assert.equal(done.steps[1].label, '운영 인수인계');
  const run = await h.runtime(`/runs/${done.steps[1].run_id}`);
  for (const attempt of run.attempts) {
    const prompt = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
    assert.ok(prompt.includes(preferences.instruction)); assert.ok(!prompt.includes('이후 작업에만 적용'));
  }
  await h.stop('runtime'); await h.start('runtime');
  assert.equal((await h.runtime(`/plans/${accepted.id}`)).status, 'completed');
  assert.ok(!(await h.runtime('/catalog')).jobs.some(job => job.id === id));
  assert.ok(fs.existsSync(run.artifact.file), 'removing a registration preserves previous artifacts and execution history');
});

test('registration validates template, metadata, contracts and revision without changing saved bytes on rejection', async t => {
  const h = await setup(t), created = await register(h), id = created.created_task_id, bytes = fs.readFileSync(settingsFile(h));
  const valid = { ...definition(created.revision), label: '별도 운영 문서' };
  for (const changes of [
    { template_id: 'session.summarize' }, { template_id: 'checks.run' }, { template_id: id }, { template_id: '__proto__' },
    { workflow: 'unchecked' }, { rules: [] }, { label: '운영 인수인계' }, { label: ' '.repeat(5) },
    { routing_terms: [] }, { routing_terms: ['same', 'same'] }, { backend: 'other' }, { revision: created.revision - 1 }
  ]) {
    await assert.rejects(h.manager('/execution-settings/custom-tasks', { method: 'POST', body: { ...valid, ...changes } }));
    assert.deepEqual(fs.readFileSync(settingsFile(h)), bytes);
  }
  await assert.rejects(h.manager(`/execution-settings/${id}`, { method: 'PUT', body: { ...preferences, revision: created.revision, template_id: 'prd.create' } }));
  await assert.rejects(h.manager('/execution-settings/prd.create', { method: 'PUT', body: { ...preferences, revision: created.revision, label: 'builtin replacement' } }));
  await assert.rejects(h.manager('/execution-settings/custom-tasks/prd.create', { method: 'DELETE', body: { revision: created.revision } }));
  assert.deepEqual(fs.readFileSync(settingsFile(h)), bytes);
});

test('first custom registration migrates v1 only on write and preserves all built-in user overrides', async t => {
  const h = new Harness(); t.after(() => h.close());
  const prior = { ...preferences, instruction: '기존 사용자 지시문\n  공백 보존\n' };
  fs.writeFileSync(settingsFile(h), JSON.stringify({ version: 1, revision: 7, tasks: { 'prd.create': prior } }));
  const bytes = fs.readFileSync(settingsFile(h));
  await h.start('runtime'); await h.start('manager');
  assert.equal((await h.runtime('/execution-settings')).revision, 7); assert.deepEqual(fs.readFileSync(settingsFile(h)), bytes);
  const created = await register(h), saved = JSON.parse(fs.readFileSync(settingsFile(h)));
  assert.equal(saved.version, 2); assert.equal(saved.revision, 8); assert.deepEqual(saved.tasks['prd.create'], prior);
  assert.ok(saved.custom_tasks[created.created_task_id]);
});

test('user HTML, entity and code tasks retain executable artifact validators and scoped source outputs', async t => {
  const h = await setup(t);
  const templates = [
    ['mockup.html.create', { requirements: '클릭할 수 있는 시안만 작성한다.' }],
    ['entity.design', { requirements: '사용자와 초대의 관계만 논리 모델로 작성한다.' }],
    ['frontend.implement', { requirements: '명시한 소스만 수정한다.', source_files: [{ path: 'src/view.mjs', content: 'export const value = 1;\n' }], allowed_paths: ['src/view.mjs'] }]
  ];
  for (const [template, input] of templates) await t.test(template, async () => {
    const created = await h.manager('/execution-settings/custom-tasks', { method: 'POST', body: {
      ...definition((await h.runtime('/execution-settings')).revision), template_id: template, label: `사용자 ${template}`
    } });
    const run = await h.finish(await h.run({ task: created.created_task_id, input }));
    assert.equal(run.status, 'completed', run.message);
    assert.ok(fs.existsSync(run.artifact.file));
    if (template === 'frontend.implement') {
      const artifact = JSON.parse(fs.readFileSync(run.artifact.file));
      assert.deepEqual(artifact.files.map(file => file.path), ['src/view.mjs']);
      await assert.rejects(h.run({ task: created.created_task_id, input: { ...input, allowed_paths: ['../outside.mjs'] } }));
    }
  });
});
