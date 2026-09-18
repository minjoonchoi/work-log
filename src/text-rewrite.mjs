import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assert } from './shared.mjs';
import { validateSchema } from './schema.mjs';
import { parseSessionSummary } from './session-summary.mjs';

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/text-rewrite.schema.json'), 'utf8'));
export function parseTextRewrite(text, format) {
  const value = validateSchema(schema, JSON.parse(text), '재작성 결과');
  assert(value.title.trim() && value.description.trim(), '제목과 설명은 비어 있을 수 없습니다.');
  assert(['work-item-metadata', 'session-summary'].includes(format), '지원하지 않는 재작성 형식입니다.');
  if (format === 'session-summary') {
    // Do not trim away blank/extra lines before checking the requested format.
    const lines = value.description.split('\n');
    assert(lines.length <= 5 && lines.every(line => line.trim()), '세션 설명은 빈 줄 없이 최대 5줄이어야 합니다.');
    return parseSessionSummary(`${value.title}\n${value.description}`);
  }
  return { title: value.title.trim(), description: value.description.trim() };
}
