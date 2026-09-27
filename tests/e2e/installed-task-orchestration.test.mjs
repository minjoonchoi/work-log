import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Harness, event, eventually } from '../helpers.mjs';
import { ROOT, serve } from '../../src/shared.mjs';

const nativeSession = 'installed-task-catalog-session';
async function setup(t, installed = []) {
  const h = new Harness(); t.after(() => h.close());
  fs.writeFileSync(path.join(h.dir, 'harness-packages.json'), JSON.stringify({ version: 1, revision: 0, installed }));
  await h.start('runtime'); await h.start('manager');
  await h.ingest([event(nativeSession, 'input', '09:00:00', 'catalog-turn', { source: 'system_hook' })]);
  return h;
}
async function cli(h, ...args) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), ...args], {
    cwd: h.dir, env: { ...process.env, HARNESS_DATA_DIR: h.dir, HARNESS_WORKER: '', CODEX_THREAD_ID: nativeSession },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
function success(result) { assert.equal(result.code, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); }
function rejected(result, message) {
  assert.equal(result.code, 1, result.stderr || result.stdout); assert.equal(result.stdout, '');
  if (message) assert.match(result.stderr, message);
}
async function change(h, id, installed) {
  const current = await h.manager('/harness-packages');
  return h.manager(`/harness-packages/${id}`, { method: 'PUT', body: { installed, revision: current.revision } });
}
const step = (id, task, depends_on = []) => ({ id, task, depends_on, output_key: id, request_excerpt: id,
  input: { requirements: `${id}에 요청한 산출물만 작성하세요.` } });
function planFile(h, name, fixture = {}) {
  const file = path.join(h.dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ prompt: 'requirements handoff', engine: 'fixture', fixture,
    idempotency_key: name, steps: [step('requirements', 'prd.create'), step('handoff', 'document.create', ['requirements'])] }));
  return file;
}
async function custom(h) {
  const snapshot = await h.runtime('/execution-settings');
  const created = await h.runtime('/execution-settings/custom-tasks', { method: 'POST', body: {
    revision: snapshot.revision, template_id: 'document.create', label: '일반 PRD 문서 작업', description: '입력된 내용을 일반 문서로 작성합니다.',
    routing_terms: ['PRD'], instruction: '# 일반 PRD 문서\n\n제공된 내용을 설명하는 문서를 작성하세요.', backend: 'codex',
    backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } }
  } });
  return created.created_task_id;
}

