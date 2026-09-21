const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let active = window.__HARNESS_QUICK_VISIBLE__ !== false, busy = false, queued = false, snapshot = null, revision = '', poll;
let controller, streamController, streaming = false;
const labels = { running: '작업 실행 중', queued: '실행 대기', agent_response_pending: '에이전트 응답 대기', completed: '완료', cancelled: '취소됨', tracked: '이력 수집' };
const activityLabel = (activity, connected) => ['running', 'queued'].includes(activity) && !connected ? '실행 상태 미확인' : labels[activity];
const stamp = value => new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
function navigate(route) {
  const bridge = window.webkit?.messageHandlers?.openWorkLog;
  if (bridge) bridge.postMessage(route);
  else window.dispatchEvent(new CustomEvent('harness:open-main', { detail: route }));
}
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.notification) navigate({ view: 'notifications', notification_id: button.dataset.notification });
  else if (button.dataset.item) navigate({ view: 'items', item_id: button.dataset.item });
  else if (button.dataset.view) navigate({ view: button.dataset.view });
});
function render(data) {
  const h = data.health, issue = h.quarantined || h.last_error;
  $('#quick-health').textContent = issue ? '이력 수집 확인 필요 · 전체 창에서 확인하세요.' : h.runtime_connected ? '실행·관리 서비스 연결됨' : '관리 연결됨 · 실행 상태 확인 중';
  $('#quick-health').className = `quick-health ${issue ? '' : 'connected'}`;
  document.body.dataset.stale = 'false';
  $('#current-count').textContent = data.counts.current; $('#notification-count').textContent = data.counts.notifications;
  const next = JSON.stringify([data.counts, data.current, data.notifications, data.recent, h.runtime_connected]);
  if (next === revision) return; revision = next;
  const list = $('.quick-content'), scroll = list.scrollTop;
  const focused = document.activeElement, focus = focused?.dataset.notification ? ['notification', focused.dataset.notification]
    : focused?.dataset.item ? ['item', focused.dataset.item] : null;
  $('#quick-groups').innerHTML = [
    ['notifications', '알림', '현재 표시할 알림이 없습니다.', 'notifications'],
    ['current', '현재 작업', '실행 또는 에이전트 응답을 기다리는 업무가 없습니다.', 'current'],
    ['recent', '최근 업무', '에이전트에서 작업하면 이곳에 기록됩니다.', 'items']
  ].map(([key, title, empty, view]) => `<section class="quick-group" data-group="${key}">
    <div class="quick-group-heading"><h2>${title} <span>${data.counts[key]}</span></h2>${data.counts[key] > data[key].length ? `<button class="quick-more" data-view="${view}">+${data.counts[key] - data[key].length}개 더 보기</button>` : ''}</div>
    ${data[key].length ? data[key].map(item => {
      if (key === 'notifications') return `<button class="quick-item quick-notification" data-notification="${esc(item.id)}" aria-label="${esc(`${item.work_item_title} · ${item.title} 알림 열기`)}" title="${esc(item.message || item.title)}">
        <span class="quick-notification-owner">${esc(item.work_item_title)}</span><span class="quick-item-title">${esc(item.title)}</span>
        ${item.message ? `<span class="quick-notification-message">${esc(item.message)}</span>` : ''}
        <span class="quick-item-meta"><span class="quick-notification-action">${esc(item.action_label || '내용 확인')}</span><time datetime="${esc(item.occurred_at)}">${stamp(item.occurred_at)}</time></span></button>`;
      const status = activityLabel(item.activity, h.runtime_connected) || labels[item.state] || '기록됨';
      const secondary = (item.activities || []).filter(a => a !== item.activity).map(a => activityLabel(a, h.runtime_connected)).filter(Boolean);
      return `<button class="quick-item" data-item="${esc(item.id)}" aria-label="${esc(item.title)} 상세 열기" title="${esc(item.title)}">
        <span class="quick-item-title">${esc(item.title)}</span><span class="quick-item-meta"><span class="${esc(item.activity)}">${esc(status)}</span><time datetime="${esc(item.last_activity)}">${stamp(item.last_activity)}</time></span>${secondary.length ? `<span class="quick-secondary">추가 상태: ${esc([...new Set(secondary)].join(' · '))}</span>` : ''}</button>`;
    }).join('') : `<p class="quick-empty">${empty}</p>`}</section>`).join('');
  list.scrollTop = scroll;
  if (focus) [...document.querySelectorAll(`[data-${focus[0]}]`)].find(b => b.dataset[focus[0]] === focus[1])?.focus({ preventScroll: true });
}
async function refresh() {
  if (!active) return;
  if (busy) { queued = true; return; } busy = true;
  controller = new AbortController(); const requestController = controller;
  try {
    if (!window.__HARNESS_TOKEN__) throw new Error('앱 연결 정보가 없습니다.');
    const response = await fetch('/api/quick', { headers: { Authorization: `Bearer ${window.__HARNESS_TOKEN__}` }, signal: requestController.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('관리 서비스 조회 실패');
    const data = await response.json(); if (!active || requestController.signal.aborted) return;
    snapshot = data; render(data);
  } catch (e) {
    if (requestController.signal.aborted) return;
    $('#quick-health').textContent = snapshot ? `연결 끊김 · ${stamp(snapshot.observed_at)}에 확인한 정보` : '관리 서비스 연결 대기 · 자동으로 다시 확인합니다.';
    $('#quick-health').className = 'quick-health stale'; document.body.dataset.stale = 'true';
    if (!snapshot) $('#quick-groups').innerHTML = '<p class="quick-empty">서비스에 연결되면 현재 작업과 최근 업무가 표시됩니다.</p>';
  } finally {
    busy = false; if (queued) { queued = false; void refresh(); }
  }
}
async function subscribe() {
  if (streaming || !active) return; streaming = true;
  const requestController = new AbortController(); streamController = requestController; let reader;
  try {
    const response = await fetch('/api/updates', { headers: { Authorization: `Bearer ${window.__HARNESS_TOKEN__}` }, signal: requestController.signal });
    if (!response.ok || !response.body) return;
    reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (active && !requestController.signal.aborted) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }); let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (frame.includes('event: change')) void refresh(); }
    }
  } catch { /* The visible panel polls while the stream reconnects. */ }
  finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); streaming = false; }
}
function setActive(value) {
  active = value; clearInterval(poll);
  if (!active) { queued = false; controller?.abort(); streamController?.abort(); return; }
  void refresh(); void subscribe(); poll = setInterval(() => { void refresh(); void subscribe(); }, 4000);
}
window.addEventListener('harness:quick-visibility', event => setActive(event.detail === true));
setActive(active);
