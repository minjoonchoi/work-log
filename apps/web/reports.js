import { descriptionHTML } from './description.js';
import { reportBodyMarkdown } from './report-body.js';

export function reportsUI({ api, esc, modal, toast, absoluteTime, navigate, active, showSettings }) {
  const $ = selector => document.querySelector(selector), selectedDates = new Set();
  const labels = { pending: '작성 대기', running: '작성 중', completed: '작성 완료', failed: '작성 실패', cancelled: '작성 취소', interrupted: '작성 중단' };
  let selectedReport = null, requestVersion = 0, listRevision = '', detailRevision = '', detailKey = '', cachedDetail = null, modalRevision = 0;
  window.addEventListener('worklog:modal-open', () => { modalRevision++; });
  const periodLabel = dates => dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates.at(-1)} · 선택 ${dates.length}일`;
  function selectDateHTML(date) {
    return `<label class="report-date-pick" title="${esc(date)} 요약 날짜 선택"><input type="checkbox" data-report-date="${esc(date)}" aria-label="${esc(date)} 요약 날짜 선택"></label>`;
  }
  function updateSelection() {
    const dates = [...selectedDates].sort();
    $('#report-selection-count').textContent = dates.length ? `${dates.length}일 선택됨` : '선택한 날짜 없음';
    $('#clear-report-dates').disabled = !dates.length; $('#create-calendar-report').disabled = !dates.length;
    $('#report-selected-dates').hidden = !dates.length; $('#report-selected-dates p').textContent = dates.join(' · ');
    $('#calendar').querySelectorAll('[data-report-date]').forEach(input => {
      input.checked = selectedDates.has(input.dataset.reportDate);
      input.closest('[data-date]')?.classList.toggle('report-date-selected', input.checked);
    });
  }
  function bindCalendar() {
    $('#calendar').querySelectorAll('[data-report-date]').forEach(input => input.onchange = () => {
      const date = input.dataset.reportDate;
      if (input.checked && selectedDates.size >= 366) { input.checked = false; toast('한 요약에서 최대 366일을 선택할 수 있습니다.'); return; }
      input.checked ? selectedDates.add(date) : selectedDates.delete(date); updateSelection();
    });
    updateSelection();
  }
  const localDate = date => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  function periodDates() {
    const year = Number($('#report-year').value), period = $('#report-period').value, part = Number($('#report-period-part').value);
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new Error('연도는 2000~2200 사이로 입력하세요.');
    const span = period === 'year' ? 12 : period === 'half' ? 6 : 3, month = period === 'year' ? 0 : (part - 1) * span;
    const dates = [], end = new Date(Date.UTC(year, month + span, 1));
    for (let date = new Date(Date.UTC(year, month, 1)); date < end; date.setUTCDate(date.getUTCDate() + 1)) dates.push(localDate(date));
    return dates;
  }
  function createDialog(dates = null, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const now = new Date();
    modal(`<h2>${dates ? '선택 날짜 업무 요약 작성' : '기간 업무 요약 작성'}</h2><p>선택한 현지 날짜에 시작된 세션의 기록을 기준으로 작성합니다. 자정을 넘긴 세션도 시작일에 한 번만 포함합니다.</p>
      <div id="report-create-error" class="error" role="alert" hidden></div>
      ${dates ? `<p class="report-period-preview">${dates.length}일 · ${esc(dates.join(' · '))}</p>` : `<div class="report-period-fields"><label>기간<select id="report-period" aria-label="대상 기간"><option value="quarter">분기</option><option value="half">반기</option><option value="year">연간</option></select></label><label>연도<input id="report-year" type="number" min="2000" max="2200" value="${now.getFullYear()}" aria-label="대상 연도"></label><label id="report-period-part-control">구간<select id="report-period-part" aria-label="기간 구간"></select></label></div>`}
      <p class="help">수행한 업무·역할·확인된 결과·근거·협업·남은 과제를 정리합니다. 기록에 없는 성과 수치를 만들지 않습니다. 자료가 많으면 나누어 작성한 뒤 통합합니다. ${esc(timezone)} 기준.</p>
      <div class="dialog-actions"><button data-close>취소</button><button id="confirm-create-report" class="primary">업무 요약 작성</button></div>`);
    const dialog = $('#modal'), error = $('#report-create-error'), confirm = $('#confirm-create-report');
    if (!dates) {
      const period = $('#report-period'), part = $('#report-period-part');
      const options = () => {
        const count = period.value === 'year' ? 1 : period.value === 'half' ? 2 : 4;
        part.innerHTML = Array.from({ length: count }, (_, i) => `<option value="${i + 1}">${period.value === 'half' ? ['상반기', '하반기'][i] : `${i + 1}분기`}</option>`).join('');
        $('#report-period-part-control').hidden = period.value === 'year';
        part.value = String(Math.floor(now.getMonth() / (period.value === 'half' ? 6 : period.value === 'year' ? 12 : 3)) + 1);
      };
      period.onchange = options; options();
    }
    let intent = null;
    confirm.onclick = async () => {
      confirm.disabled = true; error.hidden = true;
      try {
        intent ||= { operation_id: crypto.randomUUID(), dates: dates || periodDates(), timezone };
        dialog.querySelectorAll('input,select').forEach(node => node.disabled = true);
        const result = await api('/reports', { method: 'POST', body: intent });
        if (dialog.open && confirm.isConnected) { dialog.close(); selectedReport = result.id; detailRevision = ''; await navigate(); }
        toast('업무 요약 작성을 시작했습니다.');
      } catch (e) {
        if (dialog.open && error.isConnected) {
          error.textContent = e.message; error.hidden = false;
          if (e.status && e.status < 500) { intent = null; dialog.querySelectorAll('input,select').forEach(node => node.disabled = false); }
        }
      } finally { if (confirm.isConnected) confirm.disabled = false; }
    };
  }
  function openExternal(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.atlassian.net') || !parsed.pathname.startsWith('/wiki/')) throw new Error('지원하지 않는 Confluence 페이지 주소입니다.');
    if (window.webkit?.messageHandlers?.openExternal) window.webkit.messageHandlers.openExternal.postMessage(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }
  async function publishDialog(report) {
    const revisionAtStart = modalRevision;
    const current = () => active() && selectedReport === report.id && modalRevision === revisionAtStart;
    const status = await api('/integrations/atlassian');
    if (!current()) return;
    if (!status.connected) { toast('Confluence 게시를 위해 Atlassian을 연결하세요. 로컬 요약은 보관됩니다.'); return showSettings(); }
    const sites = (await api('/integrations/atlassian/sites')).filter(site => site.scopes?.includes('read:page:confluence'));
    if (!current()) return;
    modal(`<h2>Confluence에 업무 요약 게시</h2><p>확인한 요약으로 선택한 공간에 새 페이지를 만듭니다.</p><strong>${esc(report.title)}</strong><div id="report-publish-error" class="error" role="alert" hidden></div>
      <label for="report-confluence-site">사이트</label><select id="report-confluence-site">${sites.map(site => `<option value="${esc(site.id)}">${esc(site.name)}</option>`).join('')}</select>
      <label for="report-confluence-space">Confluence 공간</label><select id="report-confluence-space" disabled></select><button id="report-spaces-more" class="secondary" hidden>공간 더 보기</button>
      <div class="dialog-actions"><button data-close>취소</button><button id="confirm-publish-report" class="primary" disabled>페이지 게시</button></div>`);
    const dialog = $('#modal'), site = $('#report-confluence-site'), spaces = $('#report-confluence-space'), confirm = $('#confirm-publish-report'), error = $('#report-publish-error'), more = $('#report-spaces-more');
    let cursor = null, revision = 0, operation = null;
    async function loadSpaces(append = false) {
      const current = ++revision, cloud = site.value; confirm.disabled = true; spaces.disabled = true; more.disabled = true; error.hidden = true;
      if (!append) { spaces.innerHTML = ''; cursor = null; operation = null; }
      try {
        const result = await api(`/integrations/atlassian/confluence-spaces?cloud_id=${encodeURIComponent(cloud)}${append && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (current !== revision || !dialog.open || !spaces.isConnected) return;
        const selected = spaces.value;
        const known = new Map([...spaces.options].map(option => [option.value, option.textContent]));
        for (const space of result.spaces) known.set(space.id, `${space.name} (${space.key})`);
        spaces.innerHTML = [...known].map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
        if (selected) spaces.value = selected;
        cursor = result.next_cursor; more.hidden = !cursor;
        if (!spaces.options.length) throw new Error('게시할 수 있는 공간이 없습니다. 연결 권한을 확인하세요.');
      } catch (e) { if (current === revision && error.isConnected) { error.textContent = e.message; error.hidden = false; } }
      finally { if (current === revision && spaces.isConnected) { spaces.disabled = false; confirm.disabled = !spaces.value; more.disabled = false; } }
    }
    site.onchange = () => loadSpaces(); more.onclick = () => loadSpaces(true); spaces.onchange = () => { operation = null; };
    confirm.onclick = async () => {
      operation ||= { operation_id: crypto.randomUUID(), cloud_id: site.value, space_id: spaces.value };
      confirm.disabled = true; site.disabled = true; spaces.disabled = true; more.disabled = true; error.hidden = true;
      try {
        const result = await api(`/reports/${report.id}/publish`, { method: 'POST', body: operation });
        if (result.state !== 'published') throw new Error(result.message || '게시 결과를 요약에서 확인하세요.');
        if (dialog.open && confirm.isConnected) dialog.close();
        detailRevision = ''; await refresh(); toast('Confluence 페이지에 게시했습니다.');
      } catch (e) {
        if (dialog.open && error.isConnected) { error.textContent = e.message; error.hidden = false; }
        // A confirmed rejection can be retried by another explicit click. Unknown
        // outcomes keep their original operation so clicking cannot duplicate a page.
        try {
          const latest = await api(`/reports/${report.id}?view=summary`);
          if (latest.publications?.find(row => row.operation_id === operation?.operation_id)?.state === 'failed') operation = null;
        } catch { /* Retain the existing intent until its outcome is known. */ }
        detailRevision = ''; await refresh();
      } finally { if (confirm.isConnected) { confirm.disabled = false; site.disabled = false; spaces.disabled = false; more.disabled = false; } }
    };
    if (sites.length) await loadSpaces(); else { error.textContent = 'Confluence 읽기·공간 조회·페이지 작성 권한으로 다시 연결하세요.'; error.hidden = false; }
  }
  function resolveDialog(reportId, publication) {
    modal(`<h2>Confluence 게시 결과 확인</h2><p>게시된 것으로 보이는 페이지 ID를 입력하세요. 공간·제목·내용이 이 요약과 일치하는지 확인합니다. 페이지를 다시 만들지 않습니다.</p><div id="report-resolve-error" class="error" role="alert" hidden></div><label for="report-page-id">페이지 ID</label><input id="report-page-id" inputmode="numeric"><div class="dialog-actions"><button data-close>닫기</button><button id="resolve-report-publication" class="primary">페이지 확인</button></div>`);
    const dialog = $('#modal'), confirm = $('#resolve-report-publication'), error = $('#report-resolve-error');
    confirm.onclick = async () => {
      confirm.disabled = true; error.hidden = true;
      try {
        await api(`/reports/${reportId}/publications/${publication.operation_id}/resolve`, { method: 'POST', body: { page_id: $('#report-page-id').value.trim() } });
        if (dialog.open && confirm.isConnected) dialog.close(); detailRevision = ''; await refresh();
      } catch (e) { if (error.isConnected) { error.textContent = e.message; error.hidden = false; } }
      finally { if (confirm.isConnected) confirm.disabled = false; }
    };
  }
  function reportHTML(body) {
    return descriptionHTML(reportBodyMarkdown(body), esc, { format: 'markdown' });
  }
  function bindReferences(container, data) {
    container.querySelectorAll('[data-report-reference]').forEach(button => button.onclick = async () => {
      try {
        if (button.dataset.referenceKind === 'session') {
          const session = data.sessions.find(session => session.id === button.dataset.reportReference);
          modal(`<h2>요약의 근거 세션</h2><p>${esc(session.work_item_title)} · ${esc(absoluteTime(session.start_at))}</p><p class="help">작성 시점의 이력 · ${esc(session.id)}</p>${session.summary ? `<pre class="report-source-text">${esc(session.summary)}</pre>` : (session.events || []).map(event => `<div class="report-source-event"><small>${esc(event.kind)} · ${esc(absoluteTime(event.event_at))}</small><pre class="report-source-text">${esc(event.text ?? '원문 미제공')}</pre></div>`).join('')}<div class="dialog-actions"><button data-close>닫기</button></div>`);
        } else {
          const revisionAtStart = modalRevision;
          const { part } = await api(`/reports/${data.report.id}/parts/${button.dataset.reportReference}`);
          if (!button.isConnected || !active() || selectedReport !== data.report.id || modalRevision !== revisionAtStart) return;
          modal(`<h2>${esc(part.title || '부분 요약 근거')}</h2><p class="help">작성 시점의 부분 요약 · 세션 ${part.source_ids.length}개 · ${esc(part.id)}</p><div class="report-body work-item-description">${reportHTML(part.body, data)}</div><div class="dialog-actions"><button data-close>닫기</button></div>`);
          bindReferences($('#modal'), data);
        }
      } catch (e) { toast(e.message); }
    });
  }
  async function refresh() {
    if (!active()) return;
    const version = ++requestVersion, rows = await api('/reports');
    if (!active() || version !== requestVersion) return;
    const serialized = JSON.stringify(rows);
    if (serialized !== listRevision) {
      listRevision = serialized;
      const focused = $('#report-list').contains(document.activeElement) ? document.activeElement.closest('[data-report-id]')?.dataset.reportId : null;
      $('#report-list').innerHTML = rows.length ? rows.map(report => `<article class="report-row" data-report-id="${esc(report.id)}"><div><button class="report-open">${esc(report.title || '요약 작성 중')}</button><p>${esc(periodLabel(report.dates))} · 세션 ${report.session_count}개</p></div><div class="report-row-meta"><span class="badge">${esc(labels[report.state] || report.state)}</span><time datetime="${esc(report.created_at)}">${esc(absoluteTime(report.created_at))}</time></div></article>`).join('') : '<div class="empty"><strong>작성한 업무 요약이 없습니다</strong>캘린더에서 날짜를 선택하거나 분기·반기·연간 요약을 작성하세요.</div>';
      $('#report-list').querySelectorAll('.report-open').forEach(button => button.onclick = () => { selectedReport = button.closest('[data-report-id]').dataset.reportId; detailRevision = ''; void refresh().catch(e => toast(e.message)); });
      if (focused) [...$('#report-list').querySelectorAll('[data-report-id]')].find(row => row.dataset.reportId === focused)?.querySelector('.report-open').focus({ preventScroll: true });
    }
    if (!selectedReport) { $('#report-detail').hidden = true; cachedDetail = null; detailKey = ''; return; }
    const id = selectedReport, nextKey = JSON.stringify(rows.find(report => report.id === id));
    if (cachedDetail?.report.id === id && detailKey === nextKey && detailRevision) return;
    const update = await api(`/reports/${encodeURIComponent(id)}${cachedDetail?.report.id === id ? '?view=summary' : ''}`);
    if (!active() || version !== requestVersion || id !== selectedReport) return;
    const data = { ...update, sessions: update.sessions || cachedDetail?.sessions || [] };
    cachedDetail = data; detailKey = nextKey;
    // The source snapshot is immutable and downloaded once per selected report.
    const serializedDetail = JSON.stringify({ report: data.report, parts: data.parts, publications: data.publications });
    if (detailRevision === serializedDetail) return;
    detailRevision = serializedDetail;
    const { report, sessions = [], publications = [] } = data, panel = $('#report-detail');
    const focus = panel.contains(document.activeElement) ? document.activeElement.id : null;
    const sourcesOpen = $('#report-sources')?.open, rawOpen = $('#report-markdown')?.open, partsOpen = $('#report-parts')?.open;
    panel.hidden = false;
    panel.innerHTML = `<div class="report-detail-heading"><div><span class="eyebrow">WORK SUMMARY</span><h2>${esc(report.title || '요약 작성 중')}</h2></div><button id="close-report-detail" aria-label="요약 상세 닫기">×</button></div><p class="report-context">${esc(absoluteTime(report.created_at))} 작성 · ${esc(report.timezone)}<br>${esc(periodLabel(report.dates))} · 세션 ${report.session_count}개</p>
      <p class="report-state" role="status">${esc(labels[report.state] || report.state)}${report.progress ? ` · ${Number(report.progress.completed) || 0}/${Number(report.progress.total) || 0}개 처리` : ''}</p>${report.message ? `<p class="error" role="alert">${esc(report.message)}</p>` : ''}
      ${report.state === 'completed' ? `<div class="report-actions"><button id="publish-report" class="primary">Confluence 게시</button><button id="regenerate-report" class="secondary">같은 기간 새 업무 요약</button></div><div class="report-body work-item-description">${reportHTML(report.body, data)}</div><details id="report-markdown" ${rawOpen ? 'open' : ''}><summary>저장된 Markdown 원문</summary><pre>${esc(report.body || '')}</pre></details>` : ['failed', 'cancelled', 'interrupted'].includes(report.state) ? '<button id="regenerate-report" class="secondary">다시 작성</button>' : '<p class="help">기록이 많으면 나누어 작성한 뒤 통합합니다. 로컬 실행 서비스에서 진행하며 화면을 이동해도 계속됩니다.</p>'}
      <div class="report-publications">${publications.map(publication => `<article class="report-publication" data-publication-id="${esc(publication.operation_id)}"><strong>${esc(publication.state === 'published' ? 'Confluence 게시됨' : publication.state === 'unknown' ? '게시 결과 확인 필요' : publication.state === 'failed' ? '게시 실패' : '게시 중')}</strong>${publication.url ? ` <a href="${esc(publication.url)}" data-report-url="${esc(publication.url)}" target="_blank" rel="noopener noreferrer">페이지 열기 ↗</a>` : ''}${publication.message ? `<p>${esc(publication.message)}</p>` : ''}${publication.state === 'unknown' ? `<button class="secondary" data-resolve-publication="${esc(publication.operation_id)}">게시 결과 확인</button>` : ''}</article>`).join('')}</div>
      <details id="report-sources" ${sourcesOpen ? 'open' : ''}><summary>기준 이력 · ${sessions.length}개 세션</summary><p class="help">요약 작성 시점의 기록입니다. 이후 업무 편집·병합·삭제로 이 내용을 바꾸지 않습니다.</p><ul>${sessions.map(session => `<li><strong>${esc(session.work_item_title || session.title || session.work_item_id || session.id)}</strong> · ${esc(absoluteTime(session.start_at))}<button class="report-reference" data-report-reference="${esc(session.id)}" data-reference-kind="session">원본 이력 보기</button><small>${esc(session.id)}${session.tags?.length ? ` · ${esc(session.tags.join(', '))}` : ''}</small></li>`).join('')}</ul>${data.parts?.length > 1 ? `<details id="report-parts" ${partsOpen ? 'open' : ''}><summary>부분 작성 기록 · ${data.parts.length}개</summary><ul>${data.parts.filter(part => part.state === 'completed').map(part => `<li><button class="report-reference" data-report-reference="${esc(part.id)}" data-reference-kind="part">${esc(part.title || '부분 요약')}</button></li>`).join('')}</ul></details>` : ''}</details>`;
    $('#close-report-detail').onclick = () => { selectedReport = null; detailRevision = ''; panel.hidden = true; };
    if ($('#publish-report')) $('#publish-report').onclick = () => publishDialog(report).catch(e => toast(e.message));
    if ($('#regenerate-report')) $('#regenerate-report').onclick = () => createDialog(report.dates, report.timezone);
    panel.querySelectorAll('[data-report-url]').forEach(link => link.onclick = event => { event.preventDefault(); try { openExternal(link.dataset.reportUrl); } catch (e) { toast(e.message); } });
    panel.querySelectorAll('[data-resolve-publication]').forEach(button => button.onclick = () => resolveDialog(report.id, publications.find(row => row.operation_id === button.dataset.resolvePublication)));
    bindReferences(panel, data);
    if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
  }
  $('#clear-report-dates').onclick = () => { selectedDates.clear(); updateSelection(); };
  $('#create-calendar-report').onclick = () => { if (selectedDates.size) createDialog([...selectedDates].sort()); };
  $('#create-period-report').onclick = () => createDialog();
  return { selectDateHTML, bindCalendar, refresh };
}
