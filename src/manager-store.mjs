import path from 'node:path';
import { database, transaction, validateEvent, stableId, id, now, json, assert, digest } from './shared.mjs';
import { currentHookEvent, receivedTurn, resolveHookTurns } from './hook-events.mjs';

const schema = `
CREATE TABLE IF NOT EXISTS work_items (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 merged_into TEXT REFERENCES work_items(id), manual INTEGER NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, metadata_protected INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_sessions (
 id TEXT PRIMARY KEY, engine TEXT NOT NULL, source_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 role TEXT NOT NULL, UNIQUE(engine, source_id)
);
CREATE TABLE IF NOT EXISTS agent_item_bindings (
 agent_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id)
);
INSERT OR IGNORE INTO agent_item_bindings SELECT id,work_item_id FROM agent_sessions;
CREATE TABLE IF NOT EXISTS events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
 kind TEXT NOT NULL, event_at TEXT NOT NULL, ingested_at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_agent_time ON events(agent_id, event_at, seq);
CREATE TABLE IF NOT EXISTS work_item_sessions (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, work_item_id TEXT NOT NULL, first_event_id TEXT NOT NULL,
 start_at TEXT NOT NULL, end_at TEXT NOT NULL, pending INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS event_links (event_id TEXT PRIMARY KEY, session_id TEXT, resolution TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS event_link_session ON event_links(session_id,event_id);
CREATE TABLE IF NOT EXISTS history_revisions (agent_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS run_views (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS merges (id TEXT PRIMARY KEY, target TEXT NOT NULL, sources TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_item_deletions (
 work_item_id TEXT PRIMARY KEY REFERENCES work_items(id), deleted_at TEXT, operation_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS item_visibility_operations (
 operation_id TEXT PRIMARY KEY, action TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_item_tags (
 work_item_id TEXT NOT NULL REFERENCES work_items(id), tag TEXT NOT NULL,
 PRIMARY KEY(work_item_id,tag)
);
CREATE INDEX IF NOT EXISTS work_item_tag_name ON work_item_tags(tag,work_item_id);
CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version=1;`;

