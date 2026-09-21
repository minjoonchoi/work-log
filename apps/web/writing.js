import { descriptionHTML } from './description.js';

// Presentation only: legacy paragraph summaries keep their original stored/Jira text.
function summaryItems(lines) {
  const items = lines.flatMap(line => {
    const value = line.trim();
    if (!value) return [];
    if (/^[-*•]\s+/.test(value)) return [value.replace(/^[-*•]\s+/, '')];
    const parts = []; let start = 0;
    for (const match of value.matchAll(/([.!?。！？]+["'”’\)\]]*)\s+(?=\S)/gu)) {
      const end = match.index + match[1].length, before = value.slice(0, end), after = value.slice(match.index + match[0].length);
      // Whitespace is required, so decimal/version numbers and URL dots stay intact.
      // Keep common abbreviations, initials and spaced numeric dates in one sentence.
      if (/(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|(?:[A-Z]\.)*[A-Z])\.$/u.test(before)
        || (/\d\.$/.test(before) && /^\d/.test(after))) continue;
      parts.push(value.slice(start, end)); start = match.index + match[0].length;
    }
    parts.push(value.slice(start)); return parts;
  });
  // Keep every word when old paragraphs contain more than five sentences.
  return items.length > 5 ? [...items.slice(0, 4), items.slice(4).join(' ')] : items;
}

export function writingUI({ api, esc, toast, refresh, absoluteTime }) {
  const busy = request => ['pending', 'running'].includes(request?.state);
  const icons = {
    edit: '<path d="m11.5 4.5 4 4M4 16l3.5-.75L17 5.75a1.77 1.77 0 0 0-2.5-2.5L5 12.75 4 16Z"/>',
    rewrite: '<path d="M16 7a6.5 6.5 0 0 0-11-2L3 7m0-4v4h4M4 13a6.5 6.5 0 0 0 11 2l2-2m0 4v-4h-4"/>'
  };
  const icon = name => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[name]}</svg>`;
  const compactTime = value => new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  function statusHTML(request) {
    if (!request) return '';
    const label = { pending: '작성 대기', running: '작성 중', completed: '작성 완료', failed: '작성 실패', superseded: '새 내용 확인 필요' }[request.state];
    return `<div class="writing-status" data-state="${esc(request.state)}" role="status"><div class="writing-status-line"><span class="writing-state">${request.source === 'automatic' ? '자동 ' : ''}${esc(label)}</span>
      <time datetime="${esc(request.snapshot_at)}" title="${esc(absoluteTime(request.snapshot_at))}" aria-label="${esc(absoluteTime(request.snapshot_at))} 기준">${esc(compactTime(request.snapshot_at))} 기준</time></div>
      ${request.message ? `<p class="writing-message">${esc(request.message)}</p>` : ''}
      ${request.run_id ? `<button class="writing-details" data-run-details="${esc(request.run_id)}">실행 상세</button>` : ''}</div>`;
  }
  function metadataHTML(data) {
    const pending = busy(data.metadata_rewrite);
    return `<section class="metadata-writing" aria-labelledby="metadata-heading"><div class="writing-header">
      <h3 id="metadata-heading">제목·설명</h3><div class="writing-actions" role="group" aria-label="제목·설명 작업">
        <button id="edit-item" class="writing-action" aria-label="제목·설명 편집" title="제목과 설명 직접 편집">${icon('edit')}<span>편집</span></button>
        <button id="rewrite-metadata" class="writing-action writing-action-accent" aria-label="제목·설명 다시 작성" title="현재까지의 세션 이력과 요약으로 다시 작성" ${pending || !data.sessions.length ? 'disabled' : ''} aria-busy="${pending}">${icon('rewrite')}<span>${pending ? '작성 중' : '다시 작성'}</span></button>
      </div></div>
      <h2 class="work-item-title">${esc(data.item.title)}</h2><div class="work-item-description ${data.item.description ? '' : 'is-empty'}">${data.item.description ? descriptionHTML(data.item.description, esc) : '<p>업무 설명을 추가해 보세요.</p>'}</div>
      ${data.item.metadata_protected ? '<p class="help">직접 편집한 제목·설명을 보호하고 있습니다. 자동으로 덮어쓰지 않으며, 원할 때 다시 작성할 수 있습니다.</p>' : ''}
      ${statusHTML(data.metadata_rewrite)}</section>`;
  }
  function sessionHTML(session) {
    const summary = session.summary, lines = summary?.text?.split('\n') || [];
    return `<section class="session-summary" aria-labelledby="summary-heading-${esc(session.id)}"><div class="writing-header">
      <h4 id="summary-heading-${esc(session.id)}">세션 요약${!session.closed ? '<span class="summary-open">진행 중</span>' : ''}</h4>
      </div>${summary?.text ? `<div class="summary-text"><strong>${esc(lines[0])}</strong><ul>${summaryItems(lines.slice(1)).map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : '<p class="summary-empty">아직 작성된 요약이 없습니다.</p>'}
      ${summary?.text && !summary.current ? '<p class="summary-notice">요약 이후 새 대화가 있습니다.</p>' : ''}
      ${statusHTML(session.rewrite)}${!session.rewrite && summary?.message ? `<p class="writing-message" role="status">${esc(summary.message)}</p>` : ''}</section>`;
  }
  function sessionHeadingHTML(session) {
    const title = session.summary?.text?.split('\n')[0]?.trim();
    const pending = busy(session.rewrite) || (!session.rewrite && busy(session.summary));
    const label = pending ? '요약 중' : title ? '재요약' : '요약하기';
    return `<span class="session-summary-heading"><span class="session-summary-title ${title ? '' : 'is-empty'}">${esc(title || '아직 요약되지 않은 세션')}</span>
      <span class="writing-actions" role="group" aria-label="세션 요약 작업"><button id="rewrite-summary-${esc(session.id)}" class="writing-action writing-action-accent" data-rewrite-summary="${esc(session.id)}" aria-label="${label}" title="현재까지의 대화를 요약합니다. Jira 업무 로그는 세션 종료 후 동기화됩니다." ${pending ? 'disabled' : ''} aria-busy="${pending}">${icon('rewrite')}<span>${label}</span></button></span></span>`;
  }
  function bindDetail(data) {
    document.querySelectorAll('#rewrite-metadata,[data-rewrite-summary]').forEach(button => {
      let operation;
      button.onclick = async event => {
        // A summary action must not toggle its surrounding details element.
        event.preventDefault(); event.stopPropagation();
        button.disabled = true;
        operation ||= crypto.randomUUID();
        const session = button.dataset.rewriteSummary;
        try {
          await api(session ? `/sessions/${session}/summary/regenerate` : `/items/${data.item.id}/metadata/regenerate`, {
            method: 'POST', body: { operation_id: operation, ...(!session ? { version: data.item.version } : {}) }
          });
          toast('현재 이력으로 재작성을 요청했습니다.'); await refresh(data.item.id);
        } catch (e) { toast(e.message); button.disabled = false; }
      };
    });
  }
  return { metadataHTML, sessionHTML, sessionHeadingHTML, bindDetail };
}
