import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assert } from './shared.mjs';
import { validateSchema } from './schema.mjs';
import { parseSessionSummary } from './session-summary.mjs';

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/text-rewrite.schema.json'), 'utf8'));
function validateJiraDescription(description) {
  const source = description.replace(/\r\n?/g, '\n').trim();
  const expected = ['배경', '목표', '요구사항', '작업 범위', '참고사항'];
  const headings = [...source.matchAll(/^[ \t]*(?:h[1-6]\.|#{1,6})[^\n]*$/gm)];
  assert(headings.length === expected.length && headings[0].index === 0
    && headings.every((heading, index) => heading[0] === `h2. ${expected[index]}`),
  '업무 설명은 배경·목표·요구사항·작업 범위·참고사항 순서의 정확한 Jira 제목(h2.) 다섯 구역이어야 합니다.');
  const bodies = headings.map((heading, index) => source.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim());
  assert(bodies.every(Boolean), '업무 설명의 각 구역에 본문이 필요합니다. 확인되지 않은 내용은 미확인으로 표시하세요.');
  assert(!/^[ \t]*[-+•]\s/mu.test(source) && !/^\*\s*$/mu.test(source),
    'Jira 업무 설명의 목록은 내용이 있는 "* " 항목이어야 합니다. Markdown 목록으로 바꾸지 마세요.');
  for (const index of [2, 3, 4]) assert(/^\* \S/mu.test(bodies[index]), `${expected[index]} 구역에는 "* "로 시작하는 항목이 필요합니다.`);
  assert(bodies[1].split('\n').some(line => line.trim() && !/^\s*\*/u.test(line)), '목표 구역에는 목표를 설명하는 본문 문장이 필요합니다.');
  let prior = -1;
  for (const label of ['현재 상황', '문제점', '작업 필요성']) {
    const entries = [...bodies[0].matchAll(new RegExp(`^\\* ${label}:([^\\n]*)$`, 'gm'))];
    assert(entries.length === 1 && entries[0][1].trim() && entries[0].index > prior,
      '배경에는 현재 상황·문제점·작업 필요성을 이 순서의 "* 항목: 내용"으로 작성하세요.');
    prior = entries[0].index;
  }
  const placeholder = line => {
    const value = line.trim().replace(/^\*\s+/u, '').replace(/^(?:현재 상황|문제점|작업 필요성):\s*/u, '').trim();
    if (!/^\{[^{}\n]*\}$/u.test(value)) return false;
    // A standalone template hint is unfilled; actual JSON objects are source content.
    try { JSON.parse(value); return false; } catch { return true; }
  };
  assert(!bodies.some(body => body.split('\n').some(placeholder)), '템플릿의 중괄호 안내문을 실제 이력 또는 미확인으로 바꾸세요.');
}

export function parseTextRewrite(text, format, { metadataFormat, requireJiraDescription = false,
  requireStructuredDescription = false, requireBulletSummary = false } = {}) {
  const value = validateSchema(schema, JSON.parse(text), '재작성 결과');
  assert(value.title.trim() && value.description.trim(), '제목과 설명은 비어 있을 수 없습니다.');
  assert(['work-item-metadata', 'session-summary'].includes(format), '지원하지 않는 재작성 형식입니다.');
  if (format === 'session-summary') {
    // Do not trim away blank/extra lines before checking the requested format.
    const lines = value.description.split('\n');
    assert(lines.length <= 5 && lines.every(line => line.trim()), '세션 설명은 빈 줄 없이 최대 5줄이어야 합니다.');
    return parseSessionSummary(`${value.title}\n${value.description}`, { requireBullets: requireBulletSummary });
  }
  if (requireJiraDescription || metadataFormat === 'work-item-jira-v1') validateJiraDescription(value.description);
  else if (requireStructuredDescription || metadataFormat === 'work-item-v1') {
    const source = value.description.replace(/\r\n?/g, '\n').trim();
    const headings = [...source.matchAll(/^## ([^\n]+)$/gm)];
    const expected = ['작업 배경', '목적', '범위', '결과'];
    assert(headings.length === expected.length && headings[0].index === 0
      && headings.every((heading, index) => heading[1] === expected[index]),
    '업무 설명은 작업 배경·목적·범위·결과 순서의 Markdown 제목(##) 네 구역이어야 합니다.');
    assert(headings.every((heading, index) => source.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim()),
      '업무 설명의 각 구역에 본문이 필요합니다. 모르는 결과는 미확인 또는 미완료로 표시하세요.');
  }
  return { title: value.title.trim(), description: value.description.trim() };
}
