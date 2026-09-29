import { assert } from './shared.mjs';

// Decode fields required by SQLite/UI consumers. Style and content are for the
// user to judge; do not add model retries or quality gates here.
function object(text) {
  const value = JSON.parse(text);
  assert(value && typeof value === 'object' && !Array.isArray(value), '저장할 응답은 JSON 객체여야 합니다.');
  return value;
}
function field(value, key) {
  assert(typeof value[key] === 'string' && value[key].trim(), `저장할 응답에 ${key} 문자열이 필요합니다.`);
  return value[key];
}
export function parseTextRewrite(text, format) {
  const value = object(text);
  const title = field(value, 'title'), description = field(value, 'description');
  return { title, description, ...(format === 'session-summary' ? { text: `${title}\n${description}` } : {}) };
}
export function parseSessionSummary(text) {
  assert(typeof text === 'string' && text.trim(), '저장할 요약 응답이 없습니다.');
  const lines = text.trim().replace(/\r\n?/g, '\n').split('\n');
  return { title: lines[0], description: lines.slice(1).join('\n'), text: text.trim() };
}
export function parseResultSummary(text) {
  return { text: field(object(text), 'text') };
}
export function parseWorkReport(text, input) {
  const value = object(text), consolidated = input.stage === 'consolidate';
  // Associations are owned by the frozen request, never inferred from model claims.
  const source_refs = (consolidated ? input.parts : input.sessions).map(source => `${consolidated ? 'part' : 'session'}:${source.id}`);
  return { title: field(value, 'title'), body: field(value, 'body'), source_refs };
}
