import { assert } from './shared.mjs';

// Compatibility entry for natural-language callers. The execution graph only receives compiled requests.
export function resolveTask(input) { return input.task ?? classifyPrompt(input.prompt); }

function classifyPrompt(prompt) {
  if (/실행\s*방법|실행하지\s*마|실행하지\s*않|\bhow to\b|\bdo not run\b|\bdon't run\b/i.test(prompt) && !/(?:테스트|e2e|검증).*시나리오|test scenarios?/i.test(prompt)) return 'text.generate';
  if (/검증.*보고서|검사.*보고서|verification report/i.test(prompt)) return 'verification.report';
  if (/(?:테스트|e2e|검증).*시나리오|test scenarios?/i.test(prompt)) return 'test.scenarios.plan';
  if (/(?:e2e|테스트|검사).*(?:실행|돌려)|run.*(?:e2e|tests|checks)/i.test(prompt)) return 'checks.run';
  const requestedKinds = [/목업|mockup|html/i, /엔티티|entity|erd/i, /prd/i].filter(r => r.test(prompt));
  assert(requestedKinds.length <= 1, '1차 버전은 요청당 한 종류의 산출물을 지원합니다. PRD·목업·엔티티를 각각 요청해 같은 업무로 병합할 수 있습니다.');
  if (/목업|mockup|html/i.test(prompt)) return 'mockup.html.create';
  if (/엔티티|entity|erd/i.test(prompt)) return 'entity.design';
  if (/prd|요구사항|제품 요구/i.test(prompt)) return 'prd.create';
  return 'text.generate';
}
