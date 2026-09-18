import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [output, stage] = process.argv.slice(2);
const fixture = JSON.parse(process.env.HARNESS_FIXTURE || '{}');
const { job, round = 0, scenario = 'success' } = fixture;
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (scenario === 'slow' || scenario === 'child') {
  if (scenario === 'child') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(process.cwd(), 'child.pid'), String(child.pid));
  }
  await new Promise(resolve => setTimeout(resolve, fixture.delayMs || 15000));
}
if (fixture.delayMs && !['slow', 'child'].includes(scenario)) await new Promise(r => setTimeout(r, fixture.delayMs));
if (scenario === 'flood') for (let i = 0; i < 1100; i++) process.stderr.write('x'.repeat(4096));
if (scenario === 'crash') process.exit(9);
if (scenario === 'truncated') { fs.writeFileSync(output, '{"status":'); process.exit(0); }
if (scenario === 'invalid') { fs.writeFileSync(output, JSON.stringify({ status: 'done', result: {} })); process.exit(0); }
if (scenario === 'illegal-transition') { fs.writeFileSync(output, JSON.stringify({ status: 'done', result: { file: job.file, next: 'render' } })); process.exit(0); }
let result;
if (scenario === 'blocked') result = { status: 'blocked', result: { message: '필수 대상 고객 정보가 필요합니다.' } };
else if (stage === 'review') {
  if (scenario === 'tamper') fs.appendFileSync(job.file, '\n검토 중 변경');
  if (scenario === 'always-revise' || (scenario === 'revise-once' && round === 0)) result = { status: 'revise', result: { issues: [{ rule: job.rules[0], detail: '거절 상태의 수용 기준을 추가하세요.' }] } };
  else {
    const promptedRules = scenario === 'prompted-rules' ? Object.keys(JSON.parse(prompt.match(/\n규칙: ([^\n]+)\n/)[1])) : job.rules;
    const evaluatedRules = scenario === 'missing-evidence' ? [] : scenario === 'omit-common-rule' ? promptedRules.filter(rule => rule !== 'SCOPE-001') : promptedRules;
    result = { status: 'done', result: { evaluations: evaluatedRules.map(rule => ({ rule, passed: true, evidence: `고정된 ${job.file}에서 ${rule} 조건을 확인했습니다.` })) } };
  }
} else {
  let text = job.kind === 'html' ? `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>검증용 목업</title></head><body><h1>권한 신청</h1><button id="save">저장</button><p id="result" hidden>저장되었습니다</p><script>document.querySelector('#save').onclick=()=>{document.querySelector('#result').hidden=false}</script></body></html>`
    : `# ${job.label}\n\n${job.requiredSections.map(s => `## ${s}\nREQ-001: 사용자 요청에 따른 ${s}입니다.\n`).join('\n')}\n${round > 0 ? '거절 상태의 수용 기준: 거절 결과를 표시합니다.' : ''}\n`;
  if (job.kind === 'scenario_plan') {
    const categories = fixture.input.categories.filter(c => !(scenario === 'scenario-missing-recovery-once' && round === 0 && c === 'recovery'));
    text = JSON.stringify({ scenarios: categories.map((category, i) => ({
      id: `SCN-${i + 1}`, title: `${category} 시나리오`, category,
      requirement_ids: scenario === 'scenario-unknown-requirement' ? ['invented'] : fixture.input.requirements.map(r => r.id),
      preconditions: ['격리된 테스트 데이터와 서비스가 준비됨'],
      steps: [{ action: '정해진 시각의 입력과 출력을 제출함', expected: '원본 시각과 세션 연결이 보존됨' }]
    })) });
  }
  if (job.kind === 'session_summary') {
    text = `${fixture.input.title}\n${fixture.input.events.filter(e => e.text).slice(-5).map(e => e.text.replace(/\s+/g, ' ').slice(0, 400)).join('\n') || '응답 본문 미확인'}`;
    if (scenario === 'summary-too-long') text += '\n추가 설명\n추가 설명\n추가 설명\n추가 설명\n추가 설명\n추가 설명';
  }
  if (job.kind === 'text_rewrite') {
    const events = fixture.input.sessions.flatMap(s => s.events), messages = events.filter(e => e.text).map(e => e.text.replace(/\s+/g, ' ').slice(0, 400));
    const value = {
      title: (messages[0] || '작업 세션').slice(0, 200),
      description: fixture.input.format === 'session-summary' ? messages.slice(-5).join('\n') || '응답 본문 미확인'
        : `${fixture.input.sessions.length}개 세션 이력\n${messages.slice(-5).join('\n') || '응답 본문 미확인'}`
    };
    if (fixture.rewriteVariant) value.title = `${value.title.slice(0, 180)} · 작업 기록`;
    if (scenario === 'rewrite-six-lines') value.description = Array.from({ length: 6 }, () => '형식 오류').join('\n');
    if (scenario === 'rewrite-blank') value.title = '   ';
    text = JSON.stringify(value);
  }
  if (scenario === 'bad-html') text = text.replace("document.querySelector('#result').hidden=false", "throw new Error('broken button')");
  if (scenario === 'missing-section') text = '# 내용 누락';
  if (scenario === 'symlink') fs.symlinkSync(fixture.target, job.file);
  else fs.writeFileSync(job.file, text);
  result = { status: 'done', result: { file: job.file } };
}
process.stdout.write(JSON.stringify({ event: 'progress', stage }) + '\n');
fs.writeFileSync(output, JSON.stringify(result));
