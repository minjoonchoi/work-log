import { descriptionHTML } from './description.js';

export function jiraUI({ api, esc, modal, toast, refresh, absoluteTime, openExternal, showSettings, createIssue }) {
  const $ = s => document.querySelector(s), selections = new Map(), pending = new Set(), errors = new Map();
  const icon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 7a6.5 6.5 0 0 0-11-2L3 7m0-4v4h4M4 13a6.5 6.5 0 0 0 11 2l2-2m0 4v-4h-4"/></svg>';
  const statusHTML = status => `<span class="jira-status ${status?.category === 'indeterminate' ? 'is-progress' : ''}">${esc(status?.name || '상태 조회 중')}</span>`;
  function card(link) {
    const { operation_id: op, view, change, content_change: contentChange } = link, data = view?.data, issue = data?.issue || link.issue;
    const busy = pending.has(op) || ['preparing', 'sending'].includes(change?.state) || ['preparing', 'sending'].includes(contentChange?.state);
    const blocked = busy || !!view?.error || !data || !data.can_write || !!data.transition_message || change?.state === 'unknown';
    const transitions = data?.transitions || [], version = `${issue.status?.id}:${issue.updated}`;
    let selected = selections.get(op);
    if (selected?.version !== version || !transitions.some(t => t.id === selected?.id && !t.required_fields.length)) { selections.delete(op); selected = null; }
    const message = change?.state === 'unknown' ? change.message : errors.get(op) || view?.error || change?.message || data?.transition_message;
    return `<article class="jira-card" data-jira-card="${esc(op)}" aria-label="${esc(issue.key)} Jira 이슈">
      <div class="jira-card-heading"><a class="jira-link" href="${esc(issue.url)}" target="_blank" rel="noopener noreferrer" data-jira-url="${esc(issue.url)}" aria-label="${esc(issue.key)} Jira에서 열기">${esc(issue.key)} <span aria-hidden="true">↗</span></a>
        ${statusHTML(issue.status)}<button class="jira-refresh writing-action" data-refresh-jira="${esc(op)}" aria-label="${esc(issue.key)} 상태 새로고침" title="Jira 상태 새로고침" ${busy ? 'disabled' : ''} aria-busy="${busy}">${icon}</button></div>
      <p class="jira-issue-title">${esc(issue.title || '이슈 정보를 불러오는 중입니다.')}</p>
      <button class="writing-action jira-content-button" data-update-jira-content="${esc(op)}" aria-label="${esc(issue.key)} 제목·설명 반영"
        ${busy || !data?.can_write || view?.error || contentChange?.state === 'unknown' ? 'disabled' : ''}>제목·설명 반영</button>
      ${contentChange?.message ? `<p class="jira-message jira-content-message" role="status">${esc(contentChange.message)}</p>` : ''}
      <div class="jira-transition"><select id="jira-transition-${esc(op)}" data-jira-transition="${esc(op)}" aria-label="${esc(issue.key)} 변경할 상태" ${blocked || !transitions.some(t => !t.required_fields.length) ? 'disabled' : ''}>
        <option value="">변경할 상태 선택</option>${transitions.map(t => `<option value="${esc(t.id)}" ${t.required_fields.length ? 'disabled' : ''} ${selected?.id === t.id ? 'selected' : ''}>${esc(t.to.name)} · ${esc(t.name)}${t.required_fields.length ? ' (추가 입력 필요)' : ''}</option>`).join('')}</select>
        <button class="writing-action writing-action-accent" data-change-jira="${esc(op)}" aria-label="${esc(issue.key)} 상태 변경" ${blocked || !selected ? 'disabled' : ''} aria-busy="${busy}">${busy ? '확인 중…' : '상태 변경'}</button></div>
      ${message ? `<p class="jira-message" role="status">${esc(message)}</p>` : ''}
      ${!blocked && !transitions.length ? '<p class="help">변경 가능한 상태가 없습니다. Jira 워크플로와 전환 권한을 확인하세요.</p>' : ''}
      ${transitions.some(t => t.required_fields.length) ? '<p class="help jira-required-note">추가 입력이 필요한 전환은 Jira에서 변경할 수 있습니다.</p>' : ''}
      <p class="jira-observed">${view?.observed_at ? `${view.error ? '마지막 확인' : '상태 확인'} · ${esc(absoluteTime(view.observed_at))}${view.error ? ' · 최신 상태 미확인' : ''}` : 'Jira에서 현재 상태를 확인하고 있습니다.'}</p>
    </article>`;
  }
  function html(data) {
    const links = data.jira_links || [], blocked = links.some(l => ['linked', 'sending', 'unknown'].includes(l.state)), seen = new Set();
    const cards = links.filter(l => {
      if (!l.issue) return true;
      const key = `${l.issue.cloud_id}:${l.issue.id}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    }).map(l => l.state === 'linked' ? card(l)
      : `<p class="sync-message">${esc(l.message || '티켓 생성 중')}${l.state === 'unknown' ? ` <button class="secondary" data-resolve-jira="${esc(l.operation_id)}">생성 결과 확인</button>` : ''}</p>`).join('');
    return `<section class="detail-section jira-section"><h3>Jira 이슈</h3>${cards}
      ${!blocked ? `<div class="jira-connect"><p>로컬 업무로 사용할 수 있습니다. Jira에서도 추적하려면 이슈를 만들거나 연결하세요.</p><div class="jira-connect-actions" role="group" aria-label="Jira 이슈 연결">
        <button id="create-jira" class="writing-action writing-action-accent">＋ 새 이슈 만들기</button><button id="link-jira" class="writing-action">기존 이슈 연결</button></div></div>` : '<p class="help jira-sync-note">종료된 세션마다 업무 로그 하나를 연결합니다. 재요약하면 기존 로그를 갱신합니다.</p>'}
      ${(data.worklog_alerts || []).map(w => `<p class="sync-message" role="status">${esc(w.message)} · ${esc(w.session_id)}</p>`).join('')}</section>`;
  }
  async function existing(data) {
    if (!(await api('/integrations/atlassian')).connected) return showSettings();
    const sites = (await api('/integrations/atlassian/sites')).filter(s => s.scopes?.includes('read:jira-work'));
    modal(`<h2>기존 Jira 이슈 연결</h2><p>이슈 키 또는 제목으로 검색하고 연결할 이슈를 선택하세요.</p><div id="dialog-error" class="error" role="alert" hidden></div>
      <label for="existing-site">Jira 사이트</label><select id="existing-site">${sites.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
      <label for="existing-key">이슈 키 또는 제목</label><div class="jira-lookup"><input id="existing-key" maxlength="1000" placeholder="예: TEAM-123, 권한 관리 · URL도 가능" autocomplete="off"><button id="lookup-jira" class="secondary" ${sites.length ? '' : 'disabled'}>검색</button></div>
      <p id="jira-search-status" class="help" role="status">접근할 수 있는 이슈를 검색합니다.</p>
      <div id="jira-search-results" class="jira-search-results" role="radiogroup" aria-label="연결할 Jira 이슈" hidden></div>
      <button id="more-jira-results" class="jira-search-more secondary" hidden>더 보기</button>
      <p id="jira-selection" class="jira-selection" role="status" hidden></p>
      <p class="help">연결 후 종료된 세션의 요약과 관측 시간을 이 이슈의 업무 로그로 동기화합니다. Work item과 Jira의 제목·설명은 각각 유지됩니다.</p>
      <div class="dialog-actions"><button data-close>취소</button><button id="confirm-link-jira" class="primary" disabled>이슈 연결</button></div>`);
    const dialog = $('#modal'), input = $('#existing-key'), site = $('#existing-site'), results = $('#jira-search-results'), confirm = $('#confirm-link-jira'), lookup = $('#lookup-jira'), error = $('#dialog-error');
    const status = $('#jira-search-status'), more = $('#more-jira-results'), selection = $('#jira-selection');
    let revision = 0, found = null, rows = [], next = null, controller, search = null;
    const fail = e => { error.textContent = e.message; error.hidden = false; };
    const invalidate = () => {
      revision++; controller?.abort(); found = null; rows = []; next = null; search = null;
      confirm.disabled = true; results.hidden = true; results.innerHTML = ''; more.hidden = true; selection.hidden = true;
      status.textContent = '검색 버튼이나 Enter로 이슈를 찾으세요.'; error.hidden = true; lookup.disabled = !sites.length;
    };
    input.oninput = invalidate; site.onchange = invalidate;
    function render() {
      results.hidden = !rows.length;
      results.innerHTML = rows.map(issue => `<label class="jira-search-result ${found?.issue.id === issue.id ? 'is-selected' : ''}">
        <input type="radio" name="jira-issue" value="${esc(issue.id)}" ${found?.issue.id === issue.id ? 'checked' : ''} aria-label="${esc(issue.key)} ${esc(issue.title)}">
        <span class="jira-search-content"><span class="jira-search-heading"><strong>${esc(issue.key)}</strong>${statusHTML(issue.status)}</span><span class="jira-search-title" title="${esc(issue.title)}">${esc(issue.title)}</span></span></label>`).join('');
      results.querySelectorAll('input').forEach(radio => radio.onchange = () => {
        const issue = rows.find(row => row.id === radio.value);
        found = { issue, cloud: search.cloud, operation: crypto.randomUUID() }; confirm.disabled = false;
        selection.textContent = `${issue.key} · ${issue.title}`; selection.hidden = false;
        results.querySelectorAll('label').forEach(label => label.classList.toggle('is-selected', label.querySelector('input').checked));
        radio.closest('label').scrollIntoView({ block: 'nearest' });
      });
      more.hidden = !next; more.disabled = false;
      status.textContent = rows.length ? `${rows.length}개 표시${next ? ' · 더 많은 결과가 있습니다.' : ''}` : '검색 결과가 없습니다. 이슈 키나 다른 제목으로 검색하세요.';
    }
    async function find(append = false) {
      if (!append) { invalidate(); search = { query: input.value.trim(), cloud: site.value }; }
      if (!search) return;
      const current = ++revision, snapshot = search;
      controller?.abort(); controller = new AbortController();
      lookup.disabled = true; more.disabled = true; error.hidden = true; status.textContent = '검색 중…';
      try {
        const params = new URLSearchParams({ cloud_id: snapshot.cloud, query: snapshot.query });
        if (append && next) params.set('next_page_token', next);
        const page = await api(`/integrations/atlassian/jira-search?${params}`, { signal: controller.signal });
        if (current !== revision || !dialog.open || !input.isConnected) return;
        rows = [...new Map([...rows, ...page.issues].map(issue => [issue.id, issue])).values()]; next = page.next_page_token;
        render();
      } catch (e) { if (current === revision && e.name !== 'AbortError') { fail(e); status.textContent = append ? `${rows.length}개 표시 · 추가 결과를 불러오지 못했습니다.` : '검색을 완료하지 못했습니다.'; } }
      finally { if (current === revision) { lookup.disabled = !sites.length; more.disabled = false; } }
    }
    lookup.onclick = () => find(); more.onclick = () => find(true);
    input.onkeydown = e => { if (e.key === 'Enter' && !lookup.disabled) { e.preventDefault(); void find(); } };
    dialog.addEventListener('close', () => { revision++; controller?.abort(); }, { once: true });
    confirm.onclick = async () => {
      if (!found) return;
      const selected = found; revision++; controller?.abort(); confirm.disabled = true; input.disabled = true; site.disabled = true; lookup.disabled = true; more.disabled = true;
      results.querySelectorAll('input').forEach(radio => radio.disabled = true);
      try {
        await api(`/items/${data.item.id}/jira/link`, { method: 'POST', body: { operation_id: selected.operation, version: data.item.version,
          cloud_id: selected.cloud, key: selected.issue.key, issue_id: selected.issue.id } });
        dialog.close(); await refresh(data.item.id); toast('기존 Jira 이슈를 연결했습니다.');
      } catch (e) { fail(e); await refresh(data.item.id); }
      finally { confirm.disabled = !found; input.disabled = false; site.disabled = false; lookup.disabled = !sites.length; more.disabled = false; results.querySelectorAll('input').forEach(radio => radio.disabled = false); }
    };
    if (!sites.length) fail(new Error('Jira 읽기 권한이 있는 사이트가 없습니다. 연결 권한을 확인하세요.'));
  }
  function bind(data) {
    const panel = $('#detail');
    for (const [selector, fn] of [['#create-jira', createIssue], ['#link-jira', existing]]) {
      const button = $(selector);
      if (button) button.onclick = async () => { try { await fn(data); } catch (e) { toast(e.message); } };
    }
    panel.querySelectorAll('[data-jira-url]').forEach(a => a.onclick = e => { e.preventDefault(); openExternal(a.dataset.jiraUrl); });
    panel.querySelectorAll('[data-jira-transition]').forEach(select => select.onchange = () => {
      const op = select.dataset.jiraTransition, link = data.jira_links.find(l => l.operation_id === op), issue = link.view.data.issue;
      selections.set(op, { id: select.value, version: `${issue.status.id}:${issue.updated}` });
      panel.querySelector(`[data-change-jira="${op}"]`).disabled = !select.value;
    });
    async function action(op, fn) {
      pending.add(op); errors.delete(op);
      panel.querySelectorAll(`[data-jira-card="${op}"] button,[data-jira-card="${op}"] select`).forEach(el => el.disabled = true);
      try { await fn(); } catch (e) { errors.set(op, e.message); }
      finally { pending.delete(op); await refresh(data.item.id); }
    }
    panel.querySelectorAll('[data-refresh-jira]').forEach(b => b.onclick = () => action(b.dataset.refreshJira, () => api(`/jira-links/${b.dataset.refreshJira}/refresh`, { method: 'POST', body: {} })));
    panel.querySelectorAll('[data-update-jira-content]').forEach(button => button.onclick = () => {
      const op = button.dataset.updateJiraContent, issue = data.jira_links.find(link => link.operation_id === op)?.view?.data?.issue;
      if (!issue || pending.has(op)) return;
      const operationId = crypto.randomUUID();
      modal(`<h2>Jira 제목·설명 반영</h2><p>${esc(issue.key)}의 제목·설명을 현재 work item 내용으로 변경합니다.</p>
        <div id="dialog-error" class="error" role="alert" hidden></div>
        <section class="jira-content-preview"><h3>${esc(data.item.title)}</h3><div class="work-item-description">${descriptionHTML(data.item.description, esc)}</div></section>
        <div class="dialog-actions"><button data-close>취소</button><button id="confirm-jira-content" class="primary">Jira에 반영</button></div>`);
      const dialog = $('#modal'), confirm = $('#confirm-jira-content'), error = $('#dialog-error');
      confirm.onclick = async () => {
        confirm.disabled = true; pending.add(op); error.hidden = true;
        try {
          const result = await api(`/jira-links/${op}/content`, { method: 'POST', body: {
            operation_id: operationId, version: data.item.version, expected_updated: issue.updated
          } });
          if (['applied', 'observed'].includes(result.state)) { dialog.close(); toast('Jira에 제목·설명을 반영했습니다.'); }
          else { error.textContent = result.message || '반영 상태를 새로고침하여 확인하세요.'; error.hidden = false; }
        } catch (failure) { error.textContent = failure.message; error.hidden = false; }
        finally { pending.delete(op); await refresh(data.item.id); }
      };
    });
    panel.querySelectorAll('[data-change-jira]').forEach(b => b.onclick = () => {
      const op = b.dataset.changeJira, selected = selections.get(op), issue = data.jira_links.find(l => l.operation_id === op).view.data.issue;
      if (!selected?.id || pending.has(op)) return;
      return action(op, async () => {
        selections.delete(op);
        const result = await api(`/jira-links/${op}/transition`, { method: 'POST', body: { operation_id: crypto.randomUUID(), transition_id: selected.id,
          expected_status_id: issue.status.id, expected_updated: issue.updated } });
        if (result.state === 'applied') toast('Jira에 상태 변경을 반영했습니다.');
      });
    });
  }
  return { html, bind };
}
