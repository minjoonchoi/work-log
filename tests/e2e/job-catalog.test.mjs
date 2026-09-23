import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Harness } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

// These are protocol-fixture workloads. They exercise real request validation, processes,
// gates and publication; they do not claim to measure live-model content quality.
const requests = {
  'problem.define': '초대 실패 고객 문의에서 해결할 사용자 문제와 범위를 정의하세요.',
  'user.research.summarize': '제공 인터뷰 2건의 관찰과 해석을 구분해 사용자 조사 결과를 요약하세요.',
  'market.compare': '제공 후보의 팀원 초대 제품 정책을 같은 비교 기준으로 비교하세요.',
  'hypothesis.define': '중복 초대 이유를 안내하면 문의가 줄어든다는 반증 가능한 가설을 정의하세요.',
  'prd.create': '관리자 초대의 범위와 정상·거절 수용 기준을 PRD로 작성하세요.',
  'requirement.refine': '중복 초대 거절이라는 기존 요구를 관찰 가능한 정책으로 정제하세요.',
  'acceptance.define': '관리자만 초대할 수 있다는 확정 요구의 수용 조건을 정의하세요.',
  'story.create': '관리자의 초대 기능을 요청 범위 안의 사용자 스토리로 작성하세요.',
  'backlog.prioritize': '제공 가치·위험 기준으로 초대·검색 백로그 우선순위를 정하세요.',
  'metric.define': '초대 성공률 지표의 분자·분모와 수집 시점을 정의하세요.',
  'experiment.plan': '초대 오류 안내 문구가 문의율에 미치는 영향을 검증할 실험을 계획하세요.',
  'release.evaluate': '제공 릴리스 목표와 관측 결과로 사내 베타 효과를 평가하세요.',
  'feedback.analyze': '제공 고객 피드백에서 초대 기능의 반복 문제와 근거를 분석하세요.',
  'project.plan': '범위와 제약을 기준으로 초대 기능 사내 베타 프로젝트 계획을 작성하세요.',
  'scope.define': '초대·검색 후보 중 이번 사내 베타의 범위와 제외 사항을 정의하세요.',
  'wbs.create': '승인된 초대 기능 범위를 검증 가능한 작업 단위로 분해하세요.',
  'schedule.create': '제공 작업 의존성과 추정으로 일정 초안을 작성하고 미정은 표시하세요.',
  'schedule.update': '기준 일정에서 검토 지연 1일의 영향만 반영하세요.',
  'milestone.update': '제공 완료 근거를 기준으로 베타 마일스톤 상태를 갱신하세요.',
  'risk.review': '초대 기능의 미정 인증 정책에 따른 프로젝트 위험을 검토하세요.',
  'dependency.analyze': '초대 API 계약과 FE·BE 구현 작업의 의존성을 분석하세요.',
  'progress.summarize': '관측 시점까지 확인된 초대 기능 진행과 미완료 사항을 요약하세요.',
  'work.allocate': '제공 역할과 가용 시간을 근거로 확정 작업의 업무 분장안을 만드세요.',
  'meeting.summarize': '회의 원문의 논의·확정 결정·보류·후속 행동을 구분해 정리하세요.',
  'decision.record': '제공 D-01 사내 베타 승인 결정과 대안·근거를 기록하세요.',
  'status.report': '제공 진행 이력을 팀장에게 전달할 상태 보고서로 작성하세요.',
  'handoff.create': '다음 담당자가 이어갈 수 있도록 근거·미완료·다음 행동을 정리하세요.',
  'screen.specify': '초대 요구의 화면 상태·권한·동작·예외만 명세하세요.',
  'flow.design': '관리자 초대 흐름에서 정상·중복 거절·취소 전환을 정의하세요.',
  'diagram.create': '제공된 초대 상태 흐름을 편집 가능한 Mermaid 상태 다이어그램으로 표현하세요.',
  'architecture.review': '제공 설계의 권한 경계와 장애 영향 범위를 검토하세요.',
  'mockup.html.create': '권한 신청 저장 버튼과 저장 후 안내가 동작하는 샘플 HTML 목업을 작성하세요.',
  'frontend.plan': '화면 명세와 API 계약을 기준으로 FE 구현 순서와 경계를 계획하세요.',
  'frontend.implement': '제공 FE 모듈의 초대 버튼 표시를 요구에 맞게 구현하세요.',
  'component.design': '초대 버튼의 입력·상태·이벤트 계약을 설계하세요.',
  'ui.review': '제공 화면의 정상·중복 거절 상태가 화면 명세에 맞는지 검토하세요.',
  'accessibility.review': '제공 화면의 키보드 동작과 버튼 접근 가능한 이름을 검토하세요.',
  'frontend.test': '초대 버튼 상태에 대한 FE 전용 회귀 테스트를 작성하세요.',
  'performance.review': '제공 측정 결과와 목표를 비교해 초대 목록 성능을 검토하세요.',
  'entity.design': '초대 도메인의 식별자·관계·불변식을 논리 모델로 설계하세요.',
  'api.design': '관리자 초대 API의 요청·응답·중복 오류·권한 계약을 설계하세요.',
  'backend.plan': 'API·엔티티 기준으로 BE 구현 순서와 검증 경계를 계획하세요.',
  'backend.implement': '제공 BE 모듈의 관리자 초대 권한 처리를 구현하세요.',
  'migration.plan': '제공 기준과 목표 스키마 사이의 전환·검증·복구 계획을 작성하세요.',
  'backend.test': '초대 권한의 허용·거절 경계를 검증하는 BE 전용 테스트를 작성하세요.',
  'query.review': '제공 초대 목록 SQL과 실행 계획에서 조회 범위·인덱스를 검토하세요.',
  'security.review': '제공 초대 코드의 권한 검사와 입력 검증을 요구에 맞게 검토하세요.',
  'incident.analyze': '제공 장애 로그와 변경 이력에서 확인된 원인·미확인 가설을 구분하세요.',
  'code.review': '고정된 코드 변경의 권한 결함만 검토하고 소스는 수정하지 마세요.',
  'bug.analyze': '제공 비관리자 초대 허용 증상의 원인과 수정 범위를 분석하세요.',
  'bug.fix': '제공 코드에서 비관리자도 초대 가능한 결함만 수정하세요.',
  'refactor': '제공 모듈의 권한 판정을 기존 동작을 보존하면서 읽기 쉽게 정리하세요.',
  'test.create': 'FE 요청과 BE 응답 사이의 초대 권한 계약을 E2E 테스트로 작성하세요.',
  'review.respond': 'ISS-001 비관리자 초대 허용 지적에 대응하는 코드만 수정하세요.',
  'research.compare': '제공 로컬 저장 도구 A·B를 동일한 검색·복구 기준으로 비교하세요.',
  'document.create': '전용 업무 유형이 없는 사내 용어 안내 문서를 작성하세요.',
  'document.share.create': '초대 오류 안내 변경의 배경과 확인된 결과를 사전 맥락이 없는 유관 부서에 공유할 문서로 작성하세요.',
  'document.update': '제공 용어 안내 문서의 세션 정의만 변경 요청대로 개정하세요.',
  'document.review': '제공 용어 안내 문서가 검토 기준과 원문 용어에 맞는지 검토하세요.',
  'text.generate': '사내 베타 안내에 사용할 짧은 한국어 소개 문구를 작성하세요.',
  'task.plan': '지정된 초대 오류 조사 한 작업의 수행 순서와 완료 조건을 계획하세요.',
  'delivery.review': '요청한 PRD와 목업이 필수 전달 조건을 충족하는지 제공 근거로 검토하세요.'
};
const baseline = 'REQ-001: 관리자만 팀원을 초대한다. 중복 이메일은 거절하고 이유를 표시한다. 사내 베타만 범위에 포함한다. DB 제품은 미정이다.';
const samples = {
  observations: '문의 Q-01: 초대 거절 이유를 찾지 못함. 관찰 O-01: 관리자 화면에 오류 안내가 없음.',
  target_users: '사내 베타에 참여하는 팀 관리자 3명. 일반 팀원은 초대 권한 없음.',
  source_text: '2026-09-18 기록: 관리자 2명은 중복 초대 오류 안내가 없다고 말했다. D-01 사내 베타는 승인됨. 공개 출시와 가격은 미정.',
  research_goal: '중복 초대 거절 이후 관리자가 수행하는 행동 확인.', candidates: '후보 A: 이메일당 초대 1개. 후보 B: 재초대 허용.',
  criteria: '권한 거부를 설명하고 미정 정보를 확정 사실로 쓰지 않는다.', sources: '제공 자료 A v1과 B v1의 초대 정책 본문. 최신 외부 사실은 제공되지 않음.',
  problem: '중복 초대 거절 후 이유 안내가 없어 관리자 문의가 발생한다.', change_request: '세션은 마지막 출력과 다음 입력 간격이 20분 이상이면 새 단위로 구분한다고 고친다.',
  requirements_baseline: baseline, policies: '관리자만 초대 가능. 같은 이메일의 대기 초대가 존재하면 거절.', user_roles: '관리자: 초대 가능. 일반 팀원: 초대 불가.',
  backlog: 'B-01 초대 오류 안내: 가치 높음, 작업량 1일. B-02 검색: 가치 중간, 작업량 2일.', product_goal: '초대 실패 고객 문의를 줄인다.',
  data_definitions: '초대 시도: 클릭당 1회. 성공: 서버가 승인한 요청. 동일 요청 재전송은 중복 집계 제외.',
  hypothesis: '중복 오류 이유를 표시하면 문의율이 낮아진다.', metrics: '초대 실패 관련 문의 수 / 초대 실패 시도 수.',
  constraints: '사내 베타 범위, 외부 고객 공개 및 실제 원격 변경 제외. 확인되지 않은 날짜·인력은 미정.',
  release_baseline: '사내 베타 목표: 중복 초대 오류 문의율 20% 이하.', product_context: baseline, project_goal: '사내 베타 초대 흐름의 사용성 확인.',
  scope: baseline, scope_candidates: '초대 오류 안내 포함 후보. 전체 검색 개선은 차기 후보.', deliverables: '초대 정책 명세와 클릭 가능한 샘플 목업.',
  work_breakdown: 'W-01 정책 확정 → W-02 화면 명세 → W-03 샘플 목업.', estimates: 'W-01 1일, W-02 1일, W-03 2일. 작업일 기준 추정.',
  date_constraints: '시작일 2026-09-21. 확정 납기 없음.', baseline: 'M-01 사내 베타: 계획 2026-09-25, 진행중. W-01 완료, W-02 검토중.',
  changes: '2026-09-18 W-02 검토가 1일 지연됨. 범위와 담당자는 변경 없음.', subject: '권한 검사 모듈 v1: export const canInvite = role => true; 허용 대상은 관리자다.',
  work_items: 'W-01 초대 계약 확정. W-02 FE 구현은 W-01 의존. W-03 BE 구현은 W-01 의존.', as_of: '2026-09-18T09:00:00+09:00',
  people: '사람 A: FE 담당. 사람 B: BE 담당.', availability: '사람 A 주 2일, 사람 B 주 3일. 실제 배정은 아직 승인되지 않음.',
  meeting_date: '2026-09-18', decision: 'D-01: PO가 사내 베타 실시를 승인했다. 공개 출시는 미정.', alternatives: '전체 고객 공개는 지원 위험으로 보류.',
  rationale: '외부 공개 전에 권한 거절 안내를 확인하기 위함.', audience: '프로젝트 팀장과 다음 담당자.', reporting_period: '2026-09-14부터 2026-09-18까지.',
  actors: '관리자, 초대받는 팀원.', diagram_type: 'Mermaid stateDiagram-v2', quality_attributes: '권한 경계의 일관성과 장애 영향 제한.',
  screen_spec: '초대 화면: 이메일 입력, 저장 버튼, 성공 안내, 중복 오류 안내.', api_contract: 'POST /invitations: 관리자만 허용, 중복 이메일은 409, 일반 팀원은 403.',
  repository_context: 'Node.js ESM. FE와 BE 모듈 분리. 테스트는 tests/ 디렉터리에서 관리.',
  component_requirements: 'InviteButton은 pending 동안 비활성화되고 submit 이벤트를 보낸다.', ui_conventions: '파란색 포인트와 무채색, 키보드 포커스 표시.',
  evidence: 'E-01 제공 검사 로그: 권한 거절 샘플 1건 확인. 전체 빌드·전체 회귀 검사는 미실행.',
  measurements: '샘플 100회에서 목록 요청 p95 250ms. 실행 환경과 수집 기준은 제공된 표본만 유효.', targets: '제공 목표 p95 300ms 이하.',
  domain_model: 'Invitation: id, email, status(pending/accepted/cancelled). 이메일당 pending 1개.',
  existing_contract: '기존 POST /invitations는 email 필드를 받는다. 새 필드를 추측해서 추가하지 않는다.', entity_model: 'Invitation과 Team은 N:1 관계.',
  current_schema: 'invitation(id, email). email 중복 허용.', target_schema: 'invitation(id, email, status). pending 이메일 중복 금지.',
  operating_constraints: '데이터 삭제 없이 검증 후 전환. 실제 마이그레이션 실행은 범위 밖.',
  query: 'SELECT id, email FROM invitation WHERE status = $1 ORDER BY id LIMIT 20;', schema_context: 'invitation(id primary key, email, status), status 인덱스 없음.',
  execution_plan: '제공 표본: sequential scan; 1000행 읽음. 실제 서비스 측정은 제공되지 않음.', security_requirements: '관리자만 초대할 수 있고 비관리자는 403으로 거절한다.',
  logs: '2026-09-18T00:00:00Z 요청 R-01 role=member POST /invitations status=201.', diff: '- role === "admin"\n+ true',
  symptoms: '일반 팀원이 초대를 생성할 수 있다. 기대: 403 거절.', purpose: '사내 업무 기록 용어 설명.', preserve: '다른 용어 정의와 문서의 원래 순서는 보존한다.',
  task_goal: 'R-01 권한 오류의 원인과 수정 후보를 조사한다.', artifacts: 'PRD v1: 관리자만 초대. 목업 v1: 일반 팀원 버튼 비활성화.',
  acceptance_criteria: '필수 PRD와 목업 존재, 권한 용어 일치, 미실행 검사는 명시.'
};

