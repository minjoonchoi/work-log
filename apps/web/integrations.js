import { jiraUI } from './jira.js';

export function integrationUI({ api, esc, modal, toast, refresh, absoluteTime }) {
  const $ = s => document.querySelector(s);
  const labels = { pending: '동기화 대기', sending: '동기화 중', synced: 'Jira 동기화됨', unknown: '전송 결과 확인 필요', failed: '확인 필요', needs_review: '세션 경계 변경 · 확인 필요' };
  function fail(e) { const node = $('#dialog-error'); if (node) { node.textContent = e.message; node.hidden = false; } }
  const act = fn => async (...args) => { try { await fn(...args); } catch (e) { fail(e); } };
  function openExternal(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !((parsed.hostname === 'auth.atlassian.com' && parsed.pathname === '/authorize') || (parsed.hostname.endsWith('.atlassian.net') && parsed.pathname.startsWith('/browse/')))) throw new Error('지원하지 않는 외부 주소입니다.');
    if (window.webkit?.messageHandlers?.openExternal) window.webkit.messageHandlers.openExternal.postMessage(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }
  function connectionText(s) {
    return s.connecting ? '브라우저에서 Atlassian 연결을 완료하세요.' : s.connected ? 'Atlassian 연결됨 · 토큰은 macOS Keychain에 보관됩니다.' : s.message || 'Atlassian 연결 안 됨';
  }
  let polling = false;
  async function pollSettings() {
    if (polling || !$('#modal').open || !$('#atlassian-status')) return;
    polling = true;
    try { const s = await api('/integrations/atlassian'); if ($('#atlassian-status')) $('#atlassian-status').textContent = connectionText(s); }
    catch { /* Preserve unsaved fields and last known state while reconnecting. */ }
    finally { polling = false; }
  }
  setInterval(pollSettings, 2500);
  async function showSettings() {
    const [s, health] = await Promise.all([api('/integrations/atlassian'), api('/health')]);
    modal(`<h2>연결 설정</h2><p>1Password에 보관된 OAuth 앱으로 Jira와 Confluence를 연결합니다.</p>
      <div id="dialog-error" class="error" role="alert" hidden></div>
      <label for="op-vault">1Password vault 이름</label><input id="op-vault" maxlength="200" autocomplete="off" value="${esc(s.config?.vault || '')}" placeholder="예: Engineering">
      <label for="op-item">1Password item 이름</label><input id="op-item" maxlength="200" autocomplete="off" value="${esc(s.config?.item || '')}" placeholder="예: Work Log Atlassian OAuth">
      <p class="help">item의 필드 이름은 <code>client_id</code>, <code>client_secret</code>입니다. 설정에는 vault와 item 이름만 저장합니다.</p>
      <label for="oauth-callback">OAuth 앱의 Callback URL</label><input id="oauth-callback" readonly value="${esc(s.callback_url)}">
      <p class="help">Jira 읽기·쓰기, Confluence 페이지 읽기와 offline_access 권한을 사용합니다. 연결은 기본 브라우저에서 진행됩니다.</p>
      <p id="atlassian-status" class="connection-note" role="status">${esc(connectionText(s))}</p>
      <div class="settings-actions"><button id="save-atlassian" class="secondary">설정 저장</button><button id="connect-atlassian" class="primary">Atlassian 연결</button><button id="disconnect-atlassian" class="secondary">연결 해제</button></div>
      <details class="service-details"><summary>로컬 서비스 상태</summary><p>관리: 연결됨 · 실행: ${health.runtime_connected ? '연결됨' : '연결 대기'}<br>수집 이벤트 ${health.events}개 · 미확인 출력 ${health.unresolved}개<br>버전 ${esc(health.version)}</p></details>
      <div class="dialog-actions"><button data-close>닫기</button></div>`);
    const save = async () => {
      const saved = await api('/integrations/atlassian', { method: 'PUT', body: { vault: $('#op-vault').value, item: $('#op-item').value } });
      s.config = saved.config; $('#dialog-error').hidden = true; return saved;
    };
    $('#save-atlassian').onclick = act(async () => { await save(); toast('연결 설정을 저장했습니다.'); await pollSettings(); });
    $('#connect-atlassian').onclick = act(async () => {
      const button = $('#connect-atlassian'); button.disabled = true;
      try {
        if ($('#op-vault').value.trim() !== s.config?.vault || $('#op-item').value.trim() !== s.config?.item) await save();
        const result = await api('/integrations/atlassian/authorize', { method: 'POST', body: {} });
        openExternal(result.authorization_url); await pollSettings();
      } finally { button.disabled = false; }
    });
    $('#disconnect-atlassian').onclick = act(async () => { await api('/integrations/atlassian', { method: 'DELETE' }); await pollSettings(); toast('이 앱의 Atlassian 연결을 해제했습니다.'); });
  }
  const jira = jiraUI({ api, esc, modal, toast, refresh, absoluteTime, openExternal, showSettings, createIssue });
  function sessionHTML(s) {
    const summary = s.summary;
    if (!s.closed && !s.worklog) return '';
    let html = '<div class="session-sync">';
    if (s.worklog) {
      const w = s.worklog, p = JSON.parse(w.payload);
      html += `<p class="sync-status">${esc(labels[w.state] || w.state)}${w.worklog_id ? ` · #${esc(w.worklog_id)}` : ''}</p><small>${esc(absoluteTime(p.started))} · ${Math.floor(p.seconds / 60)}분 ${p.seconds % 60}초</small>`;
      if (w.message) html += `<p class="sync-message">${esc(w.message)}</p>`;
      if (['failed', 'unknown'].includes(w.state)) html += `<button class="secondary" data-retry-worklog="${esc(s.id)}">${w.state === 'unknown' ? '전송 결과 다시 확인' : '동기화 다시 시도'}</button>`;
    } else if (summary?.state === 'completed') html += '<small>Jira 티켓 연결 후 업무 로그가 동기화됩니다.</small>';
    return html + '</div>';
  }
  async function createIssue(data) {
    const status = await api('/integrations/atlassian');
    if (!status.connected) return showSettings();
    const sites = (await api('/integrations/atlassian/sites')).filter(s => s.scopes?.includes('write:jira-work'));
    const { item } = data;
    modal(`<h2>Jira 티켓 만들기</h2><p>아래 제목과 설명을 그대로 Jira 티켓에 사용합니다.</p><div id="dialog-error" class="error" role="alert" hidden></div>
      <label for="jira-site">Jira 사이트</label><select id="jira-site">${sites.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
      <label for="jira-project">프로젝트</label><select id="jira-project"></select>
      <label for="jira-type">티켓 유형</label><select id="jira-type"></select>
      <div class="jira-preview"><strong>${esc(item.title)}</strong><pre>${esc(item.description)}</pre></div>
      <p class="help">생성 후 종료된 세션의 요약과 관측 시간을 Jira 업무 로그로 자동 동기화합니다.</p>
      <div class="dialog-actions"><button data-close>취소</button><button id="confirm-jira" class="primary" disabled>Jira 티켓 만들기</button></div>`);
    let loading = 0;
    async function types() {
      const current = ++loading; $('#confirm-jira').disabled = true;
      const result = await api(`/integrations/atlassian/issue-types?cloud_id=${encodeURIComponent($('#jira-site').value)}&project=${encodeURIComponent($('#jira-project').value)}`);
      if (!$('#jira-type') || current !== loading) return;
      $('#jira-type').innerHTML = (result.issueTypes || result.values || []).map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
      $('#confirm-jira').disabled = !$('#jira-type').value;
    }
    async function projects() {
      const current = ++loading; $('#confirm-jira').disabled = true;
      const result = await api(`/integrations/atlassian/projects?cloud_id=${encodeURIComponent($('#jira-site').value)}`);
      if (!$('#jira-project') || current !== loading) return;
      $('#jira-project').innerHTML = result.values.map(p => `<option value="${esc(p.key)}">${esc(p.name)} (${esc(p.key)})</option>`).join('');
      if ($('#jira-project').value) await types();
    }
    $('#jira-site').onchange = act(projects); $('#jira-project').onchange = act(types);
    const operation = crypto.randomUUID();
    $('#confirm-jira').onclick = act(async () => {
      const button = $('#confirm-jira'); button.disabled = true;
      try {
        await api(`/items/${item.id}/jira`, { method: 'POST', body: { version: item.version, operation_id: operation,
          cloud_id: $('#jira-site').value, project: $('#jira-project').value, issue_type: $('#jira-type').value } });
        $('#modal').close(); await refresh(item.id); toast('Jira 티켓을 만들었습니다.');
      } catch (e) { await refresh(item.id); throw e; }
      finally { button.disabled = false; }
    });
    if (sites.length) await act(projects)(); else fail(new Error('Jira 쓰기 권한이 있는 사이트가 없습니다. 연결 권한을 확인하세요.'));
  }
  function bindDetail(data) {
    const panel = $('#detail');
    jira.bind(data);
    panel.querySelectorAll('[data-retry-worklog]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await api(`/sessions/${b.dataset.retryWorklog}/worklog/retry`, { method: 'POST', body: {} }); await refresh(data.item.id); }
      catch (e) { toast(e.message); b.disabled = false; }
    });
    panel.querySelectorAll('[data-resolve-jira]').forEach(b => b.onclick = () => {
      modal('<h2>Jira 생성 결과 확인</h2><p>Jira에서 생성된 티켓의 키를 입력하면 이 요청으로 생성된 티켓인지 확인합니다.</p><div id="dialog-error" class="error" role="alert" hidden></div><label for="resolve-key">티켓 키</label><input id="resolve-key" placeholder="TEAM-123"><div class="dialog-actions"><button data-close>닫기</button><button id="resolve-jira" class="primary">확인</button></div>');
      $('#resolve-jira').onclick = act(async () => { await api(`/jira-links/${b.dataset.resolveJira}/resolve`, { method: 'POST', body: { key: $('#resolve-key').value.trim() } }); $('#modal').close(); await refresh(data.item.id); });
    });
  }
  return { showSettings, jiraHTML: jira.html, sessionHTML, bindDetail };
}
