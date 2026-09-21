import { assert, digest, json, now, stableId, transaction } from './shared.mjs';

// Acknowledgements hide only the displayed incident. Source runs, hooks and Jira journals stay unchanged.
export function notificationStore({ store, writings, integrations }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS notification_dismissals (
    id TEXT NOT NULL, revision TEXT NOT NULL, dismissed_at TEXT NOT NULL, PRIMARY KEY(id,revision));`);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  function candidates() {
    const items = new Map(all('SELECT id,title FROM work_items WHERE merged_into IS NULL').filter(item => !store.isDeleted(item.id)).map(item => [item.id, item]));
    const sessions = new Map(store.sessionList().map(session => [session.id, session]));
    const result = [];
    function add(kind, target, owner, source, details) {
      const item = items.get(store.canonical(owner)); if (!item) return;
      const at = details.occurred_at;
      if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return;
      const id = stableId('notification-', `${kind}:${target}`);
      result.push({ id, revision: digest(json([kind, target, source])), work_item_id: item.id, work_item_title: item.title,
        kind, ...details, message: String(details.message).slice(0, 2000), occurred_at: new Date(at).toISOString() });
    }
    for (const row of all('SELECT * FROM run_views')) {
      const run = JSON.parse(row.payload);
      if (run.internal || !['failed', 'blocked', 'interrupted'].includes(run.status)) continue;
      const recorded = one("SELECT event_at FROM events WHERE kind='run.updated' AND json_extract(payload,'$.run.id')=? ORDER BY seq DESC LIMIT 1", row.id)?.event_at;
      const at = run.updated_at || recorded;
      add('run', row.id, row.work_item_id, [run.status, at, run.message], {
        title: run.status === 'blocked' ? '작업 진행이 막혔습니다' : run.status === 'interrupted' ? '작업이 중단되었습니다' : '작업 실행에 실패했습니다',
        message: run.message || '실행 기록에서 원인을 확인할 수 있습니다.', occurred_at: at, run_id: row.id, action_label: '실행 확인'
      });
    }
    const latestWriting = all(`SELECT w.* FROM writing_requests w JOIN
      (SELECT format,target_id,MAX(seq) AS seq FROM writing_requests GROUP BY format,target_id) latest ON latest.seq=w.seq`);
    const summariesWithWriter = new Set();
    for (const raw of latestWriting) {
      const row = writings.get(raw.operation_id);
      const summaryRecord = row.format === 'session-summary' ? integrations.summary(row.target_id) : null;
      const coversSummary = summaryRecord && summaryRecord.source_digest === row.snapshot.source_digest
        && summaryRecord.run_id === row.run_id;
      if (coversSummary) summariesWithWriter.add(row.target_id);
      if (row.state !== 'failed' || !writings.isCurrent(row)) continue;
      const summary = row.format === 'session-summary', session = summary && sessions.get(row.target_id);
      if (summary && (!session || !coversSummary)) continue;
      add(summary ? 'summary' : 'metadata', row.target_id, row.snapshot.work_item_id,
        [row.operation_id, row.run_id, row.updated_at, row.message], {
          title: summary ? '세션 요약에 실패했습니다' : '제목·설명 재작성에 실패했습니다',
          message: row.message || '기존 내용을 유지했습니다. 상세 화면에서 다시 작성할 수 있습니다.',
          occurred_at: row.updated_at, ...(summary ? { session_id: row.target_id } : {}),
          ...(row.run_id ? { run_id: row.run_id } : {}), action_label: summary ? '세션 확인' : '업무 확인'
        });
    }
    // Admission failures and earlier releases may have a summary record without a writing request.
    for (const row of all("SELECT * FROM session_summaries WHERE state='failed'")) {
      const session = sessions.get(row.session_id);
      if (!session || summariesWithWriter.has(row.session_id)) continue;
      const snapshot = integrations.sessionSnapshots([session])[0];
      if (snapshot.source_digest !== row.source_digest) continue;
      add('summary', row.session_id, session.work_item_id, [row.source_digest, row.run_id, row.updated_at, row.message], {
        title: '세션 요약에 실패했습니다', message: row.message || '세션 상세에서 요약 실패 원인을 확인하세요.', occurred_at: row.updated_at,
        session_id: row.session_id, ...(row.run_id ? { run_id: row.run_id } : {}), action_label: '세션 확인'
      });
    }
    const links = all('SELECT rowid AS sequence,* FROM jira_links ORDER BY rowid DESC').map(row => ({ ...row, issue: row.issue ? JSON.parse(row.issue) : null }));
    const latestLinks = new Map();
    for (const link of links) {
      if (!latestLinks.has(link.work_item_id)) latestLinks.set(link.work_item_id, link);
    }
    for (const link of links) {
      // An uncertain remote creation remains unresolved even after another merged item links an issue.
      if (link.state !== 'unknown' && !(link.state === 'failed' && latestLinks.get(link.work_item_id)?.operation_id === link.operation_id)) continue;
      add('jira_issue', link.operation_id, link.work_item_id, [link.operation_id, link.state, link.message], {
        title: link.state === 'unknown' ? 'Jira 이슈 생성 결과를 확인하세요' : 'Jira 이슈 생성에 실패했습니다',
        message: link.message || '업무 상세의 Jira 연결에서 확인할 수 있습니다.', occurred_at: link.updated_at,
        link_operation_id: link.operation_id, action_label: 'Jira 연결 확인'
      });
    }
    for (const row of all("SELECT * FROM jira_worklogs WHERE state IN ('failed','unknown','needs_review')")) {
      const session = sessions.get(row.session_id) || (row.state === 'needs_review'
        ? one('SELECT id,work_item_id FROM work_item_sessions WHERE id=?', row.session_id) : null);
      if (!session) continue;
      add('jira_worklog', row.session_id, session.work_item_id,
        [row.operation_id, row.source_digest, row.state, row.state === 'failed' ? row.updated_at : null, row.message], {
          title: row.state === 'failed' ? 'Jira 업무 로그 동기화에 실패했습니다' : 'Jira 업무 로그를 확인하세요',
          message: row.message || '세션 상세에서 동기화 기록을 확인할 수 있습니다.', occurred_at: row.updated_at,
          session_id: row.session_id, link_operation_id: row.issue_operation_id, action_label: '업무 로그 확인'
        });
    }
    for (const [table, kind, title] of [['jira_changes', 'jira_transition', 'Jira 상태 변경'], ['jira_content_changes', 'jira_content', 'Jira 제목·설명 반영']]) {
      const changes = all(`SELECT change.* FROM ${table} change JOIN
        (SELECT issue_key,MAX(rowid) AS sequence FROM ${table} GROUP BY issue_key) latest ON latest.sequence=change.rowid`);
      for (const change of changes) {
        if (!['failed', 'unknown'].includes(change.state)) continue;
        const matching = links.filter(link => link.state === 'linked' && link.issue && `${link.issue.cloud_id}:${link.issue.id}` === change.issue_key && items.has(store.canonical(link.work_item_id)));
        const request = JSON.parse(change.request);
        const link = request.link_operation ? matching.find(link => link.operation_id === request.link_operation) : matching[0];
        if (!link) continue;
        add(kind, change.issue_key, link.work_item_id, [change.operation_id, change.state, change.message], {
          title: `${title}${change.state === 'failed' ? '에 실패했습니다' : ' 결과를 확인하세요'}`,
          message: change.message || 'Jira 연결 상세에서 현재 결과를 확인하세요.', occurred_at: change.updated_at,
          link_operation_id: link.operation_id, action_label: 'Jira 연결 확인'
        });
      }
    }
    return result.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || a.id.localeCompare(b.id));
  }
  function list() {
    const dismissed = new Set(all('SELECT id,revision FROM notification_dismissals').map(row => `${row.id}:${row.revision}`));
    return candidates().filter(row => !dismissed.has(`${row.id}:${row.revision}`));
  }
  function dismiss(id, input) {
    assert(input && Object.keys(input).length === 1 && typeof input.revision === 'string' && /^[a-f0-9]{64}$/.test(input.revision), '현재 알림 버전이 필요합니다.');
    return transaction(db, () => {
      const current = candidates().find(row => row.id === id);
      assert(current?.revision === input.revision, '알림 내용이 변경되었거나 해결되었습니다. 목록을 다시 확인하세요.', 409);
      const repeated = !!one('SELECT id FROM notification_dismissals WHERE id=? AND revision=?', id, input.revision);
      db.prepare('INSERT OR IGNORE INTO notification_dismissals VALUES(?,?,?)').run(id, input.revision, now());
      return { id, revision: input.revision, dismissed: true, repeated };
    });
  }
  return { list, dismiss };
}
