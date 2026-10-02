// Mouse/pen range selection; touch keeps native calendar scrolling.
export function calendarSelection({ calendar, selected, update, limit }) {
  let gesture = null, suppressClick = false, clickTimer;
  const dates = () => [...calendar.querySelectorAll('[data-report-date]')].map(input => input.dataset.reportDate);
  const cell = target => target?.closest?.('[data-date]');
  function restore(values) { selected.clear(); for (const date of values) selected.add(date); update(); }
  function finish(cancel = false) {
    if (!gesture) return;
    const previous = gesture; gesture = null;
    if (cancel && previous.dragging) restore(previous.before);
    calendar.classList.remove('is-selecting-dates');
    if (calendar.hasPointerCapture(previous.pointer)) calendar.releasePointerCapture(previous.pointer);
    if (previous.dragging) { suppressClick = true; clearTimeout(clickTimer); clickTimer = setTimeout(() => { suppressClick = false; }, 0); }
  }
  calendar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === 'touch') return;
    if (event.target.closest('button, a, select, textarea, input:not([data-report-date])')) return;
    const target = cell(event.target), visible = dates();
    if (!target || !visible.includes(target.dataset.date)) return;
    gesture = { pointer: event.pointerId, x: event.clientX, y: event.clientY, anchor: target.dataset.date,
      visible, before: new Set(selected), remove: selected.has(target.dataset.date), dragging: false, warned: false };
  });
  document.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    if (!calendar.getClientRects().length || dates().join() !== gesture.visible.join()) return finish(true);
    if (!gesture.dragging && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
    gesture.dragging = true; calendar.classList.add('is-selecting-dates'); calendar.setPointerCapture(event.pointerId);
    event.preventDefault();
    const target = cell(document.elementFromPoint(event.clientX, event.clientY));
    if (!target || !calendar.contains(target)) return;
    const end = gesture.visible.indexOf(target.dataset.date), start = gesture.visible.indexOf(gesture.anchor);
    if (end < 0) return;
    const next = new Set(gesture.before);
    for (const date of gesture.visible.slice(Math.min(start, end), Math.max(start, end) + 1)) {
      if (gesture.remove) next.delete(date); else next.add(date);
    }
    if (next.size > 366) { if (!gesture.warned) { limit(); gesture.warned = true; } return; }
    restore(next);
  }, { passive: false });
  document.addEventListener('pointerup', event => { if (event.pointerId === gesture?.pointer) finish(); });
  document.addEventListener('pointercancel', event => { if (event.pointerId === gesture?.pointer) finish(true); });
  calendar.addEventListener('lostpointercapture', () => finish(true));
  calendar.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  calendar.addEventListener('dragstart', event => { if (gesture) event.preventDefault(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && gesture) { event.preventDefault(); finish(true); } });
  window.addEventListener('blur', () => finish(true));
  return { refresh() { if (gesture && dates().join() !== gesture.visible.join()) finish(true); } };
}
