import { assert } from './shared.mjs';

// A single-pass document still performs its requested operation, including a
// document review. Only an extra quality review of its result is optional.
export function reviewPolicy(task, job, workflow) {
  const required = Object.values(workflow.nodes).some(node => node.task === 'review');
  const template = job.template_id || task;
  const factual = ['meeting.summarize', 'progress.summarize'].includes(template);
  const document = ['document.create', 'document.share.create', 'document.update', 'document.review', 'text.generate'].includes(template);
  return { default_required: required, omission_allowed: (document || factual) && job.kind === 'document' && !job.allow_internal,
    scope: template === 'document.review'
      ? '제공 문서를 실제로 검토하고 판정·지적·근거를 담은 보고서를 한 번 작성합니다. 보고서의 별도 품질 검토·자동 수정은 기본으로 추가하지 않으며 사용자가 명시적으로 요청한 경우에만 선택합니다. 검토 대상 원문은 수정하지 않습니다.'
      : document ? '요청된 문서·텍스트를 한 번 작성하고 코드 검사로 종료합니다. 결과의 별도 품질 검토·자동 수정은 기본으로 추가하지 않으며 사용자가 명시적으로 요청한 경우에만 선택합니다. 전문 PRD·설계·코드·조사 업무의 검토를 이 유형으로 우회하지 않습니다.'
      : factual ? '제공된 회의·작업 이력의 사실 요약은 생성 1회와 코드 검사로 종료합니다. 별도 검토 요청이면 검토를 추가합니다. 새 조사·판단은 전문 업무로 분리하세요.'
      : required ? '이 업무의 독립 검토는 필수입니다. 검토 보고서 작성 업무도 보고서 자체의 품질 검토를 유지합니다.'
        : '프로필의 코드 검증 절차를 사용하며 요청 스킬의 검토 선택 대상이 아닙니다.' };
}

export function compileReview(task, job, workflows, selection) {
  const workflow = workflows[job.workflow], policy = reviewPolicy(task, job, workflow);
  if (selection !== undefined) {
    assert(workflow.mode === 'artifact' && !job.allow_internal, '이 작업은 프로필에 고정된 검증 절차를 사용합니다. review 선택을 지정하지 마세요.');
    assert(selection.required || policy.omission_allowed, '이 업무는 독립 검토를 생략할 수 없습니다. 카탈로그에서 생략을 허용한 문서·텍스트·사실 요약 유형만 지정하세요.');
  }
  const decision = selection || { required: policy.default_required,
    reason: policy.default_required ? '업무 프로필의 필수 독립 검토를 적용합니다.' : '업무 프로필의 코드 검증 절차를 적용합니다.' };
  return { workflow_id: selection?.required === false ? 'create-checked' : selection?.required === true && !policy.default_required ? 'create-reviewed' : job.workflow, decision: { ...decision } };
}
