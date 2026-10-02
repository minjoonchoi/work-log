export const locationHTML = `<fieldset id="confluence-location" class="confluence-location"><legend>게시 위치</legend><p id="confluence-location-selected">공간 기본 위치</p><button type="button" data-default class="secondary">기본 위치로 변경</button><label for="confluence-location-query">상위 페이지·폴더 검색</label><div class="actions"><input id="confluence-location-query" maxlength="200" placeholder="제목으로 공간 전체 검색"><button type="button" data-search>검색</button></div><nav aria-label="페이지·폴더 탐색"></nav><p data-error class="error" role="alert" hidden></p><div class="confluence-target-list"></div><button type="button" data-more hidden>더 보기</button></fieldset>`;
export function locationPicker({ root, api, esc, active, changed }) {
  const $ = s => root.querySelector(s), query = $('input'), list = $('.confluence-target-list');
  let cloud = '', space = '', selected = null, path = [], rows = [], cursor = null, revision = 0, busy = false, locked = false, search = '';
  function controls() { root.disabled = locked || !space; $('[data-search]').disabled = busy; $('[data-more]').disabled = busy; }
  function render() {
    $('#confluence-location-selected').textContent = selected ? `${selected.type === 'folder' ? '폴더' : '페이지'}: ${selected.title} 아래에 게시` : '공간 기본 위치';
    $('nav').innerHTML = `<button type="button" data-level="0">공간 전체</button>${path.map((row, i) => ` / <button type="button" data-level="${i + 1}">${esc(row.title)}</button>`).join('')}`;
    $('nav').querySelectorAll('button').forEach(button => button.onclick = () => { path = path.slice(0, Number(button.dataset.level)); query.value = ''; search = ''; load(); });
    list.innerHTML = rows.length ? rows.map((row, i) => `<div class="confluence-target-row"><span>${row.type === 'folder' ? '폴더' : '페이지'} · ${esc(row.title)}</span><button type="button" data-select="${i}" aria-label="${esc(row.title)} 아래에 게시">선택</button><button type="button" data-browse="${i}" aria-label="${esc(row.title)} 하위 탐색">하위 탐색</button></div>`).join('') : `<p class="help">${busy ? '페이지·폴더를 불러오는 중…' : '페이지·폴더가 없습니다.'}</p>`;
    list.querySelectorAll('[data-select]').forEach(button => button.onclick = () => { selected = rows[Number(button.dataset.select)]; changed(); render(); });
    list.querySelectorAll('[data-browse]').forEach(button => button.onclick = () => { path.push(rows[Number(button.dataset.browse)]); search = ''; query.value = ''; load(); });
    $('[data-more]').hidden = !cursor; controls();
  }
  async function load(append = false) {
    const version = ++revision; busy = true; $('[data-error]').hidden = true;
    if (!append) { rows = []; cursor = null; } render();
    const parent = path.at(-1), params = new URLSearchParams({ cloud_id: cloud, space_id: space, query: search });
    if (parent) { params.set('parent_id', parent.id); params.set('parent_type', parent.type); }
    if (append && cursor) params.set('cursor', cursor);
    try {
      const result = await api(`/integrations/atlassian/confluence-targets?${params}`);
      if (version !== revision || !active()) return;
      rows = [...new Map([...rows, ...result.items].map(row => [row.id, row])).values()]; cursor = result.next_cursor;
    } catch (e) { if (version === revision && active()) { $('[data-error]').textContent = e.message + (e.status === 403 ? ' 탐색 읽기 권한을 확인하고 Atlassian을 다시 연결하세요.' : ''); $('[data-error]').hidden = false; } }
    finally { if (version === revision && active()) { busy = false; render(); } }
  }
  $('[data-search]').onclick = () => { path = []; search = query.value.trim(); load(); };
  query.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('[data-search]').click(); } };
  $('[data-default]').onclick = () => { selected = null; changed(); render(); };
  $('[data-more]').onclick = () => load(true);
  return {
    reset(nextCloud, nextSpace) { revision++; cloud = nextCloud; space = nextSpace; selected = null; path = []; rows = []; cursor = null; search = ''; query.value = ''; busy = false; render(); if (space) load(); },
    value: () => selected ? { parent_id: selected.id, parent_type: selected.type } : {},
    setDisabled(value) { locked = value; controls(); },
  };
}
