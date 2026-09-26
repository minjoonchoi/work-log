import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';

const packageFile = h => path.join(h.dir, 'harness-packages.json');
async function setup(t, installed) {
  const h = new Harness();
  if (installed) fs.writeFileSync(packageFile(h), JSON.stringify({ version: 1, revision: 0, installed }));
  t.after(() => h.close()); await h.start('runtime'); return h;
}
async function change(h, id, installed) {
  const { revision } = await h.runtime('/harness-packages');
  return h.runtime(`/harness-packages/${id}`, { method: 'PUT', body: { revision, installed } });
}
const publicStep = (id, task = 'document.create', depends_on = []) => ({ id, task, output_key: id,
  request_excerpt: id, input: { requirements: '제공된 업무 기록으로 문서를 작성한다.' }, depends_on });
const summaryInput = { title: '작업 기록', events: [{ kind: 'output', event_at: '2026-09-26T02:00:00Z', text: '문서를 작성했습니다.' }] };
const customInput = revision => ({ revision, template_id: 'document.create', label: '팀 운영 기록', description: '팀 운영 결정을 기록한다.',
  routing_terms: ['팀 운영 기록'], instruction: '# 팀 운영 기록\n\n제공된 자료만 요약한다.', backend: 'codex',
  backends: { codex: { model: 'gpt-5.6-luna', effort: 'high' }, claude: { model: null, effort: null } } });

test('legacy catalog remains available without a new settings write and every public task has one role package', async t => {
  const h = await setup(t), snapshot = await h.runtime('/harness-packages'), catalog = await h.runtime('/catalog');
  assert.equal(snapshot.legacy_default, true); assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.worklog_task_ids.length, 5); assert.equal(snapshot.installed_task_count, 65);
  assert.deepEqual(snapshot.packages.map(row => [row.id, row.task_count]), [['pm', 15], ['po', 13], ['frontend', 7], ['backend', 7], ['common', 23]]);
  const publicIds = snapshot.packages.flatMap(row => row.task_ids);
  assert.equal(new Set(publicIds).size, 65); assert.equal(catalog.jobs.length, 70);
  for (const job of catalog.jobs) {
    assert.equal(job.installed, true);
    assert.equal(job.package_ids.length, job.management_group === 'worklog' ? 0 : 1);
  }
  assert.equal(fs.existsSync(packageFile(h)), false);
});

test('empty packages retain WorkLog utility execution but reject public runs, plans and custom drafts without side effects', async t => {
  const h = await setup(t, []), catalog = await h.runtime('/catalog'), settings = await h.runtime('/execution-settings');
  assert.equal(catalog.jobs.length, 5); assert.ok(catalog.jobs.every(job => job.management_group === 'worklog'));
  assert.deepEqual(settings.templates, []); assert.equal(settings.tasks.filter(task => task.installed).length, 5);
  await assert.rejects(h.run(), /PO.*po/);
  await assert.rejects(h.run({ internal: true }), /PO.*po/);
  await assert.rejects(h.runtime('/plans', { method: 'POST', body: { prompt: 'plan write', engine: 'fixture',
    steps: [publicStep('plan', 'prd.create'), publicStep('write', 'document.create', ['plan'])] } }), /PO.*po/);
  await assert.rejects(h.runtime('/execution-settings/custom-task-drafts', { method: 'POST', body: { request: '팀 운영 기록 작성', idempotency_key: 'package-draft-empty' } }), /먼저 설치/);
  await assert.rejects(h.runtime('/execution-settings/custom-tasks', { method: 'POST', body: customInput(settings.revision) }), /공통 업무.*common/);
  assert.equal((await h.runtime('/runs')).length, 0); assert.equal((await h.runtime('/plans')).length, 0);
  const run = await h.finish(await h.run({ task: 'session.summarize', internal: true, prompt: undefined, input: summaryInput }));
  assert.equal(run.status, 'completed', run.message); assert.equal(run.attempts.length, 1);
});

