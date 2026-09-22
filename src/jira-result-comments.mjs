import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assert, digest, json, now, request } from './shared.mjs';
import { validateSchema, canonicalJson } from './schema.mjs';
import { parseResultSummary } from './result-summary.mjs';
import { plainTextADF } from './jira-adf.mjs';

const inputSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/inputs/result-summary.schema.json'), 'utf8'));
const active = ['waiting_transition', 'pending', 'running', 'ready'];

// A Done transition, its frozen evidence, and its separate comment each have a durable outcome.
export function jiraResultComments({ dir, store, integrations, client, notify, exclusive, fixture = false }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS jira_result_comments (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
    transition_operation TEXT NOT NULL, link_operation TEXT NOT NULL, work_item_id TEXT NOT NULL,
    issue TEXT NOT NULL, snapshot TEXT NOT NULL, source_digest TEXT NOT NULL, state TEXT NOT NULL,
    run_id TEXT, text TEXT, comment_id TEXT, message TEXT, retry_of TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jira_result_link ON jira_result_comments(link_operation,seq);`);
  db.prepare("UPDATE jira_result_comments SET state='unknown',message='이전 댓글 전송 응답을 확인하지 못했습니다. Jira 댓글을 확인하세요.',updated_at=? WHERE state='sending'").run(now());
  const decode = row => row && ({ ...row, issue: JSON.parse(row.issue), snapshot: JSON.parse(row.snapshot) });
  const get = operation => decode(db.prepare('SELECT * FROM jira_result_comments WHERE operation_id=?').get(operation));
  const latest = link => decode(db.prepare('SELECT * FROM jira_result_comments WHERE link_operation=? ORDER BY seq DESC LIMIT 1').get(link));
  const transition = row => db.prepare('SELECT state,message FROM jira_changes WHERE operation_id=?').get(row.transition_operation);
  const confirmed = row => ['applied', 'observed'].includes(transition(row)?.state);
  const publicView = row => row ? Object.fromEntries(['operation_id', 'state', 'text', 'message', 'run_id', 'comment_id', 'updated_at'].map(key => [key, row[key]])) : null;
  function finish(operation, state, message = null, extra = {}) {
    const updates = { state, message, updated_at: now(), ...extra };
    assert(Object.keys(updates).every(key => ['state', 'message', 'updated_at', 'run_id', 'text', 'comment_id'].includes(key)), '댓글 상태 필드가 잘못되었습니다.');
    db.prepare(`UPDATE jira_result_comments SET ${Object.keys(updates).map(key => `${key}=?`).join(',')} WHERE operation_id=?`)
      .run(...Object.values(updates), operation); notify(); return get(operation);
  }
  function owners(item) {
    return db.prepare('SELECT id FROM work_items').all().filter(row => store.canonical(row.id) === item).map(row => row.id).sort();
  }
  function capture(link) {
    const { item, sessions } = store.detail(link.work_item_id, { summary: true });
    const selected = sessions.filter(session => db.prepare("SELECT 1 FROM agent_sessions WHERE id=? AND role='user'").get(session.agent_id));
    const base = { work_item_id: item.id, link_work_item_id: link.work_item_id,
      visibility_revision: store.visibilityRevision(item.id), owners: owners(item.id), references: [] };
    try {
      assert(selected.length <= 500, '완료 결과에 포함할 세션이 500개를 초과했습니다.');
      const snapshots = integrations.sessionSnapshots(selected);
      base.references = snapshots.map(session => ({ id: session.id, agent_id: session.agent_id,
        original_work_item_id: session.original_work_item_id, first_event_id: session.first_event_id }));
      const input = { title: item.title, description: item.description, sessions: snapshots.map(session => {
        const summary = integrations.summary(session.id);
        return { id: session.id, engine: session.engine, start_at: session.start_at, end_at: session.end_at,
          summary: summary?.state === 'completed' && summary.accepted_digest === session.source_digest ? summary.text : null,
          events: session.source.events };
      }) };
      validateSchema(inputSchema, input, '완료 결과 요약 입력');
      assert(Buffer.byteLength(json(input)) <= 2 * 1024 * 1024, '완료 결과 요약 입력이 너무 큽니다.');
      return { ...base, input };
    } catch (error) { return { ...base, input: null, admission_error: error.message }; }
  }
  function guard(row) {
    const source = row.snapshot, link = integrations.links().find(link => link.operation_id === row.link_operation);
    assert(link?.state === 'linked' && link.issue?.cloud_id === row.issue.cloud_id && link.issue?.id === row.issue.id
      && link.work_item_id === source.link_work_item_id, '완료 결과의 Jira 연결이 변경되었습니다.', 409);
    assert(store.canonical(source.work_item_id) === source.work_item_id && store.canonical(link.work_item_id) === source.work_item_id
      && canonicalJson(owners(source.work_item_id)) === canonicalJson(source.owners), '완료 결과의 업무가 병합되거나 변경되었습니다.', 409);
    assert(!store.isDeleted(source.work_item_id) && store.visibilityRevision(source.work_item_id) === source.visibility_revision,
      '완료 결과의 업무가 삭제되거나 목록 상태가 변경되었습니다.', 409);
    for (const ref of source.references) {
      const session = db.prepare('SELECT * FROM work_item_sessions WHERE id=? AND active=1').get(ref.id);
      assert(session && session.agent_id === ref.agent_id && session.first_event_id === ref.first_event_id
        && session.work_item_id === ref.original_work_item_id && store.canonical(session.work_item_id) === source.work_item_id,
      '완료 결과의 세션 소속이 변경되었습니다.', 409);
    }
  }
  function insert({ operation, transitionOperation, link, issue, snapshot, retryOf = null, text = null, runId = null, state = 'waiting_transition' }) {
    const timestamp = now(), sourceDigest = digest(json(snapshot.input));
    db.prepare(`INSERT INTO jira_result_comments(operation_id,transition_operation,link_operation,work_item_id,issue,snapshot,
      source_digest,state,run_id,text,retry_of,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(operation, transitionOperation, link, snapshot.work_item_id, json(issue), json(snapshot), sourceDigest, state, runId, text, retryOf, timestamp, timestamp);
    notify(); return get(operation);
  }
  function prepare(linkOperation, transitionOperation) {
    const previous = db.prepare('SELECT operation_id FROM jira_result_comments WHERE transition_operation=?').get(transitionOperation);
    if (previous) return get(previous.operation_id);
    const unresolved = db.prepare("SELECT operation_id FROM jira_result_comments WHERE link_operation=? AND state IN ('waiting_transition','pending','running','ready','sending','unknown') LIMIT 1").get(linkOperation);
    assert(!unresolved, '이전 완료 결과 댓글이 처리 중이거나 게시 여부가 미확인입니다. 결과를 확인한 뒤 다시 완료로 변경하세요.', 409);
    const link = integrations.links().find(link => link.operation_id === linkOperation);
    assert(link?.state === 'linked' && link.issue, '완료 결과의 Jira 연결이 없습니다.', 409);
    return insert({ operation: transitionOperation, transitionOperation, link: linkOperation, issue: link.issue, snapshot: capture(link) });
  }
  function observeTransition(operation) {
    for (const raw of db.prepare("SELECT * FROM jira_result_comments WHERE transition_operation=? AND state='waiting_transition'").all(operation)) {
      const row = decode(raw), status = transition(row);
      if (status?.state === 'failed') finish(row.operation_id, 'failed', `Done 상태 변경을 확인하지 못해 결과 댓글을 게시하지 않았습니다. ${status.message || ''}`);
      else if (confirmed(row)) finish(row.operation_id, row.snapshot.admission_error ? 'failed' : 'pending', row.snapshot.admission_error || null);
    }
  }
  async function currentDone(row) {
    guard(row); assert(confirmed(row), 'Done 상태 변경이 아직 확인되지 않았습니다.', 409);
    const current = await client.issueState(row.issue);
    guard(row); assert(current.issue.id === row.issue.id && current.issue.cloud_id === row.issue.cloud_id, '완료 결과의 Jira 이슈가 변경되었습니다.', 409);
    assert(current.issue.status.category === 'done', 'Jira 이슈가 더 이상 완료 상태가 아니므로 결과 댓글을 게시하지 않았습니다.', 409);
    assert(current.can_write, 'Jira 쓰기 권한으로 OAuth를 다시 연결하세요.', 403);
  }
  async function send(row) {
    return exclusive(`${row.issue.cloud_id}:${row.issue.id}`, async () => {
      row = get(row.operation_id); if (row.state !== 'ready') return;
      try { await currentDone(row); }
      catch (error) { finish(row.operation_id, 'failed', error.message); return; }
      finish(row.operation_id, 'sending');
      let comment;
      try {
        comment = await client.postResultComment(row.issue, { operation_id: row.operation_id,
          work_item_id: row.work_item_id, text: row.text, source_digest: row.source_digest }, { beforeSend: () => currentDone(row) });
      } catch (error) {
        const unknown = !error.not_sent && (error.code === 'unconfirmed' || error.status >= 500);
        finish(row.operation_id, unknown ? 'unknown' : 'failed', unknown
          ? '댓글 전송 응답을 확인하지 못했습니다. 자동으로 다시 보내지 않으며 Jira 댓글 확인이 필요합니다.' : error.message);
        return;
      }
      // A local confirmation/notification failure cannot undo the accepted remote write.
      finish(row.operation_id, 'posted', '완료 결과를 Jira 일반 댓글에 등록했습니다.', { comment_id: comment.id });
    });
  }
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      for (const raw of db.prepare(`SELECT * FROM jira_result_comments WHERE state IN (${active.map(() => '?').join(',')}) ORDER BY seq`).all(...active)) {
        let row = decode(raw);
        if (row.state === 'waiting_transition') { observeTransition(row.transition_operation); continue; }
        let waitingForRuntime = false;
        try {
          guard(row);
          if (row.state === 'pending') {
            waitingForRuntime = true;
            const run = await request(dir, 'runtime', '/runs', { method: 'POST', body: {
              task: 'work-item.result.summarize', input: row.snapshot.input, internal: true, work_item_id: row.work_item_id,
              origin: { engine: 'harness-result', agent_session_id: row.operation_id, turn_id: row.operation_id },
              idempotency_key: `jira-result:${row.operation_id}`,
              ...(fixture ? { engine: 'fixture', fixture: JSON.parse(process.env.HARNESS_RESULT_FIXTURE || '{}') } : {})
            } });
            waitingForRuntime = false;
            finish(row.operation_id, 'running', null, { run_id: run.id });
          } else if (row.state === 'running') {
            waitingForRuntime = true;
            const run = await request(dir, 'runtime', `/runs/${row.run_id}`);
            waitingForRuntime = false;
            guard(row);
            if (run.status === 'completed') {
              assert(run.id === row.run_id && run.task === 'work-item.result.summarize' && run.internal === true
                && run.origin?.engine === 'harness-result' && run.origin.agent_session_id === row.operation_id && run.origin.turn_id === row.operation_id
                && run.request?.task === 'work-item.result.summarize'
                && canonicalJson(run.request.input) === canonicalJson(row.snapshot.input)
                && (run.request.work_item_id === undefined || run.request.work_item_id === row.work_item_id)
                && run.artifact?.file, '완료 결과 생성 작업 또는 고정한 입력이 다릅니다.');
              const file = fs.realpathSync(run.artifact.file), root = fs.realpathSync(path.join(dir, 'runs', run.id, 'artifacts')) + path.sep;
              assert(file.startsWith(root), '완료 결과 산출물 경로가 잘못되었습니다.');
              const bytes = fs.readFileSync(file); assert(digest(bytes) === run.artifact.content_digest, '검증 후 완료 결과가 변경되었습니다.');
              finish(row.operation_id, 'ready', null, parseResultSummary(bytes.toString('utf8')));
            } else if (!['pending', 'running'].includes(run.status)) finish(row.operation_id, 'failed', run.message || '완료 결과를 작성하지 못했습니다.');
          } else if (row.state === 'ready') await send(row);
        } catch (error) {
          const persisted = get(row.operation_id);
          if (['posted', 'unknown'].includes(persisted?.state)) continue;
          if (persisted?.state === 'sending') {
            // If this write also fails, keep sending for restart recovery; never enable retry.
            finish(row.operation_id, 'unknown', '댓글 전송 후 로컬 확인을 기록하지 못했습니다. 다시 보내지 않으며 Jira 댓글 확인이 필요합니다.');
            continue;
          }
          // A disconnected runtime is recoverable with the same persisted run key.
          const recoverable = waitingForRuntime && (error.status >= 500 || error.name === 'TimeoutError'
            || ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code || error.cause?.code));
          if (!recoverable) finish(row.operation_id, 'failed', error.message);
        }
      }
    } finally { busy = false; }
  }
  async function retry(linkOperation, input) {
    assert(input && Object.keys(input).length === 1 && typeof input.operation_id === 'string'
      && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation_id), '결과 댓글 재시도 요청 식별자를 확인하세요.');
    const previous = get(input.operation_id);
    if (previous) { assert(previous.link_operation === linkOperation && previous.retry_of, '같은 요청 식별자의 대상이 다릅니다.', 409); return publicView(previous); }
    const row = latest(linkOperation); assert(row?.state === 'failed', '확인된 실패 결과만 다시 시도할 수 있습니다.', 409);
    return exclusive(`${row.issue.cloud_id}:${row.issue.id}`, async () => {
      const prior = get(input.operation_id);
      if (prior) { assert(prior.link_operation === linkOperation && prior.retry_of, '같은 요청 식별자의 대상이 다릅니다.', 409); return publicView(prior); }
      assert(latest(linkOperation)?.operation_id === row.operation_id && get(row.operation_id).state === 'failed', '결과 댓글 상태가 변경되었습니다.', 409);
      assert(!row.snapshot.admission_error, row.snapshot.admission_error || '완료 시점의 입력을 사용할 수 없습니다.', 409);
      await currentDone(row);
      return publicView(insert({ operation: input.operation_id, transitionOperation: row.transition_operation, link: row.link_operation,
        issue: row.issue, snapshot: row.snapshot, retryOf: row.operation_id, text: row.text, runId: row.run_id, state: row.text ? 'ready' : 'pending' }));
    });
  }
  async function reconcile(linkOperation, input) {
    assert(input && Object.keys(input).length === 0, '결과 댓글 확인 요청을 확인하세요.');
    const row = latest(linkOperation); assert(row?.state === 'unknown', '게시 결과 확인이 필요한 댓글이 없습니다.', 409);
    return exclusive(`${row.issue.cloud_id}:${row.issue.id}`, async () => {
      assert(get(row.operation_id).state === 'unknown', '댓글 상태가 변경되었습니다.', 409); guard(row);
      try {
        const comment = await client.findResultComment(row.issue, row.operation_id); guard(row);
        if (!comment) return publicView(finish(row.operation_id, 'unknown', '일치하는 댓글이 아직 보이지 않습니다. 지연 또는 조회 권한 때문에 부재를 확정할 수 없어 다시 보내지 않습니다.'));
        const marker = comment.properties.find(property => property.key === 'work-log-result')?.value;
        assert(marker?.work_item_id === row.work_item_id && marker.source_digest === row.source_digest
          && canonicalJson(comment.body) === canonicalJson(plainTextADF(row.text)), '기존 결과 댓글의 출처 또는 본문이 달라 직접 확인이 필요합니다.', 409);
        return publicView(finish(row.operation_id, 'posted', 'Jira에서 동일 요청의 결과 댓글을 확인했습니다.', { comment_id: comment.id }));
      } catch (error) { finish(row.operation_id, 'unknown', error.message); throw error; }
    });
  }
  return { prepare, observeTransition, tick, retry, reconcile, view: link => publicView(latest(link)) };
}
