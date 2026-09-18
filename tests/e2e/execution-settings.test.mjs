import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

test('local task settings select backend, model, effort and instruction for new runs and survive restart', async t => {
  const cli = path.join(ROOT, 'tests/fixtures/cli-double.mjs'); fs.chmodSync(cli, 0o755);
  const h = new Harness(); h.env = { HARNESS_CODEX_BIN: cli, HARNESS_CLAUDE_BIN: cli }; await h.start('runtime');
  t.after(() => h.close());
  const initial = await h.runtime('/execution-settings');
  const prd = initial.tasks.find(task => task.id === 'prd.create');
  assert.equal(prd.backend, 'codex'); assert.equal(prd.profile, 'document'); assert.equal(prd.backends.codex.model, null);
  const configured = await h.runtime('/execution-settings/prd.create', { method: 'PUT', body: {
    revision: initial.revision, instruction: '승인 상태와 실패 복구를 빠짐없이 작성하는 제품 책임자.', backend: 'claude',
    backends: { codex: { model: 'gpt-5.5', effort: 'low' }, claude: { model: 'opus', effort: 'xhigh' } }
  } });
  assert.equal(configured.revision, initial.revision + 1);
  await assert.rejects(h.runtime('/execution-settings/prd.create', { method: 'PUT', body: {
    revision: initial.revision, instruction: '오래된 설정', backend: 'codex',
    backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } }
  } }), /다른 창에서 변경/);
  const run = await h.finish(await h.runtime('/runs', { method: 'POST', body: { task: 'prd.create', input: { requirements: '초대 승인 정책' } } }));
  assert.equal(run.status, 'completed', run.message); assert.equal(run.engine, 'claude');
  const first = run.attempts[0], invocation = JSON.parse(fs.readFileSync(path.join(first.directory, 'invocation.json')));
  assert.equal(invocation[invocation.indexOf('--model') + 1], 'opus');
  assert.equal(invocation[invocation.indexOf('--effort') + 1], 'xhigh');
  assert.match(fs.readFileSync(path.join(first.directory, 'prompt.txt'), 'utf8'), /승인 상태와 실패 복구/);
  const process = JSON.parse(fs.readFileSync(path.join(first.directory, 'process.json')));
  assert.deepEqual({ model: process.model, effort: process.effort }, { model: 'opus', effort: 'xhigh' });
  await h.stop('runtime'); await h.start('runtime');
  const restored = await h.runtime('/execution-settings');
  assert.equal(restored.tasks.find(task => task.id === 'prd.create').backend, 'claude');
  const reset = await h.runtime('/execution-settings/prd.create', { method: 'DELETE', body: { revision: restored.revision } });
  const defaultPrd = reset.tasks.find(task => task.id === 'prd.create');
  assert.equal(defaultPrd.backend, 'codex'); assert.equal(defaultPrd.instruction, prd.instruction); assert.equal(defaultPrd.overridden, false);
});

test('execution settings reject unknown tasks, fields and invalid backend selections', async t => {
  const h = new Harness(); await h.start('runtime'); t.after(() => h.close());
  const { revision } = await h.runtime('/execution-settings');
  const valid = { revision, instruction: '유효한 지시문', backend: 'codex',
    backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } } };
  await assert.rejects(h.runtime('/execution-settings/checks.run', { method: 'PUT', body: valid }), /모델 기반 업무/);
  await assert.rejects(h.runtime('/execution-settings/prd.create', { method: 'PUT', body: { ...valid, backend: 'other' } }), /backend/);
  await assert.rejects(h.runtime('/execution-settings/prd.create', { method: 'PUT', body: { ...valid, command: 'rm -rf' } }), /등록되지 않은 필드/);
});
