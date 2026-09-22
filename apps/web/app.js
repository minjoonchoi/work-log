import { integrationUI } from './integrations.js';
import { agentConnectionsUI } from './agent-connections.js';
import { writingUI } from './writing.js';
import { historyUI } from './history.js';
import { executionSettingsUI } from './execution-settings.js';
import { automationSettingsUI } from './automation-settings.js';
import { descriptionPreview } from './description.js';
import { itemTagsUI } from './item-tags.js';
import { reportsUI } from './reports.js';
const $ = selector => document.querySelector(selector);
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function savedMode(key, fallback) {
  try { const value = localStorage.getItem(key); return ['items', 'sessions'].includes(value) ? value : fallback; } catch { return fallback; }
}
function saveMode(key, value) { try { localStorage.setItem(key, value); } catch { /* The current view still works if storage is unavailable. */ } }
const state = { items: [], sessions: [], notifications: [], selected: new Set(), view: 'items', trash: false, currentOnly: false, listMode: savedMode('worklog.list-mode', 'items'), calendarView: 'month', mode: savedMode('worklog.calendar-mode', 'sessions'), date: new Date(), detail: null };
let listRevision = '', notificationRevision = '', calendarMarkup = '', calendarRequest = 0, loadRequest = 0, detailRequest = 0;
let calendarLayout = '', calendarFocusNow = false, calendarClockTimer;
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
let streamConnected = false, refreshQueued = false, refreshing = false, refreshTimer;
const statusLabels = { tracked: '이력 수집', running: '작업 실행 중', queued: '실행 대기', agent_response_pending: '에이전트 응답 대기', completed: '완료', cancelled: '취소됨', failed: '실패', blocked: '진행 불가', interrupted: '중단됨', pending: '실행 대기', session_closed: '구간 종료', session_idle: '대화 대기' };
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
function modal(html) {
  window.dispatchEvent(new Event('worklog:modal-open'));
  const dialog = $('#modal'), content = $('#modal-content'); content.innerHTML = html;
  const heading = content.querySelector('h2');
  if (heading) { heading.id ||= 'modal-heading'; dialog.setAttribute('aria-labelledby', heading.id); }
  else dialog.removeAttribute('aria-labelledby');
  if (!dialog.open) dialog.showModal();
  content.querySelectorAll('[data-close]').forEach(button => button.onclick = () => dialog.close());
}
const integrations = integrationUI({ api, esc, modal, toast, absoluteTime, refresh: async id => { await openDetail(id, undefined, true, true); await load(); } });
const agentConnections = agentConnectionsUI({ api, esc, modal, showAtlassian: integrations.showSettings });
const writing = writingUI({ api, esc, toast, absoluteTime, refresh: async id => { await openDetail(id, undefined, true); await load(); } });
const history = historyUI({ api, esc, eventHTML, invalidated: scheduleRefresh });
const executionSettings = executionSettingsUI({ api, esc, modal, toast });
const automationSettings = automationSettingsUI({ api, esc, modal, toast });
const itemTags = itemTagsUI({ api, esc, modal, toast, refresh: async id => { await openDetail(id, undefined, true, true); await load(true); } });
const reports = reportsUI({ api, esc, modal, toast, absoluteTime, navigate: () => showView('reports'), active: () => state.view === 'reports', showSettings: integrations.showSettings });
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
    updateListControls();
    const sessionsMode = isSessionList(), query = encodeURIComponent($('#search').value);
    const [health, items, sessions, notifications, tags] = await Promise.all([api('/health'), api(`/items?q=${sessionsMode ? '' : query}&jira=${state.trash ? 'all' : $('#jira-filter').value}&trash=${state.trash}${itemTags.filterQuery()}`), sessionsMode ? api(`/sessions?q=${query}`) : Promise.resolve([]), api('/notifications'), api(`/tags?trash=${state.trash}`)]);
    if (requestNumber !== loadRequest) return;
    itemTags.updateFilter(tags);
    $('#connection').textContent = health.runtime_connected ? '서비스 연결됨' : '실행 서비스 연결 대기';
    $('#connection').classList.toggle('offline', !health.runtime_connected);
    if (health.quarantined || health.last_error) $('#connection').textContent = `수집 확인 필요 · ${health.quarantined}건`;
    state.items = items; state.sessions = sessions.filter(session => items.some(item => item.id === session.work_item_id));
    state.notifications = notifications;
    $('#notification-count').textContent = notifications.length;
    $('#notification-count').hidden = !notifications.length;
    const ids = new Set(state.items.map(i => i.id)); for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
    $('#item-count').textContent = health.visible_items;
    const revision = JSON.stringify([sessionsMode, state.trash, state.items, state.sessions]);
    if (state.view === 'items' && (force || revision !== listRevision)) {
      renderItems(); listRevision = revision;
    }
    const notices = JSON.stringify(notifications);
    if (state.view === 'notifications' && (force || notices !== notificationRevision)) {
      renderNotifications(); notificationRevision = notices;
    }
    // Summary edits can change calendar labels without adding an input/output event.
    if (state.view === 'calendar') await renderCalendar();
    if (state.view === 'reports') await reports.refresh();
    $('#error').hidden = true;
  } catch (e) {
    if (requestNumber !== loadRequest) return;
    $('#connection').textContent = '관리 서비스 연결 끊김'; $('#connection').classList.add('offline'); error(e);
  }
}
function isSessionList() { return state.view === 'items' && !state.trash && !state.currentOnly && state.listMode === 'sessions'; }
function updateListControls() {
  const sessionsMode = isSessionList();
  $('#list-mode-control').hidden = state.trash || state.currentOnly;
  $('#list-mode').value = state.listMode;
  $('#jira-filter-control').hidden = state.trash;
  $('#merge').hidden = sessionsMode || state.trash;
  $('#delete-items').hidden = sessionsMode || state.trash;
  $('#restore-items').hidden = !state.trash;
  $('#select-all-control').hidden = sessionsMode;
  $('#trash-view').hidden = state.trash;
  $('#active-items').hidden = !state.trash;
  $('#search').setAttribute('aria-label', sessionsMode ? '세션 검색' : '업무 검색');
  $('#search').placeholder = sessionsMode ? '세션 제목·요약 또는 업무 검색' : '업무 제목과 설명 검색';
  $('#item-list').setAttribute('aria-label', sessionsMode ? '세션 목록' : '업무 목록');
}
function sessionRange(s) {
  const endDay = isoDate(new Date(s.start_at)) === isoDate(new Date(s.end_at)) ? '' : `${dateLabel(s.end_at)} `;
  return `${dateLabel(s.start_at)} ${time(s.start_at)} → ${endDay}${time(s.end_at)}`;
}
function renderSessions() {
  const sessions = state.sessions;
  $('#list-label').textContent = `모든 세션 · ${sessions.length}`;
  $('#selection-label').textContent = '최근 활동순 · 세션을 선택해 입력·응답을 확인하세요';
  $('#merge').disabled = true;
  $('#item-list').innerHTML = sessions.length ? sessions.map(s => `<article class="session-row" data-session-id="${esc(s.id)}" data-item-id="${esc(s.work_item_id)}">
    <div class="item-main"><button class="session-open" title="${esc(s.title)}">${esc(s.title)}</button><p class="session-owner">${esc(s.work_item_title)} · ${esc(s.engine === 'codex' ? 'Codex' : s.engine === 'claude' ? 'Claude' : '하네스')}</p>${s.description ? `<p class="session-preview">${esc(descriptionPreview(s.description))}</p>` : '<p class="session-preview">아직 작성된 요약이 없습니다.</p>'}${itemTags.listHTML(state.items.find(item => item.id === s.work_item_id) || {})}</div>
    <div class="session-meta">${badge(s.pending ? 'agent_response_pending' : s.closed ? 'session_closed' : 'session_idle')}<time datetime="${esc(s.start_at)}" title="${esc(`${absoluteTime(s.start_at)} → ${absoluteTime(s.end_at)}`)}">${esc(sessionRange(s))}</time></div></article>`).join('')
    : `<div class="empty"><strong>${$('#search').value ? '검색 결과가 없습니다' : '아직 기록된 세션이 없습니다'}</strong>${$('#search').value ? '세션 제목·요약이나 연결된 업무로 검색해 보세요.' : '에이전트에서 프롬프트를 입력하면 기록 구간이 이곳에 나타납니다.'}</div>`;
  $('#item-list').querySelectorAll('.session-row').forEach(row => row.querySelector('.session-open').onclick = safe(() => openDetail(row.dataset.itemId, row.dataset.sessionId)));
}
function renderItems() {
  if (isSessionList()) return renderSessions();
  const items = visibleItems(), visibleIds = new Set(items.map(item => item.id));
  for (const id of state.selected) if (!visibleIds.has(id)) state.selected.delete(id);
  const empty = state.trash ? ['휴지통이 비어 있습니다', '삭제한 업무는 이곳에서 세션 이력과 함께 복원할 수 있습니다.']
    : state.currentOnly ? ['현재 진행 중인 업무가 없습니다', '실행 또는 에이전트 응답을 기다리는 업무가 있으면 여기에 표시합니다.']
    : $('#search').value || $('#jira-filter').value !== 'all' || $('#tag-filter').value !== 'all' ? ['검색 결과가 없습니다', '검색어·업무 유형·Jira 연결 필터를 변경해 보세요.']
    : ['아직 기록된 업무가 없습니다', '에이전트에서 요청하거나 CLI로 작업을 실행하면 업무와 세션 이력이 이곳에 나타납니다.'];
  $('#list-label').textContent = `${state.trash ? '삭제된 업무' : state.currentOnly ? '현재 작업' : '모든 업무'} · ${items.length}`;
  $('#item-list').innerHTML = items.length ? items.map(i => `<article class="item-row ${state.selected.has(i.id) ? 'selected' : ''}" data-id="${esc(i.id)}">
    <input type="checkbox" aria-label="${esc(i.title)} 선택" ${state.selected.has(i.id) ? 'checked' : ''}>
    <div class="item-main">${state.trash ? `<strong class="item-title">${esc(i.title)}</strong>` : `<button class="item-open" title="${esc(i.title)}">${esc(i.title)}</button>`}<p>${esc(descriptionPreview(i.description || '첫 요청과 작업 이력이 여기에 모입니다.'))}</p>${itemTags.listHTML(i)}<span class="item-jira ${i.jira_state === 'linked' ? 'linked' : ''}">${esc(i.jira_state === 'linked' ? i.jira_keys.join(' · ') : i.jira_state === 'unknown' ? 'Jira 연결 확인 필요' : '로컬 업무')}</span></div>
    <div class="item-meta">${state.trash ? '<span class="badge">복원 후 이력 확인</span>' : `${badge(i.activity === 'recent' ? i.state : i.activity)}${i.notification_count ? ` <button class="notification-badge" data-item-notifications="${esc(i.id)}" aria-label="${esc(i.title)} 알림 ${i.notification_count}개">알림 ${i.notification_count}</button>` : ''}`}<small>세션 ${i.session_count}개 · <time datetime="${esc(i.last_activity)}" title="${esc(absoluteTime(i.last_activity))}">${dateLabel(i.last_activity)} ${time(i.last_activity)}</time></small>${state.trash ? `<small>삭제 ${esc(dateLabel(i.deleted_at))} ${esc(time(i.deleted_at))}</small>` : ''}</div></article>`).join('')
    : `<div class="empty"><strong>${empty[0]}</strong>${empty[1]}</div>`;
  document.querySelectorAll('.item-row').forEach(row => {
    row.querySelector('input').onchange = e => { e.target.checked ? state.selected.add(row.dataset.id) : state.selected.delete(row.dataset.id); renderItems(); };
    const button = row.querySelector('.item-open'); if (button) button.onclick = safe(() => openDetail(row.dataset.id));
    const notice = row.querySelector('[data-item-notifications]'); if (notice) notice.onclick = safe(async () => {
      await showView('notifications'); focusNotification(state.notifications.find(n => n.work_item_id === row.dataset.id)?.id);
    });
  });
  updateSelection();
}
function visibleItems() {
  return state.items.filter(i => !state.currentOnly || i.is_current);
}
function updateSelection() {
  const count = visibleItems().length;
  $('#select-all').checked = count > 0 && state.selected.size === count;
  $('#select-all').indeterminate = state.selected.size > 0 && state.selected.size < count;
  $('#select-all').disabled = !count;
  $('#merge').disabled = state.selected.size < 2 || state.selected.size > 100;
  $('#merge').title = state.selected.size > 100 ? '한 번에 최대 100개 업무를 병합할 수 있습니다.' : '';
  $('#delete-items').disabled = !state.selected.size;
  $('#restore-items').disabled = !state.selected.size;
  $('#selection-label').textContent = state.selected.size ? `${state.selected.size}개 선택됨${state.selected.size > 100 ? ' · 병합은 한 번에 100개까지' : ''}` : '업무를 선택해 이력을 확인하세요';
}
async function showView(view, currentOnly = false) {
  calendarRequest++;
  state.selected.clear(); state.trash = false;
  state.view = view; state.currentOnly = currentOnly;
  $('#items-view').hidden = view !== 'items'; $('#calendar-view').hidden = view !== 'calendar';
  $('#notifications-view').hidden = view !== 'notifications';
  $('#reports-view').hidden = view !== 'reports';
  if (view === 'notifications' || view === 'reports') closeDetail();
  $('#page-title').textContent = view === 'reports' ? '업무 요약' : view === 'calendar' ? '작업 캘린더' : view === 'notifications' ? '알림' : currentOnly ? '현재 작업' : '업무 목록';
  $('#page-description').textContent = view === 'reports' ? '일별 기록을 모아 분기·반기·연간 업무 요약을 작성하세요.' : view === 'calendar' ? '업무가 이어진 시간과 세션의 흐름을 살펴보세요.' : view === 'notifications' ? '실행·요약·Jira 연동에서 처리할 문제가 생기면 알려드립니다.' : '여러 에이전트의 작업과 대화를 한곳에서 이어 보세요.';
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  $(view === 'reports' ? '#nav-reports' : view === 'calendar' ? '#nav-calendar' : view === 'notifications' ? '#nav-notifications' : '#nav-items').classList.add('active');
  listRevision = ''; notificationRevision = '';
  await load(true);
}
const dismissingNotifications = new Set();
function focusNotification(id) {
  const row = [...document.querySelectorAll('.notification-row')].find(node => node.dataset.notificationId === id);
  row?.scrollIntoView({ block: 'center' }); row?.querySelector('[data-open-notification]')?.focus({ preventScroll: true });
}
function renderNotifications() {
  const focused = document.activeElement?.closest('.notification-row')?.dataset.notificationId;
  const wasDismiss = document.activeElement?.hasAttribute('data-dismiss-notification');
  const labels = { run: '작업 실행', metadata: '업무 정보', summary: '세션 요약', jira_issue: 'Jira 이슈', jira_worklog: 'Jira 업무 로그', jira_transition: 'Jira 상태', jira_content: 'Jira 내용', jira_result_comment: 'Jira 완료 결과' };
  $('#notification-list-label').textContent = `알림 · ${state.notifications.length}`;
  $('#notification-list').innerHTML = state.notifications.length ? state.notifications.map(n => `<article class="notification-row" data-notification-id="${esc(n.id)}">
    <div class="notification-heading"><span class="notification-category">${esc(labels[n.kind] || '작업')}</span><time datetime="${esc(n.occurred_at)}" title="${esc(absoluteTime(n.occurred_at))}">${esc(eventTime(n.occurred_at))}</time></div>
    <h2>${esc(n.title)}</h2><p class="notification-owner">${esc(n.work_item_title)}</p><p class="notification-message">${esc(n.message)}</p>
    <div class="notification-actions"><button class="writing-action writing-action-accent" data-open-notification="${esc(n.id)}">${esc(n.action_label)}</button><button class="notification-dismiss" data-dismiss-notification="${esc(n.id)}" title="이 알림만 지웁니다. 원본 기록과 작업 상태는 유지됩니다." ${dismissingNotifications.has(n.id) ? 'disabled' : ''}>알림 지우기</button></div>
    </article>`).join('') : '<div class="empty"><strong>새 알림이 없습니다</strong>실행·요약·Jira 연동에서 처리할 문제가 생기면 이곳에 표시합니다.</div>';
  $('#notification-list').querySelectorAll('[data-open-notification]').forEach(button => button.onclick = safe(async () => {
    const notice = state.notifications.find(n => n.id === button.dataset.openNotification);
    if (notice) await openNotification(notice);
  }));
  $('#notification-list').querySelectorAll('[data-dismiss-notification]').forEach(button => button.onclick = safe(async () => {
    const index = state.notifications.findIndex(n => n.id === button.dataset.dismissNotification), notice = state.notifications[index];
    if (!notice || dismissingNotifications.has(notice.id)) return;
    dismissingNotifications.add(notice.id); button.disabled = true;
    try {
      await api(`/notifications/${encodeURIComponent(notice.id)}/dismiss`, { method: 'POST', body: { revision: notice.revision } });
      await load(true); toast('알림을 지웠습니다. 원본 기록은 보존됩니다.');
      if (state.view === 'notifications') {
        const next = state.notifications[Math.min(index, state.notifications.length - 1)];
        if (next) focusNotification(next.id); else $('#refresh-notifications').focus();
      }
    } catch (e) { await load(true); throw e; }
    finally {
      dismissingNotifications.delete(notice.id); button.disabled = false;
      $('#notification-list').querySelectorAll('[data-dismiss-notification]').forEach(node => { if (node.dataset.dismissNotification === notice.id) node.disabled = false; });
    }
  }));
  if (focused) {
    const row = [...document.querySelectorAll('.notification-row')].find(node => node.dataset.notificationId === focused);
    row?.querySelector(wasDismiss ? '[data-dismiss-notification]' : '[data-open-notification]')?.focus({ preventScroll: true });
  }
}
async function openNotification(notice) {
  await openDetail(notice.work_item_id, notice.session_id);
  if (state.detail?.item.id !== notice.work_item_id) return;
  let target;
  if (notice.kind === 'run') {
    target = [...$('#detail').querySelectorAll('[data-run-id]')].find(node => node.dataset.runId === notice.run_id);
    if (target) for (let parent = target.parentElement; parent && parent !== $('#detail'); parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  } else if (notice.kind === 'metadata') target = $('#detail .metadata-writing');
  else if (notice.session_id && notice.kind !== 'jira_result_comment') {
    const session = [...$('#detail').querySelectorAll('[data-session-id]')].find(node => node.dataset.sessionId === notice.session_id);
    target = session?.querySelector(notice.kind === 'jira_worklog' ? '.session-sync' : '.session-summary');
  }
  if (!target && notice.kind.startsWith('jira_')) target = [...$('#detail').querySelectorAll('[data-jira-card]')].find(node => node.dataset.jiraCard === notice.link_operation_id) || $('#detail .jira-section');
  if (target) { target.tabIndex = -1; target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
}
function eventHTML(e) {
  const names = { input: '프롬프트 입력', output: '응답 출력', 'turn.failed': '실패', 'turn.interrupted': '중단', 'session.started': '에이전트 시작', 'session.ended': '에이전트 종료', 'tool.started': '도구 시작', 'tool.finished': '도구 종료' };
  const source = e.source === 'system_hook' ? (e.hook_event_name || (e.kind === 'input' ? 'UserPromptSubmit' : 'Stop'))
    : e.source === 'runtime' || e.engine === 'harness' ? '하네스 기록' : '수집 기록';
  return `<details class="event" data-event-id="${esc(e.uid)}" data-kind="${esc(e.kind)}"><summary><span class="event-header"><span class="event-label-title">${names[e.kind] || esc(e.kind)}${e.resolution === 'unresolved' ? ' · 연결 미확인' : ''}</span><time datetime="${esc(e.event_at)}" title="${esc(absoluteTime(e.event_at))}">${eventTime(e.event_at)}</time><span class="event-source" title="${esc(`레코드: ${e.uid}\n수집 시각: ${absoluteTime(e.ingested_at)}`)}">${esc(source)}</span></span></summary><pre>${esc(e.text ?? (e.kind === 'output' ? '응답 본문이 제공되지 않았습니다.' : e.kind === 'input' ? '입력 본문이 제공되지 않았습니다.' : ''))}</pre></details>`;
}
const taskLabels = { 'prd.create': 'PRD 작성', 'mockup.html.create': 'HTML 목업 작성', 'entity.design': '엔티티 설계',
  'text.rewrite': '내용 다시 작성', 'session.summarize': '세션 요약', 'checks.run': '검사 실행', 'verification.report': '검사 보고서', 'test.scenarios.plan': '검증 시나리오 작성' };
const stageLabels = { classify: '분류', plan: '계획', produce: '생성', verify: '검증', review: '검토', repair: '수정', integrate: '통합', render: '전달' };
function executionEventHTML(event, attempts) {
  const identifiers = new Set([event.parent?.task_id, event.turn_id, event.agent_session_id].filter(Boolean));
  const matches = attempts.filter(attempt => identifiers.has(attempt.id));
  const attempt = matches.length === 1 ? matches[0] : null;
  const stage = Object.hasOwn(stageLabels, event.stage) ? event.stage : attempt?.stage;
  const phase = Object.hasOwn(stageLabels, stage) ? stageLabels[stage] : '작업자';
  const action = { input: '입력', output: '결과', 'turn.failed': '실패', 'turn.interrupted': '중단' }[event.kind] || event.kind;
  const label = phase === '작업자' ? `${phase} ${action}` : `${phase} · ${action}`;
  const milliseconds = attempt?.ended_at && Date.parse(attempt.ended_at) - Date.parse(attempt.started_at);
  const elapsed = event.kind !== 'input' && Number.isFinite(milliseconds) && milliseconds >= 0
    ? ` · 소요 ${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(milliseconds / 1000)}초` : '';
  return `<details class="execution-event" data-stage="${esc(Object.hasOwn(stageLabels, stage) ? stage : '')}" data-kind="${esc(event.kind)}"><summary><strong>${esc(label)}</strong> · ${esc(absoluteTime(event.event_at))}${esc(elapsed)}</summary><pre>${esc(event.text ?? '본문이 제공되지 않았습니다.')}</pre></details>`;
}
function runHTML(run) {
  const fallback = { completed: '작업이 완료되었습니다.', pending: '작업을 준비하고 있습니다.', running: '요청한 작업을 수행하고 있습니다.',
    failed: '작업이 실패했습니다.', blocked: '진행에 필요한 내용을 확인하세요.', cancelled: '작업이 취소되었습니다.', interrupted: '작업이 중단되었습니다.' };
  return `<article class="run session-result" data-run-id="${esc(run.id)}"><div class="result-heading"><h4>${esc(taskLabels[run.task] || run.task || '연결된 작업')}</h4>${badge(run.status)}</div>
    <p>${esc(run.message || fallback[run.status] || '실행 상세에서 기록을 확인하세요.')}</p>
    <div class="result-actions">${['pending', 'running'].includes(run.status) ? `<button class="secondary" data-cancel="${esc(run.id)}">실행 취소</button>` : ''}
      ${['failed', 'blocked', 'interrupted', 'cancelled'].includes(run.status) ? `<button class="secondary" data-resume="${esc(run.id)}">${run.plan_id ? '전체 계획 재개' : '다시 실행'}</button>` : ''}
      ${run.artifact && run.status === 'completed' ? `<button class="writing-action writing-action-accent" data-artifact="${esc(run.id)}">산출물 보기</button>` : ''}
      ${run.evidence ? `<button class="secondary" data-evidence="${esc(run.id)}">검사 결과 보기</button>` : ''}
      <button class="secondary" data-run-details="${esc(run.id)}">실행 상세</button></div></article>`;
}
async function runDetails(run, data) {
  const { records: workers, attempts = [] } = await api(`/items/${data.item.id}/runs/${run.id}/events`);
  if (state.detail?.item.id !== data.item.id || $('#detail').hidden) return;
  modal(`<h2>실행 상세</h2><p>${esc(taskLabels[run.task] || run.task)} · ${esc(statusLabels[run.status] || run.status)}</p>
    <dl class="execution-facts"><dt>작업</dt><dd>${esc(run.task)}</dd><dt>엔진</dt><dd>${esc(run.engine)}</dd>
    <dt>실행 ID</dt><dd>${esc(run.id)}</dd><dt>현재 단계</dt><dd>${esc(stageLabels[run.stage] || run.stage || '준비')} · 수정 ${run.round || 0}회</dd>
    <dt>시작</dt><dd>${esc(absoluteTime(run.created_at))}</dd><dt>최근 상태</dt><dd>${esc(absoluteTime(run.updated_at))}</dd></dl>
    ${run.message ? `<p>${esc(run.message)}</p>` : ''}<h3>실행 기록 <small>${workers.length}</small></h3>
    <p class="help">생성·검토·수정 과정의 진단 기록입니다. 사용자 세션의 작업 시간에는 추가하지 않습니다.</p>
    <div class="execution-events">${workers.length ? workers.map(event => executionEventHTML(event, attempts)).join('') : '<p class="help">이 실행에 수집된 작업자 입출력은 없습니다.</p>'}</div>
    <div class="dialog-actions"><button data-close>닫기</button></div>`);
}
async function openDetail(id, sessionId, refresh = false, force = false) {
  const requestNumber = ++detailRequest;
  let data;
  try { data = await api(`/items/${id}?view=summary`); }
  catch (e) {
    if (requestNumber === detailRequest && e.status === 404) {
      closeDetail(); if (!refresh) toast('업무가 삭제되었거나 더 이상 표시되지 않습니다. 휴지통을 확인하세요.');
      return;
    }
    throw e;
  }
  if (requestNumber !== detailRequest) return;
  if (refresh && !force && JSON.stringify(data) === JSON.stringify(state.detail)) { history.refresh(); return; }
  const panel = $('#detail');
  const expanded = refresh ? [...$('#detail').querySelectorAll('[data-session-id][open]')].map(e => e.dataset.sessionId) : [];
  const expandedResults = refresh ? [...$('#detail').querySelectorAll('[data-results-session][open]')].map(e => e.dataset.resultsSession) : [];
  const unlinkedResultsOpen = refresh && !!panel.querySelector('.unlinked-results[open]');
  const scrollTop = refresh ? $('#detail').scrollTop : 0;
  const focused = refresh && panel.contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.id, focusSession = focused?.closest('[data-session-id]')?.dataset.sessionId;
  const focusHistory = focused?.closest('[data-raw-history-key]')?.dataset.rawHistoryKey;
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
    ${itemTags.detailHTML(item)}
    ${item.activities?.length > 1 ? `<p class="help">함께 기록된 상태: ${item.activities.slice(1).map(a => esc(statusLabels[a])).join(' · ')}</p>` : ''}
    ${item.aliases.length ? `<p>병합된 업무 ${item.aliases.length}개 · 원본 세션 유지</p>` : ''}
    ${integrations.jiraHTML(data)}
    <section class="detail-section"><h3>세션 이력 <small>${sessions.length}</small></h3><div class="history-toolbar"><span id="history-live">${liveStatus()}</span><span>발생 시각 · 최신순</span></div>${sessions.map(s => {
      const results = runs.filter(r => r.session_id === s.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const pendingLabel = results.some(r => r.status === 'running') ? '작업 실행 중' : results.some(r => r.status === 'pending') ? '실행 대기' : s.pending ? '에이전트 응답 대기' : '';
      return `<details class="session-card" data-session-id="${esc(s.id)}" ${s.id === sessionId ? 'open' : ''}><summary><span class="session-time">${dateLabel(s.start_at)} ${time(s.start_at)} → ${time(s.end_at)}${pendingLabel ? ` · ${pendingLabel}` : ''}${results.length ? `<span class="session-result-count">작업 ${results.length}</span>` : ''}</span>${writing.sessionHeadingHTML(s)}</summary>
        <small class="session-source" title="${esc(s.agent_session_id)}">${esc(s.engine === 'codex' ? 'Codex' : s.engine === 'claude' ? 'Claude' : '하네스')} 대화</small>
        ${writing.sessionHTML(s)}${integrations.sessionHTML(s, data)}
        ${results.length ? `<details class="session-results" data-results-session="${esc(s.id)}"><summary>연결된 작업 ${results.length}개</summary>${results.map(runHTML).join('')}</details>` : ''}
        ${history.html(s.id)}</details>`;
    }).join('') || '<small>첫 입력을 기다리고 있습니다.</small>'}</section>
    ${unlinkedRuns.length ? `<details class="detail-section unlinked-results" ${unlinkedResultsOpen ? 'open' : ''}><summary>세션 연결 대기 · 작업 ${unlinkedRuns.length}개</summary><p class="help">원본 입력을 확인하면 해당 세션에 표시합니다.</p>${unlinkedRuns.map(runHTML).join('')}</details>` : ''}
    ${data.unlinked_history.count ? `<section class="detail-section"><h3>연결 미확인 출력 <small>${data.unlinked_history.count}건</small></h3>${history.html(null)}</section>` : ''}`;
  for (const node of $('#detail').querySelectorAll('[data-session-id]')) if (expanded.includes(node.dataset.sessionId)) node.open = true;
  for (const node of panel.querySelectorAll('[data-results-session]')) if (expandedResults.includes(node.dataset.resultsSession)) node.open = true;
  history.mount(panel);
  $('#detail').scrollTop = scrollTop;
  if (anchorId) {
    const current = [...panel.querySelectorAll('.event')].find(e => e.dataset.eventId === anchorId);
    if (current) panel.scrollTop += current.getBoundingClientRect().top - anchorTop;
  }
  const restoreFocus = focused?.isConnected ? focused : focusId ? document.getElementById(focusId) : focusHistory
    ? [...panel.querySelectorAll('[data-raw-history-key]')].find(e => e.dataset.rawHistoryKey === focusHistory)?.querySelector('summary') : focusSession
    ? [...panel.querySelectorAll('[data-session-id]')].find(e => e.dataset.sessionId === focusSession)?.querySelector('summary') : null;
  restoreFocus?.focus({ preventScroll: true });
  integrations.bindDetail(data);
  writing.bindDetail(data);
  itemTags.bindDetail(item);
  if (sessionId && !refresh) {
    const selectedSession = [...panel.querySelectorAll('[data-session-id]')].find(node => node.dataset.sessionId === sessionId);
    selectedSession?.scrollIntoView({ block: 'start' });
    selectedSession?.querySelector('summary')?.focus({ preventScroll: true });
  }
  panel.querySelectorAll('[data-run-details]').forEach(button => button.onclick = safe(async () => {
    const run = data.runs.find(r => r.id === button.dataset.runDetails);
    if (run) await runDetails(run, data); else toast('실행 이력을 수집하고 있습니다. 잠시 후 다시 확인하세요.');
  }));
  $('#close-detail').onclick = closeDetail;
  $('#edit-item').onclick = () => {
    modal(`<h2>업무 정보 편집</h2><p>직접 편집한 값은 자동 갱신에서 보호됩니다.</p><label for="edit-title">제목</label><input id="edit-title" maxlength="200" value="${esc(item.title)}"><label for="edit-description">설명</label><textarea id="edit-description" maxlength="5000" aria-describedby="edit-description-help">${esc(item.description)}</textarea><p id="edit-description-help" class="help">Jira 위키 형식으로 h2. 배경, h2. 목표, h2. 요구사항, h2. 작업 범위, h2. 참고사항을 작성하고 목록은 * 로 시작하세요. 기존 Markdown과 일반 텍스트도 원문 그대로 저장됩니다.</p><div class="dialog-actions"><button data-close>취소</button><button class="primary" id="save-item">저장</button></div>`);
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
function updateCalendarClock() {
  if (state.view !== 'calendar') return;
  const now = new Date(), today = isoDate(now), minutes = now.getHours() * 60 + now.getMinutes();
  const clock = $('#calendar-now');
  clock.dateTime = now.toISOString();
  clock.textContent = `현재 ${now.getMonth() + 1}월 ${now.getDate()}일 (${weekdays[now.getDay()]}) ${time(now)}`;
  const calendar = $('#calendar');
  calendar.querySelectorAll('[data-date]').forEach(node => {
    const current = node.dataset.date === today;
    node.classList.toggle('is-today', current);
    const date = node.querySelector(':scope > time');
    if (date) {
      date.classList.toggle('current', current);
      if (current) date.setAttribute('aria-current', 'date'); else date.removeAttribute('aria-current');
    }
  });
  const todayColumn = calendar.querySelector(`.time-day[data-date="${today}"]`);
  calendar.querySelectorAll('.weekday').forEach(node => node.classList.toggle('is-today',
    Boolean(calendar.querySelector(`.month-day[data-date="${today}"]`)) && Number(node.dataset.weekday) === now.getDay()));
  calendar.querySelectorAll('.current-time-line').forEach(line => { if (line.parentElement !== todayColumn) line.remove(); });
  if (todayColumn) {
    let line = todayColumn.querySelector('.current-time-line');
    if (!line) { line = document.createElement('div'); line.className = 'current-time-line'; line.append(document.createElement('time')); todayColumn.append(line); }
    line.dataset.currentTime = time(now);
    line.classList.toggle('near-midnight', minutes < 20);
    line.style.top = `${minutes}px`;
    line.firstElementChild.dateTime = now.toISOString();
    line.firstElementChild.textContent = time(now);
    line.setAttribute('aria-label', `현재 시각 ${time(now)}`);
  }
}
function tickCalendarClock() {
  clearTimeout(calendarClockTimer);
  updateCalendarClock();
  // Update the clock without replacing events, refetching data or moving the reader.
  calendarClockTimer = setTimeout(tickCalendarClock, 60000 - Date.now() % 60000);
}
function focusCalendarNow() {
  const scroller = $('#calendar .time-calendar'), today = $('#calendar .time-day.is-today');
  if (!scroller) return;
  if (!today) { scroller.scrollTop = 7 * 60; return; }
  const now = new Date(), minutes = now.getHours() * 60 + now.getMinutes();
  const headerHeight = scroller.querySelector('.time-header').offsetHeight;
  scroller.scrollTop = minutes - (scroller.clientHeight - headerHeight) / 2;
  const dayRect = today.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
  if (dayRect.left < viewport.left + 52 || dayRect.right > viewport.right) {
    scroller.scrollLeft += dayRect.left - viewport.left - 52;
  }
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
  const owner = state.mode === 'sessions' && e.work_item_title && e.work_item_title !== e.title ? e.work_item_title : '';
  return `<button class="calendar-event ${cls}" style="${style}" data-event="${esc(e.id)}" aria-label="${esc(e.title)} ${owner ? `${esc(owner)} ` : ''}${time(e.start_at)} 세션 ${e.session_ids.length}개" title="${esc(e.title)}${owner ? ` · ${esc(owner)}` : ''} · ${absoluteTime(e.start_at)} → ${absoluteTime(e.end_at)}"><span class="event-time">${time(e.start_at)}</span><span class="event-label">${esc(e.title)}${owner ? `<small>${esc(owner)}</small>` : ''}</span></button>`;
}
async function renderCalendar() {
  const requestNumber = ++calendarRequest;
  const mode = state.mode, { start, end } = range(), entries = await api(`/calendar?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&mode=${mode}`);
  if (requestNumber !== calendarRequest || state.view !== 'calendar') return;
  $('#calendar-mode').value = mode;
  $('#calendar-unit-label').textContent = mode === 'items' ? '업무별 보기' : '세션별 보기';
  $('#calendar-date').value = isoDate(state.date);
  $('#calendar-title').textContent = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', ...(state.calendarView === 'month' ? {} : { day: 'numeric' }) }).format(state.date);
  $('#timezone-label').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.querySelectorAll('#calendar-view [data-view]').forEach(b => {
    const selected = b.dataset.view === state.calendarView;
    b.classList.toggle('active', selected); b.setAttribute('aria-pressed', String(selected));
  });
  const days = []; for (let d = new Date(start); d < end; d = addDays(d, 1)) days.push(d);
  const dayEntries = days.map(d => entriesForDay(entries, d));
  const moreLists = []; let markup;
  if (state.calendarView === 'month') {
    markup = `<div class="month-grid">${weekdays.map((d, i) => `<div class="weekday" data-weekday="${i}">${d}</div>`).join('')}${days.map((d, i) => {
      const list = dayEntries[i];
      return `<div class="month-day ${d.getMonth() === state.date.getMonth() ? '' : 'outside'}" data-date="${isoDate(d)}"><time class="day-number" datetime="${isoDate(d)}">${d.getDate()}</time>${reports.selectDateHTML(isoDate(d))}${list.slice(0, 2).map(e => eventButton(e)).join('')}${list.length > 2 ? (moreLists.push({ entries: list, day: d }), `<button class="more" data-more="${moreLists.length - 1}">+${list.length - 2}개 더보기</button>`) : ''}</div>`;
    }).join('')}</div>`;
  } else {
    const labels = Array.from({ length: 24 }, (_, h) => `<span style="top:${h * 60 + 4}px">${String(h).padStart(2, '0')}:00</span>`).join('');
    markup = `<div class="time-calendar" style="--days:${days.length}"><div class="time-header"><div>시간</div>${days.map((d, i) => `<div data-date="${isoDate(d)}"><time datetime="${isoDate(d)}">${dateLabel(d)} <span class="day-weekday">(${weekdays[d.getDay()]})</span></time>${state.calendarView === 'week' ? reports.selectDateHTML(isoDate(d)) : ''}${dayEntries[i].length > 2 ? (moreLists.push({ entries: dayEntries[i], day: d }), `<button class="more day-more" data-more="${moreLists.length - 1}">${state.mode === 'items' ? '업무' : '세션'} ${dayEntries[i].length}개 더보기</button>`) : ''}</div>`).join('')}</div><div class="time-body"><div class="time-labels">${labels}</div>${days.map((day, i) => {
      const list = dayEntries[i];
      // Position by local wall clock; DST offsets remain visible in full timestamps in the detail.
      const position = timestamp => { const date = new Date(timestamp); return date <= day ? 0 : date >= addDays(day, 1) ? 1440 : date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60; };
      const placed = list.map(e => ({ e, top: position(e.start_at), bottom: Math.max(position(e.start_at) + 38, position(e.end_at)) })).sort((a, b) => a.top - b.top);
      const clusters = []; for (const p of placed) { let c = clusters.at(-1); if (!c || p.top >= c.end) { c = { entries: [], end: p.bottom }; clusters.push(c); } c.entries.push(p); c.end = Math.max(c.end, p.bottom); }
      return `<div class="time-day" data-date="${isoDate(day)}">${clusters.map(c => {
        const visible = c.entries.slice(0, 2);
        return visible.map((p, n) => eventButton(p.e, 'timed-event', `top:${p.top}px;height:${Math.min(1440 - p.top, p.bottom - p.top)}px;left:${n * 50 + 1}%;width:${visible.length > 1 ? 48 : 97}%`)).join('') + (c.entries.length > 2 ? (moreLists.push({ entries: list, day }), `<button class="more time-more" style="top:${Math.min(c.entries[0].top + 40, 1400)}px" data-more="${moreLists.length - 1}">+${c.entries.length - 2}개 더보기</button>`) : '');
      }).join('')}</div>`;
    }).join('')}</div></div>`;
  }
  // Repeated snapshots must not detach a keyboard-focused button or reset scroll.
  const layout = `${state.calendarView}:${isoDate(start)}`;
  const changedPeriod = calendarLayout !== layout;
  if (calendarMarkup !== markup) {
    const previous = $('#calendar .time-calendar');
    const scroll = previous ? { top: previous.scrollTop, left: previous.scrollLeft } : null;
    const focused = $('#calendar').contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.event;
    const focusReportDate = focused?.dataset.reportDate;
    const focusDate = focused?.closest('[data-date]')?.dataset.date;
    const focusMore = focused?.hasAttribute('data-more');
    calendarMarkup = markup; $('#calendar').innerHTML = markup;
    const next = $('#calendar .time-calendar');
    if (next && scroll && !changedPeriod) { next.scrollTop = scroll.top; next.scrollLeft = scroll.left; }
    if (!changedPeriod && focused) {
      // A midnight-spanning event has a button on each day; overflow counts can change.
      const moreCandidates = focusMore ? [...$('#calendar').querySelectorAll('[data-more]')].filter(b => b.closest('[data-date]')?.dataset.date === focusDate && b.className === focused.className) : [];
      const target = focusReportDate ? [...$('#calendar').querySelectorAll('[data-report-date]')].find(input => input.dataset.reportDate === focusReportDate)
        : focusKey ? [...$('#calendar').querySelectorAll('[data-event]')].find(b => b.dataset.event === focusKey && b.closest('[data-date]')?.dataset.date === focusDate)
        : moreCandidates.find(b => b.style.top === focused.style.top) || moreCandidates[0];
      target?.focus({ preventScroll: true });
    }
  }
  calendarLayout = layout;
  updateCalendarClock();
  if (changedPeriod || calendarFocusNow) focusCalendarNow();
  calendarFocusNow = false;
  reports.bindCalendar();
  const allEntries = [...entries, ...dayEntries.flat()];
  $('#calendar').querySelectorAll('[data-event]').forEach(b => b.onclick = safe(async () => {
    const e = allEntries.find(e => e.id === b.dataset.event); await openDetail(e.work_item_id, mode === 'sessions' ? e.session_ids[0] : undefined);
  }));
  $('#calendar').querySelectorAll('[data-more]').forEach(b => b.onclick = () => {
    const { entries: list, day } = moreLists[Number(b.dataset.more)];
    modal(`<h2>${dateLabel(day)} · ${mode === 'items' ? '업무' : '세션'} ${list.length}개</h2><div class="dialog-list">${list.map((e, i) => `<button class="dialog-entry" data-entry="${i}">${esc(e.title)}${mode === 'sessions' && e.work_item_title !== e.title ? `<small>${esc(e.work_item_title)}</small>` : ''}<small>${time(e.start_at)}–${time(e.end_at)} · 세션 ${new Set(e.session_ids).size}개</small></button>`).join('')}</div><div class="dialog-actions"><button data-close>닫기</button></div>`);
    $('#modal').querySelectorAll('[data-entry]').forEach(button => button.onclick = safe(async () => { const e = list[Number(button.dataset.entry)]; $('#modal').close(); await openDetail(e.work_item_id, mode === 'sessions' ? e.session_ids[0] : undefined); }));
  });
}
$('#nav-items').onclick = safe(() => showView('items'));
$('#nav-calendar').onclick = safe(() => showView('calendar'));
$('#nav-reports').onclick = safe(() => showView('reports'));
$('#nav-notifications').onclick = safe(() => showView('notifications'));
$('#refresh-notifications').onclick = safe(() => load(true));
$('#refresh').onclick = safe(() => load(true));
function closeDetail() { detailRequest++; $('#detail').hidden = true; state.detail = null; history.clear(); }
function clearSelection() { state.selected.clear(); updateSelection(); document.querySelectorAll('.item-row').forEach(row => { row.classList.remove('selected'); row.querySelector('input').checked = false; }); }
let searchTimer; $('#search').oninput = () => { clearTimeout(searchTimer); clearSelection(); loadRequest++; searchTimer = setTimeout(() => load(true), 200); };
$('#jira-filter').onchange = safe(async () => { clearTimeout(searchTimer); clearSelection(); await load(true); });
$('#tag-filter').onchange = safe(async () => { clearTimeout(searchTimer); clearSelection(); await load(true); });
$('#select-all').onchange = e => { state.selected = e.target.checked ? new Set(visibleItems().map(item => item.id)) : new Set(); renderItems(); };
$('#trash-view').onclick = safe(async () => {
  clearTimeout(searchTimer); closeDetail(); clearSelection(); state.trash = true;
  state.currentOnly = false; $('#search').value = '';
  $('#page-title').textContent = '휴지통'; $('#page-description').textContent = '삭제한 업무를 세션 이력과 함께 복원할 수 있습니다. Jira 이슈는 보존됩니다.';
  await load(true);
});
$('#active-items').onclick = safe(async () => { $('#search').value = ''; await showView('items'); });
function confirmVisibility(action) {
  const selected = visibleItems().filter(item => state.selected.has(item.id));
  if (!selected.length) return;
  const ids = selected.map(item => item.id), versions = Object.fromEntries(selected.map(item => [item.id, item.version]));
  const restoring = action === 'restore', verb = restoring ? '복원' : '삭제';
  modal(`<h2>${ids.length}개 업무 ${verb}</h2><p>${restoring ? '선택한 업무와 연결된 세션 이력을 목록과 캘린더에 다시 표시합니다.' : '목록과 캘린더에서 숨기고 휴지통으로 이동합니다. 원본 세션 이력과 Jira 이슈는 보존되며, 진행 중인 사용자 작업은 계속됩니다.'}</p><ul class="operation-items">${selected.map(item => `<li>${esc(item.title)} <small>세션 ${item.session_count}개</small></li>`).join('')}</ul><div id="operation-error" class="error" role="alert" hidden></div><div class="dialog-actions"><button data-close>취소</button><button id="confirm-${action}" class="primary">${verb}</button></div>`);
  const operationId = crypto.randomUUID(), button = $(`#confirm-${action}`);
  button.onclick = async () => {
    const dialog = $('#modal'), cancel = dialog.querySelector('[data-close]'), preventClose = event => event.preventDefault();
    dialog.addEventListener('cancel', preventClose); cancel.disabled = true;
    button.disabled = true; $('#operation-error').hidden = true;
    try {
      await api(`/items/${action}`, { method: 'POST', body: { ids, versions, operation_id: operationId } });
      if (state.detail && ids.includes(state.detail.item.id)) closeDetail();
      clearSelection(); $('#modal').close(); await load(true); toast(`${ids.length}개 업무를 ${verb}했습니다.`);
    } catch (e) { $('#operation-error').textContent = e.message; $('#operation-error').hidden = false; }
    finally { button.disabled = false; cancel.disabled = false; dialog.removeEventListener('cancel', preventClose); }
  };
}
$('#delete-items').onclick = () => confirmVisibility('delete');
$('#restore-items').onclick = () => confirmVisibility('restore');
$('#list-mode').onchange = safe(async e => {
  clearTimeout(searchTimer);
  state.listMode = e.target.value; saveMode('worklog.list-mode', state.listMode);
  state.selected.clear(); listRevision = '';
  updateListControls();
  $('#item-list').innerHTML = '<div class="empty" role="status">목록을 불러오는 중입니다.</div>';
  await load(true);
});
$('#merge').onclick = () => {
  const visible = new Map(visibleItems().map(item => [item.id, item]));
  const selected = [...state.selected].map(id => visible.get(id)).filter(Boolean), ids = selected.map(item => item.id);
  if (ids.length < 2) return;
  modal(`<h2>${ids.length}개 업무를 하나로 병합</h2><p>모든 세션 이력을 대표 업무 아래에 모읍니다. 기존 세션과 입력·출력 시각은 보존됩니다.</p><label for="merge-target">대표 업무</label><select id="merge-target">${selected.map(i => `<option value="${esc(i.id)}">${esc(i.title)}</option>`).join('')}</select><p>세션 ${selected.reduce((n, i) => n + i.session_count, 0)}개가 연결됩니다.</p><div class="dialog-actions"><button data-close>취소</button><button id="confirm-merge" class="primary">하나로 병합</button></div>`);
  const operationId = crypto.randomUUID();
  $('#confirm-merge').onclick = safe(async () => {
    $('#confirm-merge').disabled = true;
    try { const result = await api('/merge', { method: 'POST', body: { ids, target: $('#merge-target').value, operation_id: operationId } }); state.selected.clear(); $('#modal').close(); await load(); await openDetail(result.id); toast('업무가 병합되었습니다.'); }
    finally { if ($('#confirm-merge')) $('#confirm-merge').disabled = false; }
  });
};
$('#calendar-mode').value = state.mode;
$('#calendar-mode').onchange = safe(async e => { state.mode = e.target.value; saveMode('worklog.calendar-mode', state.mode); await renderCalendar(); });
$('#calendar-date').onchange = safe(async e => {
  const date = new Date(`${e.target.value}T12:00:00`);
  if (Number.isNaN(date.getTime())) { e.target.value = isoDate(state.date); return; }
  state.date = date; await renderCalendar();
});
async function switchCalendarView(view) {
  if (state.calendarView === view) return;
  state.calendarView = view; await renderCalendar();
}
document.querySelectorAll('#calendar-view [data-view]').forEach(b => b.onclick = safe(() => switchCalendarView(b.dataset.view)));
document.addEventListener('keydown', safe(async e => {
  if (state.view !== 'calendar' || e.defaultPrevented || e.repeat || e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || document.querySelector('dialog[open]')) return;
  if (e.target instanceof Element && (e.target.closest('input, textarea, select, [role="textbox"]') || e.target.isContentEditable)) return;
  const view = { d: 'day', w: 'week', m: 'month' }[e.key.toLowerCase()];
  if (!view) return;
  e.preventDefault(); await switchCalendarView(view);
}));
function move(direction) { if (state.calendarView === 'month') state.date = new Date(state.date.getFullYear(), state.date.getMonth() + direction, 1); else state.date = addDays(state.date, direction * (state.calendarView === 'week' ? 7 : 1)); return renderCalendar(); }
$('#previous').onclick = safe(() => move(-1)); $('#next').onclick = safe(() => move(1));
$('#today').onclick = safe(() => { state.date = new Date(); calendarFocusNow = true; return renderCalendar(); });
$('#settings').onclick = safe(agentConnections.showSettings);
$('#execution-settings').onclick = safe(executionSettings.showSettings);
$('#automation-settings').onclick = safe(automationSettings.showSettings);
window.addEventListener('harness:navigate', safe(async e => {
  let route = typeof e.detail === 'string' ? { view: e.detail } : e.detail;
  if (route && ['attention', 'waiting-user'].includes(route.view)) route = { ...route, view: 'notifications' };
  if (!route || !['items', 'current', 'notifications', 'calendar', 'settings'].includes(route.view)) return;
  $('#modal').close(); $('#search').value = ''; $('#tag-filter').value = 'all';
  if (state.detail) $('#close-detail').click();
  if (route.view === 'settings') return agentConnections.showSettings();
  if (route.view === 'calendar') { state.date = new Date(); calendarFocusNow = true; return showView('calendar'); }
  if (route.view === 'notifications') {
    await showView('notifications');
    const notice = state.notifications.find(n => n.id === route.notification_id);
    if (notice) { focusNotification(notice.id); await openNotification(notice); }
    else if (route.notification_id) toast('해당 알림이 해결되었거나 지워졌습니다.');
    return;
  }
  await showView('items', route.view === 'current');
  if (typeof route.item_id === 'string' && route.item_id.length <= 200) await openDetail(route.item_id);
}));
tickCalendarClock();
window.addEventListener('focus', tickCalendarClock);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tickCalendarClock(); });
await load();
window.webkit?.messageHandlers?.mainReady?.postMessage({ ready: true });
void subscribeChanges();
// A periodic snapshot also checks service health; live updates never wait for this timer.
setInterval(scheduleRefresh, 5000);
