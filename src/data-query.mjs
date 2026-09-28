import { assert, digest, json, now } from './shared.mjs';

const paging = ['limit', 'cursor'], period = ['from', 'to'];
export const queryResources = {
  items: ['search', 'tag', 'jira', ...period, ...paging], item: ['id'],
  sessions: ['item', 'search', 'engine', ...period, ...paging], session: ['id'],
  history: ['item', 'session', ...paging],
  runs: ['item', 'internal', ...period, ...paging], run: ['id'],
  reports: ['search', ...period, ...paging], report: ['id'], tags: [...paging]
};
export const queryHelp = {
  version: 1, command: 'harness query <resource> [id] [options]', read_only: true,
  resources: queryResources,
  defaults: { limit: 20, max_limit: 100, internal: 'exclude' },
  notes: ['items 검색은 제목·설명·병합 전 제목, sessions 검색은 업무·세션 제목과 요약, reports 검색은 제목에 적용합니다.',
    'history에는 --item과 --session이 모두 필요합니다. 원본 입력·응답을 최신순으로 반환합니다.',
    '--from은 포함, --to는 제외합니다. 날짜만 쓰면 UTC 자정이며 현지 날짜는 시간대가 포함된 ISO 시각을 사용하세요.',
    'items는 최근 활동, sessions는 시간 구간 겹침, runs는 갱신 시각, reports는 생성 시각으로 기간을 필터링합니다.',
    '목록은 next_cursor를 --cursor에 전달합니다. 조회 조건이나 데이터가 바뀌어 409가 나면 첫 페이지부터 다시 조회하세요.',
    '관리 서비스에 저장된 기록만 조회합니다. 외부 동기화·모델 실행·상태 변경은 수행하지 않습니다.']
};

export function validateQuery(params) {
  const resource = params.get('resource'), allowed = queryResources[resource];
  assert(Array.isArray(allowed) && [...params.keys()].every(key => key === 'resource' || allowed.includes(key))
    && [...new Set(params.keys())].every(key => params.getAll(key).length === 1), '지원하지 않거나 중복된 조회 조건입니다. query --help를 확인하세요.');
  const q = Object.fromEntries(params);
  for (const key of ['id', 'item', 'session', 'tag', 'search']) if (key in q)
    assert(q[key].trim().length > 0 && q[key].length <= 500, `${key}는 1~500자로 입력하세요.`);
  if (allowed.includes('id')) assert(q.id, '조회할 ID가 필요합니다.');
  if (resource === 'history') assert(q.item && q.session, 'history에는 --item과 --session이 필요합니다.');
  if ('limit' in q) assert(/^\d+$/.test(q.limit) && Number(q.limit) >= 1 && Number(q.limit) <= 100, 'limit은 1~100이어야 합니다.');
  if ('cursor' in q) assert(q.cursor.length > 0 && q.cursor.length <= 2048, '조회 커서가 잘못되었습니다.');
  if ('jira' in q) assert(['all', 'linked', 'unlinked'].includes(q.jira), 'jira는 all|linked|unlinked입니다.');
  if ('engine' in q) assert(['codex', 'claude'].includes(q.engine), 'engine은 codex|claude입니다.');
  if ('internal' in q) assert(['exclude', 'include', 'only'].includes(q.internal), 'internal은 exclude|include|only입니다.');
  for (const key of period) if (key in q) {
    assert(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(q[key])
      && Number.isFinite(Date.parse(q[key])) && new Date(q[key].slice(0, 10)).toISOString().slice(0, 10) === q[key].slice(0, 10), `${key}는 유효한 날짜 또는 시간대가 있는 ISO 시각이어야 합니다.`);
    q[key] = new Date(q[key]).toISOString();
  }
  assert(!q.from || !q.to || q.from < q.to, 'from은 to보다 이전이어야 합니다.');
  return q;
}