export function managerStore(dir) {
  const db = database(path.join(dir, 'memory.sqlite'), schema);
  if (!db.prepare('PRAGMA table_info(work_items)').all().some(column => column.name === 'metadata_protected')) {
    transaction(db, () => {
    db.exec('ALTER TABLE work_items ADD COLUMN metadata_protected INTEGER NOT NULL DEFAULT 0');
    // Only an exact, version-adjacent accepted writer proves that no human edit followed generation.
    db.exec('UPDATE work_items SET metadata_protected=manual');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='writing_requests'").get()) {
      for (const item of db.prepare('SELECT * FROM work_items WHERE manual=1').all()) {
        const row = db.prepare("SELECT snapshot,result,state FROM writing_requests WHERE format='work-item-metadata' AND target_id=? ORDER BY seq DESC LIMIT 1").get(item.id);
        if (!row || row.state !== 'completed') continue;
        try {
          const snapshot = JSON.parse(row.snapshot), result = JSON.parse(row.result);
          if (snapshot.base_version + 1 === item.version && result.title === item.title && result.description === item.description) {
            db.prepare('UPDATE work_items SET metadata_protected=0 WHERE id=?').run(item.id);
          }
        } catch { /* Ambiguous legacy values remain protected. */ }
      }
    }
    });
  }
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const exec = (sql, ...args) => db.prepare(sql).run(...args);
  function canonical(item) {
    const seen = new Set(); let row;
    while ((row = one('SELECT * FROM work_items WHERE id=?', item))?.merged_into) {
      assert(!seen.has(item), '병합 연결 순환', 500); seen.add(item); item = row.merged_into;
    }
    return item;
  }
  const isDeleted = item => !!one('SELECT deleted_at FROM work_item_deletions WHERE work_item_id=?', canonical(item))?.deleted_at;
  const visibilityRevision = item => one('SELECT revision FROM work_item_deletions WHERE work_item_id=?', canonical(item))?.revision || 0;
  function assertVisible(item) {
    assert(one('SELECT id FROM work_items WHERE id=?', canonical(item)) && !isDeleted(item), '업무를 찾을 수 없습니다.', 404);
  }
  function normalizeTag(value) {
    assert(typeof value === 'string' && !/[\p{Cc}\p{Cf}]/u.test(value), '태그 이름은 제어 문자 없이 1~40자로 입력하세요.');
    const tag = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
    assert([...tag].length >= 1 && [...tag].length <= 40, '태그 이름은 1~40자로 입력하세요.');
    return tag;
  }
  function normalizedTags(values) {
    assert(Array.isArray(values) && values.length <= 20, '업무에는 태그를 최대 20개 지정할 수 있습니다.');
    return [...new Set(values.map(normalizeTag))].sort();
  }
  const itemTags = item => all('SELECT tag FROM work_item_tags WHERE work_item_id=?', canonical(item)).map(row => row.tag).sort();
  function tagList({ trash = false } = {}) {
    assert(typeof trash === 'boolean', '태그 조회 조건이 잘못되었습니다.');
    return all(`SELECT t.tag AS name,COUNT(*) AS count FROM work_item_tags t JOIN work_items w ON w.id=t.work_item_id
      LEFT JOIN work_item_deletions d ON d.work_item_id=w.id WHERE w.merged_into IS NULL
      AND (d.deleted_at IS NOT NULL)=? GROUP BY t.tag ORDER BY t.tag`, Number(trash));
  }
  function replaceTags(item, tags) {
    exec('DELETE FROM work_item_tags WHERE work_item_id=?', item);
    for (const tag of tags) exec('INSERT INTO work_item_tags VALUES(?,?)', item, tag);
  }
  function editTags(itemId, input) {
    assert(input && typeof input === 'object' && !Array.isArray(input)
      && Object.keys(input).length === 2 && Object.keys(input).every(key => ['version', 'tags'].includes(key))
      && Number.isSafeInteger(input.version) && input.version >= 1, '현재 업무 버전과 태그 목록이 필요합니다.');
    const tags = normalizedTags(input.tags);
    return transaction(db, () => {
      assertVisible(itemId);
      const item = one('SELECT id,version FROM work_items WHERE id=?', canonical(itemId));
      assert(item.id === itemId && input.version === item.version, '업무 정보가 변경되었습니다. 최신 내용을 불러오세요.', 409);
      if (json(itemTags(item.id)) !== json(tags)) {
        replaceTags(item.id, tags);
        exec('UPDATE work_items SET version=version+1 WHERE id=?', item.id);
      }
      return detail(item.id);
    });
  }
  function ensureItem(item, at) {
    exec('INSERT OR IGNORE INTO work_items(id,title,created_at) VALUES(?,?,?)', item, '새 작업', at);
    return item;
  }
  function bindItem(agentId, requested, at) {
    // Reserve a parent's identity even if its worker reaches the manager first.
    // Keep the original owner alias: merges must not create new time windows.
    const owner = one('SELECT work_item_id FROM agent_item_bindings WHERE agent_id=?', agentId)?.work_item_id
      || one('SELECT work_item_id FROM agent_sessions WHERE id=?', agentId)?.work_item_id
      || requested || stableId('item-', agentId);
    ensureItem(owner, at);
    exec('INSERT OR IGNORE INTO agent_item_bindings VALUES(?,?)', agentId, owner);
    return owner;
  }
  function orderedAgentEvents(agentId) {
    const rows = all('SELECT * FROM events WHERE agent_id=? ORDER BY event_at, seq', agentId);
    rows.sort((a, b) => {
      if (a.event_at !== b.event_at) return a.event_at.localeCompare(b.event_at);
      const left = JSON.parse(a.payload), right = JSON.parse(b.payload);
      return currentHookEvent(left) && currentHookEvent(right) && left.observed_order && right.observed_order
        ? left.observed_order.localeCompare(right.observed_order) || a.seq - b.seq : a.seq - b.seq;
    });
    return rows;
  }
  function agentContext({ engine, session_id }) {
    assert(['codex', 'claude'].includes(engine) && typeof session_id === 'string'
      && session_id.length > 0 && session_id.length <= 500 && !/[\u0000-\u001f\u007f]/.test(session_id), '에이전트 세션 식별자를 확인하세요.');
    const agent = one("SELECT * FROM agent_sessions WHERE engine=? AND source_id=? AND role='user'", engine, session_id);
    const binding = one('SELECT work_item_id FROM agent_item_bindings WHERE agent_id=?', stableId('agent-', `${engine}:${session_id}`));
    assert(agent || binding, '등록된 에이전트 세션이 없습니다.', 404);
    const owner = binding?.work_item_id || agent.work_item_id;
    assert(!isDeleted(owner), '삭제한 업무입니다. 업무를 복원한 뒤 다시 요청하세요.', 409);
    // A worker can reserve its parent before the first native hook arrives.
    // This is a known owner with an unobserved input, not a standalone request.
    if (!agent) return { work_item_id: canonical(owner), origin: null };
    const rows = orderedAgentEvents(agent.id).filter(row => JSON.parse(row.payload).source === 'system_hook');
    const { pending } = resolveHookTurns(rows, { withPending: true });
    const input = pending.length === 1 ? pending[0] : null;
    return { work_item_id: canonical(owner),
      origin: input ? { engine, agent_session_id: session_id, turn_id: input.turn_id } : null };
  }
  function project(agentId) {
    const agent = one('SELECT * FROM agent_sessions WHERE id=?', agentId);
    const rows = orderedAgentEvents(agentId);
    const previous = new Map(all(`SELECT e.id,l.session_id,l.resolution,json_extract(e.payload,'$.turn_id') AS turn_id FROM events e JOIN event_links l ON l.event_id=e.id
      WHERE e.agent_id=? AND e.kind IN ('input','output')`, agentId).map(r => [r.id, r]));
    exec('UPDATE work_item_sessions SET active=0 WHERE agent_id=?', agentId);
    for (const r of rows) exec('DELETE FROM event_links WHERE event_id=?', r.id);
    if (agent.role !== 'user') {
      for (const row of rows) {
        const e = JSON.parse(row.payload);
        const parent = e.parent || {};
        const sourceAgent = stableId('agent-', `${parent.engine}:${parent.agent_session_id}`);
        const input = all("SELECT id,payload FROM events WHERE agent_id=? AND kind='input'", sourceAgent)
          .find(x => JSON.parse(x.payload).turn_id === parent.turn_id);
        const link = input && one('SELECT session_id FROM event_links WHERE event_id=?', input.id);
        exec('INSERT INTO event_links VALUES(?,?,?)', row.id, link?.session_id || null, link?.session_id ? 'parent' : 'unresolved');
      }
      return;
    }
    const resolved = resolveHookTurns(rows);
    for (let index = 0; index < rows.length; index++) {
      const payload = json(resolved[index]);
      if (payload !== rows[index].payload) {
        exec('UPDATE events SET payload=? WHERE id=?', payload, rows[index].id);
        rows[index].payload = payload;
      }
    }
    const counts = new Map();
    for (const row of rows) if (row.kind === 'input') {
      const key = JSON.parse(row.payload).turn_id; counts.set(key, (counts.get(key) || 0) + 1);
    }
    const turns = new Map(), windows = new Map();
    let current, lastOutput = null, previousOwner = null;
    for (const row of rows) {
      const e = JSON.parse(row.payload);
      let sid = null, resolution = 'unresolved';
      if (e.kind === 'input') {
        const owner = e.work_item_id || previousOwner || agent.work_item_id;
        ensureItem(owner, e.event_at);
        // Compare original owners, not canonical aliases: a merge must never resegment history.
        if (!current || owner !== previousOwner || (lastOutput !== null && Date.parse(e.event_at) - lastOutput >= 1200000)) {
          current = stableId('session-', row.id);
          windows.set(current, { id: current, owner, first: row.id, start: e.event_at, end: e.event_at, pending: new Set() });
        }
        previousOwner = owner;
        const w = windows.get(current); w.end = e.event_at > w.end ? e.event_at : w.end;
        w.pending.add(e.turn_id);
        if (counts.get(e.turn_id) === 1) turns.set(e.turn_id, current);
        sid = current; resolution = 'input';
        const item = one('SELECT * FROM work_items WHERE id=?', canonical(owner));
        if (item.title === '새 작업' && !item.manual && e.text && !isDeleted(item.id)) {
          exec('UPDATE work_items SET title=?, description=?, version=version+1 WHERE id=?', e.text.trim().slice(0, 70), e.text.slice(0, 500), item.id);
        }
      } else if (['output', 'turn.interrupted', 'turn.failed'].includes(e.kind) && turns.has(e.turn_id)) {
        sid = turns.get(e.turn_id); resolution = e.text == null && e.kind === 'output' ? 'missing_body' : 'matched';
        const w = windows.get(sid); w.end = e.event_at > w.end ? e.event_at : w.end;
        w.pending.delete(e.turn_id);
        // An observed Stop with missing body still proves output timing; unmatched output never does.
        if (e.kind === 'output') lastOutput = Date.parse(e.event_at);
      } else if (turns.has(e.turn_id)) { sid = turns.get(e.turn_id); resolution = 'matched'; }
      exec('INSERT INTO event_links VALUES(?,?,?)', row.id, sid, resolution);
    }
    // Appends keep paging snapshots valid. Only reassigning an existing record invalidates them.
    if (all(`SELECT e.id,l.session_id,l.resolution,json_extract(e.payload,'$.turn_id') AS turn_id FROM events e JOIN event_links l ON l.event_id=e.id
      WHERE e.agent_id=? AND e.kind IN ('input','output')`, agentId).some(r => {
      const old = previous.get(r.id); return old && (old.session_id !== r.session_id || old.resolution !== r.resolution || old.turn_id !== r.turn_id);
    })) exec(`INSERT INTO history_revisions VALUES(?,1) ON CONFLICT(agent_id) DO UPDATE SET revision=revision+1`, agentId);
    for (const w of windows.values()) {
      exec(`INSERT INTO work_item_sessions VALUES(?,?,?,?,?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET work_item_id=excluded.work_item_id,start_at=excluded.start_at,
        end_at=excluded.end_at,pending=excluded.pending,active=1`,
      w.id, agentId, w.owner, w.first, w.start, w.end, w.pending.size > 0 ? 1 : 0);
    }
  }
  function ingestMany(raws, cursor) {
    return transaction(db, () => {
      let inserted = 0; const changed = new Set();
      for (const raw of raws) {
        const e = validateEvent(raw);
        const aid = stableId('agent-', `${e.engine}:${e.agent_session_id}`);
        const uid = stableId('event-', `${e.engine}:${e.agent_session_id}:${e.id}`);
        const old = one('SELECT payload FROM events WHERE id=?', uid);
        if (old) {
          const previous = JSON.parse(old.payload);
          // Pre-spool-receipt hooks kept replay timestamps in their own SQLite
          // database. Preserve those already ingested observations on upgrade.
          const legacyHookReplay = previous.source === 'system_hook' && !currentHookEvent(previous) && currentHookEvent(e)
            && previous.kind === e.kind && previous.text === e.text
            && (!e.source_turn_id || previous.turn_id === e.source_turn_id);
          if (legacyHookReplay) continue;
          assert(previous.kind === e.kind && previous.event_at === e.event_at && previous.text === e.text && receivedTurn(previous) === receivedTurn(e)
            && currentHookEvent(previous) === currentHookEvent(e),
            '같은 원본 키에 다른 이벤트가 있습니다.', 409);
          continue;
        }
        let agent = one('SELECT * FROM agent_sessions WHERE id=?', aid);
        let parentOwner;
        if (e.role !== 'user' && typeof e.parent?.engine === 'string' && e.parent.engine
          && typeof e.parent?.agent_session_id === 'string' && e.parent.agent_session_id) {
          parentOwner = bindItem(stableId('agent-', `${e.parent.engine}:${e.parent.agent_session_id}`),
            e.parent.work_item_id || e.work_item_id, e.event_at);
        }
        const owner = bindItem(aid, parentOwner || e.work_item_id || e.parent?.work_item_id, e.event_at);
        if (e.work_item_id && e.work_item_id !== owner) e.requested_work_item_id = e.work_item_id;
        e.work_item_id = owner;
        if (parentOwner) e.parent = { ...e.parent, work_item_id: parentOwner,
          ...(e.parent.work_item_id && e.parent.work_item_id !== parentOwner ? { requested_work_item_id: e.parent.work_item_id } : {}) };
        if (!agent) {
          exec('INSERT INTO agent_sessions VALUES(?,?,?,?,?)', aid, e.engine, e.agent_session_id, owner, e.role);
          agent = { role: e.role };
        }
        assert(agent.role === e.role, '에이전트 세션 역할이 충돌합니다.', 409);
        exec('INSERT INTO events(id,agent_id,kind,event_at,ingested_at,payload) VALUES(?,?,?,?,?,?)', uid, aid, e.kind, e.event_at, now(), json(e));
        if (e.kind === 'run.updated' && e.run) {
          exec('INSERT INTO run_views VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', e.run.id, owner, json(e.run));
        }
        inserted++; changed.add(aid);
      }
      for (const a of changed) if (one('SELECT role FROM agent_sessions WHERE id=?', a).role === 'user') project(a);
      if (changed.size) for (const a of all("SELECT id FROM agent_sessions WHERE role!='user'")) project(a.id);
      if (cursor) exec('INSERT INTO cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value', cursor.source, String(cursor.value));
      return { inserted, duplicates: raws.length - inserted };
    });
  }
  function sessionList(itemId, { includeDeleted = false } = {}) {
    return all(`SELECT s.*,a.engine,a.source_id AS agent_session_id FROM work_item_sessions s
      JOIN agent_sessions a ON a.id=s.agent_id WHERE s.active=1 ORDER BY s.start_at,s.id`)
      .map(s => ({ ...s, original_work_item_id: s.work_item_id, work_item_id: canonical(s.work_item_id), pending: !!s.pending }))
      .filter(s => (includeDeleted || !isDeleted(s.work_item_id)) && (!itemId || s.work_item_id === canonical(itemId)));
  }
  function sessionEntries({ q = '' } = {}, summaries = new Map()) {
    assert(typeof q === 'string' && q.length <= 500, '세션 검색어는 500자 이하여야 합니다.');
    const search = q.trim().toLowerCase(), sessions = sessionList(), latest = new Map();
    const workItems = all('SELECT id,title,description,merged_into FROM work_items');
    const labels = new Map(workItems.map(item => [item.id, item])), aliases = new Map();
    for (const item of workItems) if (item.merged_into) {
      const owner = canonical(item.id), titles = aliases.get(owner) || [];
      titles.push(`${item.title} ${item.description}`); aliases.set(owner, titles);
    }
    for (const session of sessionList(null, { includeDeleted: true })) latest.set(session.agent_id, session.id);
    return sessions.map(session => {
      const item = labels.get(session.work_item_id), summary = summaries.get(session.id);
      const summaryText = typeof summary?.text === 'string' ? summary.text.trim() : '';
      const [summaryTitle = '', ...body] = summaryText.split(/\r?\n/);
      // Only a short label is read from the original prompt. The list never returns conversation bodies.
      const firstInput = summaryTitle ? '' : one("SELECT substr(json_extract(payload,'$.text'),1,200) AS text FROM events WHERE id=?", session.first_event_id)?.text || '';
      const title = summaryTitle || firstInput.trim().split(/\r?\n/)[0] || item.title;
      const description = summaryText ? body.join('\n').trim() : '';
      const row = { id: session.id, work_item_id: session.work_item_id, work_item_title: item.title,
        title, description, engine: session.engine, agent_session_id: session.agent_session_id,
        start_at: session.start_at, end_at: session.end_at, last_activity: session.end_at,
        pending: session.pending,
        closed: latest.get(session.agent_id) !== session.id && !session.pending,
        summary_state: summary?.state || null, has_summary: !!summaryText };
      return { row, searchable: `${item.title} ${item.description} ${(aliases.get(item.id) || []).join(' ')} ${title} ${description}`.toLowerCase() };
    }).filter(({ searchable }) => searchable.includes(search)).map(({ row }) => row)
      .sort((a, b) => b.end_at.localeCompare(a.end_at) || b.start_at.localeCompare(a.start_at) || a.id.localeCompare(b.id));
  }
  function runs(itemId) {
    return all('SELECT * FROM run_views').filter(r => !itemId || canonical(r.work_item_id) === canonical(itemId))
      .map(r => ({ ...JSON.parse(r.payload), work_item_id: canonical(r.work_item_id) }));
  }
  function items(search = '', { trash = false, tag = null, untagged = false } = {}) {
    assert(typeof trash === 'boolean', '삭제한 업무 조회 조건이 잘못되었습니다.');
    assert(typeof untagged === 'boolean' && !(tag !== null && untagged), '태그 조회 조건이 잘못되었습니다.');
    const requestedTag = tag === null ? null : normalizeTag(tag);
    search = search.trim().toLowerCase();
    const sessions = sessionList(null, { includeDeleted: trash }); const running = runs();
    return all('SELECT * FROM work_items WHERE merged_into IS NULL').filter(w => isDeleted(w.id) === trash).map(w => {
      const ss = sessions.filter(s => s.work_item_id === w.id), rr = running.filter(r => r.work_item_id === w.id && !r.internal);
      const aliases = all('SELECT id,title,description FROM work_items WHERE merged_into IS NOT NULL').filter(a => canonical(a.id) === w.id);
      const state = rr.some(r => ['running', 'pending'].includes(r.status)) ? 'running'
        : rr.length && rr.every(r => r.status === 'completed') && !ss.some(s => s.pending) ? 'completed' : 'tracked';
      const pending = ss.filter(s => s.pending).length;
      const activities = [
        rr.some(r => r.status === 'running') && 'running',
        rr.some(r => r.status === 'pending') && 'queued',
        !rr.some(r => ['running', 'pending'].includes(r.status)) && ss.some(s => s.pending) && 'agent_response_pending'
      ].filter(Boolean);
      const activity = activities[0] || 'recent';
      const activityTimes = [...ss.map(s => s.end_at), ...rr.map(r => r.updated_at)].filter(at => typeof at === 'string' && Number.isFinite(Date.parse(at)))
        .map(at => new Date(at).toISOString());
      return { ...w, tags: itemTags(w.id), state, activity, activities, is_current: ['running', 'queued', 'agent_response_pending'].includes(activity), pending_session_count: pending,
        aliases, session_count: ss.length, last_activity: activityTimes.sort().at(-1) || w.created_at,
        deleted_at: one('SELECT deleted_at FROM work_item_deletions WHERE work_item_id=?', w.id)?.deleted_at || null };
    }).filter(w => (requestedTag === null || w.tags.includes(requestedTag)) && (!untagged || w.tags.length === 0)
      && `${w.title} ${w.description} ${w.aliases.map(a => `${a.title} ${a.description}`).join(' ')}`.toLowerCase().includes(search))
      .sort((a, b) => b.last_activity.localeCompare(a.last_activity) || a.id.localeCompare(b.id));
  }
  function quickOverview() {
    const rows = items().map(w => ({ id: w.id, title: w.title, state: w.state, last_activity: w.last_activity, activity: w.activity, activities: w.activities }));
    const current = rows.filter(w => ['running', 'queued', 'agent_response_pending'].includes(w.activity));
    const recent = rows.filter(w => w.activity === 'recent');
    return { counts: { current: current.length, recent: recent.length, total: rows.length },
      current: current.slice(0, 5), recent: recent.slice(0, 5) };
  }
  const decodeEvent = e => ({ ...JSON.parse(e.payload), uid: e.id, sequence: e.seq, session_id: e.session_id,
    resolution: e.resolution, ingested_at: e.ingested_at });
  function historyScope(itemId, sessionId) {
    const resolved = canonical(itemId);
    assertVisible(resolved);
    if (sessionId) {
      const session = one('SELECT * FROM work_item_sessions WHERE id=?', sessionId);
      assert(session && canonical(session.work_item_id) === resolved, '세션을 찾을 수 없습니다.', 404);
      assert(session.active, '세션 경계가 변경되었습니다. 이력을 다시 불러오세요.', 409);
      const revision = one('SELECT revision FROM history_revisions WHERE agent_id=?', session.agent_id)?.revision || 0;
      return { clause: "e.agent_id=? AND l.session_id=? AND e.kind IN ('input','output')", args: [session.agent_id, sessionId],
        revision: digest(json([resolved, sessionId, revision])) };
    }
    const agents = all("SELECT a.id,a.work_item_id,COALESCE(h.revision,0) AS revision FROM agent_sessions a LEFT JOIN history_revisions h ON h.agent_id=a.id WHERE a.role='user' ORDER BY a.id")
      .filter(a => canonical(a.work_item_id) === resolved);
    return { clause: `e.agent_id IN (${agents.map(() => '?').join(',') || 'NULL'}) AND l.session_id IS NULL AND e.kind='output'`,
      args: agents.map(a => a.id), revision: digest(json([resolved, agents.map(a => [a.id, a.revision])])) };
  }
  const historyFrom = 'FROM events e LEFT JOIN event_links l ON l.event_id=e.id';
  function historyMeta(itemId, sessionId) {
    const scope = historyScope(itemId, sessionId);
    return { ...one(`SELECT COUNT(*) AS count,COALESCE(MAX(e.seq),0) AS watermark ${historyFrom} WHERE ${scope.clause}`, ...scope.args), revision: scope.revision };
  }
  function history(itemId, { session_id = null, cursor = null, after = null, limit = 40 } = {}) {
    limit = Number(limit);
    assert(Number.isInteger(limit) && limit >= 1 && limit <= 100, '이력 페이지 크기는 1~100이어야 합니다.');
    const scope = historyScope(itemId, session_id);
    let page;
    if (cursor !== null) {
      assert(after === null && typeof cursor === 'string' && cursor.length <= 2048, '이력 커서가 잘못되었습니다.');
      try { page = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { assert(false, '이력 커서가 잘못되었습니다.'); }
      assert(page && page.item === canonical(itemId) && page.session === session_id && ['older', 'newer'].includes(page.mode)
        && Number.isSafeInteger(page.upper) && page.upper >= 0 && Number.isSafeInteger(page.position) && page.position >= 0
        && (page.mode === 'newer' || (typeof page.at === 'string' && Number.isFinite(Date.parse(page.at)))), '이력 커서가 잘못되었습니다.');
      assert(page.revision === scope.revision, '세션 경계가 변경되었습니다. 이력을 다시 불러오세요.', 409);
    } else {
      const upper = one('SELECT COALESCE(MAX(seq),0) AS n FROM events').n;
      assert(after === null || (/^\d+$/.test(String(after)) && Number.isSafeInteger(Number(after)) && Number(after) <= upper), '이력 수집 위치가 잘못되었습니다.');
      page = { item: canonical(itemId), session: session_id, revision: scope.revision, upper,
        mode: after === null ? 'older' : 'newer', position: after === null ? upper + 1 : Number(after), at: '9999-12-31T23:59:59.999Z' };
    }
    const newer = page.mode === 'newer';
    const bounds = newer ? 'e.seq>?' : '(e.event_at<? OR (e.event_at=? AND e.seq<?))';
    const args = newer ? [page.position] : [page.at, page.at, page.position];
    const rows = all(`SELECT e.*,l.session_id,l.resolution ${historyFrom} WHERE ${scope.clause} AND e.seq<=? AND ${bounds}
      ORDER BY ${newer ? 'e.seq' : 'e.event_at DESC,e.seq DESC'} LIMIT ?`, ...scope.args, page.upper, ...args, limit + 1);
    const more = rows.length > limit, records = rows.slice(0, limit), last = records.at(-1);
    return { records: records.map(decodeEvent), watermark: page.upper, revision: scope.revision,
      next_cursor: more ? Buffer.from(json({ ...page, at: last.event_at, position: last.seq })).toString('base64url') : null };
  }
  function runEvents(itemId, runId) {
    assertVisible(itemId);
    assert(runs(itemId).some(r => r.id === runId), '실행을 찾을 수 없습니다.', 404);
    return all(`SELECT e.*,l.session_id,l.resolution ${historyFrom} WHERE json_extract(e.payload,'$.parent.run_id')=?
      AND json_extract(e.payload,'$.role')!='user' ORDER BY e.event_at DESC,e.seq DESC`, runId).map(decodeEvent);
  }
  function sessionMessages(sessionId) {
    const session = one('SELECT work_item_id FROM work_item_sessions WHERE id=?', sessionId);
    if (session) assertVisible(session.work_item_id);
    return all(`SELECT e.*,l.session_id,l.resolution ${historyFrom} WHERE l.session_id=?
      AND json_extract(e.payload,'$.role')='user' AND e.kind IN ('input','output','turn.failed','turn.interrupted')
      ORDER BY e.event_at,e.seq`, sessionId).map(decodeEvent);
  }
  function detail(itemId, { summary = false } = {}) {
    const resolved = canonical(itemId), item = items().find(i => i.id === resolved);
    assert(item, '업무를 찾을 수 없습니다.', 404);
    const sessions = sessionList(resolved), sids = new Set(sessions.map(s => s.id));
    const agents = all('SELECT * FROM agent_sessions').filter(a => canonical(a.work_item_id) === resolved);
    const agentIds = new Set(agents.map(a => a.id));
    const events = summary ? [] : all('SELECT e.*,l.session_id,l.resolution FROM events e LEFT JOIN event_links l ON l.event_id=e.id ORDER BY event_at,seq')
      .filter(e => sids.has(e.session_id) || (!e.session_id && agentIds.has(e.agent_id)))
      .map(decodeEvent);
    const linkedRuns = runs(resolved).map(run => {
      // Legacy CLI inputs have deterministic run IDs; worker parents also preserve explicit origins.
      // Neither recovery path relies on time proximity or on a similar title.
      const candidates = run.origin ? [] : all(`SELECT payload FROM events WHERE json_extract(payload,'$.parent.run_id')=?
        OR (kind='input' AND json_extract(payload,'$.role')='user' AND json_extract(payload,'$.id')=?)`, run.id, `input-${run.id}`).map(e => JSON.parse(e.payload));
      const origins = run.origin ? [run.origin] : [...new Map(candidates.map(e => {
        const { engine, agent_session_id, turn_id } = e.parent?.run_id === run.id ? e.parent : e, origin = { engine, agent_session_id, turn_id };
        return [json(origin), origin];
      })).values()];
      const origin = origins.length === 1 ? origins[0] : null;
      const inputs = origin ? all(`SELECT l.session_id FROM events e JOIN event_links l ON l.event_id=e.id
        WHERE e.agent_id=? AND e.kind='input' AND json_extract(e.payload,'$.role')='user' AND json_extract(e.payload,'$.turn_id')=? LIMIT 2`,
      stableId('agent-', `${origin.engine}:${origin.agent_session_id}`), origin.turn_id) : [];
      return { ...run, origin, session_id: inputs.length === 1 && sids.has(inputs[0].session_id) ? inputs[0].session_id : null };
    });
    return { item, sessions: summary ? sessions.map(s => ({ ...s, history: historyMeta(resolved, s.id) })) : sessions,
      agents, events, runs: linkedRuns, ...(summary ? { unlinked_history: historyMeta(resolved, null) } : {}) };
  }
  function merge({ ids, target, operation_id }) {
    assert(Array.isArray(ids) && ids.length >= 2 && ids.length <= 100 && ids.every(x => typeof x === 'string'), '병합할 업무를 2개 이상 선택하세요.');
    assert(ids.includes(target), '대표 업무는 선택한 항목이어야 합니다.');
    assert(typeof operation_id === 'string' && operation_id.length, '병합 요청 ID가 필요합니다.');
    return transaction(db, () => {
      for (const item of ids) assertVisible(item);
      const prior = one('SELECT * FROM merges WHERE id=?', operation_id);
      if (prior) {
        assert(prior.sources === json(ids) && prior.target === target, '병합 요청 ID가 충돌합니다.', 409);
        return { id: canonical(target), repeated: true };
      }
      for (const item of ids) assert(one('SELECT id FROM work_items WHERE id=?', item), '업무를 찾을 수 없습니다.', 404);
      const representative = canonical(target);
      const sources = new Set(ids.map(canonical));
      const tags = [...new Set([...sources].flatMap(itemTags))].sort();
      assert(tags.length <= 20, '병합 후 태그가 20개를 초과합니다. 태그를 정리한 뒤 다시 병합하세요.');
      for (const source of sources) if (source !== representative) {
        exec('UPDATE work_items SET merged_into=?,version=version+1 WHERE id=?', representative, source);
        exec('DELETE FROM work_item_tags WHERE work_item_id=?', source);
      }
      replaceTags(representative, tags);
      exec('INSERT INTO merges VALUES(?,?,?,?)', operation_id, target, json(ids), now());
      exec('UPDATE work_items SET version=version+1 WHERE id=?', representative);
      return { id: representative, repeated: false };
    });
  }
  function edit(itemId, input) {
    return transaction(db, () => {
      assertVisible(itemId);
      const item = one('SELECT * FROM work_items WHERE id=?', canonical(itemId));
      assert(item, '업무가 없습니다.', 404); assert(input.version === item.version, '새 내용을 다시 불러오세요.', 409);
      assert(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 200, '제목은 1~200자로 입력하세요.');
      assert(typeof input.description === 'string' && input.description.length <= 5000, '설명은 5000자 이하여야 합니다.');
      exec('UPDATE work_items SET title=?,description=?,manual=1,metadata_protected=1,version=version+1 WHERE id=?', input.title.trim(), input.description, item.id);
      return detail(item.id);
    });
  }
  function setItemVisibility(action, input) {
    assert(input && Object.keys(input).every(key => ['ids', 'operation_id', 'versions'].includes(key)), '업무 삭제·복원 요청을 확인하세요.');
    const { ids, operation_id, versions } = input;
    assert(Array.isArray(ids) && ids.length >= 1 && ids.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200)
      && new Set(ids).size === ids.length, '업무를 1개 이상 선택하세요. 중복 항목은 허용하지 않습니다.');
    assert(typeof operation_id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(operation_id), '삭제·복원 요청 식별자가 필요합니다.');
    const versioned = Object.hasOwn(input, 'versions'), sortedIds = [...ids].sort();
    if (versioned) assert(versions && typeof versions === 'object' && !Array.isArray(versions)
      && Object.keys(versions).length === ids.length && ids.every(item => Object.hasOwn(versions, item) && Number.isSafeInteger(versions[item]) && versions[item] >= 1),
    '선택한 모든 업무의 현재 버전이 필요합니다.');
    // Keep the original unversioned journal identity for older callers and saved retries.
    const request = json(versioned ? { ids: sortedIds, versions: Object.fromEntries(sortedIds.map(item => [item, versions[item]])) } : sortedIds);
    return transaction(db, () => {
      const prior = one('SELECT * FROM item_visibility_operations WHERE operation_id=?', operation_id);
      if (prior) {
        assert(prior.action === action && prior.request === request, '같은 삭제·복원 요청 식별자의 내용이 다릅니다.', 409);
        return { ids: JSON.parse(prior.result), repeated: true };
      }
      const targets = [...new Set(ids.map(item => {
        const current = one('SELECT id,version FROM work_items WHERE id=?', item), owner = canonical(item);
        assert(current, '업무를 찾을 수 없습니다.', 404);
        if (versioned) assert(owner === item && current.version === versions[item], '선택한 업무가 변경되었습니다. 목록을 새로 확인한 후 다시 요청하세요.', 409);
        return owner;
      }))].sort();
      const at = now(), deleted = action === 'delete';
      for (const item of targets) if (isDeleted(item) !== deleted) {
        exec(`INSERT INTO work_item_deletions(work_item_id,deleted_at,operation_id,revision) VALUES(?,?,?,1)
          ON CONFLICT(work_item_id) DO UPDATE SET deleted_at=excluded.deleted_at,operation_id=excluded.operation_id,revision=revision+1`, item, deleted ? at : null, operation_id);
        exec('UPDATE work_items SET version=version+1 WHERE id=?', item);
      }
      exec('INSERT INTO item_visibility_operations VALUES(?,?,?,?,?)', operation_id, action, request, json(targets), at);
      return { ids: targets, repeated: false };
    });
  }
  const deleteItems = input => setItemVisibility('delete', input);
  const restoreItems = input => setItemVisibility('restore', input);
  function calendar({ start, end, mode = 'sessions', item_id }, summaries = new Map()) {
    assert(Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end)) && Date.parse(end) > Date.parse(start), '조회 시간 범위가 잘못되었습니다.');
    assert(Date.parse(end) - Date.parse(start) <= 93 * 86400000, '최대 93일을 조회할 수 있습니다.');
    assert(['sessions', 'items'].includes(mode), '잘못된 캘린더 단위입니다.');
    if (item_id) assertVisible(item_id);
    start = new Date(start).toISOString(); end = new Date(end).toISOString();
    const ss = sessionEntries({}, summaries).filter(s => (!item_id || s.work_item_id === canonical(item_id)) && s.start_at < end && s.end_at >= start)
      .sort((a, b) => a.start_at.localeCompare(b.start_at) || a.id.localeCompare(b.id)).map(s => ({
      id: s.id, work_item_id: s.work_item_id, title: mode === 'items' ? s.work_item_title : s.title,
      work_item_title: s.work_item_title,
      start_at: s.start_at, end_at: s.end_at, pending: s.pending, session_ids: [s.id],
      engine: s.engine, agent_session_id: s.agent_session_id
    }));
    if (mode === 'sessions') return ss;
    const grouped = new Map();
    for (const s of ss.sort((a, b) => a.start_at.localeCompare(b.start_at))) {
      const list = grouped.get(s.work_item_id) || [], previous = list.at(-1);
      if (previous && previous.end_at >= s.start_at) {
        previous.end_at = previous.end_at > s.end_at ? previous.end_at : s.end_at;
        previous.session_ids.push(s.id); previous.pending ||= s.pending;
      } else list.push({ ...s, id: stableId('range-', s.id), engine: null, agent_session_id: null });
      grouped.set(s.work_item_id, list);
    }
    return [...grouped.values()].flat();
  }
  return { db, ingestMany, agentContext, items, quickOverview, detail, history, runEvents, sessionMessages, merge, edit, tagList, editTags, calendar, canonical, sessionList, sessionEntries, isDeleted, visibilityRevision, deleteItems, restoreItems,
    cursor: source => one('SELECT value FROM cursors WHERE source=?', source)?.value || '0',
    stats: () => ({ events: one('SELECT COUNT(*) AS n FROM events').n, unresolved: one("SELECT COUNT(*) AS n FROM event_links l JOIN events e ON e.id=l.event_id WHERE l.resolution='unresolved' AND e.kind='output'").n }) };
}