function sampleInput(job) {
  if (job.kind === 'scenario_plan') return { requirements: [{ id: 'REQ-001', text: baseline }], categories: ['normal', 'failure', 'boundary', 'recovery'] };
  assert.ok(requests[job.id], `새 업무 ${job.id}에는 실제 사용 목적의 E2E 입력을 추가하세요.`);
  if (job.kind === 'code_bundle') {
    const isTest = ['frontend.test', 'backend.test', 'test.create'].includes(job.id);
    return { requirements: requests[job.id], source_files: [{ path: 'src/invitation.mjs', content: 'export const canInvite = role => true;\n' }],
      allowed_paths: [isTest ? 'tests/invitation.test.mjs' : 'src/invitation.mjs'], instructions: '요청한 업무의 허용 파일만 작성하고, 실제 미실행 검사를 합격으로 표현하지 마세요.' };
  }
  const input = job.input_schema.properties.requirements ? { requirements: `${requests[job.id]}\n기준 자료: ${baseline}` } : {};
  for (const field of Object.keys(job.input_schema.properties)) {
    if (field === 'requirements') continue;
    if (field === 'instructions') input[field] = '제공된 근거와 담당 업무 범위를 지키고 미정은 미정으로 표시하세요.';
    else if (field === 'browser_checks') input[field] = [{ click: '#save', visible: '#result', text: '저장되었습니다' }];
    else { assert.ok(samples[field], `${job.id}.${field}의 의미 있는 입력 표본이 없습니다.`); input[field] = samples[field]; }
  }
  return input;
}
const submit = (h, task, input, fixture = {}) => h.runtime('/runs', { method: 'POST', body: { task, input, engine: 'fixture', fixture } });
async function setup(t) { const h = await new Harness().start('runtime'); t.after(() => h.close()); return h; }

