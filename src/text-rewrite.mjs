import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assert } from './shared.mjs';
import { validateSchema } from './schema.mjs';
import { parseSessionSummary } from './session-summary.mjs';

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/text-rewrite.schema.json'), 'utf8'));
export function parseTextRewrite(text, format, { requireStructuredDescription = false, requireBulletSummary = false } = {}) {
  const value = validateSchema(schema, JSON.parse(text), '재작성 결과');
  assert(value.title.trim() && value.description.trim(), '제목과 설명은 비어 있을 수 없습니다.');
  assert(['work-item-metadata', 'session-summary'].includes(format), '지원하지 않는 재작성 형식입니다.');
  if (format === 'session-summary') {
    // Do not trim away blank/extra lines before checking the requested format.
    const lines = value.description.split('\n');
    assert(lines.length <= 5 && lines.every(line => line.trim()), '세션 설명은 빈 줄 없이 최대 5줄이어야 합니다.');
    return parseSessionSummary(`${value.title}\n${value.description}`, { requireBullets: requireBulletSummary });
  }
  if (requireStructuredDescription) {
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
