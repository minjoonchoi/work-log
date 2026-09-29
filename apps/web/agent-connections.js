import { showHeldSessions } from './held-sessions.js';
import { settingsTabs, bindSettingsTabs } from './settings-tabs.js';

export function agentConnectionsUI({ api, esc, modal, showAtlassian }) {
  const names = { codex: 'Codex', claude: 'Claude' };
  const purposes = { tracking: '이력 수집' };
  const states = { connected: '연결됨', disconnected: '연결 안 됨', needs_attention: '확인 필요' };

  async function showSettings({ onBack, tab = null } = {}) {
    const canGoBack = typeof onBack === 'function';
    modal(`${canGoBack ? '<div class="agent-connection-backbar"><button type="button" id="back-execution-settings" class="secondary agent-connection-back">작업 실행 설정으로 돌아가기</button></div>' : ''}
      <h2>연결 설정</h2><p>앱 설치만으로 에이전트가 자동으로 연결되지 않습니다. 대화를 기록할 에이전트를 선택하세요.</p>
      <div id="agent-connections"></div>`);
    const dialog = document.querySelector('#modal'), root = document.querySelector('#agent-connections');
    const backButton = canGoBack ? dialog.querySelector('#back-execution-settings') : null;
    const active = () => dialog.open && root.isConnected;
    let snapshot = null, pending = null, failure = '', feedback = '', readEpoch = 0;
    let selectedTab = ['agents', 'atlassian'].includes(tab) ? tab : 'agents';
    const connectionPart = (connection, kind) => connection?.[kind] || connection;

    function renderPart(engine, kind, connection, busy, available) {
      const part = connectionPart(connection, kind), state = part && states[part.state] ? part.state : 'needs_attention';
      const disabled = busy || !available || !part, changing = pending?.engine === engine && pending?.kind === kind;
      return `<section class="agent-connection-purpose" aria-label="${names[engine]} ${purposes[kind]}" data-connection="${engine}-${kind}">
        <div class="agent-connection-heading"><h4>${purposes[kind]}</h4><span class="agent-connection-state ${snapshot ? state : 'loading'}">${snapshot ? states[state] : '확인 중'}</span></div>
        <p>${kind === 'tracking' ? '입력·응답을 수집해 업무와 세션 이력을 기록합니다.' : 'work 스킬로 요청을 분류하고 설치한 작업 유형에 위임합니다.'}</p>
        ${part?.message ? `<p class="agent-connection-detail">${esc(part.message)}</p>` : ''}
        ${kind === 'tracking' && state === 'connected' ? `<p class="connection-note" data-collection-state="${esc(connection?.collection?.state || 'awaiting_hook')}">${connection?.collection?.state === 'observed'
          ? `훅 수신 확인 · ${esc(new Date(connection.collection.last_event_at).toLocaleString())}`
          : '훅 수신 대기 · 연결 설정과 실제 수집은 별도로 확인합니다.'}</p>
          <details class="agent-connection-help" data-details="${engine}-help"><summary>기존 세션에서 수집 시작하기</summary><p>첫 입력 훅이 도착하면 업무를 자동 등록합니다. 연결 전 대화는 소급하여 만들지 않습니다.${engine === 'codex'
            ? ' 수신되지 않으면 Codex의 /hooks에서 WorkLog 훅을 검토·신뢰한 뒤 다시 입력하세요. 새 설정을 읽지 않는 환경에서는 세션을 재개해야 할 수 있습니다.'
            : ' 수신되지 않으면 Claude의 훅 설정과 변경 사항 반영 여부를 확인하세요.'}</p></details>` : ''}
        ${part?.paths?.length ? `<details class="agent-connection-paths" data-details="${engine}-${kind}-paths"><summary>연결 위치</summary><ul>${part.paths.map(value => `<li>${esc(value)}</li>`).join('')}</ul></details>` : ''}
        <div class="agent-connection-actions">${state === 'connected' ? '' : `<button id="connect-${engine}-${kind}" class="primary" ${disabled ? 'disabled' : ''}>${purposes[kind]} ${changing && pending.method === 'POST' ? '연결 중' : state === 'needs_attention' && part ? '다시 연결' : '연결'}</button>`}
          ${state === 'disconnected' || !part ? '' : `<button id="disconnect-${engine}-${kind}" class="secondary" ${disabled ? 'disabled' : ''}>${purposes[kind]} ${changing && pending.method === 'DELETE' ? '해제 중' : '해제'}</button>`}</div>
      </section>`;
    }
    function render() {
      if (!active()) return;
      const busy = !!pending, available = snapshot?.available === true;
      if (backButton) backButton.disabled = busy;
      const expanded = new Set([...root.querySelectorAll('details[open][data-details]')].map(details => details.dataset.details));
      root.setAttribute('aria-busy', String(busy));
      const focusedTab = root.contains(document.activeElement) ? document.activeElement.dataset.settingsTab : null;
      root.innerHTML = `${settingsTabs('connections', '연결 설정 영역', [['agents', '에이전트 연결'], ['atlassian', 'Atlassian 연결']])}
        <div id="agent-connections-error" class="error" role="alert" ${failure ? '' : 'hidden'}>${esc(failure)}</div>
        ${snapshot && !available ? '<p class="connection-note">설치된 WorkLog 환경에서 연결할 수 있습니다. WorkLog를 설치한 뒤 앱을 다시 열어 주세요.</p>' : ''}
        <div class="agent-connection-toolbar"><p role="status">${esc(pending === 'refresh' ? '설정을 확인하고 있습니다.' : pending === 'back' ? '작업 실행 설정으로 돌아가고 있습니다.' : pending?.engine ? `${names[pending.engine]} ${purposes[pending.kind]} ${pending.method === 'DELETE' ? '연결을 해제' : '연결을 설정'}하고 있습니다.` : pending?.package ? '직무 패키지를 변경하고 있습니다.' : feedback)}</p><button id="refresh-agent-connections" class="secondary" ${busy ? 'disabled' : ''}>상태 새로고침</button></div>
        <div id="connections-panel-agents"><button id="open-held-sessions" class="secondary">분류 보류 기록</button><p class="agent-connection-explanation">에이전트의 입력·응답 수집을 연결합니다. 해제 시 선택한 기능의 WorkLog 연결만 제거하며 기존 이력은 보존합니다.</p>
        <div class="agent-connection-cards">${Object.entries(names).map(([engine, name]) => {
          const connection = snapshot?.connections?.find(row => row.engine === engine);
          return `<section class="agent-connection-card" aria-labelledby="agent-${engine}-title" data-engine="${engine}">
            <h3 id="agent-${engine}-title">${name}</h3>${renderPart(engine, 'tracking', connection, busy, available)}
          </section>`;
        }).join('')}</div></div>
        <section id="connections-panel-atlassian" class="agent-atlassian-settings" aria-label="Atlassian 연결"><div><h3>Jira · Confluence</h3><p>이슈와 업무 로그를 연결하거나 작성한 요약을 게시하려면 Atlassian을 설정하세요.</p></div><button id="open-atlassian-settings" class="secondary">Atlassian 설정</button></section>
        <div class="dialog-actions"><button id="close-agent-connections">닫기</button></div>`;
      bindSettingsTabs(root, 'connections', selectedTab, key => { selectedTab = key; });
      if (focusedTab) root.querySelector(`[data-settings-tab="${focusedTab}"]`)?.focus();
      root.querySelector('#refresh-agent-connections').onclick = refresh;
      root.querySelector('#open-held-sessions').onclick = () => showHeldSessions({ api, esc, modal, onBack: () => showSettings({ onBack }) });
      for (const details of root.querySelectorAll('details[data-details]')) details.open = expanded.has(details.dataset.details);
      root.querySelector('#close-agent-connections').onclick = () => dialog.close();
      root.querySelector('#open-atlassian-settings').onclick = async () => {
        try { await showAtlassian({ onBack: () => showSettings({ onBack, tab: 'atlassian' }) }); } catch (error) { if (active()) { failure = error.message; render(); } }
      };
      for (const engine of Object.keys(names)) for (const kind of Object.keys(purposes)) {
        const connect = root.querySelector(`#connect-${engine}-${kind}`), disconnect = root.querySelector(`#disconnect-${engine}-${kind}`);
        if (connect) connect.onclick = () => mutate(engine, kind, 'POST');
        if (disconnect) disconnect.onclick = () => mutate(engine, kind, 'DELETE');
      }
    }
    if (backButton) backButton.onclick = async () => {
      if (pending || !active()) return;
      readEpoch++;
      pending = 'back'; failure = ''; render();
      try { await onBack(); }
      catch (error) { if (active()) failure = error.message; }
      finally {
        pending = null;
        if (active()) { render(); backButton.focus(); }
      }
    };
    async function refresh({ initial = false } = {}) {
      if (pending || !active()) return;
      readEpoch++;
      pending = 'refresh'; failure = ''; feedback = ''; render();
      const results = await Promise.allSettled([api('/agent-connections')]);
      if (active()) {
        if (results[0].status === 'fulfilled') snapshot = results[0].value; else failure = results[0].reason.message;
      }
      pending = null;
      if (active()) {
        render();
        root.querySelector('#refresh-agent-connections').focus();
      }
    }
    async function mutate(engine, kind, method) {
      if (pending || !active() || !snapshot?.available) return;
      readEpoch++;
      pending = { engine, kind, method }; failure = ''; feedback = ''; render();
      try {
        const result = await api(`/agent-connections/${engine}/${kind}`, { method, body: {} });
        if (active()) { snapshot = result; feedback = `${names[engine]} ${purposes[kind]} ${method === 'DELETE' ? '연결을 해제했습니다.' : '연결 상태를 갱신했습니다.'}`; }
      } catch (error) {
        if (!active()) return;
        failure = error.message;
        try { const result = await api('/agent-connections'); if (active()) snapshot = result; }
        catch { /* Preserve the previous state and the original action error. */ }
      } finally {
        pending = null;
        if (active()) { render(); root.querySelector(`[data-connection="${engine}-${kind}"] button`)?.focus(); }
      }
    }
    await refresh({ initial: true });
    async function observeCollection() {
      if (!active()) return;
      if (!pending) {
        const epoch = readEpoch;
        const results = await Promise.allSettled([api('/agent-connections')]);
        if (active() && !pending && epoch === readEpoch) {
          let changed = false;
          if (results[0].status === 'fulfilled' && JSON.stringify(results[0].value) !== JSON.stringify(snapshot)) { snapshot = results[0].value; changed = true; }
          if (changed) render();
        }
      }
      if (active()) setTimeout(observeCollection, 5000);
    }
    if (active()) setTimeout(observeCollection, 5000);
  }
  return { showSettings };
}
