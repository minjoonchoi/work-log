import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

const inherited = () => ({ codex: { model: null, effort: null }, claude: { model: null, effort: null } });
const task = snapshot => snapshot.tasks.find(value => value.id === 'prd.create');
const setting = (snapshot, changes = {}) => ({ revision: snapshot.revision, instruction: task(snapshot).instruction,
  backend: task(snapshot).backend, backends: Object.fromEntries(['codex', 'claude'].map(engine => [engine, {
    model: task(snapshot).backends[engine].model, effort: task(snapshot).backends[engine].effort
  }])), ...changes });
const save = (h, body) => h.runtime('/execution-settings/prd.create', { method: 'PUT', body });
const plan = () => ({ prompt: '설계', steps: [{ id: 'design', task: 'prd.create', output_key: 'prd', request_excerpt: '설계',
  input: { requirements: '초대 승인 정책을 설계한다.' }, depends_on: [] }] });
async function setup(t, cliDouble = false) {
  const h = new Harness(); t.after(() => h.close());
  if (cliDouble) {
    const cli = path.join(ROOT, 'tests/fixtures/cli-double.mjs'); fs.chmodSync(cli, 0o755);
    h.env = { HARNESS_CODEX_BIN: cli, HARNESS_CLAUDE_BIN: cli };
  }
  await h.start('runtime'); return h;
}

