import { assert } from './shared.mjs';

// Runtime checks for the versioned scenario-plan contract; no model score is a gate.
export function checkScenarios(text, input) {
  const checks = [], add = (check, passed, detail) => checks.push({ rule: 'SCENARIO-001', check, passed, ...(detail ? { detail } : {}) });
  try {
    const document = JSON.parse(text);
    assert(document && Object.keys(document).length === 1 && Array.isArray(document.scenarios), 'scenarios 배열만 반환해야 합니다.');
    assert(document.scenarios.length > 0 && document.scenarios.length <= 80, '시나리오는 1~80개여야 합니다.');
    const ids = new Set(), covered = new Set(), categories = new Set();
    const nonempty = value => typeof value === 'string' && value.trim().length > 0;
    for (const scenario of document.scenarios) {
      const keys = ['id', 'title', 'requirement_ids', 'category', 'preconditions', 'steps'];
      assert(scenario && Object.keys(scenario).length === keys.length && keys.every(k => Object.hasOwn(scenario, k)), '시나리오 필드가 계약과 다릅니다.');
      assert(nonempty(scenario.id) && nonempty(scenario.title) && !ids.has(scenario.id), '시나리오 ID와 제목이 없거나 ID가 중복됩니다.'); ids.add(scenario.id);
      assert(['normal', 'failure', 'boundary', 'recovery'].includes(scenario.category), '알 수 없는 시나리오 분류입니다.'); categories.add(scenario.category);
      assert(Array.isArray(scenario.requirement_ids) && scenario.requirement_ids.length && new Set(scenario.requirement_ids).size === scenario.requirement_ids.length && scenario.requirement_ids.every(id => input.requirements.some(r => r.id === id)), '제공하지 않은 요구사항을 참조하거나 요구사항 참조가 비어 있습니다.');
      scenario.requirement_ids.forEach(id => covered.add(id));
      assert(Array.isArray(scenario.preconditions) && scenario.preconditions.every(nonempty), '사전 조건 형식이 잘못되었습니다.');
      assert(Array.isArray(scenario.steps) && scenario.steps.length && scenario.steps.every(step => step && Object.keys(step).length === 2 && nonempty(step.action) && nonempty(step.expected)), '각 행동에는 관찰할 기대 결과가 필요합니다.');
    }
    add('scenario contract', true);
    const missing = input.requirements.filter(r => !covered.has(r.id)).map(r => r.id);
    add('requirement coverage', missing.length === 0, { missing });
    const missingCategories = input.categories.filter(c => !categories.has(c));
    add('scenario categories', missingCategories.length === 0, { missing: missingCategories });
  } catch (e) { add('scenario contract', false, e.message); }
  return checks;
}
