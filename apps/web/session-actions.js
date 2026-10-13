export function sessionActionsUI({ api, esc, modal, toast, refresh, absoluteTime }) {
  let owner, selected = new Set();
  function configure(data) {
    if (owner !== data.item.id) selected.clear();
    owner = data.item.id;
    const available = new Set(data.sessions.map(s => s.id));
    for (const id of selected) if (!available.has(id)) selected.delete(id);
  }
  const checkbox = session => `<input type="checkbox" class="session-select" data-select-session="${esc(session.id)}" aria-label="${esc(absoluteTime(session.start_at))} 세션 선택" ${selected.has(session.id) ? 'checked' : ''}>`;
  const toolbar = () => `<div class="session-actions" role="group" aria-label="세션 선택 작업"><label><input type="checkbox" id="select-all-sessions"> 전체 선택</label><span id="selected-sessions-count" role="status"></span><button id="move-sessions" class="secondary">다른 업무로 이동</button><button id="delete-sessions" class="secondary">선택 삭제</button><button id="deleted-sessions" class="secondary">삭제한 세션</button></div>`;
  async function show(data, action) {
    const item = data.item, ids = [...selected];
    try {
      let choices = [], deleted = [];
      if (action === 'move') choices = (await api('/items')).filter(i => i.id !== item.id);
      if (action === 'restore') deleted = await api(`/items/${item.id}/deleted-sessions`);
      const verb = { move: '이동', delete: '삭제', restore: '복원' }[action];
      modal(`<h2>세션 ${verb}</h2><p>${action === 'delete' ? '선택한 세션을 업무·캘린더·자동 요약에서 제외합니다. 삭제한 세션에서 복원할 수 있습니다.' : action === 'move' ? '선택한 세션의 원문과 요약을 다른 업무로 이동합니다. 이후 새 세션의 수집 업무는 바뀌지 않습니다.' : '복원할 세션을 선택하세요.'}</p><p class="help">이미 전송된 Jira 업무 로그는 그대로 유지됩니다.</p>
        ${action === 'move' ? `<label for="session-target-search">업무 검색</label><input id="session-target-search" type="search" placeholder="업무 제목으로 검색"><label for="session-target">이동할 업무</label><select id="session-target" size="6"></select>` : action === 'restore' ? `<div class="deleted-session-list">${deleted.map(s => `<label><input type="checkbox" data-restore-session="${esc(s.id)}"> ${esc(absoluteTime(s.start_at))} → ${esc(absoluteTime(s.end_at))}</label>`).join('') || '<p>삭제한 세션이 없습니다.</p>'}</div>` : `<p>${ids.length}개 세션 선택</p>`}
        <p id="session-action-error" class="error" role="alert" hidden></p><div class="dialog-actions"><button data-close>취소</button><button id="confirm-session-action" class="primary">${verb}</button></div>`);
      const root = document.querySelector('#modal-content'), confirm = root.querySelector('#confirm-session-action');
      const operation = crypto.randomUUID();
      if (action === 'move') {
        const select = root.querySelector('#session-target'), search = root.querySelector('#session-target-search');
        const paint = () => {
          const previous = select.value, matches = choices.filter(i => i.title.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
          select.innerHTML = matches.map(i => `<option value="${esc(i.id)}">${esc(i.title)}</option>`).join('');
          if (matches.some(i => i.id === previous)) select.value = previous;
          else if (matches.length) select.value = matches[0].id;
          confirm.disabled = !select.value;
        };
        search.oninput = paint; select.onchange = () => { confirm.disabled = !select.value; }; paint();
      }
      if (action === 'restore') {
        const update = () => { confirm.disabled = !root.querySelector('[data-restore-session]:checked'); };
        root.querySelectorAll('[data-restore-session]').forEach(input => { input.onchange = update; }); update();
      }
      let request;
      confirm.onclick = async () => {
        request ||= { item_id: item.id, version: item.version, operation_id: operation,
          session_ids: action === 'restore' ? [...root.querySelectorAll('[data-restore-session]:checked')].map(i => i.dataset.restoreSession) : ids,
          ...(action === 'move' ? { target_id: root.querySelector('#session-target').value } : {}) };
        confirm.disabled = true;
        root.querySelectorAll('input,select').forEach(control => { control.disabled = true; });
        try {
          await api(`/sessions/${action}`, { method: 'POST', body: request }); selected.clear();
          if (confirm.isConnected) document.querySelector('#modal').close();
          toast(`${request.session_ids.length}개 세션을 ${verb}했습니다.`); await refresh(item.id);
        } catch (error) {
          if (!confirm.isConnected) return;
          const message = root.querySelector('#session-action-error'); message.hidden = false; message.textContent = error.message;
          confirm.disabled = false;
        }
      };
    } catch (error) { toast(error.message); }
  }
  function bind(data) {
    const panel = document.querySelector('#detail'), all = panel.querySelector('#select-all-sessions');
    function paint() {
      panel.querySelector('#selected-sessions-count').textContent = `${selected.size}개 선택`;
      for (const id of ['move-sessions', 'delete-sessions']) panel.querySelector(`#${id}`).disabled = !selected.size;
      all.checked = !!data.sessions.length && selected.size === data.sessions.length;
      all.indeterminate = selected.size > 0 && selected.size < data.sessions.length;
      all.disabled = !data.sessions.length;
      panel.querySelectorAll('[data-select-session]').forEach(input => { input.checked = selected.has(input.dataset.selectSession); });
    }
    panel.querySelectorAll('[data-select-session]').forEach(input => {
      input.onclick = event => event.stopPropagation();
      input.onchange = () => { input.checked ? selected.add(input.dataset.selectSession) : selected.delete(input.dataset.selectSession); paint(); };
    });
    all.onchange = () => { selected = all.checked ? new Set(data.sessions.map(s => s.id)) : new Set(); paint(); };
    panel.querySelector('#move-sessions').onclick = () => show(data, 'move');
    panel.querySelector('#delete-sessions').onclick = () => show(data, 'delete');
    panel.querySelector('#deleted-sessions').onclick = () => show(data, 'restore');
    paint();
  }
  return { configure, checkbox, toolbar, bind };
}
