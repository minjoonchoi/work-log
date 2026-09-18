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
    return `<div class="writing-status" data-state="${esc(request.state)}" role="status"><div class="writing-status-line"><span class="writing-state">${esc(label)}</span>
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
      <h2 class="work-item-title">${esc(data.item.title)}</h2><p class="work-item-description ${data.item.description ? '' : 'is-empty'}">${esc(data.item.description || '업무 설명을 추가해 보세요.')}</p>
      ${statusHTML(data.metadata_rewrite)}</section>`;
  }
  function sessionHTML(session) {
    const summary = session.summary, pending = busy(session.rewrite), lines = summary?.text?.split('\n') || [];
    return `<section class="session-summary" aria-labelledby="summary-heading-${esc(session.id)}"><div class="writing-header">
      <h4 id="summary-heading-${esc(session.id)}">세션 요약${!session.closed ? '<span class="summary-open">진행 중</span>' : ''}</h4>
      <div class="writing-actions" role="group" aria-label="세션 요약 작업"><button id="rewrite-summary-${esc(session.id)}" class="writing-action writing-action-accent" data-rewrite-summary="${esc(session.id)}" aria-label="요약 다시 작성" title="현재까지의 대화를 요약합니다. Jira 업무 로그는 세션 종료 후 동기화됩니다." ${pending ? 'disabled' : ''} aria-busy="${pending}">${icon('rewrite')}<span>${pending ? '작성 중' : '다시 작성'}</span></button></div>
      </div>${summary?.text ? `<pre class="summary-text"><strong>${esc(lines[0])}</strong>\n${esc(lines.slice(1).join('\n'))}</pre>` : '<p class="summary-empty">아직 작성된 요약이 없습니다.</p>'}
      ${summary?.text && !summary.current ? '<p class="summary-notice">요약 이후 새 대화가 있습니다.</p>' : ''}
      ${statusHTML(session.rewrite)}${!session.rewrite && summary?.message ? `<p class="writing-message" role="status">${esc(summary.message)}</p>` : ''}</section>`;
  }
  function bindDetail(data) {
    document.querySelectorAll('#rewrite-metadata,[data-rewrite-summary]').forEach(button => {
      let operation;
      button.onclick = async () => {
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
  return { metadataHTML, sessionHTML, bindDetail };
}
