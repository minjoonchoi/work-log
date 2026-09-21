import { assert } from './shared.mjs';

const guidance = '자연어 run은 한 종류의 산출물과 명확한 동작만 지원합니다. work 스킬에서 요청을 분할하고 구조화된 orchestrate 계획을 제출하거나 task/input을 지정하세요.';
const fail = () => assert(false, guidance);
const action = /작성|생성|만들|설계|계획|수립|구현|검토|리뷰|분석|정의|정제|요약|갱신|수정|업데이트|배정|분장|우선순위|리팩터|반영|실행|돌려|평가|정리|인수인계|기록|\b(?:create|write|generate|design|plan|implement|review|analy[sz]e|define|refine|summari[sz]e|update|fix|refactor|run|evaluate|record)\b/i;
const review = /검토|리뷰|\breview\b/i;
const explanation = /설명|알려|무엇|뭐야|차이|의미|뜻|\b(?:explain|what|why|how|describe|tell me)\b/i;
const requestedAction = /(?:작성|생성|구현|검토|분석|설계|수정|실행|요약|정리)(?:해|하|해줘)|만들어|\b(?:create|generate|implement|run|write|fix)\b/i;
const negative = /하지\s*(?:마|말|않)|금지|불필요|\b(?:do not|don't|never)\b/i;
const genericJobs = new Set(['text.generate', 'document.create', 'document.update', 'document.review']);
const createArtifact = /작성|생성|만들|\b(?:create|write|generate)\b/i;
const changeArtifact = /수정|갱신|업데이트|\b(?:update|modify|fix)\b/i;
const planArtifact = /작성|생성|만들|설계|계획|수립|\b(?:create|write|generate|design|plan)\b/i;
const executeChecks = /(?:e2e|테스트|검사).*(?:실행(?=\s*(?:해|하|$))|돌려)|\brun\b.*(?:e2e|tests|checks)/i;
const customActions = {
  create: createArtifact, design: /작성|생성|만들|설계|\b(?:create|write|generate|design)\b/i,
  plan: planArtifact, review, update: changeArtifact,
  define: /정의|정리|수립|\bdefine\b/i,
  summarize: /요약|정리|\bsummari[sz]e\b/i,
  analyze: /분석|비교|조사|\b(?:analy[sz]e|compare|research)\b/i,
  refine: /정제|구체화|\brefine\b/i,
  prioritize: /우선순위|정렬|\bprioriti[sz]e\b/i,
  evaluate: /평가|\bevaluate\b/i,
  record: /기록|작성|\b(?:record|write)\b/i,
  implement: /구현|\bimplement\b/i,
  test: /작성|생성|만들|구현|\b(?:write|create|generate|implement)\b/i,
  fix: /수정|고쳐|고치|\bfix\b/i,
  refactor: /리팩터|리팩토|\brefactor\b/i,
  respond: /반영|대응|수정|\b(?:respond|apply|address|fix)\b/i
};
const reviewTargets = [
  ['security.review', /보안|security/i], ['accessibility.review', /접근성|accessibility/i],
  ['performance.review', /성능|performance/i], ['query.review', /쿼리|\bsql\b|query/i],
  ['architecture.review', /아키텍처|architecture/i], ['ui.review', /\bui\b|화면|목업|mockup/i],
  ['risk.review', /위험|리스크|risk/i], ['delivery.review', /납품|출고|전달\s*준비|delivery/i],
  ['code.review', /코드|code/i],
  ['document.review', /\bprd\b|문서|기획서|요구사항|\bapi\b|엔티티|entity|erd|계획서|명세|설계|보고서|시나리오|(?:테스트|검사|검증|실행).*결과|document|\breport\b|\bbrief\b|\bscenarios?\b|\b(?:test|check).*results?\b/i]
];

// This compatibility intake accepts a deliberately limited set of clear single-job requests.
// Semantic decomposition belongs to the work skill and validated task/input DAG, not regex guessing.
export function resolveTask(input, jobs = {}) {
  if (input.task !== undefined && input.task !== null) return input.task;
  assert(typeof input.prompt === 'string' && input.prompt.trim(), guidance);
  const prompt = input.prompt.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const parts = prompt
    .replace(/((?:작성|생성|구현|검토|분석|설계|수정|실행|리뷰))(?:하고|한\s*(?:후|뒤)|해서|\s+(?:후|뒤)\s+)/g, '$1\n')
    .replace(/만들고/g, '만들\n')
    .replace(/(하지\s*(?:말고|않고))/g, '$1\n')
    .replace(/(PRD|API|목업|엔티티|설계|구현|문서|검토|리뷰|코드|계획|요약|테스트|분석)(?:와|과)(?=\s)/gi, '$1\n')
    .split(/[,;\n]|\s+(?:및|그리고|and|then)\s+/i)
    .map(part => removeReference(part.trim()))
    .filter(part => part && !negative.test(part));
  if (!parts.length) return fail();
  const candidates = new Set();
  let explanatory = false, unresolvedAction = false;
  for (const part of parts) {
    if (explanation.test(part) && (!requestedAction.test(part) || /방법|무엇|개념|의미|뜻|\b(?:how|what|why)\b/i.test(part))) { explanatory = true; continue; }
    const selected = classifyPart(part, jobs);
    if (!selected.length) {
      // An unresolved action after a recognized one may be an omitted-object second task.
      // E.g. "PRD 검토 및 수정" must never silently execute review alone.
      if (action.test(part) || !explanation.test(part)) unresolvedAction = true;
    }
    for (const id of selected) candidates.add(id);
  }
  if (candidates.size === 0 && explanatory && !unresolvedAction) return 'text.generate';
  if (candidates.size !== 1 || unresolvedAction || explanatory) return fail();
  return [...candidates][0];
}

function removeReference(part) {
  // Source references are not deliverables. Only remove an explicit reference clause;
  // unsupported sentence structures stay ambiguous and are rejected below.
  const match = part.match(/^(.+?)(?:참고(?:해서|하여|해|로)|참조(?:해서|하여|해)|기반으로|바탕으로|입력으로)\s*/);
  if (match && !requestedAction.test(match[1])) part = part.slice(match[0].length).trim();
  return part.replace(/(?:수정|변경|실행)\s*없이/g, '').trim();
}

function classifyPart(part, jobs) {
  const builtin = classifyBuiltinPart(part, jobs);
  const custom = Object.entries(jobs).filter(([, job]) => {
    if (job.source !== 'user' || job.allow_internal || !job.routing?.terms?.some(term => part.toLocaleLowerCase().includes(term.toLocaleLowerCase()))) return false;
    const operation = job.routing.action;
    // Read-only requests never select a producer because its keyword happens to
    // name the source being reviewed. Command execution also stays a local route.
    if (review.test(part) && !builtin.includes('review.respond') && operation !== 'review') return false;
    if (executeChecks.test(part)) return false;
    if (operation !== 'review' && !['update', 'fix', 'refactor', 'respond'].includes(operation) && changeArtifact.test(part)) return false;
    return action.test(part) && !!customActions[operation]?.test(part);
  });
  if (!custom.length) return builtin;
  if (custom.length !== 1) return fail();
  const [id, job] = custom[0];
  // A custom keyword refines its inherited task or a generic fallback. It must
  // not silently replace a different specialized artifact or review boundary.
  if (builtin.some(task => task !== job.template_id && !genericJobs.has(task))) return fail();
  return [id];
}

function classifyBuiltinPart(part, jobs) {
  const responseRequested = jobs['review.respond']?.routing.terms.some(term => part.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
  // The word "review" is also part of "review response"; an explicit request to
  // inspect that response must still stay read-only instead of applying changes.
  const inspectResponse = /검토|리뷰(?:해|하)|\breview\s+(?:the\s+)?review response\b/i.test(part);
  if (review.test(part) && (!responseRequested || inspectResponse)) {
    if (/(?:검토|리뷰|review).*?(?:후|뒤|하고|then).*?(?:수정|반영|고쳐|구현|fix|edit)/i.test(part)) return fail();
    const matches = reviewTargets.filter(([id, target]) => jobs[id] && target.test(part)).map(([id]) => id);
    let specialized = matches.filter(id => !['code.review', 'document.review'].includes(id));
    if (specialized.some(id => id !== 'ui.review')) specialized = specialized.filter(id => id !== 'ui.review');
    if (specialized.length) return specialized;
    if (matches.includes('code.review')) return ['code.review'];
    return matches;
  }
  if (responseRequested) return ['review.respond'];
  // Artifact nouns do not authorize creation or command execution. Keep these
  // local/specialized routes behind the requested operation, after review routing.
  if (/검증.*보고서|검사.*보고서|verification report/i.test(part)) return createArtifact.test(part) && !changeArtifact.test(part) ? ['verification.report'] : [];
  if (/(?:테스트|e2e|검증).*시나리오|test scenarios?/i.test(part)) return planArtifact.test(part) && !changeArtifact.test(part) ? ['test.scenarios.plan'] : [];
  if (executeChecks.test(part)) return ['checks.run'];
  const result = Object.entries(jobs).filter(([, job]) => job.source !== 'user' && !job.allow_internal && job.routing?.terms?.some(term => part.toLocaleLowerCase().includes(term.toLocaleLowerCase())))
    .map(([id]) => id);
  if (action.test(part)) {
    if (/\bprd\b|제품\s*요구사항\s*문서/i.test(part)) result.push('prd.create');
    if (/목업|mockup|\bhtml\b/i.test(part)) result.push('mockup.html.create');
    if (/엔티티|\bentity\b|\berd\b/i.test(part)) result.push('entity.design');
  }
  let unique = [...new Set(result)].filter(id => {
    const operation = jobs[id]?.routing.action;
    if (['create', 'design'].includes(operation)) return /작성|생성|만들|설계|\b(?:create|write|generate|design)\b/i.test(part)
      && !/수정|갱신|업데이트|\b(?:update|modify|fix)\b/i.test(part);
    if (operation === 'implement') return /구현|\bimplement/i.test(part);
    if (operation === 'execute') return executeChecks.test(part);
    return true;
  });
  if (unique.some(id => !genericJobs.has(id))) unique = unique.filter(id => !genericJobs.has(id));
  if (!action.test(part)) return [];
  return unique;
}
