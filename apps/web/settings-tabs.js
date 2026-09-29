// Static IDs/labels supplied by the settings views. Panels stay mounted so
// switching tabs never discards unsaved values or starts another API request.
export function settingsTabs(id, label, tabs) {
  return `<div class="settings-tabs" role="tablist" aria-label="${label}" data-settings-tabs="${id}">${tabs.map(([key, title]) =>
    `<button type="button" role="tab" id="${id}-tab-${key}" data-settings-tab="${key}" aria-controls="${id}-panel-${key}" aria-selected="false" tabindex="-1">${title}</button>`).join('')}</div>`;
}

export function bindSettingsTabs(root, id, selected, onChange = () => {}) {
  const list = root.querySelector(`[data-settings-tabs="${id}"]`), tabs = [...list.querySelectorAll('[role="tab"]')];
  function activate(tab, focus = false) {
    for (const candidate of tabs) {
      const active = candidate === tab;
      candidate.setAttribute('aria-selected', String(active)); candidate.tabIndex = active ? 0 : -1;
      const panel = root.querySelector(`#${candidate.getAttribute('aria-controls')}`);
      panel.hidden = !active; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', candidate.id);
    }
    onChange(tab.dataset.settingsTab);
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => activate(tab);
    tab.onkeydown = event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next === null || tabs[next].disabled) return;
      event.preventDefault(); activate(tabs[next], true);
    };
  });
  activate(tabs.find(tab => tab.dataset.settingsTab === selected) || tabs[0]);
}

// A shared loading treatment: block pointer and keyboard interaction while
// preserving each control's own disabled state. Closing remains available.
const loadingViews = new WeakMap();
export function setSettingsLoading(root, loading) {
  if (!root) return;
  const previous = loadingViews.get(root);
  if (previous) {
    previous.overlay.remove();
    previous.controls.forEach(([node, inert]) => { node.inert = inert; });
    previous.closers.forEach(node => node.classList.remove('settings-loading-close'));
    loadingViews.delete(root);
  }
  root.classList.toggle('settings-loading', loading);
  root.setAttribute('aria-busy', String(loading));
  if (!loading) return;
  const closers = [...root.querySelectorAll('[data-close], #close-agent-connections')];
  const controls = [...root.querySelectorAll('button, input, select, textarea, a, summary, [tabindex], [contenteditable]')]
    .filter(node => !closers.includes(node)).map(node => [node, node.inert]);
  controls.forEach(([node]) => { node.inert = true; });
  closers.forEach(node => node.classList.add('settings-loading-close'));
  const overlay = document.createElement('div');
  overlay.className = 'settings-loading-overlay';
  overlay.innerHTML = '<span role="status" class="settings-loading-label">설정을 불러오는 중…</span>';
  root.append(overlay);
  const state = { overlay, controls, closers };
  loadingViews.set(root, state);
  return () => { if (loadingViews.get(root) === state) setSettingsLoading(root, false); };
}

export async function loadSettingsModal({ modal, title, load, retry }) {
  modal(`<h2>${title}</h2><div id="settings-initial-load"><p>설정 데이터를 준비하고 있습니다.</p></div><div class="dialog-actions"><button data-close>닫기</button></div>`);
  const marker = document.querySelector('#settings-initial-load'), root = marker.closest('#modal-content'), dialog = root.closest('dialog');
  const active = () => marker.isConnected && dialog.open;
  const finishLoading = setSettingsLoading(root, true);
  try {
    const result = await load();
    return active() ? result : null;
  } catch (error) {
    if (active()) {
      marker.replaceChildren();
      const message = document.createElement('p'); message.className = 'error'; message.setAttribute('role', 'alert'); message.textContent = error.message;
      const button = document.createElement('button'); button.className = 'secondary'; button.textContent = '다시 불러오기'; button.onclick = retry;
      marker.append(message, button);
    }
    return null;
  } finally { finishLoading(); }
}
