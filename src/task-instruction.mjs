// Defaults are derived from the reviewed catalog. Local instructions remain
// untouched; immutable task boundaries are also enforced separately at runtime.
export function defaultTaskInstruction(job) {
  const { boundary } = job;
  // The catalog's generated persona suffix repeats the structured boundary.
  // Preserve its role and task-specific procedure without displaying it twice.
  const persona = job.persona.split(' 담당 범위:')[0].trim();
  const genericPersona = `${boundary.owns} 담당하는 작성자.`;
  const perspective = persona && persona !== genericPersona ? `${persona}\n\n` : '';
  const bullets = values => values.map(value => `- ${value}`).join('\n');
  return `# ${job.label}

## 목적
${boundary.owns}

## 입력
${bullets(boundary.inputs)}

## 범위
- 전달할 산출물: \`${boundary.deliverable}\`
${bullets(boundary.excludes.map(value => `제외: ${value}`))}

## 수행 절차
${perspective}1. 제공된 입력과 기준 버전을 확인하고 사실·가정·미정 사항을 구분한다.
2. 현재 단계의 지시에 따라 담당 산출물만 작성·검토·수정한다. 제외된 인접 업무나 하위 에이전트를 임의로 실행하지 않는다.
3. 등록 규칙과 완료 기준을 대조하고, 실제 수행한 검증과 미실행 항목을 구분해 기록한다.
4. 필요한 근거가 부족해 완료 기준을 충족할 수 없으면 \`blocked\`와 필요한 입력을 반환한다. 결과는 지정된 응답 스키마를 따른다.

## 완료 기준
${bullets(boundary.acceptance)}${job.requiredSections.length ? `\n- 산출물 필수 구성: ${job.requiredSections.join(', ')}` : ''}
- 요청하지 않은 범위 확장과 근거 없는 완료 선언이 없다.
`;
}
