import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assert, atomic } from './shared.mjs';

// Packages select availability, never permissions, instructions or contracts.
// Existing data roots without this setting retain the full legacy catalog.
export function harnessPackages({ dir, jobs }) {
  const file = path.join(dir, 'harness-packages.json');
  const definition = JSON.parse(fs.readFileSync(path.join(ROOT, 'harness/task-packages.json'), 'utf8'));
  assert(definition.version === 1 && Array.isArray(definition.packages), '하네스 직무 묶음 정의가 잘못되었습니다.');
  const packages = definition.packages.map(value => {
    assert(value && /^[a-z][a-z0-9-]*$/.test(value.id) && typeof value.label === 'string' && value.label.trim()
      && typeof value.description === 'string' && Array.isArray(value.categories) && value.categories.length,
    '하네스 직무 묶음의 ID·이름·분류가 필요합니다.');
    return { ...value, task_ids: Object.entries(jobs).filter(([, job]) => !job.allow_internal && value.categories.includes(job.category)).map(([id]) => id) };
  });
  const ids = packages.map(value => value.id);
  assert(new Set(ids).size === ids.length, '하네스 직무 묶음 ID가 중복됩니다.');
  const membership = new Map();
  for (const [id, job] of Object.entries(jobs)) {
    if (job.allow_internal) continue;
    const selected = packages.filter(value => value.task_ids.includes(id)).map(value => value.id);
    assert(selected.length === 1, `공개 작업 ${id}의 직무 묶음 담당이 없거나 중복됩니다.`);
    membership.set(id, selected);
  }
  const worklogTasks = Object.entries(jobs).filter(([, job]) => job.allow_internal).map(([id]) => id);
  function read() {
    if (!fs.existsSync(file)) return { version: 1, revision: 0, installed: [...ids], legacy_default: true };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(data && typeof data === 'object' && !Array.isArray(data)
      && Object.keys(data).length === 3 && ['version', 'revision', 'installed'].every(key => Object.hasOwn(data, key))
      && data.version === 1 && Number.isSafeInteger(data.revision) && data.revision >= 0
      && Array.isArray(data.installed) && new Set(data.installed).size === data.installed.length
      && data.installed.every(id => ids.includes(id)), '저장된 하네스 직무 묶음 설정이 잘못되었습니다.');
    return { ...data, legacy_default: false };
  }
  function access(task, job = jobs[task], data) {
    assert(job, '지원하지 않는 작업 유형입니다.');
    if (job.allow_internal) return { management_group: 'worklog', installed: true, package_ids: [] };
    data ||= read();
    const packageIds = membership.get(job.template_id || task);
    assert(packageIds?.length, '작업 유형의 직무 묶음을 확인할 수 없습니다.');
    return { management_group: 'harness', installed: packageIds.some(id => data.installed.includes(id)), package_ids: [...packageIds] };
  }
  function assertInstalled(task, job) {
    const value = access(task, job);
    const names = packages.filter(item => value.package_ids.includes(item.id)).map(item => `${item.label} (${item.id})`).join(', ');
    assert(value.installed, `설치되지 않은 하네스 작업 유형입니다. WorkLog 설정에서 ${names} 묶음을 먼저 설치하세요.`, 409);
  }
  function snapshot(data = read()) {
    return { revision: data.revision, legacy_default: data.legacy_default,
      packages: packages.map(({ categories, ...value }) => ({ ...value, installed: data.installed.includes(value.id), task_count: value.task_ids.length })),
      worklog_task_ids: [...worklogTasks], installed_task_count: [...membership.values()].filter(values => values.some(id => data.installed.includes(id))).length };
  }
  function set(id, input) {
    assert(ids.includes(id), '하네스 직무 묶음을 찾을 수 없습니다.', 404);
    assert(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 2
      && typeof input.installed === 'boolean' && Number.isSafeInteger(input.revision) && input.revision >= 0,
    '설치 여부와 현재 revision을 지정하세요.');
    const data = read();
    assert(input.revision === data.revision, '직무 묶음 설정이 다른 창에서 변경되었습니다. 다시 열어 주세요.', 409);
    if (data.installed.includes(id) === input.installed) return snapshot(data);
    assert(data.revision < Number.MAX_SAFE_INTEGER, '직무 묶음 설정 revision 한도에 도달했습니다.');
    const installed = ids.filter(value => value === id ? input.installed : data.installed.includes(value));
    atomic(file, JSON.stringify({ version: 1, revision: data.revision + 1, installed }, null, 2));
    return snapshot();
  }
  return { access, assertInstalled, snapshot, set, file };
}