// Exercise every currently published artifact contract, including future additions once
// their meaningful sample is added. A fixed catalog length is not a quality assertion.
test('every public artifact profile passes its real subprocess, contract, verification, review and publication flow', async t => {
  const h = await setup(t), catalog = await h.runtime('/catalog');
  const jobs = catalog.jobs.filter(job => !job.internal && catalog.workflows[job.workflow].mode === 'artifact');
  for (const job of jobs) await t.test(job.id, async () => {
    const input = sampleInput(job), result = await h.finish(await submit(h, job.id, input, { scenario: 'prompted-rules' }));
    assert.equal(result.status, 'completed', result.message); assert.equal(result.round, 0);
    assert.ok(result.steps.some(step => step.task === 'verify' && step.outcome.status === 'done'));
    assert.equal(result.steps.some(step => step.task === 'review' && step.outcome.status === 'done'), job.review_policy.default_required);
    assert.equal(result.steps.at(-1).task, 'render');
    for (const attempt of result.attempts) {
      const prompt = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
      assert.ok(prompt.includes(JSON.stringify(job.boundary)), `${job.id}/${attempt.stage}: immutable boundary missing`);
      assert.ok(prompt.includes('JOB-BOUNDARY-001'), `${job.id}/${attempt.stage}: boundary rule missing`);
      assert.ok(prompt.includes(JSON.stringify(input.requirements ?? input.purpose)), `${job.id}/${attempt.stage}: requested purpose missing`);
    }
    const review = result.attempts.find(attempt => attempt.stage === 'review');
    if (review) {
    const prompt = fs.readFileSync(path.join(review.directory, 'prompt.txt'), 'utf8');
    const rules = JSON.parse(prompt.match(/\n규칙: ([^\n]+)\n/)[1]);
    const response = JSON.parse(fs.readFileSync(path.join(review.directory, 'result.json')));
    assert.deepEqual(new Set(response.result.evaluations.map(evaluation => evaluation.rule)), new Set(Object.keys(rules)));
    assert.ok(response.result.evaluations.every(evaluation => evaluation.passed && evaluation.evidence));
    assert.ok(Object.keys(rules).some(rule => !['REQ-001', 'OUTPUT-001', 'SCOPE-001', 'JOB-BOUNDARY-001'].includes(rule)));
    } else {
      assert.equal(result.attempts.length, 1); assert.ok(result.artifact.generation_attempt);
      assert.equal(result.artifact.review_attempt, undefined);
    }
    const text = fs.readFileSync(result.artifact.file, 'utf8');
    assert.ok(text.length > 0);
    if (job.kind === 'code_bundle') {
      const bundle = JSON.parse(text);
      assert.deepEqual(bundle.files.map(file => file.path), input.allowed_paths);
      assert.ok(bundle.files.every(file => typeof file.content === 'string'));
      const verification = JSON.parse(fs.readFileSync(result.artifact.verify_report));
      assert.equal(verification.checks.find(check => check.check === 'code verification coverage recorded').project_applied, false);
    } else assert.equal(path.basename(result.artifact.file), job.boundary.deliverable);
  });
});

