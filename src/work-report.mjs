import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assert } from './shared.mjs';
import { validateSchema } from './schema.mjs';

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/work-report.schema.json'), 'utf8'));
export function parseWorkReport(text, input) {
  const value = validateSchema(schema, JSON.parse(text), '업무 요약');
  assert(value.title.trim() && value.body.trim(), '업무 요약 제목과 본문이 필요합니다.');
  const body = value.body.replace(/\r\n?/g, '\n').trim();
  const headings = [...body.matchAll(/^## ([^\n]+)$/gm)], expected = ['업무 개요', '수행 내용', '미완료·확인 사항'];
  assert(headings.length === expected.length && headings[0].index === 0 && headings.every((heading, index) => heading[1] === expected[index]
    && body.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim()),
  `업무 요약은 ${expected.join(' / ')} Markdown 구역과 각 본문이 필요합니다.`);
  assert(!/\[(?:session|part):/i.test(body) && !/^\s*#{1,6}\s+근거\s*세션(?:\s|$)/m.test(body),
    '요약 본문에는 세션·부분 요약 참조나 근거 세션 목록을 넣을 수 없습니다. source_refs에만 기록하세요.');
  assert(!input.compact || body.length <= 12000, '부분 요약은 근거를 유지하며 본문 12000자 이내로 작성해야 합니다.');
  const type = input.stage === 'consolidate' ? 'part' : 'session', values = input.stage === 'consolidate' ? input.parts : input.sessions;
  const sources = new Set(values.map(source => source.id));
  const references = new Set(value.source_refs);
  assert(sources.size === values.length && references.size === sources.size
    && [...sources].every(source => references.has(`${type}:${source}`)), '업무 요약의 근거 참조는 선택한 모든 입력 세션 또는 부분 요약과 정확히 일치해야 합니다.');
  return { title: value.title.trim(), body, source_refs: value.source_refs };
}
