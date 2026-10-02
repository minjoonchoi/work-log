export const confluenceSettingsHTML = `<section id="confluence-space-settings" class="atlassian-settings-section"><h3>Confluence 게시 공간</h3>
  <label><input id="restrict-confluence-spaces" type="checkbox">선택한 공간에만 게시</label>
  <p class="help">제한을 켜면 아래에서 선택한 공간에만 게시합니다. 선택한 공간이 없으면 게시를 차단합니다.</p>
  <div id="confluence-space-picker" hidden><div id="confluence-selected-spaces" aria-live="polite"></div>
  <button id="load-confluence-spaces" type="button" class="secondary">공간 불러오기</button>
  <label for="confluence-settings-site">Confluence 사이트</label><select id="confluence-settings-site" disabled><option value="">연결 후 공간을 불러오세요</option></select>
  <div id="confluence-space-choices" class="confluence-choices"></div><button id="confluence-settings-more" type="button" class="secondary" hidden>공간 더 불러오기</button></div>
  <p class="help">검색·폴더 탐색 권한이 부족하면 OAuth 앱에 읽기 권한을 추가한 뒤 Atlassian을 다시 연결하세요.</p><details class="settings-help"><summary>필요한 탐색 권한</summary><p><code>read:content-details:confluence</code><br><code>read:folder:confluence</code><br><code>read:hierarchical-content:confluence</code></p></details></section>`;

export function confluenceSettings({ api, esc, active, fail }) {
  const root = document.querySelector('#confluence-space-settings'), $ = selector => root.querySelector(selector);
  const toggle = $('#restrict-confluence-spaces'), picker = $('#confluence-space-picker'), site = $('#confluence-settings-site'), choices = $('#confluence-space-choices'), more = $('#confluence-settings-more');
  let selected = new Map(), rows = new Map(), cursor = null, revision = 0, busy = false, disabled = true;
  const key = row => `${row.cloud_id}/${row.space_id}`;
  function controls() {
    root.querySelectorAll('input,button,select').forEach(node => node.disabled = disabled || busy);
    site.disabled ||= !site.value;
  }
  function render() {
    picker.hidden = !toggle.checked;
    $('#confluence-selected-spaces').innerHTML = `<p>선택한 공간 ${selected.size}개</p>` + [...selected.values()].map(row =>
      `<div class="confluence-choice"><span>${esc(row.name || row.space_id)} · ${esc(row.key || row.space_id)}</span><button type="button" class="secondary" data-remove-space="${esc(key(row))}" aria-label="${esc(row.name || row.space_id)} 선택 해제">해제</button></div>`).join('');
    choices.innerHTML = [...rows.values()].map(row => `<label><input type="checkbox" data-allow-space="${esc(key(row))}" ${selected.has(key(row)) ? 'checked' : ''}>${esc(row.name)} (${esc(row.key)})</label>`).join('');
    root.querySelectorAll('[data-remove-space]').forEach(button => button.onclick = () => { selected.delete(button.dataset.removeSpace); render(); });
    root.querySelectorAll('[data-allow-space]').forEach(input => input.onchange = () => { const id = input.dataset.allowSpace; if (input.checked) selected.set(id, rows.get(id)); else selected.delete(id); render(); });
    more.hidden = !cursor; controls();
  }
  const run = fn => async () => {
    if (busy || disabled || !active()) return;
    busy = true; controls();
    try { await fn(); } catch (error) { if (active()) fail(error); }
    finally { busy = false; if (active()) controls(); }
  };
  async function load(append = false) {
    const request = ++revision, cloud = site.value;
    if (!append) { rows.clear(); cursor = null; render(); }
    if (!cloud) return;
    const result = await api(`/integrations/atlassian/confluence-spaces?cloud_id=${encodeURIComponent(cloud)}${append && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!active() || request !== revision || cloud !== site.value) return;
    for (const row of result.spaces) { const item = { cloud_id: cloud, space_id: row.id, name: row.name, key: row.key }; rows.set(key(item), item); }
    cursor = result.next_cursor; render();
  }
  toggle.onchange = render;
  $('#load-confluence-spaces').onclick = run(async () => {
    const sites = await api('/integrations/atlassian/sites?product=confluence');
    if (!active()) return;
    site.innerHTML = sites.map(row => `<option value="${esc(row.id)}">${esc(row.url || row.name)}</option>`).join('');
    site.value = sites.find(row => row.preferred)?.id || sites[0]?.id || '';
    if (!site.value) throw new Error('Atlassian을 연결한 뒤 공간을 불러오세요.');
    await load();
  });
  site.onchange = run(() => load()); more.onclick = run(() => load(true));
  render();
  return {
    load(value) { selected = new Map((value || []).map(row => [key(row), row])); toggle.checked = Array.isArray(value); render(); },
    value() { return toggle.checked ? [...selected.values()].sort((a, b) => key(a).localeCompare(key(b))) : null; },
    setDisabled(value) { disabled = value; controls(); }
  };
}