test('local instruction overrides preserve immutable job boundaries and cannot waive required boundary review evidence', async t => {
  const h = await setup(t), catalog = await h.runtime('/catalog');
  const job = catalog.jobs.find(job => job.id === 'backend.implement');
  const initial = await h.runtime('/execution-settings');
  const override = '일반 개발자처럼 간결하게 작성하세요. 필요한 판단은 스스로 수행하세요.';
  await h.runtime('/execution-settings/backend.implement', { method: 'PUT', body: {
    revision: initial.revision, instruction: override, backend: 'codex',
    backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } }
  } });
  const input = sampleInput(job);
  const passed = await h.finish(await submit(h, job.id, input));
  assert.equal(passed.status, 'completed', passed.message);
  for (const attempt of passed.attempts) {
    const prompt = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
    assert.ok(prompt.includes(override)); assert.ok(prompt.includes(JSON.stringify(job.boundary)));
    assert.match(prompt, /로컬 지시문으로 확대할 수 없음/);
  }
  const missing = await h.finish(await submit(h, job.id, input, { scenario: 'omit-boundary-rule' }));
  assert.equal(missing.status, 'failed'); assert.equal(missing.artifact, null);
  assert.match(missing.message, /필수 검토 규칙이 누락/);
  const verification = missing.steps.find(step => step.task === 'verify'); assert.equal(verification.outcome.status, 'done');
  const review = missing.attempts.find(attempt => attempt.stage === 'review');
  const response = JSON.parse(fs.readFileSync(path.join(review.directory, 'result.json')));
  assert.ok(response.result.evaluations.length > 0);
  assert.ok(response.result.evaluations.every(evaluation => evaluation.rule !== 'JOB-BOUNDARY-001'));
  const { revision } = await h.runtime('/execution-settings');
  await assert.rejects(h.runtime('/execution-settings/backend.implement', { method: 'PUT', body: {
    revision, instruction: override, backend: 'codex', boundary: { owns: 'all work' },
    backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } }
  } }), /등록되지 않은 필드/);
});

