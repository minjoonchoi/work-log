import { integrationUI } from './integrations.js';
import { writingUI } from './writing.js';
import { historyUI } from './history.js';
import { executionSettingsUI } from './execution-settings.js';
const $ = selector => document.querySelector(selector);
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { items: [], selected: new Set(), view: 'items', attention: false, currentOnly: false, waitingOnly: false, calendarView: 'month', mode: 'sessions', date: new Date(), detail: null };
let listRevision = '', calendarRevision = '', calendarMarkup = '', calendarRequest = 0, loadRequest = 0, detailRequest = 0;
let streamConnected = false, refreshQueued = false, refreshing = false, refreshTimer;
const statusLabels = { tracked: '이력 수집', running: '작업 실행 중', queued: '실행 대기', agent_response_pending: '에이전트 응답 대기', waiting_for_user: '사용자 답변 필요', attention: '확인 필요', completed: '완료', cancelled: '취소됨', failed: '실패', blocked: '진행 불가', interrupted: '중단됨', pending: '실행 대기' };
const checkLabels = { passed: '통과', failed: '실패', not_run: '미실행', running: '실행 중', interrupted: '중단', unknown: '확인 안 됨', incomplete: '검사 미완료', source_changed: '대상 변경 · 재검사 필요' };
const time = value => new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const dateLabel = value => new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(new Date(value));
const absoluteTime = value => new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'shortOffset' }).format(new Date(value));
const eventTime = value => new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function dayStart(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
async function api(url, options = {}) {
  const token = window.__HARNESS_TOKEN__;
  if (!token) throw new Error('앱 연결 정보가 없습니다. 설치된 WorkLog 앱으로 열어 주세요.');
  const response = await fetch(`/api${url}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const result = await response.json();
  if (!response.ok) { const e = new Error(result.error); e.status = response.status; throw e; } return result;
}
function error(e) { $('#error').textContent = e.message; $('#error').hidden = false; }
function safe(fn) { return async (...args) => { try { return await fn(...args); } catch (e) { error(e); } }; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; setTimeout(() => $('#toast').hidden = true, 4000); }
function modal(html) { $('#modal-content').innerHTML = html; if (!$('#modal').open) $('#modal').showModal(); $('#modal-content').querySelectorAll('[data-close]').forEach(b => b.onclick = () => $('#modal').close()); }
const integrations = integrationUI({ api, esc, modal, toast, absoluteTime, refresh: async id => { await openDetail(id, undefined, true, true); await load(); } });
const writing = writingUI({ api, esc, toast, absoluteTime, refresh: async id => { await openDetail(id, undefined, true); await load(); } });
const history = historyUI({ api, esc, eventHTML, invalidated: scheduleRefresh });
const executionSettings = executionSettingsUI({ api, esc, modal, toast });
function badge(value) { return `<span class="badge ${esc(value)}">${esc(statusLabels[value] || value)}</span>`; }
function liveStatus() {
  return `<span class="history-live ${streamConnected ? 'connected' : ''}" role="status">${streamConnected ? '실시간 갱신 중' : '실시간 연결 대기 · 재연결 중'}</span>`;
}
function setStreamConnected(connected) {
  streamConnected = connected;
  const node = $('#history-live'); if (node) node.innerHTML = liveStatus();
}
function scheduleRefresh() {
  refreshQueued = true;
  if (refreshing || refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null; refreshing = true;
    try {
      do {
        refreshQueued = false;
        await load();
        if (state.detail) await openDetail(state.detail.item.id, undefined, true);
      } while (refreshQueued);
    } catch (e) { error(e); }
    finally { refreshing = false; }
  }, 50);
}
async function subscribeChanges() {
  // Fetch streaming preserves the Authorization header; never put the local token in a URL.
  while (true) {
    let reader;
    try {
      const response = await fetch('/api/updates', { headers: { Authorization: `Bearer ${window.__HARNESS_TOKEN__}` }, cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('이력 갱신 연결 실패');
      reader = response.body.getReader();
      setStreamConnected(true);
      // Refresh metadata, then catch up by ingestion sequence without downloading old pages again.
      scheduleRefresh();
      const decoder = new TextDecoder(); let pending = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          if (frame.split('\n').includes('event: change')) scheduleRefresh();
        }
      }
    } catch { /* Keep the recorded history visible and retry the local stream. */ }
    finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); setStreamConnected(false); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function load(force = false) {
  const requestNumber = ++loadRequest;
  try {
    const [health, items] = await Promise.all([api('/health'), api(`/items?q=${encodeURIComponent($('#search').value)}`)]);
    if (requestNumber !== loadRequest) return;
    $('#connection').textContent = health.runtime_connected ? '서비스 연결됨' : '실행 서비스 연결 대기';
    $('#connection').classList.toggle('offline', !health.runtime_connected);
    if (health.quarantined || health.last_error) $('#connection').textContent = `수집 확인 필요 · ${health.quarantined}건`;
    state.items = items;
    const ids = new Set(state.items.map(i => i.id)); for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
    $('#item-count').textContent = state.items.length;
    const revision = JSON.stringify(state.items);
    if (state.view === 'items' && (force || revision !== listRevision)) renderItems();
    if (state.view === 'calendar' && (force || calendarRevision !== `${health.events}:${revision}`)) {
      await renderCalendar(); calendarRevision = `${health.events}:${revision}`;
    }
    listRevision = revision;
    $('#error').hidden = true;
  } catch (e) {
    if (requestNumber !== loadRequest) return;
    $('#connection').textContent = '관리 서비스 연결 끊김'; $('#connection').classList.add('offline'); error(e);
  }
}
function renderItems() {
  const items = state.items.filter(i => (!state.attention || i.activity === 'attention') && (!state.currentOnly || i.is_current) && (!state.waitingOnly || i.activity === 'waiting_for_user'));
  const empty = state.waitingOnly ? ['답변이 필요한 업무가 없습니다', '명시적인 사용자 질문이 수집되면 여기에 표시합니다.']
    : state.currentOnly ? ['현재 진행 중인 업무가 없습니다', '실행 또는 에이전트 응답을 기다리는 업무가 있으면 여기에 표시합니다.']
    : state.attention ? ['확인이 필요한 업무가 없습니다', '작업의 실패·차단·중단 기록이 있으면 여기에 표시합니다.']
    : $('#search').value ? ['검색 결과가 없습니다', '다른 제목이나 설명으로 검색해 보세요.']
    : ['아직 기록된 업무가 없습니다', '에이전트에서 요청하거나 CLI로 작업을 실행하면 업무와 세션 이력이 이곳에 나타납니다.'];
  $('#list-label').textContent = `${state.attention ? '확인이 필요한 업무' : state.waitingOnly ? '사용자 답변 필요' : state.currentOnly ? '현재 작업' : '모든 업무'} · ${items.length}`;
  $('#item-list').innerHTML = items.length ? items.map(i => `<article class="item-row ${state.selected.has(i.id) ? 'selected' : ''}" data-id="${esc(i.id)}">
    <input type="checkbox" aria-label="${esc(i.title)} 선택" ${state.selected.has(i.id) ? 'checked' : ''}>
    <div class="item-main"><button class="item-open" title="${esc(i.title)}">${esc(i.title)}</button><p>${esc(i.description || '첫 요청과 작업 이력이 여기에 모입니다.')}</p></div>
    <div class="item-meta">${badge(i.activity === 'recent' ? i.state : i.activity)}<small>세션 ${i.session_count}개 · ${dateLabel(i.last_activity)}</small></div></article>`).join('')
    : `<div class="empty"><strong>${empty[0]}</strong>${empty[1]}</div>`;
  document.querySelectorAll('.item-row').forEach(row => {
    row.querySelector('input').onchange = e => { e.target.checked ? state.selected.add(row.dataset.id) : state.selected.delete(row.dataset.id); renderItems(); };
    row.querySelector('button').onclick = safe(() => openDetail(row.dataset.id));
  });
  $('#merge').disabled = state.selected.size < 2;
  $('#selection-label').textContent = state.selected.size ? `${state.selected.size}개 선택됨` : '업무를 선택해 이력을 확인하세요';
}
async function showView(view, attention = false, currentOnly = false, waitingOnly = false) {
  state.view = view; state.attention = attention; state.currentOnly = currentOnly; state.waitingOnly = waitingOnly;
  $('#items-view').hidden = view !== 'items'; $('#calendar-view').hidden = view !== 'calendar';
  $('#page-title').textContent = view === 'calendar' ? '작업 캘린더' : attention ? '확인이 필요한 작업' : waitingOnly ? '사용자 답변 필요' : currentOnly ? '현재 작업' : '업무 목록';
  $('#page-description').textContent = view === 'calendar' ? '업무가 이어진 시간과 세션의 흐름을 살펴보세요.' : '여러 에이전트의 작업과 대화를 한곳에서 이어 보세요.';
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  $(view === 'calendar' ? '#nav-calendar' : attention ? '#nav-attention' : waitingOnly ? '#nav-waiting-user' : '#nav-items').classList.add('active');
  listRevision = ''; calendarRevision = '';
  await load(true);
}
function eventHTML(e) {
  const names = { input: '프롬프트 입력', output: '응답 출력', 'turn.failed': '실패', 'turn.interrupted': '중단', 'session.started': '에이전트 시작', 'session.ended': '에이전트 종료', 'tool.started': '도구 시작', 'tool.finished': '도구 종료' };
  const source = e.source === 'system_hook' ? (e.hook_event_name || (e.kind === 'input' ? 'UserPromptSubmit' : 'Stop'))
    : e.source === 'runtime' || e.engine === 'harness' ? '하네스 기록' : '수집 기록';
  return `<div class="event" data-event-id="${esc(e.uid)}" data-kind="${esc(e.kind)}"><div class="event-header"><span class="event-label-title">${names[e.kind] || esc(e.kind)}${e.resolution === 'unresolved' ? ' · 연결 미확인' : ''}</span><time datetime="${esc(e.event_at)}" title="${esc(absoluteTime(e.event_at))}">${eventTime(e.event_at)}</time><span class="event-source" title="${esc(`레코드: ${e.uid}\n수집 시각: ${absoluteTime(e.ingested_at)}`)}">${esc(source)}</span></div><pre>${esc(e.text ?? (e.kind === 'output' ? '응답 본문이 제공되지 않았습니다.' : e.kind === 'input' ? '입력 본문이 제공되지 않았습니다.' : ''))}</pre></div>`;
}
const taskLabels = { 'prd.create': 'PRD 작성', 'mockup.html.create': 'HTML 목업 작성', 'entity.design': '엔티티 설계',
  'text.rewrite': '내용 다시 작성', 'session.summarize': '세션 요약', 'checks.run': '검사 실행', 'verification.report': '검사 보고서', 'test.scenarios.plan': '검증 시나리오 작성' };
function runHTML(run) {
  const fallback = { completed: '작업이 완료되었습니다.', pending: '작업을 준비하고 있습니다.', running: '요청한 작업을 수행하고 있습니다.',
    failed: '작업이 실패했습니다.', blocked: '진행에 필요한 내용을 확인하세요.', cancelled: '작업이 취소되었습니다.', interrupted: '작업이 중단되었습니다.' };
  return `<article class="run session-result" data-run-id="${esc(run.id)}"><div class="result-heading"><h4>${esc(taskLabels[run.task] || run.task || '연결된 작업')}</h4>${badge(run.status)}</div>
    <p>${esc(run.message || fallback[run.status] || '실행 상세에서 기록을 확인하세요.')}</p>
    <div class="result-actions">${['pending', 'running'].includes(run.status) ? `<button class="secondary" data-cancel="${esc(run.id)}">실행 취소</button>` : ''}
      ${['failed', 'blocked', 'interrupted', 'cancelled'].includes(run.status) ? `<button class="secondary" data-resume="${esc(run.id)}">다시 실행</button>` : ''}
      ${run.artifact && run.status === 'completed' ? `<button class="writing-action writing-action-accent" data-artifact="${esc(run.id)}">산출물 보기</button>` : ''}
      ${run.evidence ? `<button class="secondary" data-evidence="${esc(run.id)}">검사 결과 보기</button>` : ''}
      <button class="secondary" data-run-details="${esc(run.id)}">실행 상세</button></div></article>`;
}
async function runDetails(run, data) {
  const { records: workers } = await api(`/items/${data.item.id}/runs/${run.id}/events`);
  if (state.detail?.item.id !== data.item.id || $('#detail').hidden) return;
  modal(`<h2>실행 상세</h2><p>${esc(taskLabels[run.task] || run.task)} · ${esc(statusLabels[run.status] || run.status)}</p>
    <dl class="execution-facts"><dt>작업</dt><dd>${esc(run.task)}</dd><dt>엔진</dt><dd>${esc(run.engine)}</dd>
    <dt>실행 ID</dt><dd>${esc(run.id)}</dd><dt>현재 단계</dt><dd>${esc(run.stage || '준비')} · 수정 ${run.round || 0}회</dd>
    <dt>시작</dt><dd>${esc(absoluteTime(run.created_at))}</dd><dt>최근 상태</dt><dd>${esc(absoluteTime(run.updated_at))}</dd></dl>
    ${run.message ? `<p>${esc(run.message)}</p>` : ''}<h3>실행 기록 <small>${workers.length}</small></h3>
    <p class="help">생성·검토·수정 과정의 진단 기록입니다. 사용자 세션의 작업 시간에는 추가하지 않습니다.</p>
    <div class="execution-events">${workers.length ? workers.map(e => `<details class="execution-event"><summary>${esc(e.kind === 'input' ? '작업자 입력' : e.kind === 'output' ? '작업자 결과' : e.kind)} · ${esc(absoluteTime(e.event_at))}</summary><pre>${esc(e.text ?? '본문이 제공되지 않았습니다.')}</pre></details>`).join('') : '<p class="help">이 실행에 수집된 작업자 입출력은 없습니다.</p>'}</div>
    <div class="dialog-actions"><button data-close>닫기</button></div>`);
}
async function openDetail(id, sessionId, refresh = false, force = false) {
  const requestNumber = ++detailRequest;
  const data = await api(`/items/${id}?view=summary`);
  if (requestNumber !== detailRequest) return;
  if (refresh && !force && JSON.stringify(data) === JSON.stringify(state.detail)) { history.refresh(); return; }
  const panel = $('#detail');
  const expanded = refresh ? [...$('#detail').querySelectorAll('[data-session-id][open]')].map(e => e.dataset.sessionId) : [];
  const expandedResults = refresh ? [...$('#detail').querySelectorAll('[data-results-session][open]')].map(e => e.dataset.resultsSession) : [];
  const scrollTop = refresh ? $('#detail').scrollTop : 0;
  const focused = refresh && panel.contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.id, focusSession = focused?.closest('[data-session-id]')?.dataset.sessionId;
  const bounds = panel.getBoundingClientRect();
  const anchor = refresh && scrollTop > 0 ? [...panel.querySelectorAll('.event')].find(e => {
    const r = e.getBoundingClientRect(); return r.bottom > bounds.top && r.top < bounds.bottom;
  }) : null;
  const anchorId = anchor?.dataset.eventId, anchorTop = anchor?.getBoundingClientRect().top;
  state.detail = data;
  history.configure(data);
  const { item } = data, runs = data.runs.filter(r => !r.internal);
  const sessions = [...data.sessions].reverse();
  const unlinkedRuns = runs.filter(r => !r.session_id);
  $('#detail').hidden = false;
  $('#detail').innerHTML = `<div class="detail-top"><div class="detail-identity"><span class="eyebrow">WORK ITEM</span>${badge(item.activity === 'recent' ? item.state : item.activity)}</div><button class="close" id="close-detail" aria-label="상세 닫기">×</button></div>
    ${writing.metadataHTML(data)}
    ${data.questions?.length ? `<section class="user-questions detail-section"><h3>사용자 답변 필요</h3><p class="help">아래 질문은 해당 Claude 에이전트 세션에서 답변해 주세요.</p>${data.questions.map(q => `<article><p class="question-text">${esc(q.text)}</p><small>질문 요청 · ${esc(absoluteTime(q.requested_at))}</small><details><summary>에이전트 세션 확인</summary><code>${esc(q.agent_session_id)}</code></details></article>`).join('')}</section>` : ''}
    ${item.activities?.length > 1 ? `<p class="help">함께 기록된 상태: ${item.activities.slice(1).map(a => esc(statusLabels[a])).join(' · ')}</p>` : ''}
    ${item.aliases.length ? `<p>병합된 업무 ${item.aliases.length}개 · 원본 세션 유지</p>` : ''}
    ${integrations.jiraHTML(data)}
    <section class="detail-section"><h3>세션 이력 <small>${sessions.length}</small></h3><div class="history-toolbar"><span id="history-live">${liveStatus()}</span><span>발생 시각 · 최신순</span></div>${sessions.map(s => {
      const results = runs.filter(r => r.session_id === s.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const pendingLabel = s.waiting_for_user ? '사용자 답변 필요' : results.some(r => r.status === 'running') ? '작업 실행 중' : results.some(r => r.status === 'pending') ? '실행 대기' : s.pending ? '에이전트 응답 대기' : '';
      return `<details class="session-card" data-session-id="${esc(s.id)}" ${s.id === sessionId ? 'open' : ''}><summary><span>${dateLabel(s.start_at)} ${time(s.start_at)} → ${time(s.end_at)}${pendingLabel ? ` · ${pendingLabel}` : ''}</span>${results.length ? `<span class="session-result-count">작업 ${results.length}</span>` : ''}</summary>
        <small class="session-source" title="${esc(s.agent_session_id)}">${esc(s.engine === 'codex' ? 'Codex' : s.engine === 'claude' ? 'Claude' : '하네스')} 대화</small>
        ${writing.sessionHTML(s)}${integrations.sessionHTML(s)}
        ${results.length ? `<details class="session-results" data-results-session="${esc(s.id)}"><summary>연결된 작업 ${results.length}개</summary>${results.map(runHTML).join('')}</details>` : ''}
        <div class="conversation-heading"><h4>입력·응답 <small>${s.history.count}건</small></h4><span>기록 시각 · 최신순</span></div>${history.html(s.id)}</details>`;
    }).join('') || '<small>첫 입력을 기다리고 있습니다.</small>'}</section>
    ${unlinkedRuns.length ? `<section class="detail-section unlinked-results"><h3>세션 연결 대기 <small>${unlinkedRuns.length}</small></h3><p class="help">원본 입력을 확인하면 해당 세션에 표시합니다.</p>${unlinkedRuns.map(runHTML).join('')}</section>` : ''}
    ${data.unlinked_history.count ? `<section class="detail-section"><h3>연결 미확인 출력 <small>${data.unlinked_history.count}건</small></h3>${history.html(null)}</section>` : ''}`;
  for (const node of $('#detail').querySelectorAll('[data-session-id]')) if (expanded.includes(node.dataset.sessionId)) node.open = true;
  for (const node of panel.querySelectorAll('[data-results-session]')) if (expandedResults.includes(node.dataset.resultsSession)) node.open = true;
  $('#detail').scrollTop = scrollTop;
  if (anchorId) {
    const current = [...panel.querySelectorAll('.event')].find(e => e.dataset.eventId === anchorId);
    if (current) panel.scrollTop += current.getBoundingClientRect().top - anchorTop;
  }
  const restoreFocus = focusId ? document.getElementById(focusId) : focusSession
    ? [...panel.querySelectorAll('[data-session-id]')].find(e => e.dataset.sessionId === focusSession)?.querySelector('summary') : null;
  restoreFocus?.focus({ preventScroll: true });
  integrations.bindDetail(data);
  writing.bindDetail(data);
  history.mount(panel);
  panel.querySelectorAll('[data-run-details]').forEach(button => button.onclick = safe(async () => {
    const run = data.runs.find(r => r.id === button.dataset.runDetails);
    if (run) await runDetails(run, data); else toast('실행 이력을 수집하고 있습니다. 잠시 후 다시 확인하세요.');
  }));
  $('#close-detail').onclick = () => { detailRequest++; $('#detail').hidden = true; state.detail = null; history.clear(); };
  $('#edit-item').onclick = () => {
    modal(`<h2>업무 정보 편집</h2><p>직접 편집한 값은 자동 갱신에서 보호됩니다.</p><label for="edit-title">제목</label><input id="edit-title" maxlength="200" value="${esc(item.title)}"><label for="edit-description">설명</label><textarea id="edit-description" maxlength="5000">${esc(item.description)}</textarea><div class="dialog-actions"><button data-close>취소</button><button class="primary" id="save-item">저장</button></div>`);
    $('#save-item').onclick = safe(async () => { await api(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: $('#edit-title').value, description: $('#edit-description').value } }); $('#modal').close(); await openDetail(item.id); await load(); });
  };
  $('#detail').querySelectorAll('[data-cancel],[data-resume]').forEach(b => b.onclick = safe(async () => {
    const runId = b.dataset.cancel || b.dataset.resume, action = b.dataset.cancel ? 'cancel' : 'resume';
    await api(`/runs/${runId}/${action}`, { method: 'POST', body: {} }); toast(action === 'cancel' ? '취소 요청을 전달했습니다.' : '새 시도로 다시 실행합니다.'); await new Promise(r => setTimeout(r, 300)); await openDetail(item.id, undefined, true, true); await load();
  }));
  $('#detail').querySelectorAll('[data-artifact]').forEach(b => b.onclick = safe(async () => {
    const a = await api(`/artifacts/${b.dataset.artifact}`);
    modal(`<h2>${esc(a.name)}</h2><p>${a.task === 'verification.report' ? '실행 근거 보고서 · 검사별 판정을 확인하세요' : '검증된 산출물'} · ${esc(a.digest.slice(0, 12))}</p>${a.name.endsWith('.html') ? '<iframe id="preview" title="목업 미리보기" sandbox="allow-scripts"></iframe>' : `<pre class="artifact-text">${esc(a.text)}</pre>`}<div class="dialog-actions"><button data-close>닫기</button></div>`);
    if ($('#preview')) $('#preview').srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">` + a.text;
  }));
  $('#detail').querySelectorAll('[data-evidence]').forEach(b => b.onclick = safe(async () => {
    const { data } = await api(`/evidence/${b.dataset.evidence}`);
    modal(`<h2>검사 결과</h2><p>${esc(checkLabels[data.overall] || data.overall)} · ${esc(data.profile)}</p><p>${esc(data.validation_scope)}</p>
      ${data.checks.map(c => `<section class="run"><h3>${esc(c.label)}</h3><p>${esc(checkLabels[c.status] || c.status)}</p><p>시작: ${c.started_at ? esc(absoluteTime(c.started_at)) : '미관측'}<br>종료: ${c.ended_at ? esc(absoluteTime(c.ended_at)) : '미관측'}</p>${c.observation ? `<p>종료 코드: ${esc(c.observation.code ?? '없음')}${c.observation.reason ? ` · ${esc(c.observation.reason)}` : ''}</p>` : ''}</section>`).join('')}
      ${data.message ? `<p>${esc(data.message)}</p>` : ''}<div class="dialog-actions"><button data-close>닫기</button></div>`);
  }));
}
function range() {
  let start = dayStart(state.date), end;
  if (state.calendarView === 'month') { start.setDate(1); start = addDays(start, -start.getDay()); end = addDays(start, 42); }
  else if (state.calendarView === 'week') { start = addDays(start, -start.getDay()); end = addDays(start, 7); }
  else end = addDays(start, 1);
  return { start, end };
}
function entriesForDay(entries, day) {
  const start = dayStart(day), end = addDays(start, 1);
  const filtered = entries.filter(e => new Date(e.start_at) < end && (new Date(e.end_at) > start || (e.start_at === e.end_at && new Date(e.start_at) >= start)));
  if (state.calendarView !== 'month' || state.mode !== 'items') return filtered;
  const groups = new Map();
  for (const e of filtered) {
    if (groups.has(e.work_item_id)) { const current = groups.get(e.work_item_id); current.session_ids.push(...e.session_ids); current.end_at = current.end_at > e.end_at ? current.end_at : e.end_at; }
    else groups.set(e.work_item_id, { ...e, session_ids: [...e.session_ids] });
  }
  return [...groups.values()];
}
function eventButton(e, cls = '', style = '') {
  return `<button class="calendar-event ${cls}" style="${style}" data-event="${esc(e.id)}" aria-label="${esc(e.title)} ${time(e.start_at)} 세션 ${e.session_ids.length}개" title="${esc(e.title)} · ${absoluteTime(e.start_at)} → ${absoluteTime(e.end_at)}"><span class="event-time">${time(e.start_at)}</span><span class="event-label">${esc(e.title)}</span></button>`;
}
async function renderCalendar() {
  const requestNumber = ++calendarRequest;
  const { start, end } = range(), entries = await api(`/calendar?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&mode=${state.mode}`);
  if (requestNumber !== calendarRequest) return;
  $('#calendar-date').value = isoDate(state.date);
  $('#calendar-title').textContent = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', ...(state.calendarView === 'month' ? {} : { day: 'numeric' }) }).format(state.date);
  $('#timezone-label').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.calendarView));
  const days = []; for (let d = new Date(start); d < end; d = addDays(d, 1)) days.push(d);
  const dayEntries = days.map(d => entriesForDay(entries, d));
  const moreLists = []; let markup;
  if (state.calendarView === 'month') {
    markup = `<div class="month-grid">${['일', '월', '화', '수', '목', '금', '토'].map(d => `<div class="weekday">${d}</div>`).join('')}${days.map((d, i) => {
      const list = dayEntries[i];
      return `<div class="month-day ${d.getMonth() === state.date.getMonth() ? '' : 'outside'}" data-date="${isoDate(d)}"><time class="day-number ${isoDate(d) === isoDate(new Date()) ? 'current' : ''}">${d.getDate()}</time>${list.slice(0, 2).map(e => eventButton(e)).join('')}${list.length > 2 ? (moreLists.push({ entries: list, day: d }), `<button class="more" data-more="${moreLists.length - 1}">+${list.length - 2}개 더보기</button>`) : ''}</div>`;
    }).join('')}</div>`;
  } else {
    const labels = Array.from({ length: 24 }, (_, h) => `<span style="top:${h * 60 + 4}px">${String(h).padStart(2, '0')}:00</span>`).join('');
    markup = `<div class="time-calendar" style="--days:${days.length}"><div class="time-header"><div>시간</div>${days.map(d => `<div>${dateLabel(d)} (${['일', '월', '화', '수', '목', '금', '토'][d.getDay()]})</div>`).join('')}</div><div class="time-body"><div class="time-labels">${labels}</div>${days.map((day, i) => {
      const list = dayEntries[i], startMs = day.getTime(), endMs = addDays(day, 1).getTime();
      // Position by local wall clock; DST offsets remain visible in full timestamps in the detail.
      const position = timestamp => { const date = new Date(timestamp); return date <= day ? 0 : date >= addDays(day, 1) ? 1440 : date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60; };
      const placed = list.map(e => ({ e, top: position(e.start_at), bottom: Math.max(position(e.start_at) + 38, position(e.end_at)) })).sort((a, b) => a.top - b.top);
      const clusters = []; for (const p of placed) { let c = clusters.at(-1); if (!c || p.top >= c.end) { c = { entries: [], end: p.bottom }; clusters.push(c); } c.entries.push(p); c.end = Math.max(c.end, p.bottom); }
      return `<div class="time-day" data-date="${isoDate(day)}">${clusters.map(c => {
        const visible = c.entries.slice(0, 2);
        return visible.map((p, n) => eventButton(p.e, 'timed-event', `top:${p.top}px;height:${Math.min(1440 - p.top, p.bottom - p.top)}px;left:${n * 50 + 1}%;width:${visible.length > 1 ? 48 : 97}%`)).join('') + (c.entries.length > 2 ? (moreLists.push({ entries: c.entries.map(p => p.e), day }), `<button class="more time-more" style="top:${Math.min(c.entries[0].top + 40, 1400)}px" data-more="${moreLists.length - 1}">+${c.entries.length - 2}개 더보기</button>`) : '');
      }).join('')}</div>`;
    }).join('')}</div></div>`;
  }
  // Repeated snapshots must not detach a keyboard-focused button or reset scroll.
  if (calendarMarkup !== markup) {
    calendarMarkup = markup; $('#calendar').innerHTML = markup;
    if ($('.time-calendar')) $('.time-calendar').scrollTop = 7 * 60;
  }
  const allEntries = [...entries, ...dayEntries.flat()];
  $('#calendar').querySelectorAll('[data-event]').forEach(b => b.onclick = safe(async () => {
    const e = allEntries.find(e => e.id === b.dataset.event); await openDetail(e.work_item_id, state.mode === 'sessions' ? e.session_ids[0] : undefined);
  }));
  $('#calendar').querySelectorAll('[data-more]').forEach(b => b.onclick = () => {
    const { entries: list, day } = moreLists[Number(b.dataset.more)];
    modal(`<h2>${dateLabel(day)} · ${state.mode === 'items' ? '업무' : '세션'} ${list.length}개</h2><div class="dialog-list">${list.map((e, i) => `<button class="dialog-entry" data-entry="${i}">${esc(e.title)}<small>${time(e.start_at)}–${time(e.end_at)} · 세션 ${new Set(e.session_ids).size}개</small></button>`).join('')}</div><div class="dialog-actions"><button data-close>닫기</button></div>`);
    $('#modal').querySelectorAll('[data-entry]').forEach(button => button.onclick = safe(async () => { const e = list[Number(button.dataset.entry)]; $('#modal').close(); await openDetail(e.work_item_id, state.mode === 'sessions' ? e.session_ids[0] : undefined); }));
  });
}
$('#nav-items').onclick = safe(() => showView('items'));
$('#nav-calendar').onclick = safe(() => showView('calendar'));
$('#nav-attention').onclick = safe(() => showView('items', true));
$('#nav-waiting-user').onclick = safe(() => showView('items', false, false, true));
$('#refresh').onclick = safe(() => load(true));
let searchTimer; $('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 200); };
$('#merge').onclick = () => {
  const ids = [...state.selected], selected = ids.map(id => state.items.find(i => i.id === id));
  modal(`<h2>${ids.length}개 업무를 하나로 병합</h2><p>모든 세션 이력을 대표 업무 아래에 모읍니다. 기존 세션과 입력·출력 시각은 보존됩니다.</p><label for="merge-target">대표 업무</label><select id="merge-target">${selected.map(i => `<option value="${esc(i.id)}">${esc(i.title)}</option>`).join('')}</select><p>세션 ${selected.reduce((n, i) => n + i.session_count, 0)}개가 연결됩니다.</p><div class="dialog-actions"><button data-close>취소</button><button id="confirm-merge" class="primary">하나로 병합</button></div>`);
  const operationId = crypto.randomUUID();
  $('#confirm-merge').onclick = safe(async () => {
    $('#confirm-merge').disabled = true;
    try { const result = await api('/merge', { method: 'POST', body: { ids, target: $('#merge-target').value, operation_id: operationId } }); state.selected.clear(); $('#modal').close(); await load(); await openDetail(result.id); toast('업무가 병합되었습니다.'); }
    finally { if ($('#confirm-merge')) $('#confirm-merge').disabled = false; }
  });
};
$('#calendar-mode').onchange = safe(async e => { state.mode = e.target.value; await renderCalendar(); });
$('#calendar-date').onchange = safe(async e => { state.date = new Date(`${e.target.value}T12:00:00`); await renderCalendar(); });
document.querySelectorAll('[data-view]').forEach(b => b.onclick = safe(async () => { state.calendarView = b.dataset.view; await renderCalendar(); }));
function move(direction) { if (state.calendarView === 'month') state.date = new Date(state.date.getFullYear(), state.date.getMonth() + direction, 1); else state.date = addDays(state.date, direction * (state.calendarView === 'week' ? 7 : 1)); return renderCalendar(); }
$('#previous').onclick = safe(() => move(-1)); $('#next').onclick = safe(() => move(1));
$('#today').onclick = safe(() => { state.date = new Date(); return renderCalendar(); });
$('#settings').onclick = safe(integrations.showSettings);
$('#execution-settings').onclick = safe(executionSettings.showSettings);
window.addEventListener('harness:navigate', safe(async e => {
  const route = typeof e.detail === 'string' ? { view: e.detail } : e.detail;
  if (!route || !['items', 'current', 'attention', 'waiting-user', 'calendar', 'settings'].includes(route.view)) return;
  $('#modal').close(); $('#search').value = '';
  if (state.detail) $('#close-detail').click();
  if (route.view === 'settings') return integrations.showSettings();
  if (route.view === 'calendar') { state.date = new Date(); return showView('calendar'); }
  await showView('items', route.view === 'attention', route.view === 'current', route.view === 'waiting-user');
  if (typeof route.item_id === 'string' && route.item_id.length <= 200) await openDetail(route.item_id);
}));
await load();
window.webkit?.messageHandlers?.mainReady?.postMessage({ ready: true });
void subscribeChanges();
// A periodic snapshot also checks service health; live updates never wait for this timer.
setInterval(scheduleRefresh, 5000);
