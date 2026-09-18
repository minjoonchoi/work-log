import fs from 'node:fs';
import path from 'node:path';
import { Harness, eventually } from '../tests/helpers.mjs';
import { ROOT, assert, atomic, json } from '../src/shared.mjs';
import { loadCatalog } from '../src/catalog.mjs';

assert(process.env.HARNESS_LIVE_APPROVED === '1', '모델 사용량이 발생합니다. 명시적인 승인 후 HARNESS_LIVE_APPROVED=1로 실행하세요.');
const engine = process.env.HARNESS_LIVE_ENGINE || 'codex'; assert(['codex', 'claude'].includes(engine), '실제 엔진만 사용할 수 있습니다.');
const directory = process.env.HARNESS_LIVE_OUTPUT_DIR || path.join(ROOT, 'output/live', new Date().toISOString().replaceAll(':', '-'));
assert(!fs.existsSync(directory), '실모델 검증은 새로운 결과 디렉터리에서 실행하세요.');
const previousFile = process.env.HARNESS_LIVE_PREVIOUS_REPORT;
const previous = previousFile ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : null;
assert(!previous || (previous.finished_at && previous.engine === engine), '같은 엔진의 종료된 이전 검증 보고서가 필요합니다.');
const previousCalls = previous ? (previous.budget?.previous_calls || 0) + previous.runs.reduce((sum, run) => sum + run.attempts.length, 0) : 0;
assert(Number.isSafeInteger(previousCalls) && previousCalls >= 0 && previousCalls <= 18, '이전 호출 수가 승인 한도를 벗어났습니다.');
const { definitions } = loadCatalog();
const maximumPerRun = 2 + 2 * definitions.limits.maxRepairs;
assert(Number.isSafeInteger(maximumPerRun) && maximumPerRun >= 2, '생성·검토·수정 호출 상한을 계산할 수 없습니다.');
const h = new Harness(directory); h.testMode = false;
const jobs = [
  { task: 'prd.create', prompt: '예시 서비스의 팀원 초대 기능 PRD를 한국어로 작성하세요. 실제 프로젝트 파일이나 외부 자료는 필요 없습니다. 관리자는 이메일로 팀원을 초대하고, 초대받은 사람은 수락 또는 거절합니다. 초대는 7일 후 만료됩니다. 관리자는 수락 전 초대를 취소할 수 있습니다. 일반 팀원은 초대할 권한이 없습니다. 범위는 이 기능뿐입니다. 문제, 요구사항, 수용 기준 제목을 포함하고 요구사항 ID와 정상·거절·만료·권한 거부 수용 기준을 연결하세요. 문서는 1000자 안팎으로 작성하세요.' },
  { task: 'mockup.html.create', prompt: '한국어 팀원 초대 화면의 단일 HTML 파일 목업을 만드세요. 외부 라이브러리와 네트워크를 사용하지 마세요. 샘플 데이터임을 화면에 표시하세요. 기본 이메일 user@example.test가 들어 있는 이메일 입력과 id="save"인 저장 버튼을 포함하세요. 저장을 누르면 id="result" 영역에 "저장되었습니다"라는 문구를 표시하세요. 다른 API 연동이나 기능은 필요 없습니다. 파일은 mockup.html입니다.', input: { browser_checks: [{ click: '#save', visible: '#result', text: '저장되었습니다' }] } },
  { task: 'entity.design', prompt: '팀원 초대 기능의 논리 엔티티 설계만 한국어로 작성하세요. DB 제품은 미정이며 DDL은 만들지 마세요. 조직, 사용자, 조직 멤버십, 초대 엔티티의 식별자, 관계 수, 필수 여부를 명시하세요. 초대는 대기·수락·거절·취소·만료 상태를 가지며 7일 후 만료됩니다. 조직과 이메일별 활성 초대 중복 방지, 수락 시 멤버십 생성의 불변식을 적으세요. 엔티티, 관계, 불변식 제목을 포함해 1000자 안팎으로 작성하세요.' }
];
const report = { engine, started_at: new Date().toISOString(), source: 'live-model',
  previous_report: previousFile || null, budget: { limit: 18, previous_calls: previousCalls, current_calls: 0, total_calls: previousCalls }, runs: [] };
let activeRun;
function save() {
  report.budget.current_calls = report.runs.reduce((sum, run) => sum + run.attempts.length, 0);
  report.budget.total_calls = previousCalls + report.budget.current_calls;
  assert(report.budget.total_calls <= report.budget.limit, '승인된 호출 한도를 초과했습니다.');
  atomic(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
try {
  await h.start('runtime'); await h.start('manager');
  for (const job of jobs) {
    if (report.budget.total_calls + maximumPerRun > report.budget.limit) {
      report.runs.push({ task: job.task, status: 'not_run', message: '남은 승인 호출 수가 이 업무의 최대 호출 수보다 작아 시작하지 않았습니다.', attempts: [] }); save();
      continue;
    }
    activeRun = await h.run({ ...job, engine }); console.log(json({ started: activeRun.id, task: job.task, previous_calls: report.budget.total_calls }));
    const result = await h.finish(activeRun, 19 * 60 * 1000);
    report.runs.push(result); activeRun = null; save();
    const managed = await eventually(async () => {
      const items = await h.manager('/items');
      const details = await Promise.all(items.map(item => h.manager(`/items/${item.id}`)));
      return details.find(detail => detail.runs.some(run => run.id === result.id));
    }, detail => detail?.runs.find(run => run.id === result.id)?.status === result.status
      && !detail.sessions.some(session => session.pending) && detail.item.state !== 'running');
    result.management = { item_id: managed.item.id, state: managed.item.state, sessions: managed.sessions,
      event_count: managed.events.length, collected_at: new Date().toISOString() }; save();
    console.log(json({ completed: result.id, status: result.status, message: result.message, attempts: result.attempts.length, total_calls: report.budget.total_calls }));
  }
  report.passed = report.runs.every(r => r.status === 'completed'); report.finished_at = new Date().toISOString();
  save();
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  if (activeRun) {
    await h.runtime(`/runs/${activeRun.id}/cancel`, { method: 'POST', body: {} }).catch(() => {});
    const result = await h.runtime(`/runs/${activeRun.id}`).catch(() => null);
    if (result) report.runs.push(result);
  }
  report.passed = false; report.error = error.message; report.finished_at = new Date().toISOString(); save(); process.exitCode = 1;
} finally { await h.close(false); }
console.log(json({ report: path.join(directory, 'report.json') }));
