import { assert, json, now } from './shared.mjs';

// Jira status is independent of local work item completion. Cache reads; journal external writes.
export function jiraService({ store, integrations, client, notify }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS jira_issue_views (
    issue_key TEXT PRIMARY KEY, data TEXT, observed_at TEXT, checked_at TEXT NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS jira_changes (
    operation_id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL,
    target_status TEXT, message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  db.prepare("UPDATE jira_changes SET state='failed',message='전송 전에 서비스가 종료되었습니다. 다시 선택하세요.' WHERE state='preparing'").run();
  db.prepare("UPDATE jira_changes SET state='unknown',message='이전 상태 변경 응답을 확인하지 못했습니다. Jira 상태를 새로고침하세요.' WHERE state='sending'").run();
  const one = (sql, ...p) => db.prepare(sql).get(...p), exec = (sql, ...p) => db.prepare(sql).run(...p);
  const keyOf = issue => `${issue.cloud_id}:${issue.id}`;
  const queues = new Map(), refreshing = new Map();
  function exclusive(key, fn) {
    const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(key, task);
    task.finally(() => { if (queues.get(key) === task) queues.delete(key); }).catch(() => {});
    return task;
  }
  function linkFor(operation) {
    const link = integrations.links().find(l => l.operation_id === operation);
    assert(link?.state === 'linked' && link.issue, '연결된 Jira 이슈가 없습니다.', 404);
    return link;
  }
  function view(key) {
    const row = one('SELECT * FROM jira_issue_views WHERE issue_key=?', key);
    return row ? { ...row, data: row.data ? JSON.parse(row.data) : null } : null;
  }
  const change = key => one('SELECT operation_id,state,target_status,message,updated_at FROM jira_changes WHERE issue_key=? ORDER BY rowid DESC LIMIT 1', key) || null;
  function finish(op, state, message = null) {
    exec('UPDATE jira_changes SET state=?,message=?,updated_at=? WHERE operation_id=?', state, message, now(), op); notify();
  }
  async function fetchState(issue) {
    const key = keyOf(issue);
    try {
      const data = await client.issueState(issue), time = now();
      assert(data.issue.id === issue.id, 'Jira 이슈 식별자가 변경되었습니다.', 409);
      exec(`INSERT INTO jira_issue_views VALUES(?,?,?,?,NULL) ON CONFLICT(issue_key) DO UPDATE SET
        data=excluded.data,observed_at=excluded.observed_at,checked_at=excluded.checked_at,error=NULL`, key, json(data), time, time);
      integrations.updateLinkedIssue(data.issue);
      const pending = change(key);
      if (pending?.state === 'unknown' && pending.target_status === data.issue.status.id) {
        finish(pending.operation_id, 'observed', '현재 이슈가 요청한 상태입니다. 이전 전송 응답은 확인하지 못했습니다.');
      }
      notify(); return data;
    } catch (e) {
      exec(`INSERT INTO jira_issue_views VALUES(?,NULL,NULL,?,?) ON CONFLICT(issue_key) DO UPDATE SET
        checked_at=excluded.checked_at,error=excluded.error`, key, now(), e.message);
      notify(); throw e;
    }
  }
  function refresh(operation, force = false) {
    const { issue } = linkFor(operation), key = keyOf(issue), cached = view(key);
    if (refreshing.has(key)) return refreshing.get(key);
    if (!force && cached && Date.now() - Date.parse(cached.checked_at) < 30000) return Promise.resolve(cached.data);
    const task = exclusive(key, () => fetchState(issue)); refreshing.set(key, task);
    task.finally(() => refreshing.delete(key)).catch(() => {}); return task;
  }
  function refreshItem(itemId) {
    for (const link of integrations.links(itemId)) if (link.state === 'linked') void refresh(link.operation_id).catch(() => {});
  }
  async function link(itemId, input) {
    const checked = integrations.checkExistingLink(itemId, input);
    if (checked.prior) return checked.prior;
    const issue = await client.lookupIssue(input.cloud_id, input.key);
    const result = integrations.linkExisting(itemId, input, issue);
    notify(); refreshItem(itemId); return result;
  }
  async function transition(operation, input) {
    assert(input && Object.keys(input).every(k => ['operation_id', 'transition_id', 'expected_status_id', 'expected_updated'].includes(k)), '상태 변경 입력을 확인하세요.');
    assert(typeof input.operation_id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation_id)
      && typeof input.transition_id === 'string' && /^\d+$/.test(input.transition_id)
      && typeof input.expected_status_id === 'string' && typeof input.expected_updated === 'string'
      && Number.isFinite(Date.parse(input.expected_updated)), '현재 상태와 변경할 상태를 선택하세요.');
    const { issue } = linkFor(operation), key = keyOf(issue);
    return exclusive(key, async () => {
      const prior = one('SELECT * FROM jira_changes WHERE operation_id=?', input.operation_id);
      const request = json({ transition_id: input.transition_id, expected_status_id: input.expected_status_id, expected_updated: input.expected_updated });
      if (prior) {
        assert(prior.issue_key === key && prior.request === request, '같은 요청 식별자의 내용이 다릅니다.', 409);
        return { ...changeFor(input.operation_id), repeated: true };
      }
      assert(!['sending', 'preparing', 'unknown'].includes(change(key)?.state), '이전 상태 변경 결과를 먼저 새로고침하여 확인하세요.', 409);
      const time = now();
      exec('INSERT INTO jira_changes VALUES(?,?,?,?,?,?,?,?)', input.operation_id, key, request, 'preparing', null, null, time, time); notify();
      let selected;
      try {
        const current = await fetchState(issue);
        assert(current.issue.status.id === input.expected_status_id && current.issue.updated === input.expected_updated, 'Jira 이슈가 변경되었습니다. 최신 상태에서 다시 선택하세요.', 409);
        assert(current.can_write, 'Jira 쓰기 권한으로 OAuth를 다시 연결하세요.', 403);
        assert(!current.transition_message, current.transition_message, 409);
        selected = current.transitions.find(t => t.id === input.transition_id);
        assert(selected, '이슈에서 가능한 상태 변경이 달라졌습니다. 다시 선택하세요.', 409);
        assert(!selected.required_fields.length, '추가 필수 입력이 필요한 상태 변경입니다. Jira 이슈 링크에서 변경하세요.', 409);
      } catch (e) { finish(input.operation_id, 'failed', e.message); throw e; }
      exec("UPDATE jira_changes SET state='sending',target_status=?,updated_at=? WHERE operation_id=?", selected.to.id, now(), input.operation_id); notify();
      try { await client.transitionIssue(issue, selected.id); }
      catch (e) {
        const unknown = !e.not_sent && (e.code === 'unconfirmed' || e.status >= 500);
        finish(input.operation_id, unknown ? 'unknown' : 'failed', unknown ? '상태 변경 응답을 확인하지 못했습니다. 자동 재전송하지 않습니다. 새로고침하여 Jira 상태를 확인하세요.' : e.message);
        throw e;
      }
      // 204 confirms the write. A subsequent read failure must never cause another POST.
      finish(input.operation_id, 'applied');
      await fetchState(issue).catch(() => {});
      return changeFor(input.operation_id);
    });
  }
  function changeFor(operation) {
    return one('SELECT operation_id,state,target_status,message,updated_at FROM jira_changes WHERE operation_id=?', operation);
  }
  function decorate(detail) {
    return { ...detail, jira_links: detail.jira_links.map(l => l.issue && l.state === 'linked'
      ? { ...l, view: view(keyOf(l.issue)), change: change(keyOf(l.issue)) } : l) };
  }
  return { link, refresh, refreshItem, transition, decorate };
}
