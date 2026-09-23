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
  let polling = false, settings = null, opening = 0;
  function clearSettings() { settings?.dispose(); settings = null; }
  window.addEventListener('worklog:modal-open', () => { opening++; clearSettings(); });
  async function pollSettings() {
    const view = settings;
    if (polling || !view?.active()) return;
    polling = true;
    try { const s = await api('/integrations/atlassian'); if (view.active()) view.status.textContent = connectionText(s); }
    catch { /* Preserve unsaved fields and last known state while reconnecting. */ }
    finally { polling = false; }
  }
  setInterval(pollSettings, 2500);
  async function showSettings() {
    const ticket = ++opening;
    const [s, health] = await Promise.all([api('/integrations/atlassian'), api('/health')]);
    if (ticket !== opening) return;
    modal(`<h2>Atlassian 연결 설정</h2><p>Jira 연결은 선택 사항입니다. 업무·세션 이력·요약·유형 태그는 연결 없이 로컬에서 사용할 수 있습니다.</p><p>Atlassian OAuth 앱의 Client ID와 Client Secret을 입력하세요.</p>
      <div id="dialog-error" class="error" role="alert" hidden></div>
      <label for="atlassian-site-url">Atlassian 사이트 주소</label><input id="atlassian-site-url" maxlength="300" placeholder="https://company.atlassian.net" autocomplete="url" spellcheck="false" aria-describedby="atlassian-site-help" value="${esc(s.config?.site_url || '')}">
      <p id="atlassian-site-help" class="help">선택 사항입니다. 회사 Jira·Confluence 사이트를 기본으로 선택합니다. 비워 두면 연결된 사이트 중에서 선택할 수 있습니다.</p>
      <label for="atlassian-ca-cert-path">추가 CA 인증서 파일 경로</label><input id="atlassian-ca-cert-path" maxlength="4096" placeholder="~/Certificates/company-ca.pem" autocomplete="off" spellcheck="false" aria-describedby="atlassian-ca-cert-help" value="${esc(s.config?.ca_cert_path || '')}">
      <p id="atlassian-ca-cert-help" class="help">선택 사항입니다. 회사에서 발급한 루트·중간 CA 인증서의 PEM 번들(.pem/.crt)을 지정하세요. 절대 경로 또는 ~/ 경로를 사용할 수 있습니다. 비워서 저장하면 추가 인증서를 해제하며, 인증서 경로만 변경해도 기존 OAuth 연결과 토큰은 유지됩니다.</p>
      <label for="atlassian-client-id">Client ID</label><input id="atlassian-client-id" maxlength="200" autocomplete="off" spellcheck="false" value="${esc(s.config?.client_id || '')}">
      <label for="atlassian-client-secret">Client Secret</label><div class="credential-field"><input id="atlassian-client-secret" type="password" maxlength="4096" autocomplete="new-password" spellcheck="false" aria-describedby="client-secret-help"><button id="toggle-client-secret" type="button" class="secondary" aria-controls="atlassian-client-secret" aria-pressed="false" aria-label="Client Secret 보기">보기</button></div>
      <p id="client-secret-help" class="help">Client Secret은 macOS Keychain에 보관합니다. 같은 Client ID에서 비워 두면 저장된 값을 유지합니다.</p>
      <label for="oauth-callback">OAuth 앱의 Callback URL</label><input id="oauth-callback" readonly value="${esc(s.callback_url)}">
      <p class="help">Jira와 Confluence 연결은 기본 브라우저에서 진행됩니다.</p>
      <p id="atlassian-status" class="connection-note" role="status">${esc(connectionText(s))}</p>
      <div class="settings-actions"><button id="save-atlassian" class="secondary">설정 저장</button><button id="connect-atlassian" class="primary">Atlassian 연결</button><button id="disconnect-atlassian" class="secondary">연결 해제</button></div>
      <details class="service-details"><summary>로컬 서비스 상태</summary><p>관리: 연결됨 · 실행: ${health.runtime_connected ? '연결됨' : '연결 대기'}<br>수집 이벤트 ${health.events}개 · 미확인 출력 ${health.unresolved}개<br>버전 ${esc(health.version)}</p></details>
      <div class="dialog-actions"><button data-close>닫기</button></div>`);
    const dialog = $('#modal'), client = $('#atlassian-client-id'), secret = $('#atlassian-client-secret'), toggle = $('#toggle-client-secret'), site = $('#atlassian-site-url'), caCert = $('#atlassian-ca-cert-path');
    let config = s.config, hasSecret = !!s.has_client_secret, origin = null, revision = 0, revealing = 0, busy = false, disposed = false;
    const view = { status: $('#atlassian-status'), active: () => !disposed && settings === view && dialog.open && client.isConnected,
      dispose: () => { disposed = true; clearSecret(); dialog.removeEventListener('close', closed); } };
    function present() {
      toggle.textContent = secret.type === 'password' ? '보기' : '숨기기';
      toggle.setAttribute('aria-label', `Client Secret ${toggle.textContent}`);
      toggle.setAttribute('aria-pressed', String(secret.type === 'text'));
      secret.placeholder = hasSecret && client.value.trim() === config?.client_id ? '저장됨 · 변경할 때만 입력' : 'Client Secret 입력';
    }
    function clearSecret() { revealing++; revision++; secret.value = ''; secret.type = 'password'; origin = null; toggle.disabled = busy; present(); }
    function closed() { if (settings === view) { opening++; clearSettings(); } }
    settings = view; dialog.addEventListener('close', closed); present();
    const currentError = e => { if (view.active()) fail(e); };
    const dirty = () => client.value.trim() !== config?.client_id || site.value.trim() !== (config?.site_url || '')
      || caCert.value.trim() !== (config?.ca_cert_path || '') || (!!secret.value && origin !== 'stored');
    const withBusy = fn => async () => {
      if (busy || !view.active()) return;
      busy = true; revealing++;
      const controls = [client, secret, toggle, site, caCert, $('#save-atlassian'), $('#connect-atlassian'), $('#disconnect-atlassian')];
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
    $('#save-atlassian').onclick = withBusy(async () => { if (await save()) { toast('연결 설정을 저장했습니다.'); await pollSettings(); } });
    $('#connect-atlassian').onclick = withBusy(async () => {
      if (dirty() && !await save()) return;
      clearSecret();
      const result = await api('/integrations/atlassian/authorize', { method: 'POST', body: {} });
      if (view.active()) { openExternal(result.authorization_url); await pollSettings(); }
    });
    $('#disconnect-atlassian').onclick = withBusy(async () => { await api('/integrations/atlassian', { method: 'DELETE' }); if (view.active()) { await pollSettings(); toast('이 앱의 Atlassian 연결을 해제했습니다.'); } });
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
