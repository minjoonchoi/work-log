export function detailResize(panel, handle) {
  const key = 'worklog.detail-width-ratio';
  let ratio = 0.5, drag = null, resizingClick = false;
  try { const value = Number(localStorage.getItem(key)); if (value > 0 && value < 1) ratio = value; } catch { /* Storage can be unavailable. */ }
  const bounds = () => { const max = Math.max(0, window.innerWidth - 24); return { min: Math.min(500, max), max }; };
  function paint() {
    document.documentElement.style.setProperty('--detail-width', `${ratio * 100}vw`);
    const { min, max } = bounds(), width = Math.round(Math.min(max, Math.max(min, innerWidth * ratio)));
    handle.setAttribute('aria-valuemin', String(Math.round(min)));
    handle.setAttribute('aria-valuemax', String(Math.round(max)));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `${width}픽셀`);
    handle.hidden = panel.hidden;
  }
  function save() { try { localStorage.setItem(key, String(ratio)); } catch { /* Keep the in-memory preference. */ } }
  function width(value) { const { min, max } = bounds(); ratio = Math.min(max, Math.max(min, value)) / innerWidth; paint(); }
  function finish(cancel = false) {
    if (!drag) return;
    const previous = drag; drag = null;
    if (cancel) ratio = previous.ratio; else save();
    document.body.classList.remove('resizing-detail');
    if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
    paint();
  }
  document.addEventListener('pointerdown', () => { resizingClick = false; }, true);
  document.addEventListener('pointerup', () => { setTimeout(() => { resizingClick = false; }, 0); });
  document.addEventListener('click', event => {
    if (resizingClick) { resizingClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    resizingClick = true; event.preventDefault(); handle.focus({ preventScroll: true });
    drag = { id: event.pointerId, ratio, x: event.clientX, width: panel.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing-detail');
  });
  handle.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) width(drag.width + drag.x - event.clientX); });
  handle.addEventListener('pointerup', event => { if (drag?.id === event.pointerId) finish(); });
  handle.addEventListener('pointercancel', () => finish(true));
  handle.addEventListener('lostpointercapture', () => finish(true));
  handle.addEventListener('dblclick', () => { finish(true); ratio = 0.5; paint(); save(); });
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const { min, max } = bounds();
    width(event.key === 'Home' ? min : event.key === 'End' ? max : panel.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 32 : -32)); save();
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finish(true); }
  }, true);
  window.addEventListener('blur', () => finish(true));
  window.addEventListener('resize', () => { finish(true); paint(); });
  new MutationObserver(() => { if (panel.hidden) finish(true); paint(); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  paint();
}
