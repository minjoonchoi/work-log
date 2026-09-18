import { assert } from './shared.mjs';

export function parseSessionSummary(text) {
  const value = text.trim().replaceAll('\r\n', '\n'), lines = value.split('\n');
  assert(lines.length >= 2 && lines.length <= 6 && lines.every(line => line.trim() && !/^(#{1,6}\s|[-*]\s|```)/.test(line)), '세션 요약은 제목 1줄과 설명 1~5줄의 일반 텍스트여야 합니다.');
  assert(lines[0].length <= 200 && value.length <= 5000, '세션 요약이 허용 길이를 초과했습니다.');
  return { title: lines[0], description: lines.slice(1).join('\n'), text: value };
}
