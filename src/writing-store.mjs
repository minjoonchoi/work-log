import { assert, transaction, json, digest, id, now } from './shared.mjs';
import { loadCatalog } from './catalog.mjs';
import { validateSchema } from './schema.mjs';

// Durable intentions and immutable inputs. Model execution belongs to the runtime.
export function writingStore(store, integrations) {
  const db = store.db, inputSchema = loadCatalog().definitions.jobs['text.rewrite'].input_schema;
  db.exec(`CREATE TABLE IF NOT EXISTS writing_requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
    format TEXT NOT NULL, target_id TEXT NOT NULL, snapshot TEXT NOT NULL,
    task TEXT NOT NULL, run_key TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT,
    result TEXT, message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS writing_target ON writing_requests(format,target_id,seq);`);
  const decode = row => row && ({ ...row, snapshot: JSON.parse(row.snapshot) });
  const get = operation => decode(db.prepare('SELECT * FROM writing_requests WHERE operation_id=?').get(operation));
  const latest = (format, target) => decode(db.prepare('SELECT * FROM writing_requests WHERE format=? AND target_id=? ORDER BY seq DESC LIMIT 1').get(format, target));
  const active = row => row && ['pending', 'running'].includes(row.state);
  function snapshot(format, target) {
    assert(['work-item-metadata', 'session-summary'].includes(format), '지원하지 않는 재작성 형식입니다.');
    const detail = format === 'work-item-metadata' ? store.detail(target) : null;
    const sessions = integrations.sessionSnapshots(detail ? detail.sessions : store.sessionList().filter(s => s.id === target));
    assert(sessions.length, '재작성할 세션 이력이 없습니다.', 409);
    const input = { format, sessions: sessions.map(s => {
      const previous = integrations.summary(s.id);
      return { id: s.id, engine: s.engine, start_at: s.start_at, end_at: s.end_at,
        summary: format === 'work-item-metadata' && previous?.accepted_digest === s.source_digest ? previous.text : null,
        events: s.source.events };
    }) };
    validateSchema(inputSchema, input, '재작성 입력');
    return { input, source_digest: detail ? digest(json(input)) : sessions[0].source_digest,
      work_item_id: detail?.item.id || sessions[0].original_work_item_id,
      base_version: detail?.item.version ?? null,
      engine: [...sessions].reverse().find(s => ['claude', 'codex'].includes(s.engine))?.engine || 'codex',
      session: detail ? null : { id: sessions[0].id, source: sessions[0].source, source_digest: sessions[0].source_digest } };
  }
  function isCurrent(row) {
    if (latest(row.format, row.target_id)?.operation_id !== row.operation_id) return false;
    try {
      const current = snapshot(row.format, row.target_id);
      return current.source_digest === row.snapshot.source_digest && current.base_version === row.snapshot.base_version
        && (row.format !== 'work-item-metadata' || current.work_item_id === row.snapshot.work_item_id);
    } catch { return false; }
  }
  function summaryState(row, state, result, message) {
    if (row.format !== 'session-summary') return;
    integrations.ensureSummary(row.snapshot.session);
    integrations.finishSummary(row.snapshot.session, state, { run_id: row.run_id, text: result?.text, message });
  }
  function finish(row, state, result = null, message = null) {
    return transaction(db, () => {
      const current = get(row.operation_id);
      if (!active(current)) return current;
      if (!isCurrent(current)) {
        state = 'superseded'; message = '생성 중 이력·요약 또는 업무 정보가 변경되어 결과를 반영하지 않았습니다. 최신 내용으로 다시 작성하세요.';
      }
      if (state === 'completed' && row.format === 'work-item-metadata') {
        db.prepare('UPDATE work_items SET title=?,description=?,manual=1,version=version+1 WHERE id=? AND version=?')
          .run(result.title, result.description, row.snapshot.work_item_id, row.snapshot.base_version);
      }
      db.prepare('UPDATE writing_requests SET state=?,result=?,message=?,updated_at=? WHERE operation_id=?')
        .run(state, result ? json(result) : null, message, now(), row.operation_id);
      if (latest(row.format, row.target_id)?.operation_id === row.operation_id) summaryState(current, state, state === 'completed' ? result : null, message);
      return get(row.operation_id);
    });
  }
  function insert(format, target, source, operation, legacy = null) {
    const timestamp = now(), task = legacy ? 'session.summarize' : 'text.rewrite';
    const runKey = legacy ? `summary:${target}:${source.source_digest}` : `rewrite:${operation}`;
    const state = legacy?.state === 'running' && legacy.run_id ? 'running' : 'pending';
    db.prepare(`INSERT INTO writing_requests(operation_id,format,target_id,snapshot,task,run_key,state,run_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(operation, format, target, json(source), task, runKey, state, legacy?.run_id || null, timestamp, timestamp);
    const row = get(operation); summaryState(row, state); return row;
  }
  function enqueue(format, target, input) {
    return transaction(db, () => {
      assert(input && Object.keys(input).every(k => ['operation_id', 'version'].includes(k)), '재작성 요청을 확인하세요.');
      assert(typeof input.operation_id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation_id), '재작성 요청 식별자가 필요합니다.');
      if (format === 'work-item-metadata') target = store.canonical(target);
      const prior = get(input.operation_id);
      if (prior) {
        assert(prior.format === format && prior.target_id === target && (format !== 'work-item-metadata' || prior.snapshot.base_version === input.version), '같은 재작성 요청 식별자의 대상이 다릅니다.', 409);
        return prior;
      }
      assert(!active(latest(format, target)), '이미 작성 중입니다. 완료 후 다시 작성할 수 있습니다.', 409);
      const source = snapshot(format, target);
      if (format === 'work-item-metadata') assert(source.base_version === input.version, '업무 정보가 변경되었습니다. 최신 내용을 불러오세요.', 409);
      return insert(format, target, source, input.operation_id);
    });
  }
  function scheduleAutomatic() {
    let changed = false;
    for (const session of integrations.closedSessions()) {
      const format = 'session-summary', previous = latest(format, session.id), summary = integrations.summary(session.id);
      if (previous?.snapshot.source_digest === session.source_digest && previous.state !== 'superseded') continue;
      // Respect accepted summaries and deliberate retry after a previous failure.
      if (!active(previous) && summary?.source_digest === session.source_digest && ['completed', 'failed'].includes(summary.state)) continue;
      if (active(previous)) finish(previous, 'superseded');
      try {
        const source = snapshot(format, session.id);
        transaction(db, () => {
          const legacy = !previous && summary?.source_digest === session.source_digest && active(summary) ? summary : null;
          insert(format, session.id, source, id('auto-'), legacy);
        });
      } catch (e) {
        // An oversized/unsupported conversation must not block unrelated requests.
        if (e.status !== 400) throw e;
        integrations.ensureSummary(session); integrations.finishSummary(session, 'failed', { message: e.message });
      }
      changed = true;
    }
    return changed;
  }
  function started(row, runId) {
    db.prepare("UPDATE writing_requests SET state='running',run_id=?,updated_at=? WHERE operation_id=? AND state='pending'").run(runId, now(), row.operation_id);
    const current = get(row.operation_id);
    if (latest(row.format, row.target_id)?.operation_id === row.operation_id) summaryState(current, current.state);
  }
  const publicView = row => row ? { operation_id: row.operation_id, state: row.state, run_id: row.run_id, message: row.message,
    snapshot_at: row.created_at, updated_at: row.updated_at } : null;
  function decorate(detail) {
    const snapshots = new Map(integrations.sessionSnapshots(detail.sessions.filter(s => s.summary)).map(s => [s.id, s]));
    return { ...detail, metadata_rewrite: publicView(latest('work-item-metadata', detail.item.id)),
      sessions: detail.sessions.map(s => {
        const summary = integrations.summary(s.id), current = snapshots.get(s.id);
        return { ...s, rewrite: publicView(latest('session-summary', s.id)),
          summary: s.summary ? { ...s.summary, current: summary.accepted_digest === current.source_digest } : null };
      }) };
  }
  return { enqueue, scheduleAutomatic, isCurrent, finish, started, get, publicView, decorate,
    pending: () => db.prepare("SELECT * FROM writing_requests WHERE state IN ('pending','running') ORDER BY seq").all().map(decode) };
}
