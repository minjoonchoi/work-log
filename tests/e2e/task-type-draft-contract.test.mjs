import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog, buildPrompt } from '../../src/catalog.mjs';
import { defaultTaskInstruction } from '../../src/task-instruction.mjs';
import { parseTaskTypeDraft, validateTaskTypeDraftInput } from '../../src/task-type-draft.mjs';
import { Harness } from '../helpers.mjs';

function sample() {
  const catalog = loadCatalog(), template = catalog.definitions.jobs['prd.create'];
  const input = { request: '운영 고객의 요청과 수용 기준을 정리하는 전용 PRD 업무를 만들고 싶습니다.',
    templates: [{ id: 'prd.create', label: template.label, kind: template.kind, boundary: structuredClone(template.boundary) }],
    existing_tasks: [{ id: 'existing.review', label: 'Café Review', description: '기존 업무' }] };
  const draft = { template_id: 'prd.create', label: '운영 고객 PRD', description: '운영 고객의 요청과 수용 기준을 정리한다.', routing_terms: ['운영 고객 PRD'],
    instruction: defaultTaskInstruction({ ...template, label: '운영 고객 PRD' }) };
  return { catalog, input, draft };
}

test('draft parser rejects unsupported templates, metadata duplication and incomplete instruction contracts', () => {
  const { input, draft } = sample();
  assert.deepEqual(parseTaskTypeDraft(JSON.stringify(draft), input), draft);
  const cases = [
    ['unknown template', value => { value.template_id = 'other.template'; }, /제공된 템플릿/],
    ['duplicate name', value => { value.label = ' cafe\u0301 review '; }, /같은 이름/],
    ['builtin name', value => { value.label = input.templates[0].label; }, /같은 이름/],
    ['blank metadata', value => { value.description = ' --- '; }, /의미 있는/],
    ['duplicate terms', value => { value.routing_terms = ['운영 고객', ' 운영 고객 ']; }, /중복 없는/],
    ['extra configuration', value => { value.backend = 'claude'; }, /위반/],
    ['missing section', value => { value.instruction = value.instruction.replace('## 수행 절차', '## 기타'); }, /Markdown 구역/],
    ['empty section', value => { value.instruction = value.instruction.replace(/## 수행 절차\n[\s\S]*?(?=## 완료 기준)/, '## 수행 절차\n\n'); }, /의미 있는 본문/],
    ['fenced fake headings', value => { value.instruction = '```markdown\n' + value.instruction + '\n```'; }, /Markdown 구역/],
    ['missing exclusion', value => { value.instruction = value.instruction.replace(`제외: ${input.templates[0].boundary.excludes[0]}`, ''); }, /제외 조건/],
    ['changed deliverable', value => { value.instruction = value.instruction.replaceAll(input.templates[0].boundary.deliverable, 'unapproved.md'); }, /산출물/]
  ];
  for (const [label, mutate, error] of cases) {
    const value = structuredClone(draft); mutate(value);
    assert.throws(() => parseTaskTypeDraft(JSON.stringify(value), input), error, label);
  }
  assert.throws(() => validateTaskTypeDraftInput({ ...input, templates: [...input.templates, ...input.templates] }), /ID가 중복/);
  assert.throws(() => validateTaskTypeDraftInput({ ...input, existing_tasks: [...input.existing_tasks, ...input.existing_tasks] }), /ID가 중복/);
  assert.throws(() => validateTaskTypeDraftInput({ ...input, request: '---' }), /구체적인 업무 설명/);
  assert.throws(() => validateTaskTypeDraftInput({ ...input, backend: 'claude' }), /위반/);
});

test('draft task prompt preserves generation-only boundaries even with a local instruction override', () => {
  const { catalog, input } = sample(), job = structuredClone(catalog.definitions.jobs['task.type.draft']);
  job.instruction = '사용자 작성 생성 지시문';
  const definition = { job, task_types: catalog.taskTypes, rules: Object.fromEntries(job.rules.map(rule => [rule, catalog.rules[rule]])) };
  const prompt = buildPrompt({ stage: 'produce', definition, request: { task: 'task.type.draft', input }, issues: [] });
  assert.ok(prompt.includes(job.instruction));
  assert.match(prompt, /templates 중 단일 결과를 소유하는 템플릿 하나/);
  assert.match(prompt, /실제 유형 등록, 설정 변경, backend\/model\/effort 지정/);
  assert.match(prompt, /## 목적, ## 입력, ## 범위, ## 수행 절차, ## 완료 기준/);
});

test('headless draft generation validates one artifact without model review or task registration', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const { input } = sample(), before = await h.runtime('/catalog'), settings = await h.runtime('/execution-settings');
  const run = await h.finish(await h.run({ task: 'task.type.draft', input, internal: true }));
  assert.equal(run.status, 'completed', run.message); assert.equal(run.internal, true);
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
  assert.deepEqual(run.steps.map(step => step.task), ['produce', 'verify', 'render']);
  assert.equal(run.artifact.validation_scope, 'format'); assert.equal(run.artifact.review_attempt, undefined);
  assert.equal(run.artifact.output_file, undefined);
  const value = parseTaskTypeDraft(fs.readFileSync(run.artifact.file, 'utf8'), input);
  assert.equal(value.template_id, 'prd.create');
  assert.equal((await h.runtime('/catalog')).jobs.length, before.jobs.length);
  assert.deepEqual(await h.runtime('/execution-settings'), settings);
  assert.equal(fs.existsSync(path.join(h.dir, 'execution-settings.json')), false);
  const configured = settings.tasks.find(task => task.id === 'task.type.draft');
  assert.equal(configured.internal, true); assert.equal(settings.templates.includes(configured.id), false);
  assert.deepEqual(configured.backends.codex.defaults.produce, { model: 'gpt-5.6-luna', effort: 'high' });
});

test('invalid draft artifacts fail deterministic checks after one generation; blocked and slow outcomes stay distinct', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const { input } = sample();
  for (const scenario of ['draft-invalid', 'draft-unknown-template', 'draft-duplicate-name', 'draft-duplicate-terms', 'draft-empty-section', 'draft-missing-boundary', 'draft-extra-field']) {
    const run = await h.finish(await h.run({ task: 'task.type.draft', input, internal: true, fixture: { scenario } }));
    assert.equal(run.status, 'failed', `${scenario}: ${run.message}`); assert.equal(run.artifact, null);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
    assert.deepEqual(run.steps.map(step => step.task), ['produce', 'verify']);
  }
  const blocked = await h.finish(await h.run({ task: 'task.type.draft', input, internal: true, fixture: { scenario: 'blocked' } }));
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.artifact, null); assert.equal(blocked.attempts.length, 1);
  const slow = await h.finish(await h.run({ task: 'task.type.draft', input, internal: true, fixture: { scenario: 'slow', delayMs: 100 } }));
  assert.equal(slow.status, 'completed', slow.message); assert.equal(slow.attempts.length, 1);
});
