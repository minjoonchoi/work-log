// Stored input/output records only. Rendering never depends on a task-specific result schema.
export function historyUI({ api, esc, eventHTML, invalidated }) {
  const caches = new Map();
  let itemId = null, panel = null, observer = null;
  const keyFor = session => session || 'unlinked';
  const current = cache => caches.get(cache.key) === cache && cache.item === itemId;
  const compare = (a, b) => b.event_at.localeCompare(a.event_at) || b.sequence - a.sequence;
  // A delayed record below the loaded range is retained until scrolling reaches its timestamp.
  const sorted = cache => [...cache.records.values()].filter(e => !cache.cursor || !cache.boundary || compare(e, cache.boundary) <= 0).sort(compare);
  const nodeFor = cache => panel && [...panel.querySelectorAll('[data-history-key]')].find(n => n.dataset.historyKey === cache.key);
  const visible = node => !node.closest('.session-card') || node.closest('.session-card').open;
  function clear() {
    for (const cache of caches.values()) cache.controller?.abort();
    caches.clear(); observer?.disconnect(); itemId = null;
  }
  function configure(data) {
    if (itemId !== data.item.id) clear();
    itemId = data.item.id;
    const streams = [...data.sessions.map(s => ({ key: s.id, session: s.id, meta: s.history })),
      { key: 'unlinked', session: null, meta: data.unlinked_history }];
    const keys = new Set(streams.map(s => s.key));
    for (const [key, cache] of caches) if (!keys.has(key)) { cache.controller?.abort(); caches.delete(key); }
    for (const { key, session, meta } of streams) {
      let cache = caches.get(key);
      if (!cache || cache.meta.revision !== meta.revision) {
        cache?.controller?.abort();
        cache = { key, session, item: itemId, records: new Map(), initialized: false, busy: false, cursor: null, watermark: 0 };
        caches.set(key, cache);
      }
      cache.meta = meta;
    }
  }
  function contents(cache) {
    const records = sorted(cache);
    return `<div class="history-records">${records.map(eventHTML).join('')}</div>
      <div class="history-page-status" role="status">${cache.error ? esc(cache.error) : cache.busy ? '기록을 불러오는 중…'
        : cache.initialized && !records.length ? '수집된 입력·응답이 없습니다.' : cache.initialized && !cache.cursor ? '모든 기록을 불러왔습니다.' : ''}</div>
      ${cache.error || !cache.initialized || cache.cursor ? `<div class="history-sentinel"><button class="history-more secondary" ${cache.busy ? 'disabled' : ''}>${cache.error ? '이력 다시 불러오기' : '이전 기록 불러오기'}</button></div>` : ''}`;
  }
  function html(session) {
    const cache = caches.get(keyFor(session));
    return `<div class="conversation-history" data-history-key="${esc(cache.key)}" aria-label="${session ? '세션 입력·응답 이력' : '연결 미확인 출력 이력'}" aria-busy="${cache.busy}">${contents(cache)}</div>`;
  }
  function anchor() {
    if (!panel || panel.scrollTop <= 0) return null;
    const bounds = panel.getBoundingClientRect();
    const node = [...panel.querySelectorAll('.event')].find(n => {
      const r = n.getBoundingClientRect(); return r.height && r.bottom > bounds.top && r.top < bounds.bottom;
    });
    return node ? { id: node.dataset.eventId, top: node.getBoundingClientRect().top } : null;
  }
  function paint(cache) {
    const node = nodeFor(cache); if (!node) return;
    const saved = anchor();
    const previous = node.querySelector('.history-sentinel'); if (previous) observer?.unobserve(previous);
    node.innerHTML = contents(cache); node.setAttribute('aria-busy', String(cache.busy));
    if (saved) {
      const found = [...panel.querySelectorAll('.event')].find(n => n.dataset.eventId === saved.id);
      if (found) panel.scrollTop += found.getBoundingClientRect().top - saved.top;
    }
    bindNode(node, cache);
  }
  async function fetchRecords(cache, mode) {
    if (!current(cache) || cache.busy) return;
    if (mode === 'older' && !cache.cursor) return;
    cache.busy = true; cache.error = null; cache.retryMode = mode;
    const controller = new AbortController(); cache.controller = controller;
    paint(cache);
    try {
      let cursor = mode === 'older' ? cache.cursor : null, page;
      const received = [];
      do {
        const params = new URLSearchParams({ limit: '40' });
        if (cache.session) params.set('session_id', cache.session);
        if (cursor) params.set('cursor', cursor);
        else if (mode === 'newer') params.set('after', String(cache.watermark));
        page = await api(`/items/${encodeURIComponent(cache.item)}/history?${params}`, { signal: controller.signal });
        if (!current(cache)) return;
        if (page.revision !== cache.meta.revision) { const e = new Error('세션 경계가 변경되어 이력을 다시 불러옵니다.'); e.status = 409; throw e; }
        received.push(...page.records); cursor = page.next_cursor;
      } while (mode === 'newer' && cursor);
      for (const record of received) cache.records.set(record.uid, record);
      if (mode !== 'newer') { cache.cursor = page.next_cursor; cache.boundary = page.records.at(-1) || cache.boundary; }
      if (mode !== 'older') cache.watermark = page.watermark;
      cache.initialized = true;
    } catch (e) {
      if (!current(cache) || controller.signal.aborted) return;
      cache.error = `이력을 불러오지 못했습니다. ${e.message}`;
      if (e.status === 409) {
        cache.records.clear(); cache.initialized = false; cache.cursor = null; cache.watermark = 0; cache.retryMode = 'initial';
        // Force a new cache even if a second metadata request was already in flight.
        cache.meta = { ...cache.meta, revision: null }; invalidated();
      }
    } finally {
      if (current(cache)) { cache.busy = false; paint(cache); }
    }
    if (current(cache) && !cache.error && cache.meta.watermark > cache.watermark) void fetchRecords(cache, 'newer');
  }
  function ensure(cache) {
    if (cache.busy || (cache.error && cache.retryMode !== 'newer')) return;
    if (!cache.initialized) void fetchRecords(cache, 'initial');
    else if (cache.meta.watermark > cache.watermark) void fetchRecords(cache, 'newer');
  }
  function bindNode(node, cache) {
    const button = node.querySelector('.history-more');
    if (button) button.onclick = () => void fetchRecords(cache, cache.error ? cache.retryMode : cache.initialized ? 'older' : 'initial');
    const sentinel = node.querySelector('.history-sentinel');
    if (sentinel) observer?.observe(sentinel);
  }
  function mount(root) {
    panel = root; observer?.disconnect();
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting && entry.target.isConnected) {
        const node = entry.target.closest('[data-history-key]'), cache = caches.get(node.dataset.historyKey);
        if (cache && visible(node) && !cache.error && !cache.busy) {
          if (cache.initialized) void fetchRecords(cache, 'older'); else ensure(cache);
        }
      }
    }, { root: panel, rootMargin: '100px 0px' });
    for (const node of panel.querySelectorAll('[data-history-key]')) {
      const cache = caches.get(node.dataset.historyKey); bindNode(node, cache);
      const session = node.closest('.session-card');
      if (session) session.ontoggle = () => { if (session.open) ensure(cache); };
      if (visible(node)) ensure(cache);
    }
  }
  function refresh() {
    for (const cache of caches.values()) { const node = nodeFor(cache); if (node && visible(node)) ensure(cache); }
  }
  return { configure, html, mount, clear, refresh };
}
