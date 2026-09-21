import fs from 'node:fs';
import path from 'node:path';
import { atomic, assert } from './shared.mjs';
import { defaultTaskInstruction } from './task-instruction.mjs';

const efforts = { codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], claude: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] };
const engines = ['codex', 'claude'];
const modelPattern = /^[A-Za-z0-9._:/-]{1,120}$/;
const fresh = () => ({ version: 1, revision: 0, tasks: {} });
const exact = (value, keys, label) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} 형식이 잘못되었습니다.`);
  assert(Object.keys(value).every(key => keys.includes(key)), `${label}에 등록되지 않은 필드가 있습니다.`);
};

export function executionSettings({ dir, jobs, workflows, profiles }) {
  const file = path.join(dir, 'execution-settings.json');
  function read() {
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fresh();
    exact(data, ['version', 'revision', 'tasks'], '작업 실행 설정');
    assert(data.version === 1 && Number.isSafeInteger(data.revision) && data.revision >= 0, '작업 실행 설정 버전이 잘못되었습니다.');
    exact(data.tasks, Object.keys(jobs), '업무별 실행 설정');
    for (const [task, value] of Object.entries(data.tasks)) validate(task, value, false);
    return data;
  }
  function validate(task, input, withRevision = true) {
    assert(jobs[task] && workflows[jobs[task].workflow].mode === 'artifact', '모델 기반 업무만 설정할 수 있습니다.');
    exact(input, ['instruction', 'backend', 'backends', ...(withRevision ? ['revision'] : [])], '업무 실행 설정');
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
  function resolve(task) {
    const job = jobs[task], source = profiles[job.execution_profile], override = read().tasks[task];
    const profile = structuredClone(source);
    if (override) for (const stage of Object.values(profile.stages)) for (const engine of engines) {
      if (override.backends[engine].model) stage[engine].model = override.backends[engine].model;
      if (override.backends[engine].effort) stage[engine].effort = override.backends[engine].effort;
    }
    return { instruction: override?.instruction || defaultTaskInstruction(job), backend: override?.backend || 'codex', profile };
  }
  function snapshot() {
    const data = read();
    return { revision: data.revision, efforts, tasks: Object.entries(jobs).filter(([, job]) => workflows[job.workflow].mode === 'artifact').map(([id, job]) => {
      const override = data.tasks[id], profile = profiles[job.execution_profile];
      const stages = new Set(Object.values(workflows[job.workflow].nodes).map(node => node.task));
      return { id, label: job.label, category: job.category, boundary: structuredClone(job.boundary),
        profile: job.execution_profile, instruction: override?.instruction || defaultTaskInstruction(job),
        backend: override?.backend || 'codex', overridden: !!override,
        backends: Object.fromEntries(engines.map(engine => [engine, {
          model: override?.backends[engine].model || null, effort: override?.backends[engine].effort || null,
          defaults: Object.fromEntries(Object.entries(profile.stages).filter(([stage]) => stages.has(stage)).map(([stage, choices]) => [stage, choices[engine]]))
        }])) };
    }) };
  }
  function save(task, input) {
    validate(task, input);
    const data = read(); assert(input.revision === data.revision, '설정이 다른 창에서 변경되었습니다. 다시 열어 주세요.', 409);
    data.tasks[task] = { instruction: input.instruction.trim(), backend: input.backend,
      backends: Object.fromEntries(engines.map(engine => [engine, { model: input.backends[engine].model, effort: input.backends[engine].effort }])) };
    data.revision += 1; atomic(file, JSON.stringify(data, null, 2)); return snapshot();
  }
  function reset(task, revision) {
    assert(jobs[task] && workflows[jobs[task].workflow].mode === 'artifact', '모델 기반 업무만 설정할 수 있습니다.');
    const data = read(); assert(revision === data.revision, '설정이 다른 창에서 변경되었습니다. 다시 열어 주세요.', 409);
    delete data.tasks[task]; data.revision += 1; atomic(file, JSON.stringify(data, null, 2)); return snapshot();
  }
  read();
  return { snapshot, resolve, save, reset, file };
}
