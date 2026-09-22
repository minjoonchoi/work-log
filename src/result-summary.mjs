import { assert } from './shared.mjs';

// This checks structure only. The frozen session input supplies the model's factual evidence.
export function parseResultSummary(source) {
  const value = JSON.parse(source);
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof value.text === 'string',
  '완료 결과는 text만 포함한 JSON이어야 합니다.');
  const text = value.text.trim();
  assert(text.length > 0 && value.text.length <= 1500 && !/[\r\n\u2028\u2029]/u.test(value.text)
    && !/^(?:#{1,6}\s|h[1-6]\.\s|[-*•]\s|\d+[.)]\s|```|~~~|\{(?:code|panel|quote)\})/u.test(text),
  '완료 결과는 제목·목록·줄바꿈 없는 1~1500자 한 문단이어야 합니다.');
  return { text };
}
