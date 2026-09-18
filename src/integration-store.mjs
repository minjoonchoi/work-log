import { assert, transaction, json, now, digest, id } from './shared.mjs';

export function integrationStore(store) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS jira_links (
    operation_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, state TEXT NOT NULL,
    request TEXT NOT NULL, issue TEXT, message TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY, source_digest TEXT NOT NULL, source TEXT NOT NULL,
    state TEXT NOT NULL, run_id TEXT, text TEXT, message TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jira_worklogs (
    session_id TEXT PRIMARY KEY, issue_operation_id TEXT NOT NULL, state TEXT NOT NULL,
    source_digest TEXT NOT NULL, operation_id TEXT NOT NULL, worklog_id TEXT,
    payload TEXT NOT NULL, message TEXT, updated_at TEXT NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(session_summaries)').all().some(c => c.name === 'accepted_digest')) {
    db.exec('ALTER TABLE session_summaries ADD COLUMN accepted_digest TEXT');
    db.exec("UPDATE session_summaries SET accepted_digest=source_digest WHERE text IS NOT NULL AND state='completed'");
  }
  // An interrupted external write is never replayed without checking Jira first.
  db.prepare("UPDATE jira_links SET state='unknown',message='이전 티켓 생성 결과를 확인해야 합니다.' WHERE state='sending'").run();
  db.prepare("UPDATE jira_worklogs SET state='unknown',message='이전 업무 로그 전송 결과를 확인 중입니다.' WHERE state='sending'").run();
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const exec = (sql, ...params) => db.prepare(sql).run(...params);
  const links = item => all('SELECT * FROM jira_links ORDER BY updated_at DESC').filter(r => !item || store.canonical(r.work_item_id) === store.canonical(item))
    .map(r => ({ ...r, request: JSON.parse(r.request), issue: r.issue ? JSON.parse(r.issue) : null }));
  function beginIssue(itemId, input) {
    return transaction(db, () => {
      assert(input && Object.keys(input).every(k => ['cloud_id', 'project', 'issue_type', 'version', 'operation_id'].includes(k)), 'Jira 생성 입력을 확인하세요.');
      const { item } = store.detail(itemId);
      assert(typeof input.operation_id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation_id), '생성 요청 식별자가 필요합니다.');
      const prior = links().find(r => r.operation_id === input.operation_id);
      if (prior) {
        assert(store.canonical(prior.work_item_id) === item.id && ['cloud_id', 'project', 'issue_type'].every(k => prior.request[k] === input[k]), '같은 요청 식별자의 내용이 다릅니다.', 409);
        assert(prior.state === 'linked', prior.message || '티켓 생성 결과를 확인 중입니다. 중복 생성하지 않습니다.', 409);
        return { ...prior, repeated: true };
      }
      assert(item.version === input.version, 'work item이 변경되었습니다. 최신 제목과 설명을 확인하세요.', 409);
      assert(!links(item.id).some(r => ['sending', 'linked', 'unknown'].includes(r.state)), '이미 연결된 티켓이 있거나 생성 결과 확인이 필요합니다.', 409);
      assert(typeof input.cloud_id === 'string' && /^[a-zA-Z0-9-]+$/.test(input.cloud_id) && typeof input.project === 'string' && /^[a-zA-Z0-9_]+$/.test(input.project) && typeof input.issue_type === 'string' && /^\d+$/.test(input.issue_type), 'Jira 사이트·프로젝트·유형을 선택하세요.');
      const request = { cloud_id: input.cloud_id, project: input.project, issue_type: input.issue_type,
        title: item.title, description: item.description, operation_id: input.operation_id, work_item_id: item.id };
      exec('INSERT INTO jira_links VALUES(?,?,?,?,?,?,?)', input.operation_id, item.id, 'sending', json(request), null, null, now());
      return { operation_id: input.operation_id, request, repeated: false };
    });
  }
  const finishIssue = (operation, state, issue, message) => exec('UPDATE jira_links SET state=?,issue=?,message=?,updated_at=? WHERE operation_id=?', state, issue ? json(issue) : null, message || null, now(), operation);
  function checkExistingLink(itemId, input) {
    assert(input && Object.keys(input).every(k => ['cloud_id', 'key', 'issue_id', 'version', 'operation_id'].includes(k)), 'Jira 연결 입력을 확인하세요.');
    assert(typeof input.operation_id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation_id), '연결 요청 식별자가 필요합니다.');
    assert(typeof input.cloud_id === 'string' && /^[a-zA-Z0-9-]+$/.test(input.cloud_id) && typeof input.issue_id === 'string' && /^\d+$/.test(input.issue_id)
      && typeof input.key === 'string' && input.key.length > 0 && input.key.length <= 1000, '먼저 연결할 Jira 이슈를 조회하세요.');
    const { item } = store.detail(itemId), prior = links().find(r => r.operation_id === input.operation_id);
    if (prior) {
      assert(store.canonical(prior.work_item_id) === item.id && prior.request.kind === 'existing'
        && prior.issue?.cloud_id === input.cloud_id && prior.issue?.id === input.issue_id, '같은 요청 식별자의 내용이 다릅니다.', 409);
      return { prior: { ...prior, repeated: true } };
    }
    assert(item.id === itemId && item.version === input.version, 'work item이 변경되었습니다. 최신 내용을 확인하세요.', 409);
    assert(!links(item.id).some(r => ['sending', 'linked', 'unknown'].includes(r.state)), '이미 연결된 이슈가 있거나 생성 결과 확인이 필요합니다.', 409);
    return { item };
  }
  function linkExisting(itemId, input, issue) {
    return transaction(db, () => {
      // Recheck after the remote read: another GUI may have linked, edited, or merged this item.
      const checked = checkExistingLink(itemId, input);
      if (checked.prior) return checked.prior;
      assert(issue.id === input.issue_id && issue.cloud_id === input.cloud_id, '조회한 이슈와 연결 대상이 다릅니다. 다시 조회하세요.', 409);
      const request = { kind: 'existing', cloud_id: input.cloud_id, issue_id: issue.id };
      exec('INSERT INTO jira_links VALUES(?,?,?,?,?,?,?)', input.operation_id, checked.item.id, 'linked', json(request), json(issue), null, now());
      return { operation_id: input.operation_id, state: 'linked', issue, repeated: false };
    });
  }
  function updateLinkedIssue(issue) {
    for (const link of links()) if (link.state === 'linked' && link.issue?.id === issue.id && link.issue.cloud_id === issue.cloud_id) {
      exec('UPDATE jira_links SET issue=? WHERE operation_id=?', json(issue), link.operation_id);
    }
  }
  function closedWindows() {
    const sessions = store.sessionList(), latest = new Map();
    for (const s of sessions) latest.set(s.agent_id, s.id);
    return sessions.filter(s => latest.get(s.agent_id) !== s.id && !s.pending);
  }
  function sessionSnapshots(sessions = store.sessionList()) {
    return sessions.map(s => {
      const messages = store.sessionMessages(s.id);
      const input = messages.find(e => e.kind === 'input'), outputs = messages.filter(e => e.kind === 'output');
      const lastOutput = outputs.at(-1);
      // Work item rename/merge must not regenerate an unchanged conversation summary.
      const source = { title: '작업 세션', events: messages.map(e => ({ kind: e.kind, event_at: e.event_at, text: e.text ?? null })) };
      return { ...s, source, source_digest: digest(json(source)), origin: input && { engine: s.engine, agent_session_id: s.agent_session_id, turn_id: input.turn_id },
        started: input?.event_at, ended: lastOutput?.event_at,
        seconds: input && lastOutput ? Math.floor((Date.parse(lastOutput.event_at) - Date.parse(input.event_at)) / 1000) : 0 };
    });
  }
  const closedSessions = () => sessionSnapshots(closedWindows());
  function ensureSummary(session) {
    const current = one('SELECT * FROM session_summaries WHERE session_id=?', session.id);
    if (current?.source_digest === session.source_digest) return current;
    exec(`INSERT INTO session_summaries(session_id,source_digest,source,state,run_id,text,message,updated_at) VALUES(?,?,?,'pending',NULL,NULL,NULL,?)
      ON CONFLICT(session_id) DO UPDATE SET source_digest=excluded.source_digest,source=excluded.source,state='pending',run_id=NULL,message=NULL,updated_at=excluded.updated_at`,
    session.id, session.source_digest, json(session.source), now());
    return one('SELECT * FROM session_summaries WHERE session_id=?', session.id);
  }
  const finishSummary = (session, state, { run_id = null, text = null, message = null } = {}) =>
    exec(`UPDATE session_summaries SET state=?,run_id=?,text=COALESCE(?,text),message=?,updated_at=?,
      accepted_digest=CASE WHEN ?='completed' THEN source_digest ELSE accepted_digest END WHERE session_id=? AND source_digest=?`,
    state, run_id, text, message, now(), state, session.id, session.source_digest);
  function beginWorklog(session, link, text) {
    const payload = { started: session.started, seconds: session.seconds, comment: text };
    const source = digest(json(payload)), current = one('SELECT * FROM jira_worklogs WHERE session_id=?', session.id);
    if (current && ['sending', 'unknown'].includes(current.state)) return current;
    if (current?.source_digest === source && ['synced', 'failed'].includes(current.state)) return current;
    // Preserve the original issue when work items with multiple Jira tickets are merged later.
    exec(`INSERT INTO jira_worklogs VALUES(?,?,'pending',?,?,NULL,?,NULL,?)
      ON CONFLICT(session_id) DO UPDATE SET state='pending',source_digest=excluded.source_digest,payload=excluded.payload,message=NULL,updated_at=excluded.updated_at`,
    session.id, link.operation_id, source, id('worklog-'), json(payload), now());
    return one('SELECT * FROM jira_worklogs WHERE session_id=?', session.id);
  }
  const finishWorklog = (sessionId, state, worklogId, message) => exec('UPDATE jira_worklogs SET state=?,worklog_id=COALESCE(?,worklog_id),message=?,updated_at=? WHERE session_id=?', state, worklogId || null, message || null, now(), sessionId);
  function decorate(detail) {
    const closed = new Set(closedWindows().map(s => s.id));
    const itemLinks = links(detail.item.id);
    return { ...detail, jira_links: itemLinks.map(({ request, ...r }) => r),
      worklog_alerts: all("SELECT session_id,issue_operation_id,message FROM jira_worklogs WHERE state='needs_review'").filter(w => itemLinks.some(l => l.operation_id === w.issue_operation_id)),
      sessions: detail.sessions.map(s => ({ ...s, closed: closed.has(s.id),
        summary: one('SELECT state,run_id,text,message,updated_at FROM session_summaries WHERE session_id=?', s.id) || null,
        worklog: one('SELECT state,worklog_id,message,payload FROM jira_worklogs WHERE session_id=?', s.id) || null })) };
  }
  return { links, beginIssue, finishIssue, checkExistingLink, linkExisting, updateLinkedIssue, closedSessions, sessionSnapshots, ensureSummary, finishSummary, beginWorklog, finishWorklog, decorate,
    summary: sid => one('SELECT * FROM session_summaries WHERE session_id=?', sid),
    invalidateOpenWorklogs: closedIds => {
      let changed = false;
      const rows = all("SELECT w.*,s.agent_id FROM jira_worklogs w LEFT JOIN work_item_sessions s ON s.id=w.session_id WHERE w.state!='needs_review'");
      const affectedAgents = new Set(rows.filter(r => !closedIds.has(r.session_id)).map(r => r.agent_id));
      // A collapsed window may now overlap another already-published worklog. Freeze both;
      // never expand one log while silently retaining the other log's counted time.
      for (const row of rows) if (affectedAgents.has(row.agent_id)) {
        finishWorklog(row.session_id, 'needs_review', null, '늦게 수집된 이력으로 세션 경계가 변경되었습니다. 기존 Jira 업무 로그를 확인하세요.'); changed = true;
      }
      return changed;
    },
    retryWorklog: sid => exec("UPDATE jira_worklogs SET state='pending',message=NULL WHERE session_id=? AND state='failed'", sid),
    worklog: sid => one('SELECT * FROM jira_worklogs WHERE session_id=?', sid) };
}