test('GUI package changes immediately scope CLI discovery within the same native session, with common tasks installed independently', async t => {
  const h = await setup(t), all = await h.runtime('/catalog');
  assert.equal(all.jobs.length, 5); assert.ok(all.jobs.every(job => job.management_group === 'worklog'));
  let scoped = await h.runtime('/catalog?scope=harness');
  assert.equal(scoped.scope, 'harness'); assert.equal(scoped.package_revision, 0);
  assert.deepEqual(scoped.jobs, []); assert.deepEqual(scoped.installed_packages, []); assert.deepEqual(scoped.check_profiles, []);
  for (const args of [['catalog'], ['catalog', '--summary']]) {
    const value = success(await cli(h, ...args));
    assert.equal(value.scope, 'harness'); assert.equal(value.package_revision, 0); assert.deepEqual(value.jobs, []);
    assert.deepEqual(value.installed_packages, []);
  }
  await change(h, 'po', true);
  const packages = await h.manager('/harness-packages'), po = packages.packages.find(row => row.id === 'po');
  scoped = success(await cli(h, 'catalog'));
  assert.equal(scoped.package_revision, packages.revision);
  assert.deepEqual(scoped.installed_packages, [{ id: po.id, label: po.label }]);
  assert.deepEqual(scoped.jobs.map(job => job.id).sort(), [...po.task_ids].sort());
  assert.ok(scoped.jobs.every(job => job.installed && !job.internal && job.management_group === 'harness'));
  assert.deepEqual(scoped.check_profiles, []); assert.ok(!scoped.jobs.some(job => job.id === 'document.create'));
  assert.equal((await h.runtime('/catalog')).jobs.length, po.task_count + 5, 'the unscoped API keeps WorkLog compatibility');
  const summary = success(await cli(h, 'catalog', '--summary'));
  assert.deepEqual(summary.jobs.map(job => job.id), scoped.jobs.map(job => job.id));
  assert.equal(summary.package_revision, scoped.package_revision); assert.deepEqual(summary.installed_packages, scoped.installed_packages);
  assert.ok(summary.jobs.every(job => !Object.hasOwn(job, 'input_schema')));
  assert.deepEqual(success(await cli(h, 'catalog', '--task', 'prd.create')), scoped.jobs.find(job => job.id === 'prd.create'));
  for (const task of all.jobs.map(job => job.id)) rejected(await cli(h, 'catalog', '--task', task), /지원하지 않는 업무/);
  rejected(await cli(h, 'catalog', '--task', 'document.create'), /지원하지 않는 업무/);

  await change(h, 'common', true);
  const combined = success(await cli(h, 'catalog'));
  assert.deepEqual(combined.installed_packages.map(row => row.id), ['po', 'common']);
  assert.ok(combined.jobs.some(job => job.id === 'checks.run')); assert.ok(combined.check_profiles.length > 0);
  assert.ok(combined.jobs.some(job => job.id === 'document.create'));
  await change(h, 'po', false);
  const commonOnly = success(await cli(h, 'catalog', '--summary'));
  assert.deepEqual(commonOnly.installed_packages.map(row => row.id), ['common']);
  assert.ok(!commonOnly.jobs.some(job => job.id === 'prd.create'));
  rejected(await cli(h, 'run', 'PRD를 작성해줘', '--engine', 'fixture'), /PO.*po/);
  assert.deepEqual(await h.runtime('/runs'), [], 'removing PO never downgrades PRD into an installed generic text task');
  await change(h, 'po', true);
  assert.ok(success(await cli(h, 'catalog', '--summary')).jobs.some(job => job.id === 'prd.create'));
  for (const query of ['scope=unknown', 'scope=harness&scope=all', 'scope=harness&unexpected=true'])
    await assert.rejects(h.runtime(`/catalog?${query}`), error => error.status === 400);
});

test('the CLI refuses a legacy or incorrectly scoped service rather than exposing internal or uninstalled jobs', async t => {
  const h = new Harness(); const calls = [];
  let response = { version: 'legacy', jobs: [{ id: 'text.rewrite', internal: true }] };
  const { server } = await serve({ dir: h.dir, role: 'runtime', handler: async (req, url) => {
    calls.push(url.pathname + url.search); return response;
  } });
  t.after(async () => { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await h.close(); });
  for (const value of [response,
    { scope: 'harness', jobs: [{ id: 'text.rewrite', internal: true, management_group: 'worklog', installed: true }] },
    { scope: 'harness', jobs: [{ id: 'prd.create', internal: false, management_group: 'harness', installed: false }] }
  ]) {
    response = value;
    for (const args of [['catalog'], ['catalog', '--summary'], ['catalog', '--task', response.jobs[0].id]])
      rejected(await cli(h, ...args), /최신 버전.*업데이트/);
  }
  assert.deepEqual(new Set(calls), new Set(['/catalog?scope=harness']));
});

