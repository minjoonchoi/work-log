// Only documented error-message fields are retained, never the complete response.
export async function atlassianFailure(response, { token, method = 'GET', apiPath = '' } = {}) {
  let payload;
  const reader = response.body?.getReader();
  let timer;
  if (reader) {
    try {
      payload = await Promise.race([
        (async () => {
          const chunks = []; let size = 0;
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > 65536) throw new Error('oversized'); chunks.push(Buffer.from(value));
          }
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 2000); })
      ]);
    } catch { /* HTML, oversized, interrupted or missing bodies have no verified detail. */ }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  }
  const clean = value => {
    let text = value;
    if (token) text = text.split(token).join('[숨김]');
    return text.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [숨김]')
      .replace(/((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|api[_-]?key)\s*["']?\s*[:=]\s*)["']?[^\s,;"'}]+/gi, '$1[숨김]')
      .replace(/https?:\/\/[^\s<>"']+/gi, '[URL 생략]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 400);
  };
  const details = [];
  const add = (value, field) => {
    if (typeof value !== 'string' || !value.trim() || details.length >= 4) return;
    const message = clean(value); if (message) details.push(field ? `${clean(field).slice(0, 80)}: ${message}` : message);
  };
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (Array.isArray(payload.errorMessages)) for (const message of payload.errorMessages) add(message);
    if (payload.errors && typeof payload.errors === 'object' && !Array.isArray(payload.errors)) {
      for (const [field, value] of Object.entries(payload.errors)) {
        if (/token|secret|authorization|password|api.?key/i.test(field)) continue;
        add(value, field);
      }
    }
    if (!details.length) add(payload.message);
  }
  const worklog = /\/worklog(?:\/\d+)?(?:\?|$)/.test(apiPath);
  const operation = worklog ? (method === 'GET' ? 'Jira 업무 로그 조회' : 'Jira 업무 로그 동기화') : 'Atlassian 요청';
  const action = { 400: '요청 값과 해당 Jira 설정을 확인한 뒤 다시 시도하세요.',
    401: 'Atlassian 연결 설정에서 다시 로그인하세요.', 403: '사이트·프로젝트와 해당 작업의 권한을 확인하세요.',
    404: '대상 항목이 존재하고 접근 가능한지 확인하세요.', 429: '호출 한도에 도달했습니다. 잠시 후 다시 시도하세요.' }[response.status]
    || (response.status >= 500 ? '서버 오류입니다. 전송 결과가 불확실할 수 있으므로 반영 여부를 먼저 확인하세요.' : '해당 작업의 설정과 요청 내용을 확인하세요.');
  return `${operation} 실패 (HTTP ${response.status}). ${details.length ? `서버 응답: ${[...new Set(details)].join(' · ')}` : '서버가 구체적인 오류 원인을 제공하지 않았거나 응답을 읽을 수 없습니다.'} ${action}`;
}
