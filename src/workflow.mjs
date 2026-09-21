import { assert } from './shared.mjs';

const terminal = new Set(['$completed', '$blocked', '$failed']);
const kinds = {
  artifact: { produce: 'agent', plan: 'agent', review: 'agent', repair: 'agent', verify: 'validator', render: 'renderer' },
  checks: { verify: 'validator' }, report: { render: 'renderer' }
};
export function validateWorkflow(workflow, taskTypes) {
  assert(workflow && kinds[workflow.mode] && workflow.nodes && workflow.nodes[workflow.initial], 'workflow 시작 노드가 없습니다.');
  const checked = workflow.review_required === false;
  if (checked) assert(workflow.mode === 'artifact' && workflow.max_steps === 3
    && Object.values(workflow.nodes).map(node => node.task).sort().join(',') === 'produce,render,verify',
  '형식 검사 workflow는 한 번의 생성·검증·전달만 허용합니다.');
  assert(Number.isSafeInteger(workflow.max_steps) && workflow.max_steps > 0 && workflow.max_steps <= 100, 'workflow 실행 단계 한도가 필요합니다.');
  for (const [id, node] of Object.entries(workflow.nodes)) {
    assert(kinds[workflow.mode][node.task] && taskTypes[node.task]?.executor === kinds[workflow.mode][node.task], `workflow ${id}의 작업 실행기가 잘못되었습니다.`);
    if (['review', 'verify'].includes(node.task)) assert(taskTypes[node.task].writes_artifact === false, '검증·검토 작업에 쓰기 권한을 부여할 수 없습니다.');
    if (['plan', 'produce', 'repair'].includes(node.task)) assert(taskTypes[node.task].writes_artifact === true, '생성·계획·수정의 산출물 권한이 빠졌습니다.');
    const outcomes = ['verify', 'review'].includes(node.task) && workflow.mode === 'artifact' ? ['done', 'revise', 'blocked', 'failed'] : ['done', 'blocked', 'failed'];
    assert(node.on && Object.keys(node.on).length === outcomes.length && outcomes.every(s => Object.hasOwn(node.on, s)), `workflow ${id}의 상태 전이가 빠졌거나 허용되지 않은 상태가 있습니다.`);
    for (const [outcome, next] of Object.entries(node.on)) {
      assert(terminal.has(next) || Object.hasOwn(workflow.nodes, next), `workflow ${id}에 존재하지 않는 다음 노드가 있습니다.`);
      if (outcome === 'blocked' || outcome === 'failed') assert(next === `$${outcome}`, '실패나 판정 보류를 성공 경로로 바꿀 수 없습니다.');
      if (outcome === 'revise') assert(checked ? next === '$failed'
        : workflow.nodes[next]?.task === 'repair' && workflow.nodes[next].budget === 'repairs',
      checked ? '형식 검사 실패는 추가 모델 호출 없이 실패로 종료해야 합니다.' : '수정 요청은 제한된 repair로만 연결해야 합니다.');
      if (next === '$completed') assert(outcome === 'done' && (workflow.mode !== 'artifact' || node.task === 'render'), '완료는 최종 전달 단계에서만 가능합니다.');
    }
    assert(node.budget === undefined || node.budget === 'repairs', '알 수 없는 반복 예산입니다.');
    if (node.task === 'repair') assert(node.budget === 'repairs', 'repair에 반복 한도가 필요합니다.');
  }
  // Every cycle must cross a budgeted node; completion must be reachable.
  const visited = new Set(), active = new Set(), reachable = new Set();
  const walk = id => {
    if (terminal.has(id) || visited.has(id)) return;
    assert(!active.has(id), '반복 한도가 없는 workflow 순환입니다.');
    active.add(id);
    for (const next of Object.values(workflow.nodes[id].on)) if (!workflow.nodes[next]?.budget) walk(next);
    active.delete(id); visited.add(id);
  };
  Object.keys(workflow.nodes).forEach(walk);
  const visit = id => { if (reachable.has(id)) return; reachable.add(id); if (!terminal.has(id)) Object.values(workflow.nodes[id].on).forEach(visit); };
  visit(workflow.initial);
  assert(reachable.has('$completed') && Object.keys(workflow.nodes).every(id => reachable.has(id)), 'workflow에 완료 경로가 없거나 도달할 수 없는 노드가 있습니다.');
  // Independent review is the default; the explicit metadata workflow keeps a single generation and format gate.
  if (workflow.mode === 'artifact') {
    assert(['produce', 'plan'].includes(workflow.nodes[workflow.initial].task), '산출물 workflow는 생성 또는 계획에서 시작해야 합니다.');
    for (const node of Object.values(workflow.nodes)) {
      const next = workflow.nodes[node.on.done]?.task;
      if (['produce', 'plan', 'repair'].includes(node.task)) assert(next === 'verify', '생성·수정 후 필수 검증을 건너뛸 수 없습니다.');
      if (node.task === 'verify') assert(next === (checked ? 'render' : 'review'), checked ? '형식 검사 후 전달 단계가 필요합니다.' : '검증 후 독립 검토를 건너뛸 수 없습니다.');
      if (node.task === 'review') assert(next === 'render', '검토 후 전달 단계가 필요합니다.');
      if (node.task === 'render') assert(node.on.done === '$completed', '전달 후 완료로 연결해야 합니다.');
    }
  }
  else assert(Object.keys(workflow.nodes).length === 1 && workflow.nodes[workflow.initial].on.done === '$completed', '로컬 검사·보고서 workflow는 하나의 결정적 작업으로 완료해야 합니다.');
  return workflow;
}

// The same frozen workflow and sequence of validated outcomes produce the same transitions.
export function nextStep(workflow, nodeId, outcome, budgets, limits) {
  const node = workflow.nodes[nodeId];
  assert(node && Object.hasOwn(node.on, outcome), '등록되지 않은 workflow 상태 전이입니다.');
  const next = node.on[outcome], target = workflow.nodes[next];
  if (target?.budget === 'repairs') {
    if (budgets.repairs >= limits.maxRepairs) return { next: '$blocked', reason: 'repair_limit', budgets };
    return { next, budgets: { ...budgets, repairs: budgets.repairs + 1 } };
  }
  return { next, budgets };
}
