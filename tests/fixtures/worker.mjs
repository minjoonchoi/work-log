import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [output, stage] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.HARNESS_FIXTURE_FILE, 'utf8'));
const { job, round = 0, scenario = 'success' } = fixture;
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (fixture.stallStage === stage && (fixture.epoch || 0) === 0)
  await new Promise(resolve => setTimeout(resolve, fixture.stallMs || 15000));
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
  if (scenario === 'tamper-input-snapshot') {
    const references = JSON.parse(prompt.match(/\n자료 파일 참조[^:]+: ([^\n]+)\n/)[1]);
    fs.chmodSync(references[0].path, 0o600); fs.appendFileSync(references[0].path, '\nworker changed read-only source');
  }
  if (scenario === 'tamper') fs.appendFileSync(job.file, '\n검토 중 변경');
  if (scenario === 'always-revise' || (scenario === 'revise-once' && round === 0)) result = { status: 'revise', result: { issues: [{ rule: job.rules[0], detail: '거절 상태의 수용 기준을 추가하세요.' }] } };
  else {
    const promptedRules = scenario === 'prompted-rules' ? Object.keys(JSON.parse(prompt.match(/\n규칙: ([^\n]+)\n/)[1])) : job.rules;
    const evaluatedRules = scenario === 'missing-evidence' ? [] : scenario === 'omit-common-rule' ? promptedRules.filter(rule => rule !== 'SCOPE-001')
      : scenario === 'omit-boundary-rule' ? promptedRules.filter(rule => rule !== 'JOB-BOUNDARY-001') : promptedRules;
    result = { status: 'done', result: { evaluations: evaluatedRules.map(rule => ({ rule, passed: true, evidence: `고정된 ${job.file}에서 ${rule} 조건을 확인했습니다.` })) } };
  }
} else {
  let text = job.kind === 'html' ? `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>검증용 목업</title></head><body><h1>권한 신청</h1><button id="save">저장</button><p id="result" hidden>저장되었습니다</p><script>document.querySelector('#save').onclick=()=>{document.querySelector('#result').hidden=false}</script></body></html>`
    : `# ${job.label}\n\n${job.requiredSections.map(s => `## ${s}\nREQ-001: 사용자 요청에 따른 ${s}입니다.\n`).join('\n')}\n${round > 0 ? '거절 상태의 수용 기준: 거절 결과를 표시합니다.' : ''}\n`;
  if (fixture.copyInputSnapshot && fixture.direct && prompt.includes("고정된 자료 본문")) {
    const references = JSON.parse(prompt.match(/\n고정된 자료 본문[^:]+: ([^\n]+)\n/)[1]);
    text += `\n# 제공된 원문\n${references.map(reference => reference.content).join('\n')}`;
  }
  if (fixture.copyInputSnapshot && !fixture.direct) {
    const references = JSON.parse(prompt.match(/\n자료 파일 참조[^:]+: ([^\n]+)\n/)[1]);
    text += `\n# 제공된 원문\n${references.map(reference => fs.readFileSync(reference.path, 'utf8')).join('\n')}`;
  }
  if (job.kind === 'scenario_plan') {
    const categories = fixture.input.categories.filter(c => !(scenario === 'scenario-missing-recovery-once' && round === 0 && c === 'recovery'));
    text = JSON.stringify({ scenarios: categories.map((category, i) => ({
      id: `SCN-${i + 1}`, title: `${category} 시나리오`, category,
      requirement_ids: scenario === 'scenario-unknown-requirement' ? ['invented'] : fixture.input.requirements.map(r => r.id),
      preconditions: ['격리된 테스트 데이터와 서비스가 준비됨'],
      steps: [{ action: '정해진 시각의 입력과 출력을 제출함', expected: '원본 시각과 세션 연결이 보존됨' }]
    })) });
  }
  if (job.kind === 'code_bundle') {
    const sources = new Map(fixture.input.source_files.map(file => [file.path, file.content]));
    let files = fixture.input.allowed_paths.map(file => ({ path: file,
      content: file.endsWith('.json') ? JSON.stringify({ implemented: true })
        : `${sources.get(file) || 'export const implemented = true;'}\n// requested change\n` }));
    if (scenario === 'code-invalid-syntax-once' && round === 0) files[0].content = 'export const = ;';
    if (scenario === 'code-disallowed-path') files[0].path = 'unrequested/extra.mjs';
    if (scenario === 'code-no-change') files = fixture.input.source_files.filter(file => fixture.input.allowed_paths.includes(file.path));
    if (scenario === 'code-delete') files[0].operation = 'delete';
    if (scenario === 'code-duplicate') files.push(files[0]);
    if (scenario === 'code-extra-file') fs.writeFileSync('unrequested.txt', 'outside bundle');
    text = JSON.stringify({ summary: '요청된 범위의 소스를 작성했습니다. 프로젝트 실행 검사는 수행하지 않았습니다.', files });
  }
  if (job.kind === 'session_summary') {
    text = `${fixture.input.title}\n${fixture.input.events.filter(e => e.text).slice(-5).map(e => `- ${e.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n') || '- 응답 본문 미확인'}`;
    if (scenario === 'summary-too-long') text += '\n추가 설명\n추가 설명\n추가 설명\n추가 설명\n추가 설명\n추가 설명';
    if (scenario === 'summary-plain') text = `${fixture.input.title}\n검토한 변경 사항을 일반 문장으로 정리했습니다.`;
  }
  if (job.kind === 'work_report') {
    const values = fixture.input.sessions || fixture.input.parts, type = fixture.input.stage === 'consolidate' ? 'part' : 'session';
    const headings = ['업무 개요', '수행 내용', '미완료·확인 사항'];
    const value = { title: '선택 기간 업무 요약',
      body: headings.map((heading, index) => `## ${heading}\n${index === 0 ? `- ${fixture.input.dates.join(', ')} (${fixture.input.timezone})의 업무 기록` : '- 제공된 기록의 행동과 결과를 구분합니다. 미확인 성과와 지표는 미확인으로 유지합니다.'}`).join('\n\n'),
      source_refs: values.map(value => `${type}:${value.id}`) };
    if (scenario === 'report-invalid') value.body = '형식이 없는 본문';
    if (scenario === 'report-missing-source') value.source_refs.shift();
    if (scenario === 'report-unknown-source') value.source_refs[0] = 'session:invented-session';
    if (scenario === 'report-duplicate-source') value.source_refs.push(value.source_refs[0]);
    if (scenario === 'report-body-source-leak') value.body += `\n- [${type}:${values[0].id}]`;
    if (scenario === 'report-body-evidence-section') value.body += '\n\n### 근거 세션\n- 내부 세션 목록';
    text = JSON.stringify(value);
  }
  if (job.kind === 'task_type_draft') {
    const input = fixture.input, template = input.templates.find(value => value.id === 'document.share.create') || input.templates[0];
    const names = new Set([...input.existing_tasks, ...input.templates].map(value => value.label.normalize('NFC').trim().toLowerCase()));
    let number = 1, label = '사용자 업무 초안';
    while (names.has(label.normalize('NFC').toLowerCase())) label = `사용자 업무 초안 ${++number}`;
    const boundary = template.boundary;
    const value = { template_id: template.id, label, description: input.request.slice(0, 1900).trim(), routing_terms: [`사용자 업무 초안 ${number}`],
      instruction: `# ${label}\n\n## 목적\n${boundary.owns}\n${input.request.slice(0, 1500)}\n\n## 입력\n${boundary.inputs.map(item => `- ${item}`).join('\n')}\n\n## 범위\n- 산출물: ${boundary.deliverable}\n${boundary.excludes.map(item => `- 제외: ${item}`).join('\n')}\n\n## 수행 절차\n1. 제공된 입력과 담당 범위를 확인한다.\n2. 요청 범위에 맞는 산출물만 작성하고 제외 업무를 수행하지 않는다.\n3. 근거와 완료 기준을 확인하고 불확실한 사항을 표시한다.\n\n## 완료 기준\n${boundary.acceptance.map(item => `- ${item}`).join('\n')}` };
    if (scenario === 'draft-invalid') value.instruction = '구조화되지 않은 지시문';
    if (scenario === 'draft-unknown-template') value.template_id = 'unknown.template';
    if (scenario === 'draft-duplicate-name') value.label = input.existing_tasks[0]?.label || template.label;
    if (scenario === 'draft-duplicate-terms') value.routing_terms = ['중복 키워드', ' 중복 키워드 '];
    if (scenario === 'draft-empty-section') value.instruction = value.instruction.replace(/## 수행 절차\n[\s\S]*?(?=\n\n## 완료 기준)/, '## 수행 절차\n');
    if (scenario === 'draft-missing-boundary') value.instruction = value.instruction.replace(`- 제외: ${boundary.excludes[0]}`, '');
    if (scenario === 'draft-extra-field') value.backend = 'claude';
    text = JSON.stringify(value);
  }
  if (job.kind === 'result_summary') {
    const outputs = fixture.input.sessions.flatMap(s => s.events).filter(e => e.kind === 'output' && e.text?.trim());
    let summary = outputs.length ? `작업 이력에 기록된 결과: ${outputs.map(e => e.text.trim().replace(/\s+/g, ' ')).join(' ').slice(0, 1000)} 확인 범위는 제공된 원본 기록에 한정됩니다.`
      : '이 업무의 요청을 기록했으나 확인된 응답 결과가 없어 실제 작업 결과는 미확인입니다.';
    if (scenario === 'result-summary-invalid') summary += '\n\n두 번째 문단';
    if (scenario === 'result-summary-list') summary = '- 결과 목록';
    text = JSON.stringify({ text: summary });
  }
  if (job.kind === 'text_rewrite') {
    const events = fixture.input.sessions.flatMap(s => s.events), messages = events.filter(e => e.text?.trim()).map(e => e.text.trim().replace(/\s+/g, ' ').slice(0, 400));
    const firstInput = events.find(event => event.kind === 'input' && event.text?.trim())?.text.trim().replace(/\s+/g, ' ');
    const brief = firstInput && [...firstInput].length <= 120 && [...new Intl.Segmenter('ko', { granularity: 'sentence' }).segment(firstInput)].length === 1
      ? firstInput : '제공된 업무 요청의 핵심 요구를 정리합니다.';
    const value = {
      title: (messages[0] || '작업 세션').slice(0, 200),
      description: fixture.input.format === 'session-summary' ? messages.slice(-5).map(message => `- ${message}`).join('\n') || '- 응답 본문 미확인'
        : job.metadata_format === 'work-item-jira-v2'
          ? `h2. 배경\n* 현재 상황: ${fixture.input.sessions.length}개 세션의 사용자 요청을 정리합니다.\n* 문제점: 구체적인 문제 원인은 미확인입니다.\n* 작업 필요성: 요청한 내용을 확인합니다.\n\nh2. 목표\n${brief}\n\nh2. 요구사항\n* ${brief}\n\nh2. 작업 범위\n* 제공된 사용자 요청 범위에 한정합니다.\n\nh2. 참고사항\n* ${events.some(event => event.kind === 'output' && event.text) ? '상세 결과는 결과 요약 댓글에서 확인합니다.' : '미완료: 확인된 응답이 없어 결과 미확인입니다.'}`
        : job.metadata_format === 'work-item-jira-v1'
          ? `h2. 배경\n${fixture.input.sessions.length}개 세션 이력에 근거합니다.\n\n* 현재 상황: ${messages[0] || '미확인'}\n* 문제점: 구체적인 문제 원인은 미확인입니다.\n* 작업 필요성: 요청한 내용을 확인합니다.\n\nh2. 목표\n${messages[0] || '목표 미확인'}\n\nh2. 요구사항\n* ${messages[0] || '요구사항 미확인'}\n\nh2. 작업 범위\n${messages.slice(-5).map(message => `* ${message}`).join('\n') || '* 요청 범위 미확인'}\n\nh2. 참고사항\n* ${events.some(event => event.kind === 'output' && event.text) ? '수집된 응답을 확인했습니다. 실제 완료 여부는 원문 기준으로 확인해야 합니다.' : '미완료: 확인된 응답이 없어 결과 미확인입니다.'}`
          : `## 작업 배경\n- ${fixture.input.sessions.length}개 세션 이력\n\n## 목적\n- ${messages[0] || '목적 미확인'}\n\n## 범위\n${messages.slice(-5).map(message => `- ${message}`).join('\n') || '- 요청 범위 미확인'}\n\n## 결과\n- ${events.some(event => event.kind === 'output' && event.text) ? '수집된 응답을 확인했습니다. 실제 완료 여부는 원문 기준으로 확인해야 합니다.' : '미완료: 확인된 응답이 없어 결과 미확인입니다.'}`
    };
    if (fixture.rewriteVariant) value.title = `${value.title.slice(0, 180)} · 작업 기록`;
    if (scenario === 'rewrite-six-lines') value.description = Array.from({ length: 6 }, () => '형식 오류').join('\n');
    if (scenario === 'rewrite-empty-bullet') value.description = '- ';
    if (scenario === 'rewrite-summary-plain') value.description = '검토한 변경 사항을 일반 문장으로 정리했습니다.';
    if (scenario === 'rewrite-legacy-paragraph') value.description = '버전 1.2.3과 비율 3.14를 확인했습니다. 자료는 https://example.test/docs/v1.2?rate=3.14 입니다. Dr. Smith reviewed the API. 요구사항을 정리했습니다. 화면 흐름을 확인했습니다. <img src=x onerror=alert(1)>를 기록했습니다. 다음 검토가 남아 있습니다.';
    if (scenario === 'rewrite-blank') value.title = '   ';
    if (['rewrite-empty-section', 'rewrite-empty-jira-section'].includes(scenario)) value.description = value.description.replace(/(h2\. 참고사항|## 결과)[\s\S]*$/, '$1');
    if (scenario === 'rewrite-legacy-markdown') value.description = '## 작업 배경\n배경\n\n## 목적\n목적\n\n## 범위\n범위\n\n## 결과\n미확인';
    if (scenario === 'rewrite-placeholder') value.description = value.description.replace(/h2\. 요구사항\n[^\n]+/, 'h2. 요구사항\n* {현재 확인된 요구사항}');
    if (scenario === 'rewrite-long-sentence') value.description = value.description.replace(/h2\. 요구사항\n[^\n]+/, `h2. 요구사항\n* ${'가'.repeat(121)}`);
    if (scenario === 'rewrite-many-sentences') value.description = value.description.replace(/h2\. 요구사항\n[^\n]+/, 'h2. 요구사항\n* 첫째 조건.\n* 둘째 조건.\n* 셋째 조건.\n* 넷째 조건.');
    if (scenario === 'rewrite-compound-sentences') value.description = value.description.replace(/h2\. 요구사항\n[^\n]+/, 'h2. 요구사항\n* 첫째 조건입니다. 둘째 조건입니다.');
    text = JSON.stringify(value);
  }
  if (scenario === 'bad-html') text = text.replace("document.querySelector('#result').hidden=false", "throw new Error('broken button')");
  if (scenario === 'missing-section') text = '# 내용 누락';
  if (fixture.direct) result = { status: 'done', result: { content: text } };
  else {
  if (scenario === 'symlink') fs.symlinkSync(fixture.target, job.file);
  else fs.writeFileSync(job.file, text);
  result = { status: 'done', result: { file: job.file } };
  }
}
process.stdout.write(JSON.stringify({ event: 'progress', stage }) + '\n');
fs.writeFileSync(output, JSON.stringify(result));