test('install selection is revision-checked, isolated by package, and preserved across service restarts', async t => {
  const h = await setup(t, []), installed = await change(h, 'po', true);
  assert.equal(installed.revision, 1); assert.equal(installed.installed_task_count, 13);
  assert.equal((await h.runtime('/catalog')).jobs.length, 18);
  const settings = await h.runtime('/execution-settings');
  assert.ok(settings.templates.includes('prd.create')); assert.ok(!settings.templates.includes('document.create'));
  assert.equal(settings.tasks.find(task => task.id === 'text.rewrite').management_group, 'worklog');
  assert.equal(settings.tasks.find(task => task.id === 'document.create').installed, false);
  await assert.rejects(h.runtime('/harness-packages/po', { method: 'PUT', body: { revision: 0, installed: false } }), error => error.status === 409);
  await assert.rejects(h.runtime('/harness-packages/po', { method: 'PUT', body: { revision: 1, installed: 'false' } }), error => error.status === 400);
  await assert.rejects(h.runtime('/harness-packages/unknown', { method: 'PUT', body: { revision: 1, installed: true } }), error => error.status === 404);
  const before = fs.readFileSync(packageFile(h)); await h.stop('runtime'); await h.start('runtime');
  assert.deepEqual(await h.runtime('/harness-packages'), installed); assert.deepEqual(fs.readFileSync(packageFile(h)), before);
});

test('package removal affects new acceptance while running work, pending frozen plan children and accepted idempotency continue', async t => {
  const h = await setup(t, ['common']);
  const input = { task: 'document.create', input: { requirements: '문서 작성' }, fixture: { delayMs: 350 }, idempotency_key: 'package-running' };
  const accepted = await h.run(input);
  const plan = await h.runtime('/plans', { method: 'POST', body: { prompt: 'first second', engine: 'fixture',
    fixture: { delayMs: 350 }, steps: [publicStep('first'), publicStep('second', 'document.update', ['first'])] } });
  await change(h, 'common', false);
  await assert.rejects(h.run({ task: 'document.create' }), /common/);
  assert.equal((await h.run(input)).id, accepted.id);
  assert.equal((await h.finish(accepted)).status, 'completed');
  const done = await eventually(() => h.runtime(`/plans/${plan.id}`), value => !['running', 'pending'].includes(value.status), 20000);
  assert.equal(done.status, 'completed', done.message); assert.equal(done.progress.completed, 2);
  assert.ok(done.steps.every(step => step.run_id));
});

test('custom definitions and local instructions survive template package removal and resume availability after reinstall', async t => {
  const h = await setup(t, ['common']), initial = await h.runtime('/execution-settings');
  const created = await h.runtime('/execution-settings/custom-tasks', { method: 'POST', body: customInput(initial.revision) });
  const task = created.created_task_id, file = path.join(h.dir, 'execution-settings.json'), bytes = fs.readFileSync(file);
  await change(h, 'common', false);
  assert.ok(!(await h.runtime('/catalog')).jobs.some(job => job.id === task));
  const hidden = (await h.runtime('/execution-settings')).tasks.find(job => job.id === task);
  assert.equal(hidden.installed, false); assert.equal(hidden.source, 'user'); assert.deepEqual(hidden.package_ids, ['common']);
  assert.equal(hidden.instruction, customInput(0).instruction);
  await assert.rejects(h.run({ task }), /common/); assert.deepEqual(fs.readFileSync(file), bytes);
  await h.stop('runtime'); await h.start('runtime'); await change(h, 'common', true);
  assert.ok((await h.runtime('/catalog')).jobs.some(job => job.id === task));
  assert.equal((await h.finish(await h.run({ task }))).status, 'completed');
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('invalid harness selection is visible as an error but does not block WorkLog internal summaries', async t => {
  const h = await setup(t, []); fs.writeFileSync(packageFile(h), '{broken');
  await assert.rejects(h.runtime('/harness-packages'));
  await assert.rejects(h.run({ task: 'document.create' }));
  const run = await h.finish(await h.run({ task: 'session.summarize', internal: true, prompt: undefined, input: summaryInput }));
  assert.equal(run.status, 'completed', run.message); assert.equal(run.attempts.length, 1);
});
