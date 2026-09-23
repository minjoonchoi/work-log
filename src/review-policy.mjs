import { assert } from './shared.mjs';

// Task bounds are enforced here. Whether the user's facts and format really
// make a short text low risk is a semantic decision made by the request skill.
export function reviewPolicy(task, job, workflow) {
  const required = Object.values(workflow.nodes).some(node => node.task === 'review');
  const factual = ['meeting.summarize', 'progress.summarize'].includes(job.template_id || task);
  return { default_required: required, omission_allowed: (task === 'text.generate' || factual) && job.kind === 'document' && !job.allow_internal,
    scope: factual ? '제공된 회의·작업 이력의 사실 요약은 생성 1회와 코드 검사로 종료합니다. 별도 검토 요청이면 검토를 추가합니다. 새 조사·판단은 전문 업무로 분리하세요.' : task === 'text.generate'
      ? '제공된 사실과 명확한 출력 형식만 사용하는 짧은 문구·변환은 요청 스킬이 근거를 기록하고 독립 검토를 생략할 수 있습니다. 조사·전문 판단·전용 산출물의 대체에는 사용할 수 없습니다.'
      : required ? '이 업무의 독립 검토는 필수입니다. 검토 보고서 작성 업무도 보고서 자체의 품질 검토를 유지합니다.'
        : '프로필의 코드 검증 절차를 사용하며 요청 스킬의 검토 선택 대상이 아닙니다.' };
}

export function compileReview(task, job, workflows, selection) {
  const workflow = workflows[job.workflow], policy = reviewPolicy(task, job, workflow);
  if (selection !== undefined) {
    assert(workflow.mode === 'artifact' && !job.allow_internal, '이 작업은 프로필에 고정된 검증 절차를 사용합니다. review 선택을 지정하지 마세요.');
    assert(selection.required || policy.omission_allowed, '이 업무는 독립 검토를 생략할 수 없습니다. 카탈로그에서 생략을 허용한 사실 요약·단순 text.generate만 지정하세요.');
  }
  const decision = selection || { required: policy.default_required,
    reason: policy.default_required ? '업무 프로필의 필수 독립 검토를 적용합니다.' : '업무 프로필의 코드 검증 절차를 적용합니다.' };
  return { workflow_id: selection?.required === false ? 'create-checked' : selection?.required === true && !policy.default_required ? 'create-reviewed' : job.workflow, decision: { ...decision } };
}
