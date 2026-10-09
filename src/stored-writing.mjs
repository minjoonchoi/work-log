import { assert } from './shared.mjs';

// Decode fields required by SQLite/UI consumers. Style and content are for the
// user to judge; do not add model retries or quality gates here.
function object(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
function field(value, key) {
  assert(typeof value[key] === 'string' && value[key].trim(), `저장할 응답에 ${key} 문자열이 필요합니다.`);
  return value[key];
}
export function parseTextRewrite(text, format) {
  const value = object(text);
  const parsed = value && typeof value.title === 'string' && typeof value.description === 'string' ? value : parseSessionSummary(text);
  const title = field(parsed, 'title'), description = parsed.description;
  return { title, description, ...(format === 'session-summary' ? { text: `${title}\n${description}` } : {}) };
}
export function parseSessionSummary(text) {
  assert(typeof text === 'string' && text.trim(), '저장할 요약 응답이 없습니다.');
  const lines = text.trim().replace(/\r\n?/g, '\n').split('\n');
  return { title: lines[0], description: lines.slice(1).join('\n'), text: text.trim() };
}
export function parseResultSummary(text) {
  const value = object(text);
  if (value && typeof value.text === 'string') return { text: field(value, 'text') };
  assert(typeof text === 'string' && text.trim(), '저장할 결과 요약 응답이 없습니다.');
  return { text };
}
export function parseWorkReport(text, input) {
  const value = object(text), consolidated = input.stage === 'consolidate';
  // Associations are owned by the frozen request, never inferred from model claims.
  const source_refs = (consolidated ? input.parts : input.sessions).map(source => `${consolidated ? 'part' : 'session'}:${source.id}`);
  if (value && typeof value.title === 'string' && typeof value.body === 'string') return { title: field(value, 'title'), body: field(value, 'body'), source_refs };
  const parsed = parseSessionSummary(text);
  return { title: parsed.title, body: parsed.description, source_refs };
}