test('invalid job boundaries and unknown required review rules prevent service startup before work can be accepted', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-job-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of ['src', 'harness', 'contracts']) fs.cpSync(path.join(ROOT, folder), path.join(root, folder), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const file = path.join(root, 'harness/jobs.json'), original = JSON.parse(fs.readFileSync(file));
  const mutations = [job => { job.rules.push('UNKNOWN-REQUIRED-RULE'); }, job => { delete job.boundary; }, job => { job.boundary.excludes = []; }];
  for (const [index, change] of mutations.entries()) {
    const value = structuredClone(original); change(value.jobs['backend.implement']); fs.writeFileSync(file, JSON.stringify(value));
    const data = path.join(root, `data-${index}`);
    const child = spawnSync(process.execPath, [path.join(root, 'src/runtime.mjs')], {
      env: { ...process.env, HARNESS_DATA_DIR: data, HARNESS_TEST_MODE: '0' }, encoding: 'utf8', timeout: 5000
    });
    assert.ok(!child.error, child.error?.message); assert.notEqual(child.status, 0);
    assert.doesNotMatch(child.stdout, /"ready":true/); assert.match(child.stderr, /규칙이 없습니다|책임 경계가 필요/);
    assert.equal(fs.existsSync(path.join(data, 'runtime.endpoint.json')), false);
  }
});