test('every task and custom task inherit Luna high while the API exposes backend-specific model capabilities', async t => {
  const h = await setup(t), initial = await h.runtime('/execution-settings');
  for (const entry of initial.tasks) {
    assert.equal(entry.backend, 'codex', entry.id);
    for (const value of Object.values(entry.backends.codex.defaults)) assert.deepEqual(value, { model: 'gpt-5.6-luna', effort: 'high' }, entry.id);
  }
  const supported = (engine, id) => initial.models[engine].find(value => value.id === id).efforts;
  assert.deepEqual(supported('codex', 'gpt-5.6-luna'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(supported('codex', 'gpt-5.6-terra').includes('ultra'));
  assert.ok(!supported('codex', 'gpt-5.5').includes('max'));
  assert.ok(!supported('claude', 'claude-opus-4-6').includes('xhigh'));
  assert.deepEqual(supported('claude', 'haiku'), []);
  const created = await h.runtime('/execution-settings/custom-tasks', { method: 'POST', body: {
    ...setting(initial), template_id: 'prd.create', label: '모델 기본값 검증', description: '고객 요구를 정리한다.', routing_terms: ['고객 모델 검증'], backends: inherited()
  } });
  const custom = created.tasks.find(value => value.id === created.created_task_id);
  assert.equal(custom.backend, 'codex');
  for (const value of Object.values(custom.backends.codex.defaults)) assert.deepEqual(value, { model: 'gpt-5.6-luna', effort: 'high' });
});

test('model and effort changes reach CLI argv, no-effort models omit the flag, and backend preferences survive restart', async t => {
  const h = await setup(t, true);
  let snapshot = await h.runtime('/execution-settings');
  const configs = [
    { backend: 'codex', backends: inherited(), expected: { model: 'gpt-5.6-luna', effort: 'high' } },
    { backend: 'claude', backends: { codex: { model: 'gpt-5.5', effort: 'xhigh' }, claude: { model: 'claude-opus-4-6', effort: 'max' } }, expected: { model: 'claude-opus-4-6', effort: 'max' } },
    { backend: 'claude', backends: { codex: { model: 'gpt-5.5', effort: 'xhigh' }, claude: { model: 'haiku', effort: null } }, expected: { model: 'haiku', effort: null } },
    { backend: 'codex', backends: { codex: { model: 'gpt-5.5', effort: 'xhigh' }, claude: { model: 'haiku', effort: null } }, expected: { model: 'gpt-5.5', effort: 'xhigh' } }
  ];
  for (const config of configs) {
    snapshot = await save(h, setting(snapshot, { backend: config.backend, backends: config.backends }));
    const run = await h.finish(await h.runtime('/runs', { method: 'POST', body: { task: 'prd.create', input: { requirements: '초대 승인 상태와 복구 경로' } } }));
    assert.equal(run.status, 'completed', run.message); assert.equal(run.engine, config.backend);
    assert.ok(run.attempts.length >= 2, 'produce and independent review both use the selection');
    for (const attempt of run.attempts) {
      const argv = JSON.parse(fs.readFileSync(path.join(attempt.directory, 'invocation.json')));
      const observed = JSON.parse(fs.readFileSync(path.join(attempt.directory, 'process.json')));
      assert.equal(argv[argv.indexOf('--model') + 1], config.expected.model);
      assert.deepEqual({ model: observed.model, effort: observed.effort }, config.expected);
      if (config.backend === 'codex') assert.ok(argv.includes(`model_reasoning_effort="${config.expected.effort}"`));
      else if (config.expected.effort === null) assert.ok(!argv.includes('--effort'));
      else assert.equal(argv[argv.indexOf('--effort') + 1], config.expected.effort);
    }
  }
  await h.stop('runtime'); await h.start('runtime');
  const restored = task(await h.runtime('/execution-settings'));
  assert.equal(restored.backend, 'codex'); assert.equal(restored.backends.codex.model, 'gpt-5.5');
  assert.equal(restored.backends.claude.model, 'haiku'); assert.equal(restored.backends.claude.effort, null);
});

test('unsupported model/effort pairs are rejected before persistence including custom creation and inherited models', async t => {
  const h = await setup(t), snapshot = await h.runtime('/execution-settings');
  const valid = await save(h, setting(snapshot));
  const file = path.join(h.dir, 'execution-settings.json'), bytes = fs.readFileSync(file);
  for (const [backend, model, effort] of [
    ['codex', 'gpt-5.6-luna', 'ultra'], ['codex', null, 'ultra'], ['codex', 'gpt-5.5', 'max'],
    ['codex', 'sonnet', 'high'], ['codex', 'unlisted-model', 'high'],
    ['claude', 'claude-opus-4-6', 'xhigh'], ['claude', 'haiku', 'low'], ['claude', 'gpt-5.6-luna', 'high']
  ]) {
    const backends = inherited(); backends[backend] = { model, effort };
    await assert.rejects(save(h, setting(valid, { backend, backends })), error => error.status === 400 && /지원/.test(error.message));
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  await assert.rejects(h.runtime('/execution-settings/custom-tasks', { method: 'POST', body: {
    ...setting(valid), template_id: 'prd.create', label: '지원하지 않는 모델', description: '모델 설정 검증', routing_terms: ['잘못된 모델'],
    backends: { ...inherited(), codex: { model: 'gpt-5.6-luna', effort: 'ultra' } }
  } }), /지원하지/);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal((await h.runtime('/execution-settings')).revision, valid.revision);
  assert.deepEqual(await h.runtime('/runs'), []);
});

for (const codex of [{ model: 'legacy-private-model', effort: 'high' }, { model: 'gpt-5.6-luna', effort: 'ultra' }]) {
  test(`legacy ${codex.model}/${codex.effort} stays intact but cannot start a run or plan until corrected`, async t => {
    const h = new Harness(); t.after(() => h.close());
    const cli = path.join(ROOT, 'tests/fixtures/cli-double.mjs'); fs.chmodSync(cli, 0o755);
    h.env = { HARNESS_CODEX_BIN: cli, HARNESS_CLAUDE_BIN: cli };
    const original = { version: 1, revision: 7, tasks: { 'prd.create': {
      instruction: '# 기존 지시문\n\n공백과 설정을 보존합니다.\n', backend: 'codex', backends: { ...inherited(), codex }
    } } };
    const file = path.join(h.dir, 'execution-settings.json'); fs.writeFileSync(file, JSON.stringify(original));
    const bytes = fs.readFileSync(file); await h.start('runtime');
    let snapshot = await h.runtime('/execution-settings');
    assert.equal(task(snapshot).backends.codex.model, codex.model); assert.deepEqual(fs.readFileSync(file), bytes);
    await assert.rejects(h.run(), /지원/);
    await assert.rejects(h.runtime('/plans', { method: 'POST', body: plan() }), /지원/);
    assert.deepEqual(await h.runtime('/runs'), []); assert.deepEqual(await h.runtime('/plans'), []);
    assert.deepEqual(fs.readFileSync(file), bytes);
    snapshot = await save(h, setting(snapshot, { instruction: '# 사용자 편집\n\n기존 선택은 보존한다.' }));
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).tasks['prd.create'].backends.codex, codex);
    // Explicitly using a valid backend does not accidentally validate the inactive legacy backend.
    const run = await h.finish(await h.run({ engine: 'claude' })); assert.equal(run.status, 'completed', run.message);
    snapshot = await save(h, setting(snapshot, { backend: 'claude' }));
    await assert.rejects(save(h, setting(snapshot, { backend: 'codex' })), /지원/);
    const reset = await h.runtime('/execution-settings/prd.create', { method: 'DELETE', body: { revision: snapshot.revision } });
    assert.equal(task(reset).backend, 'codex'); assert.equal(task(reset).backends.codex.model, null);
    const repaired = await h.finish(await h.run()); assert.equal(repaired.status, 'completed', repaired.message);
  });
}
