import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, assert } from './shared.mjs';
import { defaultTaskInstruction } from './task-instruction.mjs';
import { modelCapabilities, effectiveSelection, assertModelSelection } from './model-capabilities.mjs';

const efforts = { codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], claude: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] };
const engines = ['codex', 'claude'];
const modelPattern = /^[A-Za-z0-9._:/-]{1,120}$/;
const customKinds = ['document', 'html', 'code_bundle', 'data_model', 'scenario_plan'];
const customIdPattern = /^user\.[a-f0-9]{12,64}$/;
const maxCustomTasks = 100;
const executionFields = ['instruction', 'backend', 'backends'];
const metadataFields = ['label', 'description', 'routing_terms'];
const labelKey = value => value.normalize('NFC').trim().toLowerCase();
const fresh = () => ({ version: 2, revision: 0, tasks: {}, custom_tasks: {} });
const exact = (value, keys, label) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} 형식이 잘못되었습니다.`);
  assert(Object.keys(value).every(key => keys.includes(key)), `${label}에 등록되지 않은 필드가 있습니다.`);
};

export function executionSettings({ dir, jobs, workflows, profiles }) {
  const file = path.join(dir, 'execution-settings.json');
  // Keep the shared catalog object intact: runtime intake and plans retain it.
  // Only reviewed built-ins can supply executable contracts to custom tasks.
  const builtins = Object.fromEntries(Object.entries(jobs));
  const templates = Object.keys(builtins).filter(task => {
    const job = builtins[task];
    return !job.internal && !job.allow_internal && job.category !== 'system'
      && workflows[job.workflow]?.mode === 'artifact' && customKinds.includes(job.kind);
  });
  let publishedCustomIds = [];
  function metadata(input) {
    for (const [field, limit] of [['label', 120], ['description', 2000]]) {
      assert(typeof input[field] === 'string' && input[field].trim() && input[field].length <= limit, `${field}은 1~${limit}자여야 합니다.`);
    }
    const terms = input.routing_terms;
    assert(Array.isArray(terms) && terms.length >= 1 && terms.length <= 20
      && terms.every(term => typeof term === 'string' && term.trim() && term.length <= 80)
      && new Set(terms.map(term => term.trim())).size === terms.length, 'routing_terms는 중복 없는 1~80자 문자열 1~20개여야 합니다.');
    return { label: input.label.trim(), description: input.description.trim(), routing_terms: terms.map(term => term.trim()) };
  }
  function customJob(record) {
    assert(typeof record.template_id === 'string' && templates.includes(record.template_id), '등록된 일반 모델 업무만 template_id로 사용할 수 있습니다.');
    const job = structuredClone(builtins[record.template_id]);
    return { ...job, label: record.label, source: 'user', template_id: record.template_id, description: record.description,
      boundary: { ...job.boundary, owns: `${job.boundary.owns}\n사용자 업무 설명: ${record.description}` },
      routing: { ...job.routing, terms: [...record.routing_terms] } };
  }
  function validateData(data) {
    exact(data, ['version', 'revision', 'tasks', 'custom_tasks'], '작업 실행 설정');
    assert([1, 2].includes(data.version) && Number.isSafeInteger(data.revision) && data.revision >= 0, '작업 실행 설정 버전이 잘못되었습니다.');
    if (data.version === 1) exact(data, ['version', 'revision', 'tasks'], '작업 실행 설정');
    const custom = data.version === 1 ? {} : data.custom_tasks;
    exact(custom, Object.keys(custom || {}), '사용자 업무 정의');
    assert(Object.keys(custom).length <= maxCustomTasks, `사용자 업무는 ${maxCustomTasks}개까지 등록할 수 있습니다.`);
    const customJobs = {};
    const labels = new Set(Object.values(builtins).map(job => labelKey(job.label)));
    for (const [task, record] of Object.entries(custom)) {
      assert(customIdPattern.test(task) && !Object.hasOwn(builtins, task), '사용자 업무 ID가 잘못되었습니다.');
      exact(record, ['template_id', ...metadataFields], '사용자 업무 정의');
      metadata(record);
      const label = labelKey(record.label);
      assert(!labels.has(label), '같은 이름의 업무가 이미 있습니다. 다른 업무명을 입력하세요.');
      labels.add(label);
      customJobs[task] = customJob(record);
    }
    const catalog = { ...builtins, ...customJobs };
    exact(data.tasks, Object.keys(catalog), '업무별 실행 설정');
    for (const [task, value] of Object.entries(data.tasks)) validate(task, value, catalog, false);
    return { data: { version: 2, revision: data.revision, tasks: data.tasks, custom_tasks: custom }, customJobs };
  }
  function publish(customJobs) {
    for (const task of publishedCustomIds) delete jobs[task];
    Object.assign(jobs, customJobs);
    publishedCustomIds = Object.keys(customJobs);
  }
  function read() {
    const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fresh();
    const { data, customJobs } = validateData(stored);
    // Validate the entire document before publishing any custom definitions.
    // Reading a v1 document never rewrites its bytes or its instruction text.
    publish(customJobs);
    return data;
  }
  function artifactJob(task, catalog = jobs) {
    assert(typeof task === 'string' && Object.hasOwn(catalog, task) && workflows[catalog[task].workflow]?.mode === 'artifact', '모델 기반 업무만 설정할 수 있습니다.');
    return catalog[task];
  }
  function validate(task, input, catalog = jobs, withRevision = true) {
    artifactJob(task, catalog);
    exact(input, [...executionFields, ...(withRevision ? ['revision', ...(Object.hasOwn(builtins, task) ? [] : metadataFields)] : [])], '업무 실행 설정');
    assert(typeof input.instruction === 'string' && input.instruction.trim() && input.instruction.length <= 12000, '작업 지시문은 1~12000자여야 합니다.');
    assert(engines.includes(input.backend), 'backend는 codex 또는 claude여야 합니다.');
    exact(input.backends, engines, 'backend 설정');
    assert(engines.every(engine => Object.hasOwn(input.backends, engine)), '두 backend 설정이 모두 필요합니다.');
    for (const engine of engines) {
      const selection = input.backends[engine]; exact(selection, ['model', 'effort'], `${engine} 설정`);
      assert(selection.model === null || (typeof selection.model === 'string' && modelPattern.test(selection.model)), `${engine} model 형식이 잘못되었습니다.`);
      assert(selection.effort === null || efforts[engine].includes(selection.effort), `${engine} effort가 잘못되었습니다.`);
    }
    if (withRevision) assert(Number.isSafeInteger(input.revision) && input.revision >= 0, '설정 revision이 필요합니다.');
  }
  function revisionMatches(data, revision) {
    assert(Number.isSafeInteger(revision) && revision >= 0, '설정 revision이 필요합니다.');
    assert(revision === data.revision, '설정이 다른 창에서 변경되었습니다. 다시 열어 주세요.', 409);
  }
  function executionOverride(input) {
    return { instruction: input.instruction.trim(), backend: input.backend,
      backends: Object.fromEntries(engines.map(engine => [engine, { model: input.backends[engine].model, effort: input.backends[engine].effort }])) };
  }
  function validateSelections(task, input, previous, job = jobs[task]) {
    const stages = new Set(Object.values(workflows[job.workflow].nodes).map(node => node.task));
    const profile = profiles[job.execution_profile];
    for (const engine of engines) {
      const selection = input.backends[engine], prior = previous?.backends[engine];
      const unchanged = prior && selection.model === prior.model && selection.effort === prior.effort;
      // A legacy setting can survive unrelated edits, but cannot be newly selected.
      if (unchanged && !(input.backend === engine && previous.backend !== input.backend)) continue;
      for (const [stage, choices] of Object.entries(profile.stages)) if (stages.has(stage)) {
        assertModelSelection(engine, effectiveSelection(engine, choices[engine], selection));
      }
    }
  }
  function commit(data) {
    assert(data.revision < Number.MAX_SAFE_INTEGER, '설정 revision 한도에 도달했습니다.');
    data.revision += 1;
    const validated = validateData(data);
    // Failed persistence leaves the previously published catalog untouched.
    atomic(file, JSON.stringify(validated.data, null, 2));
    publish(validated.customJobs);
    return renderSnapshot(validated.data);
  }
  function resolve(task) {
    const data = read(), job = artifactJob(task), source = profiles[job.execution_profile], override = data.tasks[task];
    const profile = structuredClone(source);
    for (const stage of Object.values(profile.stages)) for (const engine of engines)
      stage[engine] = effectiveSelection(engine, stage[engine], override?.backends[engine]);
    return { instruction: override?.instruction || defaultTaskInstruction(job), backend: override?.backend || 'codex', profile };
  }
  function renderSnapshot(data) {
    return { revision: data.revision, models: modelCapabilities(), templates: [...templates], tasks: Object.entries(jobs).filter(([, job]) => workflows[job.workflow].mode === 'artifact').map(([id, job]) => {
      const override = data.tasks[id], profile = profiles[job.execution_profile];
      const stages = new Set(Object.values(workflows[job.workflow].nodes).map(node => node.task));
      return { id, label: job.label, category: job.category, kind: job.kind, boundary: structuredClone(job.boundary),
        source: Object.hasOwn(builtins, id) ? 'builtin' : 'user', internal: !!(job.internal || job.allow_internal),
        template_id: job.template_id || null, description: job.description || job.boundary.owns, routing_terms: [...job.routing.terms],
        profile: job.execution_profile, instruction: override?.instruction || defaultTaskInstruction(job),
        backend: override?.backend || 'codex', overridden: !!override,
        backends: Object.fromEntries(engines.map(engine => [engine, {
          model: override?.backends[engine].model || null, effort: override?.backends[engine].effort || null,
          defaults: Object.fromEntries(Object.entries(profile.stages).filter(([stage]) => stages.has(stage)).map(([stage, choices]) => [stage, structuredClone(choices[engine])]))
        }])) };
    }) };
  }
  function snapshot() { return renderSnapshot(read()); }
  function draftInput(request) {
    read();
    return { request,
      templates: templates.map(id => {
        const job = builtins[id];
        return { id, label: job.label, kind: job.kind, boundary: structuredClone(job.boundary) };
      }),
      existing_tasks: Object.entries(jobs).map(([id, job]) => ({ id, label: job.label, description: job.description || job.boundary.owns })) };
  }
  function save(task, input) {
    const data = read();
    validate(task, input);
    revisionMatches(data, input.revision);
    validateSelections(task, input, data.tasks[task]);
    if (Object.hasOwn(data.custom_tasks, task)) {
      const record = data.custom_tasks[task];
      const changes = Object.fromEntries(metadataFields.filter(field => Object.hasOwn(input, field)).map(field => [field, input[field]]));
      data.custom_tasks[task] = { template_id: record.template_id, ...metadata({ ...record, ...changes }) };
    }
    data.tasks[task] = executionOverride(input);
    return commit(data);
  }
  function reset(task, revision) {
    const data = read(); artifactJob(task); revisionMatches(data, revision);
    delete data.tasks[task]; return commit(data);
  }
  function create(input) {
    exact(input, ['revision', 'template_id', ...metadataFields, ...executionFields], '사용자 업무 생성');
    const data = read(); revisionMatches(data, input.revision);
    assert(Object.keys(data.custom_tasks).length < maxCustomTasks, `사용자 업무는 ${maxCustomTasks}개까지 등록할 수 있습니다.`);
    const record = { template_id: input.template_id, ...metadata(input) }, job = customJob(record);
    let task;
    do { task = `user.${crypto.randomBytes(12).toString('hex')}`; } while (Object.hasOwn(jobs, task));
    const override = Object.fromEntries(executionFields.map(field => [field, input[field]]));
    validate(task, override, { [task]: job }, false);
    validateSelections(task, input, null, job);
    data.custom_tasks[task] = record;
    data.tasks[task] = executionOverride(input);
    return { ...commit(data), created_task_id: task };
  }
  function remove(task, revision) {
    const data = read(); revisionMatches(data, revision);
    assert(typeof task === 'string' && Object.hasOwn(data.custom_tasks, task), '사용자 업무만 삭제할 수 있습니다.');
    delete data.custom_tasks[task]; delete data.tasks[task];
    return commit(data);
  }
  read();
  return { snapshot, draftInput, resolve, save, reset, create, remove, file };
}