test('a custom task follows its template package and an inactive custom keyword cannot obscure an installed natural request', async t => {
  const h = await setup(t, ['po', 'common']), task = await custom(h);
  const saved = fs.readFileSync(path.join(h.dir, 'execution-settings.json'));
  assert.ok(success(await cli(h, 'catalog')).jobs.some(job => job.id === task));
  rejected(await cli(h, 'run', 'PRD를 작성해줘', '--engine', 'fixture'), /한 종류의 산출물/);
  assert.deepEqual(await h.runtime('/runs'), []);
  await change(h, 'common', false);
  assert.ok(!success(await cli(h, 'catalog', '--summary')).jobs.some(job => job.id === task));
  rejected(await cli(h, 'catalog', '--task', task), /지원하지 않는 업무/);
  rejected(await cli(h, 'run', '--task', task, '--engine', 'fixture', '맞춤 문서를 작성하세요.'), /common/);
  assert.deepEqual(await h.runtime('/runs'), []);
  const run = success(await cli(h, 'run', 'PRD를 작성해줘', '--engine', 'fixture', '--wait'));
  assert.equal(run.task, 'prd.create'); assert.equal(run.status, 'completed');
  assert.equal(run.origin.agent_session_id, nativeSession);
  const inactive = (await h.runtime('/execution-settings')).tasks.find(row => row.id === task);
  assert.equal(inactive.installed, false); assert.equal(inactive.source, 'user'); assert.deepEqual(inactive.package_ids, ['common']);
  assert.deepEqual(fs.readFileSync(path.join(h.dir, 'execution-settings.json')), saved);
  await change(h, 'common', true);
  assert.equal(success(await cli(h, 'catalog', '--task', task)).id, task);
  const restored = success(await cli(h, 'run', '--task', task, '--engine', 'fixture', '맞춤 문서를 작성하세요.', '--wait'));
  assert.equal(restored.task, task); assert.equal(restored.status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(h.dir, 'execution-settings.json')), saved);
});

test('removing a package after discovery atomically rejects a mixed plan before any child starts, and reinstall restores acceptance', async t => {
  const h = await setup(t, ['po', 'common']);
  const before = success(await cli(h, 'catalog', '--summary'));
  assert.ok(['prd.create', 'document.create'].every(id => before.jobs.some(job => job.id === id)));
  const file = planFile(h, 'catalog-before-removal');
  await change(h, 'common', false);
  rejected(await cli(h, 'orchestrate', '--input', file, '--wait'), /common/);
  assert.deepEqual(await h.runtime('/runs'), []); assert.deepEqual(await h.runtime('/plans'), []);
  assert.deepEqual((await h.runtime('/events')).events, []);
  await change(h, 'common', true);
  const restored = success(await cli(h, 'orchestrate', '--input', file, '--wait'));
  assert.equal(restored.status, 'completed'); assert.equal(restored.progress.completed, 2);
  assert.equal((await h.runtime('/runs')).length, 2); assert.equal((await h.runtime('/plans')).length, 1);
});

test('removing an installed package after plan acceptance leaves frozen downstream work and idempotent retries executable', async t => {
  const h = await setup(t, ['po', 'common']), file = planFile(h, 'accepted-before-removal', { delayMs: 800 });
  const accepted = success(await cli(h, 'orchestrate', '--input', file));
  const active = await eventually(() => h.runtime(`/plans/${accepted.id}`), value => value.steps[0].run_id && !value.steps[1].run_id);
  assert.ok(['pending', 'running'].includes(active.status));
  await change(h, 'common', false);
  assert.ok(!success(await cli(h, 'catalog')).jobs.some(job => job.id === 'document.create'));
  const retried = success(await cli(h, 'orchestrate', '--input', file)); assert.equal(retried.id, accepted.id);
  const done = success(await cli(h, 'status', accepted.id, '--wait'));
  assert.equal(done.status, 'completed', done.message); assert.equal(done.progress.completed, 2);
  assert.ok(done.steps.every(row => row.run_id && row.status === 'completed'));
  const followup = await h.runtime(`/runs/${done.steps[1].run_id}`);
  assert.equal(followup.task, 'document.create'); assert.equal(followup.status, 'completed');
  assert.equal((await h.runtime('/runs')).length, 2); assert.equal((await h.runtime('/plans')).length, 1);
});
