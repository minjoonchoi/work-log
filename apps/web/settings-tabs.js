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