export function dataQuery({ store, itemListing, sessionSummaries, itemDetail, reports }) {
  const envelope = (resource, value) => ({ version: 1, resource, observed_at: now(), source: 'local_store', ...value });
  const requireItem = id => {
    const canonical = store.canonical(id);
    assert(store.items().some(row => row.id === canonical), '업무를 찾을 수 없습니다.', 404); return canonical;
  };
  const runView = row => Object.fromEntries(['id', 'work_item_id', 'task', 'status', 'stage', 'internal', 'engine', 'created_at', 'updated_at', 'message', 'artifact', 'evidence', 'origin']
    .filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
  const storedRuns = () => {
    const visible = new Set(store.items().map(row => row.id));
    return store.storedRuns().filter(row => visible.has(row.work_item_id)).map(runView);
  };
  return params => {
    const q = validateQuery(params), resource = q.resource, limit = Number(q.limit || 20);
    const within = (end, start = end) => (!q.from || end >= q.from) && (!q.to || start < q.to);
    let rows;
    if (resource === 'history') return envelope(resource, store.history(requireItem(q.item), { session_id: q.session, limit, cursor: q.cursor || null }));
    if (resource === 'item') {
      const detail = itemDetail(requireItem(q.id));
      return envelope(resource, { record: { item: detail.item, agents: detail.agents, jira_links: detail.jira_links || [],
        session_ids: detail.sessions.map(row => row.id), run_ids: detail.runs.map(row => row.id) } });
    }
    if (resource === 'report') return envelope(resource, { record: reports.detail(q.id, { summary: true }) });
    if (resource === 'items') rows = itemListing(new URLSearchParams({ ...(q.search ? { q: q.search } : {}),
      ...(q.tag ? { tag: q.tag } : {}), ...(q.jira ? { jira: q.jira } : {}) })).filter(row => within(row.last_activity));
    if (['sessions', 'session'].includes(resource)) {
      const owner = q.item ? requireItem(q.item) : null;
      rows = store.sessionEntries({ q: q.search || '' }, sessionSummaries()).filter(row => (!owner || row.work_item_id === owner)
        && (!q.engine || row.engine === q.engine) && within(row.end_at, row.start_at));
    }
    if (['runs', 'run'].includes(resource)) {
      const owner = q.item ? requireItem(q.item) : null;
      rows = storedRuns().filter(row => (!owner || row.work_item_id === owner) && within(row.updated_at || row.created_at)
        && (resource === 'run' || q.internal === 'include' || (q.internal === 'only' ? row.internal : !row.internal)))
        .sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '') || a.id.localeCompare(b.id));
    }
    if (['session', 'run'].includes(resource)) {
      const record = rows.find(row => row.id === q.id); assert(record, '기록을 찾을 수 없습니다.', 404);
      return envelope(resource, { record });
    }
    if (resource === 'reports') rows = reports.list().filter(row => within(row.created_at) && row.title.toLowerCase().includes((q.search || '').toLowerCase()));
    if (resource === 'tags') rows = store.tagList();
    const { cursor, limit: ignored, ...scope } = q;
    const fingerprint = digest(json({ scope, rows }));
    let offset = 0;
    if (cursor) {
      let page; try { page = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { assert(false, '조회 커서가 잘못되었습니다.'); }
      assert(page && Number.isSafeInteger(page.offset) && page.offset >= 0 && typeof page.fingerprint === 'string', '조회 커서가 잘못되었습니다.');
      assert(page.fingerprint === fingerprint, '조회 조건 또는 기록이 변경되었습니다. 첫 페이지부터 다시 조회하세요.', 409);
      offset = page.offset; assert(offset <= rows.length, '조회 커서 범위가 잘못되었습니다.');
    }
    const next = offset + limit;
    return envelope(resource, { records: rows.slice(offset, next), total: rows.length,
      next_cursor: next < rows.length ? Buffer.from(json({ offset: next, fingerprint })).toString('base64url') : null });
  };
}
