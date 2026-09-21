import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assert } from './shared.mjs';

// Release-owned capabilities are shared by the picker and execution validator.
// No login, model invocation, global configuration mutation or cache scraping.
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'harness/model-capabilities.json'), 'utf8'));
const validEfforts = { codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], claude: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] };
assert(catalog.version === 1 && catalog.models, '모델 기능 목록 형식이 잘못되었습니다.');
for (const engine of ['codex', 'claude']) {
  const models = catalog.models[engine];
  assert(Array.isArray(models) && models.length > 0 && new Set(models.map(model => model.id)).size === models.length, `${engine} 모델 목록이 잘못되었습니다.`);
  for (const model of models) {
    assert(typeof model.id === 'string' && /^[A-Za-z0-9._:/-]{1,120}$/.test(model.id)
      && typeof model.label === 'string' && model.label.trim()
      && Array.isArray(model.efforts) && new Set(model.efforts).size === model.efforts.length
      && model.efforts.every(effort => validEfforts[engine].includes(effort))
      && (model.efforts.length ? model.efforts.includes(model.default_effort) : model.default_effort === null), `${engine} 모델 기능 정의가 잘못되었습니다: ${model.id}`);
  }
}
export function modelCapabilities() { return structuredClone(catalog.models); }
export function supportedModel(engine, id) { return catalog.models[engine]?.find(model => model.id === id); }

export function selectionProblem(engine, selection) {
  const model = supportedModel(engine, selection?.model);
  if (!model) return `${engine} 모델 '${selection?.model ?? ''}'의 지원 정보를 확인할 수 없습니다. 작업 실행 설정에서 지원 모델을 선택하세요.`;
  if (!model.efforts.length) return selection.effort == null ? null : `${engine} 모델 '${model.id}'는 effort를 지원하지 않습니다. effort를 기본값으로 지우세요.`;
  return model.efforts.includes(selection.effort) ? null : `${engine} 모델 '${model.id}'에서 effort '${selection.effort ?? ''}'는 지원하지 않습니다. 지원 값: ${model.efforts.join(', ')}.`;
}
export function assertModelSelection(engine, selection) {
  const problem = selectionProblem(engine, selection);
  assert(!problem, problem);
}

export function effectiveSelection(engine, base, override) {
  const model = override?.model ?? base.model;
  const capability = supportedModel(engine, model);
  // An explicit saved effort must never be silently clamped to another level.
  // Only an unset override inherits a compatible profile/model default.
  const effort = override?.effort ?? (capability
    ? capability.efforts.includes(base.effort) ? base.effort : capability.default_effort
    : base.effort);
  return { model, effort };
}
