import { jiraUI } from './jira.js';
import { descriptionHTML } from './description.js';

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
  let polling = false, settings = null;
  function clearSettings() { settings?.dispose(); settings = null; }
  window.addEventListener('worklog:modal-open', () => { clearSettings(); });
  async function pollSettings() {
    const view = settings;
    if (polling || !view?.active() || view.loading) return;
    polling = true;
    try { const s = await api('/integrations/atlassian'); if (view.active()) view.status.textContent = connectionText(s); }
    catch { /* Preserve unsaved fields and last known state while reconnecting. */ }
    finally { polling = false; }
  }
  setInterval(pollSettings, 2500);
  async function showSettings({ onBack, target = null } = {}) {
    clearSettings();
    const s = {};
    if (target && !target.isConnected) return;
    const renderSettings = target ? html => { target.innerHTML = html; } : modal;
    renderSettings(`${onBack ? '<button type="button" id="back-connection-settings" class="secondary">연결 설정으로 돌아가기</button>' : ''}${target ? '' : '<h2>Atlassian 연결 설정</h2>'}<p>Jira·Confluence 연결은 선택 사항입니다. 연결 없이도 WorkLog를 사용할 수 있습니다.</p>
      <p id="atlassian-status" class="connection-note" role="status">설정을 불러오는 중…</p><button id="retry-atlassian-settings" class="secondary" hidden>다시 불러오기</button>
      <div id="dialog-error" class="error" role="alert" hidden></div><div id="atlassian-panel-oauth" class="atlassian-settings-section"><h3>OAuth 연결</h3>
      <label for="atlassian-site-url">Atlassian 사이트 주소</label><input id="atlassian-site-url" maxlength="300" placeholder="https://company.atlassian.net" autocomplete="url" spellcheck="false" aria-describedby="atlassian-site-help" value="${esc(s.config?.site_url || '')}">
      <p id="atlassian-site-help" class="help">기본으로 사용할 사이트입니다. 비워 두면 연결 후 선택할 수 있습니다.</p>
      <label for="atlassian-client-id">Client ID</label><input id="atlassian-client-id" maxlength="200" autocomplete="off" spellcheck="false" value="${esc(s.config?.client_id || '')}">
      <label for="atlassian-client-secret">Client Secret</label><div class="credential-field"><input id="atlassian-client-secret" type="password" maxlength="4096" autocomplete="new-password" spellcheck="false" aria-describedby="client-secret-help"><button id="toggle-client-secret" type="button" class="secondary" aria-controls="atlassian-client-secret" aria-pressed="false" aria-label="Client Secret 보기">보기</button></div>
      <p id="client-secret-help" class="help">Keychain에 안전하게 보관합니다. Client ID가 같으면 빈칸으로 저장해도 기존 값을 유지합니다.</p>
      <details class="settings-help"><summary>OAuth 앱 등록 안내</summary><label for="oauth-callback">OAuth 앱의 Callback URL</label><input id="oauth-callback" readonly value="${esc(s.callback_url || '')}">
      <p class="help">OAuth 앱에 위 주소를 등록하세요. 연결은 기본 브라우저에서 진행됩니다.</p></details>
      </div><hr class="settings-divider"><div id="atlassian-panel-network" class="atlassian-settings-section"><h3>네트워크·진단</h3><p class="help">회사 네트워크에서 연결되지 않으면 추가 인증서를 설정하세요.</p>
      <label for="atlassian-ca-cert-path">추가 CA 인증서 파일 경로</label><input id="atlassian-ca-cert-path" maxlength="4096" placeholder="~/Certificates/company-ca.pem" autocomplete="off" spellcheck="false" aria-describedby="atlassian-ca-cert-help" value="${esc(s.config?.ca_cert_path || '')}">
      <p id="atlassian-ca-cert-help" class="help">회사 루트·중간 CA 인증서(.pem/.crt)의 절대 경로 또는 ~/ 경로를 입력하세요. 비워서 저장하면 추가 인증서만 해제하며, 기존 연결은 유지합니다.</p>
      </div>
      <div class="settings-actions"><button id="save-atlassian" class="secondary">설정 저장</button><button id="connect-atlassian" class="primary">Atlassian 연결</button><button id="disconnect-atlassian" class="secondary">연결 해제</button></div>
      ${target ? '' : '<div class="dialog-actions"><button data-close>닫기</button></div>'}`);
    const dialog = $('#modal'), client = $('#atlassian-client-id'), secret = $('#atlassian-client-secret'), toggle = $('#toggle-client-secret'), site = $('#atlassian-site-url'), caCert = $('#atlassian-ca-cert-path');
    let config = s.config, hasSecret = !!s.has_client_secret, origin = null, revision = 0, revealing = 0, busy = false, disposed = false;
    const view = { loading: true, status: $('#atlassian-status'), active: () => !disposed && settings === view && dialog.open && client.isConnected,
      dispose: () => { disposed = true; clearSecret(); dialog.removeEventListener('close', closed); } };
    function present() {
      toggle.textContent = secret.type === 'password' ? '보기' : '숨기기';
      toggle.setAttribute('aria-label', `Client Secret ${toggle.textContent}`);
      toggle.setAttribute('aria-pressed', String(secret.type === 'text'));
      secret.placeholder = hasSecret && client.value.trim() === config?.client_id ? '저장됨 · 변경할 때만 입력' : 'Client Secret 입력';
    }
    function clearSecret() { revealing++; revision++; secret.value = ''; secret.type = 'password'; origin = null; toggle.disabled = busy; present(); }
    function closed() { if (settings === view) clearSettings(); }
    settings = view; dialog.addEventListener('close', closed); present();
    const currentError = e => { if (view.active()) fail(e); };
    const dirty = () => client.value.trim() !== config?.client_id || site.value.trim() !== (config?.site_url || '')
      || caCert.value.trim() !== (config?.ca_cert_path || '') || (!!secret.value && origin !== 'stored');
    const withBusy = fn => async () => {
      if (busy || view.loading || !view.active()) return;
      busy = true; revealing++;
      const controls = [client, secret, toggle, site, caCert, $('#save-atlassian'), $('#connect-atlassian'), $('#disconnect-atlassian'), ...dialog.querySelectorAll('[data-settings-tab], #back-connection-settings')];
      controls.forEach(control => control.disabled = true);
      try { await fn(); } catch (e) { currentError(e); }
      finally { busy = false; if (view.active()) { controls.forEach(control => control.disabled = false); present(); } }
    };
    client.oninput = () => { clearSecret(); $('#dialog-error').hidden = true; };
    site.oninput = () => { $('#dialog-error').hidden = true; };
    caCert.oninput = () => { $('#dialog-error').hidden = true; };
    secret.oninput = () => { revision++; revealing++; origin = secret.value ? 'typed' : null; toggle.disabled = busy; present(); };
    toggle.onclick = async () => {
      if (!view.active() || busy) return;
      if (secret.type === 'text') {
        secret.type = 'password'; if (origin === 'stored') clearSecret(); else present(); return;
      }
      if (secret.value || !hasSecret || client.value.trim() !== config?.client_id) { secret.type = 'text'; present(); return; }
      const requestId = ++revealing, inputRevision = revision, clientId = client.value.trim();
      toggle.disabled = true; toggle.textContent = '불러오는 중';
      try {
        const result = await api('/integrations/atlassian/client-secret', { method: 'POST', body: { client_id: clientId } });
        if (!view.active() || busy || requestId !== revealing || inputRevision !== revision || client.value.trim() !== clientId) return;
        secret.value = result.client_secret; origin = 'stored'; secret.type = 'text'; present();
      } catch (e) { if (requestId === revealing) currentError(e); }
      finally { if (view.active() && requestId === revealing) { toggle.disabled = busy; present(); } }
    };
    const save = async () => {
      const clientId = client.value.trim(), newSecret = origin !== 'stored' ? secret.value : '';
      if (!clientId) throw new Error('Client ID를 입력하세요.');
      if (!newSecret && (!hasSecret || clientId !== config?.client_id)) throw new Error('이 Client ID의 Client Secret을 입력하세요.');
      secret.type = 'password'; present();
      const saved = await api('/integrations/atlassian', { method: 'PUT', body: { client_id: clientId, ...(newSecret ? { client_secret: newSecret } : {}),
        ...(site.value.trim() !== (config?.site_url || '') ? { site_url: site.value.trim() } : {}),
        ...(caCert.value.trim() !== (config?.ca_cert_path || '') ? { ca_cert_path: caCert.value.trim() } : {}) } });
      if (!view.active()) return false;
      config = saved.config; hasSecret = saved.has_client_secret ?? !!(newSecret || hasSecret); client.value = config.client_id; site.value = config.site_url || '';
      caCert.value = config.ca_cert_path || '';
      clearSecret(); $('#dialog-error').hidden = true; return true;
    };
    if (onBack) $('#back-connection-settings').onclick = withBusy(async () => { await onBack(); });
    $('#save-atlassian').onclick = withBusy(async () => { if (await save()) { toast('연결 설정을 저장했습니다.'); await pollSettings(); } });
    $('#connect-atlassian').onclick = withBusy(async () => {
      if (dirty() && !await save()) return;
      clearSecret();
      const result = await api('/integrations/atlassian/authorize', { method: 'POST', body: {} });
      if (view.active()) { openExternal(result.authorization_url); await pollSettings(); }
    });
    $('#disconnect-atlassian').onclick = withBusy(async () => { await api('/integrations/atlassian', { method: 'DELETE' }); if (view.active()) { await pollSettings(); toast('이 앱의 Atlassian 연결을 해제했습니다.'); } });
    const formControls = [client, secret, toggle, site, caCert, $('#oauth-callback'), $('#save-atlassian'), $('#connect-atlassian'), $('#disconnect-atlassian')];
    const retry = $('#retry-atlassian-settings');
    async function loadSettings() {
      if (!view.active()) return;
      view.loading = true;
      formControls.forEach(control => control.disabled = true);
      retry.hidden = true;
      view.status.textContent = '설정을 불러오는 중…';
      try {
        const loaded = await api('/integrations/atlassian');
        if (!view.active()) return;
        config = loaded.config; hasSecret = !!loaded.has_client_secret;
        client.value = config?.client_id || ''; site.value = config?.site_url || ''; caCert.value = config?.ca_cert_path || '';
        $('#oauth-callback').value = loaded.callback_url || '';
        view.status.textContent = connectionText(loaded);
        view.loading = false;
        formControls.forEach(control => control.disabled = false);
        present();
      } catch (error) {
        if (!view.active()) return;
        view.status.textContent = '설정을 불러오지 못했습니다. 다시 시도하세요.';
        currentError(error); retry.hidden = false;
      }
    }
    retry.onclick = () => { $('#dialog-error').hidden = true; void loadSettings(); };
    await loadSettings();

  }
  const jira = jiraUI({ api, esc, modal, toast, refresh, absoluteTime, openExternal, showSettings, createIssue });
  function sessionHTML(s, data) {
    const summary = s.summary;
    if (!s.closed && !s.worklog) return '';
    let html = '<div class="session-sync">';
    if (s.worklog) {
      const w = s.worklog, p = JSON.parse(w.payload);
      const link = data?.jira_links?.find(link => link.operation_id === w.issue_operation_id);
      const issue = link?.view?.data?.issue || link?.issue;
      html += `<p class="sync-status">${esc(labels[w.state] || w.state)}${w.worklog_id ? ` · #${esc(w.worklog_id)}` : ''}</p><small>${esc(absoluteTime(p.started))} · ${Math.floor(p.seconds / 60)}분 ${p.seconds % 60}초</small>`;
      if (issue) html += `<p class="worklog-destination">업무 로그 대상 · <a href="${esc(issue.url)}" data-jira-url="${esc(issue.url)}" target="_blank" rel="noopener noreferrer">${esc(issue.key)}</a></p>`;
      if (w.message) html += `<p class="sync-message">${esc(w.message)}</p>`;
      if (['failed', 'unknown'].includes(w.state)) html += `<button class="secondary" data-retry-worklog="${esc(s.id)}">${w.state === 'unknown' ? '전송 결과 다시 확인' : '동기화 다시 시도'}</button>`;
    } else if (summary?.state === 'completed') html += '<small>로컬에 보관됨 · Jira 이슈 연결 후 세션별 업무 로그로 동기화됩니다.</small>';
    return html + '</div>';
  }
  async function createIssue(data) {
    const status = await api('/integrations/atlassian');
    if (!status.connected) return showSettings();
    const availableSites = await api('/integrations/atlassian/sites?product=jira');
    const preferred = availableSites.find(site => site.preferred);
    if (preferred && !preferred.scopes?.includes('write:jira-work')) throw new Error('설정한 Atlassian 사이트에 Jira 쓰기 권한이 없습니다. 연결 권한을 확인하세요.');
    const sites = availableSites.filter(site => site.scopes?.includes('write:jira-work'));
    const { item } = data;
    modal(`<h2>Jira 티켓 만들기</h2><p>아래 제목과 설명을 그대로 Jira 티켓에 사용합니다.</p><div id="dialog-error" class="error" role="alert" hidden></div>
      <label for="jira-site">Jira 사이트</label><select id="jira-site">${sites.map(s => `<option value="${esc(s.id)}">${esc(s.url ? `${s.name} · ${s.url}` : s.name)}</option>`).join('')}</select>
      <label for="jira-project">프로젝트</label><select id="jira-project"></select>
      <label for="jira-type">티켓 유형</label><select id="jira-type"></select>
      <div class="jira-preview"><strong>${esc(item.title)}</strong><div class="work-item-description">${descriptionHTML(item.description, esc)}</div></div>
      <p class="help">생성 후 종료된 세션의 요약과 관측 시간을 Jira 업무 로그로 자동 동기화합니다.</p>
      <div class="dialog-actions"><button data-close>취소</button><button id="confirm-jira" class="primary" disabled>Jira 티켓 만들기</button></div>`);
    $('#jira-site').value = preferred?.id || sites[0]?.id || '';
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
