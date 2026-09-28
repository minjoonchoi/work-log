import { assert } from './shared.mjs';

export function parseSessionSummary(text, { requireBullets = false } = {}) {
  const value = text.trim().replaceAll('\r\n', '\n'), lines = value.split('\n');
  // Retain old plain-text summaries while accepting the new one-bullet-per-line output.
  assert(lines.length >= 2 && lines.length <= 6 && !/^\s*[-*•]\s/.test(lines[0])
    && lines.every(line => line.trim() && !/^\s*(#{1,6}\s|```)/.test(line))
    && lines.slice(1).every(line => line.replace(/^\s*[-*•]\s*/, '').trim()),
  '세션 요약은 제목 1줄과 내용이 있는 설명 1~5줄이어야 합니다. 각 bullet 항목은 별도 줄에 작성하세요.');
  assert(!requireBullets || lines.slice(1).every(line => /^- \S/u.test(line)),
    '새 세션 요약의 설명은 각 줄이 \"- \"로 시작하는 1~5개 bullet 항목이어야 합니다.');
  assert(lines[0].length <= 200 && value.length <= 5000, '세션 요약이 허용 길이를 초과했습니다.');
  return { title: lines[0], description: lines.slice(1).join('\n'), text: value };
}

// Presentation-only cleanup. Never truncate, invent content, or repair invalid JSON.
export function normalizeSummaryArtifact(content, job, input) {
  if (job.summary_format !== 'session-bullets-v1') return content;
  const clean = text => text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  const body = lines => lines.map(line => line.replace(/^[-*•]\s+/, '- '));
  if (job.kind === 'session_summary') {
    const [title, ...lines] = clean(content);
    return [title, ...body(lines)].join('\n');
  }
  if (job.kind === 'text_rewrite' && input.format === 'session-summary') {
    try {
      const value = JSON.parse(content);
      if (typeof value.title !== 'string' || typeof value.description !== 'string') return content;
      return JSON.stringify({ ...value, title: value.title.trim(), description: body(clean(value.description)).join('\n') });
    } catch { return content; }
  }
  return content;
}
