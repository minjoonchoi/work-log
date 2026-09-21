const suggestions = ['기획', '설계', '개발', '검토', '테스트', '조사', '문서', '운영'];
const normalized = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

export function itemTagsUI({ api, esc, modal, toast, refresh }) {
  const $ = selector => document.querySelector(selector);
  function chips(tags = []) {
    return tags.length ? tags.map(tag => `<span class="tag-chip">${esc(tag)}</span>`).join('') : '<span class="tag-empty">미분류</span>';
  }
  function listHTML(item) { return `<div class="item-tags" aria-label="업무 유형 태그">${chips(item.tags)}</div>`; }
  function detailHTML(item) {
    return `<section class="item-type-tags" aria-labelledby="item-tags-heading"><div class="writing-header"><h3 id="item-tags-heading">업무 유형</h3>
      <button id="edit-item-tags" class="writing-action" aria-label="업무 유형 태그 편집">태그 편집</button></div>${listHTML(item)}</section>`;
  }
  function filterQuery() {
    const value = $('#tag-filter').value;
    return value === 'untagged' ? '&untagged=true' : value.startsWith('tag:') ? `&tag=${encodeURIComponent(value.slice(4))}` : '';
  }
  function updateFilter(rows) {
    const select = $('#tag-filter'), selected = select.value;
    const options = [...rows];
    if (selected.startsWith('tag:') && !options.some(row => row.name === selected.slice(4))) options.push({ name: selected.slice(4), count: 0 });
    const markup = '<option value="all">전체 유형</option><option value="untagged">미분류</option>'
      + options.map(row => `<option value="tag:${esc(row.name)}">${esc(row.name)} (${row.count})</option>`).join('');
    if (select.innerHTML !== markup) { select.innerHTML = markup; select.value = selected || 'all'; }
  }
  async function edit(item) {
    let base = item, draft = [...(item.tags || [])], busy = false, conflict = false;
    const known = await api('/tags');
    const choices = [...new Set([...suggestions, ...known.map(row => row.name)])];
    modal(`<h2>업무 유형 태그 편집</h2><p>여러 태그로 업무를 분류합니다. Jira 연결 없이 저장되며 제목·설명을 다시 작성해도 유지됩니다.</p>
      <div id="tag-error" class="error" role="alert" hidden></div><button id="reload-item-tags" class="secondary" hidden>최신 태그 불러오기</button>
      <div class="tag-editor-heading"><strong>선택한 태그</strong><span id="tag-count"></span></div><div id="selected-item-tags" class="tag-choices"></div>
      <label for="new-item-tag">새 태그</label><div class="tag-input-row"><input id="new-item-tag" maxlength="120" autocomplete="off" placeholder="예: API 설계"><button id="add-item-tag" class="secondary">추가</button></div>
      <p class="help">태그당 최대 40자, 업무당 최대 20개까지 추가할 수 있습니다.</p>
      <fieldset class="tag-suggestions"><legend>자주 쓰는 유형과 기존 태그</legend><div id="suggested-item-tags" class="tag-choices"></div></fieldset>
      <div class="dialog-actions"><button data-close>취소</button><button id="save-item-tags" class="primary">태그 저장</button></div>`);
    const dialog = $('#modal'), error = $('#tag-error'), input = $('#new-item-tag'), save = $('#save-item-tags');
    function fail(message) { error.textContent = message; error.hidden = false; }
    function render() {
      $('#tag-count').textContent = `${draft.length} / 20`;
      $('#selected-item-tags').innerHTML = draft.length ? draft.map(tag => `<button class="tag-chip tag-remove" data-remove-tag="${esc(tag)}" aria-label="태그${esc(tag)} 삭제">${esc(tag)} <span aria-hidden="true">×</span></button>`).join('') : '<span class="tag-empty">태그가 없으면 미분류로 표시합니다.</span>';
      $('#suggested-item-tags').innerHTML = choices.map(tag => `<button class="tag-chip tag-suggestion" data-suggest-tag="${esc(tag)}" aria-pressed="${draft.includes(tag)}" ${draft.includes(tag) || busy ? 'disabled' : ''}>${esc(tag)}</button>`).join('');
      $('#selected-item-tags').querySelectorAll('[data-remove-tag]').forEach(button => {
        button.disabled = busy; button.onclick = () => { draft = draft.filter(tag => tag !== button.dataset.removeTag); error.hidden = true; render(); };
      });
      $('#suggested-item-tags').querySelectorAll('[data-suggest-tag]').forEach(button => button.onclick = () => add(button.dataset.suggestTag));
      input.disabled = busy; $('#add-item-tag').disabled = busy; save.disabled = busy || conflict;
    }
    function add(value) {
      const tag = normalized(value);
      if (!tag || [...tag].length > 40 || /[\p{Cc}\p{Cf}]/u.test(value)) return fail('태그는 제어 문자 없이 1~40자로 입력하세요.');
      if (!draft.includes(tag)) {
        if (draft.length >= 20) return fail('업무당 태그는 최대 20개입니다.');
        draft.push(tag);
      }
      input.value = ''; error.hidden = true; render(); input.focus();
    }
    $('#add-item-tag').onclick = () => add(input.value);
    input.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); add(input.value); } };
    $('#reload-item-tags').onclick = async () => {
      try {
        const latest = await api(`/items/${base.id}`);
        if (!dialog.open || !input.isConnected) return;
        base = latest.item; draft = [...(base.tags || [])]; conflict = false; error.hidden = true; $('#reload-item-tags').hidden = true; render();
      } catch (e) { fail(e.message); }
    };
    save.onclick = async () => {
      if (busy || conflict) return;
      if (input.value.trim()) { add(input.value); if (!error.hidden) return; }
      busy = true; error.hidden = true; render();
      try {
        const result = await api(`/items/${base.id}/tags`, { method: 'PUT', body: { version: base.version, tags: draft } });
        // A delayed save must not close a newly opened dialog or steal its item selection.
        if (dialog.open && save.isConnected) { dialog.close(); await refresh(result.item.id); }
        toast('업무 유형 태그를 저장했습니다.');
      } catch (e) {
        if (dialog.open && error.isConnected) {
          fail(e.message); conflict = e.status === 409; $('#reload-item-tags').hidden = !conflict;
        }
      } finally { busy = false; if (dialog.open && save.isConnected) render(); }
    };
    render(); input.focus();
  }
  function bindDetail(item) { $('#edit-item-tags').onclick = () => edit(item).catch(e => toast(e.message)); }
  return { listHTML, detailHTML, bindDetail, filterQuery, updateFilter };
}
