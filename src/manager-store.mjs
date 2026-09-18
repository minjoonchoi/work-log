import path from 'node:path';
import { database, transaction, validateEvent, stableId, id, now, json, assert, digest } from './shared.mjs';

const schema = `
CREATE TABLE IF NOT EXISTS work_items (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 merged_into TEXT REFERENCES work_items(id), manual INTEGER NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
 id TEXT PRIMARY KEY, engine TEXT NOT NULL, source_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 role TEXT NOT NULL, UNIQUE(engine, source_id)
);
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
CREATE TABLE IF NOT EXISTS user_questions (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 call_id TEXT NOT NULL, turn_id TEXT NOT NULL, text TEXT NOT NULL, requested_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS merges (id TEXT PRIMARY KEY, target TEXT NOT NULL, sources TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version=1;`;

export function managerStore(dir) {
  const db = database(path.join(dir, 'memory.sqlite'), schema);
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
  function ensureItem(item, at) {
    exec('INSERT OR IGNORE INTO work_items(id,title,created_at) VALUES(?,?,?)', item, '새 작업', at);
    return item;
  }
  function project(agentId) {
    const agent = one('SELECT * FROM agent_sessions WHERE id=?', agentId);
    const rows = all('SELECT * FROM events WHERE agent_id=? ORDER BY event_at, seq', agentId);
    const previous = new Map(all(`SELECT e.id,l.session_id,l.resolution FROM events e JOIN event_links l ON l.event_id=e.id
      WHERE e.agent_id=? AND e.kind IN ('input','output')`, agentId).map(r => [r.id, r]));
    exec('UPDATE work_item_sessions SET active=0 WHERE agent_id=?', agentId);
    exec('DELETE FROM user_questions WHERE agent_id=?', agentId);
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
    const counts = new Map();
    for (const row of rows) if (row.kind === 'input') {
      const key = JSON.parse(row.payload).turn_id; counts.set(key, (counts.get(key) || 0) + 1);
    }
    const turns = new Map(), windows = new Map(), questions = new Map();
    let current, lastOutput = null, previousOwner = null;
    for (const row of rows) {
      const e = JSON.parse(row.payload);
      let sid = null, resolution = 'unresolved';
      if (e.kind === 'input') {
        // A new prompt supersedes the previous question; it is not proof of an answer.
        questions.clear();
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
        if (item.title === '새 작업' && !item.manual && e.text) {
          exec('UPDATE work_items SET title=?, description=?, version=version+1 WHERE id=?', e.text.trim().slice(0, 70), e.text.slice(0, 500), item.id);
        }
      } else if (['output', 'turn.interrupted', 'turn.failed'].includes(e.kind) && turns.has(e.turn_id)) {
        sid = turns.get(e.turn_id); resolution = e.text == null && e.kind === 'output' ? 'missing_body' : 'matched';
        const w = windows.get(sid); w.end = e.event_at > w.end ? e.event_at : w.end;
        w.pending.delete(e.turn_id);
        // An observed Stop with missing body still proves output timing; unmatched output never does.
        if (e.kind === 'output') lastOutput = Date.parse(e.event_at);
      } else if (turns.has(e.turn_id)) { sid = turns.get(e.turn_id); resolution = 'matched'; }
      if (e.kind === 'session.ended') questions.clear();
      if (['output', 'turn.interrupted', 'turn.failed'].includes(e.kind)) {
        for (const [key, q] of questions) if (q.turn_id === e.turn_id) questions.delete(key);
      }
      if (e.kind === 'tool.finished' && e.call_id) questions.delete(e.call_id);
      if (sid && e.kind === 'tool.started' && e.source === 'system_hook' && e.engine === 'claude' && e.call_id) {
        // Only an explicit, documented question-tool invocation proves a user question.
        // Stop text, generic blocked results and ordinary tools never imply user input.
        let tool; try { tool = JSON.parse(e.text); } catch {}
        const qs = tool?.input?.questions;
        if (tool?.name === 'AskUserQuestion' && Array.isArray(qs) && qs.length > 0 && qs.length <= 4
          && qs.every(q => typeof q.question === 'string' && q.question.trim() && q.question.length <= 4000)) {
          questions.set(e.call_id, { id: row.id, session_id: sid, work_item_id: windows.get(sid).owner,
            call_id: e.call_id, turn_id: e.turn_id, text: qs.map(q => q.question).join('\n'), requested_at: e.event_at });
        }
      }
      exec('INSERT INTO event_links VALUES(?,?,?)', row.id, sid, resolution);
    }
    // Appends keep paging snapshots valid. Only reassigning an existing record invalidates them.
    if (all(`SELECT e.id,l.session_id,l.resolution FROM events e JOIN event_links l ON l.event_id=e.id
      WHERE e.agent_id=? AND e.kind IN ('input','output')`, agentId).some(r => {
      const old = previous.get(r.id); return old && (old.session_id !== r.session_id || old.resolution !== r.resolution);
    })) exec(`INSERT INTO history_revisions VALUES(?,1) ON CONFLICT(agent_id) DO UPDATE SET revision=revision+1`, agentId);
    for (const w of windows.values()) {
      exec(`INSERT INTO work_item_sessions VALUES(?,?,?,?,?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET work_item_id=excluded.work_item_id,start_at=excluded.start_at,
        end_at=excluded.end_at,pending=excluded.pending,active=1`,
      w.id, agentId, w.owner, w.first, w.start, w.end, w.pending.size > 0 ? 1 : 0);
    }
    for (const q of questions.values()) exec('INSERT INTO user_questions VALUES(?,?,?,?,?,?,?,?)',
      q.id, agentId, q.session_id, q.work_item_id, q.call_id, q.turn_id, q.text, q.requested_at);
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
          assert(previous.kind === e.kind && previous.event_at === e.event_at && previous.text === e.text && previous.turn_id === e.turn_id,
            '같은 원본 키에 다른 이벤트가 있습니다.', 409);
          continue;
        }
        let agent = one('SELECT * FROM agent_sessions WHERE id=?', aid);
        const owner = e.work_item_id || e.parent?.work_item_id || agent?.work_item_id || stableId('item-', aid);
        ensureItem(owner, e.event_at);
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
  function sessionList(itemId) {
    return all(`SELECT s.*,a.engine,a.source_id AS agent_session_id FROM work_item_sessions s
      JOIN agent_sessions a ON a.id=s.agent_id WHERE s.active=1 ORDER BY s.start_at,s.id`)
      .map(s => ({ ...s, original_work_item_id: s.work_item_id, work_item_id: canonical(s.work_item_id), pending: !!s.pending,
        waiting_for_user: !!one('SELECT id FROM user_questions WHERE session_id=? LIMIT 1', s.id) }))
      .filter(s => !itemId || s.work_item_id === canonical(itemId));
  }
  function runs(itemId) {
    return all('SELECT * FROM run_views').filter(r => !itemId || canonical(r.work_item_id) === canonical(itemId))
      .map(r => ({ ...JSON.parse(r.payload), work_item_id: canonical(r.work_item_id) }));
  }
  function items(search = '') {
    const sessions = sessionList(); const running = runs();
    return all('SELECT * FROM work_items WHERE merged_into IS NULL').map(w => {
      const ss = sessions.filter(s => s.work_item_id === w.id), rr = running.filter(r => r.work_item_id === w.id && !r.internal);
      const aliases = all('SELECT id,title FROM work_items WHERE merged_into IS NOT NULL').filter(a => canonical(a.id) === w.id);
      const state = rr.some(r => ['running', 'pending'].includes(r.status)) ? 'running'
        : rr.some(r => ['failed', 'blocked', 'interrupted'].includes(r.status)) ? 'attention'
        : rr.length && rr.every(r => r.status === 'completed') && !ss.some(s => s.pending) ? 'completed' : 'tracked';
      const pending = ss.filter(s => s.pending).length;
      const activities = [
        ss.some(s => s.waiting_for_user) && 'waiting_for_user',
        rr.some(r => r.status === 'running') && 'running',
        rr.some(r => r.status === 'pending') && 'queued',
        !rr.some(r => ['running', 'pending'].includes(r.status)) && ss.some(s => s.pending && !s.waiting_for_user) && 'agent_response_pending',
        rr.some(r => ['failed', 'blocked', 'interrupted'].includes(r.status)) && 'attention'
      ].filter(Boolean);
      const activity = activities[0] || 'recent';
      return { ...w, state, activity, activities, is_current: ['running', 'queued', 'agent_response_pending'].includes(activity), pending_session_count: pending,
        aliases, session_count: ss.length, last_activity: ss.map(s => s.end_at).sort().at(-1) || w.created_at };
    }).filter(w => `${w.title} ${w.description} ${w.aliases.map(a => a.title).join(' ')}`.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.last_activity.localeCompare(a.last_activity) || a.id.localeCompare(b.id));
  }
  function quickOverview() {
    const rows = items().map(w => ({ id: w.id, title: w.title, state: w.state, last_activity: w.last_activity, activity: w.activity, activities: w.activities }));
    const current = rows.filter(w => ['running', 'queued', 'agent_response_pending'].includes(w.activity));
    const waiting = rows.filter(w => w.activity === 'waiting_for_user');
    const attention = rows.filter(w => w.activity === 'attention'), recent = rows.filter(w => w.activity === 'recent');
    return { counts: { current: current.length, waiting: waiting.length, attention: attention.length, recent: recent.length, total: rows.length },
      current: current.slice(0, 5), waiting: waiting.slice(0, 3), attention: attention.slice(0, 3), recent: recent.slice(0, 5) };
  }
  const decodeEvent = e => ({ ...JSON.parse(e.payload), uid: e.id, sequence: e.seq, session_id: e.session_id,
    resolution: e.resolution, ingested_at: e.ingested_at });
  function historyScope(itemId, sessionId) {
    const resolved = canonical(itemId);
    assert(one('SELECT id FROM work_items WHERE id=?', resolved), '업무를 찾을 수 없습니다.', 404);
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
    assert(runs(itemId).some(r => r.id === runId), '실행을 찾을 수 없습니다.', 404);
    return all(`SELECT e.*,l.session_id,l.resolution ${historyFrom} WHERE json_extract(e.payload,'$.parent.run_id')=?
      AND json_extract(e.payload,'$.role')!='user' ORDER BY e.event_at DESC,e.seq DESC`, runId).map(decodeEvent);
  }
  function sessionMessages(sessionId) {
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
    const questions = all('SELECT q.*,a.engine,a.source_id AS agent_session_id FROM user_questions q JOIN agent_sessions a ON a.id=q.agent_id ORDER BY requested_at DESC')
      .filter(q => canonical(q.work_item_id) === resolved).map(q => ({ ...q, work_item_id: resolved }));
    return { item, questions, sessions: summary ? sessions.map(s => ({ ...s, history: historyMeta(resolved, s.id) })) : sessions,
      agents, events, runs: linkedRuns, ...(summary ? { unlinked_history: historyMeta(resolved, null) } : {}) };
  }
  function merge({ ids, target, operation_id }) {
    assert(Array.isArray(ids) && ids.length >= 2 && ids.length <= 100 && ids.every(x => typeof x === 'string'), '병합할 업무를 2개 이상 선택하세요.');
    assert(ids.includes(target), '대표 업무는 선택한 항목이어야 합니다.');
    assert(typeof operation_id === 'string' && operation_id.length, '병합 요청 ID가 필요합니다.');
    return transaction(db, () => {
      const prior = one('SELECT * FROM merges WHERE id=?', operation_id);
      if (prior) {
        assert(prior.sources === json(ids) && prior.target === target, '병합 요청 ID가 충돌합니다.', 409);
        return { id: canonical(target), repeated: true };
      }
      for (const item of ids) assert(one('SELECT id FROM work_items WHERE id=?', item), '업무를 찾을 수 없습니다.', 404);
      const representative = canonical(target);
      for (const source of new Set(ids.map(canonical))) if (source !== representative)
        exec('UPDATE work_items SET merged_into=?,version=version+1 WHERE id=?', representative, source);
      exec('INSERT INTO merges VALUES(?,?,?,?)', operation_id, target, json(ids), now());
      exec('UPDATE work_items SET version=version+1 WHERE id=?', representative);
      return { id: representative, repeated: false };
    });
  }
  function edit(itemId, input) {
    return transaction(db, () => {
      const item = one('SELECT * FROM work_items WHERE id=?', canonical(itemId));
      assert(item, '업무가 없습니다.', 404); assert(input.version === item.version, '새 내용을 다시 불러오세요.', 409);
      assert(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 200, '제목은 1~200자로 입력하세요.');
      assert(typeof input.description === 'string' && input.description.length <= 5000, '설명은 5000자 이하여야 합니다.');
      exec('UPDATE work_items SET title=?,description=?,manual=1,version=version+1 WHERE id=?', input.title.trim(), input.description, item.id);
      return detail(item.id);
    });
  }
  function calendar({ start, end, mode = 'sessions', item_id }) {
    assert(Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end)) && Date.parse(end) > Date.parse(start), '조회 시간 범위가 잘못되었습니다.');
    assert(Date.parse(end) - Date.parse(start) <= 93 * 86400000, '최대 93일을 조회할 수 있습니다.');
    assert(['sessions', 'items'].includes(mode), '잘못된 캘린더 단위입니다.');
    start = new Date(start).toISOString(); end = new Date(end).toISOString();
    const labels = new Map(items().map(w => [w.id, w]));
    const ss = sessionList(item_id).filter(s => s.start_at < end && s.end_at >= start).map(s => ({
      id: s.id, work_item_id: s.work_item_id, title: labels.get(s.work_item_id).title,
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
  // Rebuild this derived projection once on upgrade; original events and windows remain authoritative.
  if (!one('SELECT value FROM cursors WHERE source=?', 'projection.user-questions.v1')) transaction(db, () => {
    for (const agent of all("SELECT id FROM agent_sessions WHERE role='user'")) project(agent.id);
    exec('INSERT INTO cursors VALUES(?,?)', 'projection.user-questions.v1', '1');
  });
  return { db, ingestMany, items, quickOverview, detail, history, runEvents, sessionMessages, merge, edit, calendar, canonical, sessionList,
    cursor: source => one('SELECT value FROM cursors WHERE source=?', source)?.value || '0',
    stats: () => ({ events: one('SELECT COUNT(*) AS n FROM events').n, unresolved: one("SELECT COUNT(*) AS n FROM event_links l JOIN events e ON e.id=l.event_id WHERE l.resolution='unresolved' AND e.kind='output'").n }) };
}
