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

test('Markdown defaults describe every model task and are frozen into real worker requests before local edits', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const initial = await h.runtime('/execution-settings');
  for (const task of initial.tasks) {
    for (const section of ['목적', '입력', '범위', '수행 절차', '완료 기준']) assert.ok(task.instruction.includes(`\n## ${section}\n`), `${task.id}: ${section}`);
    assert.ok(task.instruction.includes(task.boundary.owns));
    assert.ok(task.instruction.includes(task.boundary.deliverable));
    assert.ok(task.instruction.length <= 12000, `${task.id}: editable default fits the input limit`);
  }
  const prd = initial.tasks.find(task => task.id === 'prd.create');
  assert.ok(!prd.instruction.includes('담당 범위:'), 'generated persona boundary suffix is not duplicated in the readable instruction');
  const first = await h.run({ fixture: { delayMs: 100 } });
  const markdown = '# 사용자 PRD 지시문\n\n## 목적\n**승인 상태**를 명확히 한다.\n\n## 수행 절차\n1. `REQ-001`을 대조한다.\n2. 거절 상태를 확인한다.';
  await h.runtime('/execution-settings/prd.create', { method: 'PUT', body: {
    revision: initial.revision, instruction: markdown, backend: 'codex',
    backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } }
  } });
  const done = await h.finish(first); assert.equal(done.status, 'completed', done.message);
  for (const attempt of done.attempts) {
    const prompt = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
    assert.ok(prompt.includes(prd.instruction)); assert.ok(!prompt.includes(markdown));
  }
  const next = await h.finish(await h.run()); assert.equal(next.status, 'completed', next.message);
  for (const attempt of next.attempts) assert.ok(fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8').includes(markdown));
  await h.stop('runtime'); await h.start('runtime');
  assert.equal((await h.runtime('/execution-settings')).tasks.find(task => task.id === 'prd.create').instruction, markdown);
});

test('preexisting plain-text instruction overrides remain byte-for-byte unchanged until an explicit reset', async t => {
  const h = new Harness(); t.after(() => h.close());
  const file = path.join(h.dir, 'execution-settings.json'), instruction = '기존 사용자 작성 지시문입니다.\n  들여쓰기와 줄바꿈도 보존합니다.\n';
  const custom = { instruction, backend: 'codex', backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } } };
  fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 2, tasks: { 'entity.design': custom, 'text.rewrite': custom, 'session.summarize': custom } }));
  const bytes = fs.readFileSync(file);
  await h.start('runtime');
  const settings = await h.runtime('/execution-settings');
  for (const task of ['text.rewrite', 'session.summarize']) assert.equal(settings.tasks.find(t => t.id === task).instruction, instruction);
  assert.equal(settings.tasks.find(task => task.id === 'entity.design').instruction, instruction);
  const run = await h.finish(await h.run({ task: 'entity.design' })); assert.equal(run.status, 'completed', run.message);
  assert.ok(fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8').includes(instruction));
  assert.deepEqual(fs.readFileSync(file), bytes);
  const reset = await h.runtime('/execution-settings/entity.design', { method: 'DELETE', body: { revision: settings.revision } });
  assert.match(reset.tasks.find(task => task.id === 'entity.design').instruction, /^# 엔티티 설계\n/);
});
