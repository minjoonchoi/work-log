export function agentConnectionsUI({ api, esc, modal, showAtlassian }) {
  const names = { codex: 'Codex', claude: 'Claude' };
  const states = { connected: '연결됨', disconnected: '연결 안 됨', needs_attention: '확인 필요' };

  async function showSettings() {
    modal(`<h2>연결 설정</h2><p>WorkLog 앱을 설치해도 Codex와 Claude는 자동으로 연결되지 않습니다. 사용할 에이전트를 각각 연결하세요.</p>
      <div id="agent-connections"></div>`);
    const dialog = document.querySelector('#modal'), root = document.querySelector('#agent-connections');
    const active = () => dialog.open && root.isConnected;
    let snapshot = null, pending = null, failure = '', feedback = '', readEpoch = 0;

    function render() {
      if (!active()) return;
      const busy = !!pending, available = snapshot?.available === true;
      const expanded = new Set([...root.querySelectorAll('.agent-connection-card')].filter(card => card.querySelector('details[open]')).map(card => card.dataset.engine));
      root.setAttribute('aria-busy', String(busy));
      root.innerHTML = `<p class="agent-connection-explanation">연결하면 작업 요청용 <strong>work 스킬</strong>과 대화 기록 수집이 함께 설정됩니다. 기존 사용자 설정은 유지하며, 해제할 때는 WorkLog가 연결한 항목만 제거합니다.</p>
        <div id="agent-connections-error" class="error" role="alert" ${failure ? '' : 'hidden'}>${esc(failure)}</div>
        ${snapshot && !available ? '<p class="connection-note">설치된 WorkLog 환경에서 연결할 수 있습니다. WorkLog를 설치한 뒤 앱을 다시 열어 주세요.</p>' : ''}
        <div class="agent-connection-toolbar"><p role="status">${esc(pending === 'refresh' ? '연결 상태를 확인하고 있습니다.' : pending ? `${names[pending.engine]} ${pending.method === 'DELETE' ? '연결을 해제' : '연결을 설정'}하고 있습니다.` : feedback)}</p><button id="refresh-agent-connections" class="secondary" ${busy ? 'disabled' : ''}>상태 새로고침</button></div>
        <div class="agent-connection-cards">${Object.entries(names).map(([engine, name]) => {
          const connection = snapshot?.connections?.find(row => row.engine === engine);
          const state = connection && states[connection.state] ? connection.state : 'needs_attention';
          const disabled = busy || !available || !connection;
          const changing = pending?.engine === engine;
          return `<section class="agent-connection-card" aria-labelledby="agent-${engine}-title" data-engine="${engine}">
            <div class="agent-connection-heading"><h3 id="agent-${engine}-title">${name}</h3><span class="agent-connection-state ${snapshot ? state : 'loading'}">${snapshot ? states[state] : '확인 중'}</span></div>
            <p>${esc(connection?.message || (snapshot ? '연결 상태를 확인할 수 없습니다. 상태를 새로고침해 주세요.' : '연결 상태를 불러오고 있습니다.'))}</p>
            ${state === 'connected' ? `<p class="connection-note" data-collection-state="${esc(connection?.collection?.state || 'awaiting_hook')}">${connection?.collection?.state === 'observed'
              ? `훅 수신 확인 · ${esc(new Date(connection.collection.last_event_at).toLocaleString())}`
              : '훅 수신 대기 · 설정 연결과 실제 대화 수집은 별도로 확인합니다.'}</p>
              <p class="connection-note">이미 열려 있는 세션도 첫 입력 훅이 도착하면 업무를 자동 등록합니다. 연결 전 대화는 소급하여 만들지 않습니다.${engine === 'codex'
                ? ' 수신되지 않으면 Codex의 /hooks에서 WorkLog 훅을 검토·신뢰한 뒤 다시 입력하세요. 실행 중인 환경이 새 설정을 읽지 않으면 세션을 재개해야 할 수 있습니다.'
                : ' 수신되지 않으면 Claude의 훅 설정과 변경 사항 반영 여부를 확인하세요.'}</p>` : ''}
            ${connection?.paths?.length ? `<details class="agent-connection-paths"><summary>연결 위치</summary><ul>${connection.paths.map(value => `<li>${esc(value)}</li>`).join('')}</ul></details>` : ''}
            <div class="agent-connection-actions">${state === 'connected' ? '' : `<button id="connect-${engine}" class="primary" ${disabled ? 'disabled' : ''}>${changing && pending.method === 'POST' ? '연결 중' : state === 'needs_attention' && connection ? '다시 연결' : '연결'}</button>`}
              ${state === 'disconnected' || !connection ? '' : `<button id="disconnect-${engine}" class="secondary" ${disabled ? 'disabled' : ''}>${changing && pending.method === 'DELETE' ? '해제 중' : '연결 해제'}</button>`}</div>
          </section>`;
        }).join('')}</div>
        <section class="agent-atlassian-settings" aria-label="Atlassian 연결"><div><h3>Jira · Confluence</h3><p>이슈와 업무 로그를 연결하거나 작성한 요약을 게시하려면 Atlassian을 설정하세요.</p></div><button id="open-atlassian-settings" class="secondary">Atlassian 설정</button></section>
        <div class="dialog-actions"><button id="close-agent-connections">닫기</button></div>`;
      root.querySelector('#refresh-agent-connections').onclick = refresh;
      for (const engine of expanded) { const details = root.querySelector(`[data-engine="${engine}"] details`); if (details) details.open = true; }
      root.querySelector('#close-agent-connections').onclick = () => dialog.close();
      root.querySelector('#open-atlassian-settings').onclick = async () => {
        try { await showAtlassian(); } catch (error) { if (active()) { failure = error.message; render(); } }
      };
      for (const engine of Object.keys(names)) {
        const connect = root.querySelector(`#connect-${engine}`), disconnect = root.querySelector(`#disconnect-${engine}`);
        if (connect) connect.onclick = () => mutate(engine, 'POST');
        if (disconnect) disconnect.onclick = () => mutate(engine, 'DELETE');
      }
    }
    async function refresh() {
      if (pending || !active()) return;
      readEpoch++;
      pending = 'refresh'; failure = ''; feedback = ''; render();
      try { const result = await api('/agent-connections'); if (active()) snapshot = result; }
      catch (error) { if (active()) failure = error.message; }
      finally { pending = null; if (active()) { render(); root.querySelector('#refresh-agent-connections').focus(); } }
    }
    async function mutate(engine, method) {
      if (pending || !active() || !snapshot?.available) return;
      readEpoch++;
      pending = { engine, method }; failure = ''; feedback = ''; render();
      try {
        const result = await api(`/agent-connections/${engine}`, { method, body: {} });
        if (active()) { snapshot = result; feedback = `${names[engine]} ${method === 'DELETE' ? '연결을 해제했습니다.' : '연결 상태를 갱신했습니다.'}`; }
      } catch (error) {
        if (!active()) return;
        failure = error.message;
        try { const result = await api('/agent-connections'); if (active()) snapshot = result; }
        catch { /* Preserve the previous state and the original action error. */ }
      } finally {
        pending = null;
        if (active()) { render(); root.querySelector(`[data-engine="${engine}"] button`)?.focus(); }
      }
    }
    await refresh();
    async function observeCollection() {
      if (!active()) return;
      if (!pending) {
        const epoch = readEpoch;
        try {
          const result = await api('/agent-connections');
          if (active() && !pending && epoch === readEpoch && JSON.stringify(result) !== JSON.stringify(snapshot)) {
            snapshot = result; render();
          }
        } catch { /* Explicit refresh exposes transport failures; retain the last observed state. */ }
      }
      if (active()) setTimeout(observeCollection, 5000);
    }
    if (active()) setTimeout(observeCollection, 5000);
  }
  return { showSettings };
}
