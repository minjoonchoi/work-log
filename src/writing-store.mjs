import { assert, transaction, json, digest, id, now, stableId } from './shared.mjs';
import { loadCatalog } from './catalog.mjs';
import { validateSchema } from './schema.mjs';

// Durable intentions and immutable inputs. Model execution belongs to the runtime.
export function writingStore(store, integrations, { clock = Date.now } = {}) {
  const db = store.db, inputSchema = loadCatalog().definitions.jobs['text.rewrite'].input_schema;
  db.exec(`CREATE TABLE IF NOT EXISTS writing_requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
    format TEXT NOT NULL, target_id TEXT NOT NULL, snapshot TEXT NOT NULL,
    task TEXT NOT NULL, run_key TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT,
    result TEXT, message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS writing_cancellations(run_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS summary_prompt_receipts (
      prompt_key TEXT PRIMARY KEY, event_seq INTEGER NOT NULL, selected_count INTEGER NOT NULL, processed_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS writing_target ON writing_requests(format,target_id,seq);
    CREATE TABLE IF NOT EXISTS metadata_automation_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), initial_output_count INTEGER NOT NULL, summary_interval INTEGER NOT NULL);
    INSERT OR IGNORE INTO metadata_automation_settings(singleton,initial_output_count,summary_interval) VALUES(1,5,5);
    CREATE TABLE IF NOT EXISTS metadata_automation_state (
      work_item_id TEXT PRIMARY KEY, initial_consumed INTEGER NOT NULL DEFAULT 0, summary_highwater INTEGER NOT NULL DEFAULT 0);`);
  if (!db.prepare('PRAGMA table_info(writing_requests)').all().some(column => column.name === 'source')) {
    db.exec("ALTER TABLE writing_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  }
  if (!db.prepare('PRAGMA table_info(metadata_automation_settings)').all().some(column => column.name === 'session_summary_enabled')) {
    db.exec('ALTER TABLE metadata_automation_settings ADD COLUMN session_summary_enabled INTEGER NOT NULL DEFAULT 1');
  }
  if (!db.prepare('PRAGMA table_info(metadata_automation_settings)').all().some(column => column.name === 'session_summary_idle_minutes')) {
    db.exec('ALTER TABLE metadata_automation_settings ADD COLUMN session_summary_idle_minutes INTEGER NOT NULL DEFAULT 15');
  }
  if (!db.prepare('PRAGMA table_info(metadata_automation_settings)').all().some(column => column.name === 'work_summary_enabled')) {
    db.exec('ALTER TABLE metadata_automation_settings ADD COLUMN work_summary_enabled INTEGER NOT NULL DEFAULT 1');
  }
  // Keep legacy prompt receipts as history. Scheduling now scans unfinished
  // summaries on the manager's timer; prompt arrival is not an admission token.
  const decode = row => row && ({ ...row, snapshot: JSON.parse(row.snapshot) });
  const get = operation => decode(db.prepare('SELECT * FROM writing_requests WHERE operation_id=?').get(operation));
  const latest = (format, target) => decode(db.prepare('SELECT * FROM writing_requests WHERE format=? AND target_id=? ORDER BY seq DESC LIMIT 1').get(format, target));
  const active = row => row && ['pending', 'running'].includes(row.state);
  const userSession = session => db.prepare("SELECT 1 FROM agent_sessions WHERE id=? AND role='user'").get(session.agent_id);
  const automationSettings = () => { const row = db.prepare('SELECT initial_output_count,summary_interval,session_summary_enabled,session_summary_idle_minutes,work_summary_enabled FROM metadata_automation_settings WHERE singleton=1').get(); return { ...row, session_summary_enabled: !!row.session_summary_enabled, work_summary_enabled: !!row.work_summary_enabled }; };
  function saveAutomationSettings(input) {
    assert(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length > 0
      && Object.keys(input).every(key => ['session_summary_enabled', 'work_summary_enabled'].includes(key) ? typeof input[key] === 'boolean' : ['initial_output_count', 'summary_interval', 'session_summary_idle_minutes'].includes(key)
        && Number.isInteger(input[key]) && input[key] >= 1 && input[key] <= 1000), '자동 작성 기준은 1~1000 사이의 정수여야 합니다.');
    const settings = { ...automationSettings(), ...input };
    db.prepare('UPDATE metadata_automation_settings SET initial_output_count=?,summary_interval=?,session_summary_enabled=?,session_summary_idle_minutes=?,work_summary_enabled=? WHERE singleton=1')
      .run(settings.initial_output_count, settings.summary_interval, Number(settings.session_summary_enabled), settings.session_summary_idle_minutes, Number(settings.work_summary_enabled));
    return settings;
  }
  function milestones(target, closed = integrations.closedSessions()) {
    const settings = automationSettings(), turns = new Set();
    for (const row of db.prepare(`SELECT e.payload,a.id AS agent_id,s.work_item_id FROM events e
      JOIN agent_sessions a ON a.id=e.agent_id JOIN event_links l ON l.event_id=e.id
      JOIN work_item_sessions s ON s.id=l.session_id
      WHERE a.role='user' AND a.engine IN ('claude','codex') AND e.kind='output' AND l.resolution='matched' AND s.active=1
      AND json_extract(e.payload,'$.source')='system_hook'`).all()) {
      const event = JSON.parse(row.payload);
      // The original window owner, not the agent's initial item, decides ownership after an explicit split.
      if (store.canonical(row.work_item_id) === target && typeof event.text === 'string' && event.text.trim() && event.turn_id) turns.add(`${row.agent_id}:${event.turn_id}`);
    }
    // An accepted automatic idle/SessionEnd summary is a completed unit of work,
    // even before another input creates the next window. Keep manual open
    // summaries out of the cadence and reject summaries of changed history.
    const closedIds = new Set(closed.map(session => session.id));
    const automaticallySummarized = new Set(db.prepare(`SELECT DISTINCT r.target_id FROM writing_requests r
      JOIN session_summaries s ON s.session_id=r.target_id AND s.accepted_digest=json_extract(r.snapshot,'$.source_digest')
      WHERE r.format='session-summary' AND r.source='automatic' AND r.state='completed'`).all().map(row => row.target_id));
    const candidates = [...closed, ...integrations.sessionSnapshots(store.sessionList().filter(session =>
      store.canonical(session.work_item_id) === target && !closedIds.has(session.id)
      && automaticallySummarized.has(session.id) && !store.isDeleted(session.work_item_id)))];
    const accepted = candidates.filter(session => userSession(session) && store.canonical(session.work_item_id) === target && (() => {
      const summary = integrations.summary(session.id);
      return summary?.state === 'completed' && summary.text?.trim() && summary.accepted_digest === session.source_digest;
    })());
    const state = db.prepare('SELECT * FROM metadata_automation_state WHERE work_item_id=?').get(target)
      || { initial_consumed: 0, summary_highwater: 0 };
    const bucket = Math.floor(accepted.length / settings.summary_interval) * settings.summary_interval;
    const initialDue = !state.initial_consumed && turns.size >= settings.initial_output_count;
    return { initial_due: initialDue,
      summary_due: !!(state.initial_consumed || initialDue) && bucket > state.summary_highwater, output_count: turns.size, summary_count: accepted.length,
      initial_consumed: state.initial_consumed || Number(turns.size >= settings.initial_output_count),
      // A request includes every accepted summary in its snapshot, including a partial bucket.
      // Remember that coverage so changing the interval cannot replay the same history.
      summary_highwater: Math.max(state.summary_highwater, accepted.length), summary_ids: accepted.map(session => session.id), settings };
  }
  function consumeMilestones(target, covered) {
    db.prepare(`INSERT INTO metadata_automation_state VALUES(?,?,?) ON CONFLICT(work_item_id) DO UPDATE SET
      initial_consumed=MAX(initial_consumed,excluded.initial_consumed),summary_highwater=MAX(summary_highwater,excluded.summary_highwater)`)
      .run(target, covered.initial_consumed, covered.summary_highwater);
  }
  const eventReferences = session => store.sessionMessages(session).map(event => ({ uid: event.uid,
    digest: digest(json([event.kind, event.event_at, event.text ?? null, event.resolution, event.turn_id])) }));
  function snapshot(format, target, automatic = false, covered = null, { legacyOpenSummaries = false } = {}) {
    assert(['work-item-metadata', 'session-summary'].includes(format), '지원하지 않는 재작성 형식입니다.');
    const detail = format === 'work-item-metadata' ? store.detail(target) : null;
    const selected = detail ? detail.sessions : store.sessionList().filter(s => s.id === target);
    const sessions = integrations.sessionSnapshots(automatic ? selected.filter(userSession) : selected);
    assert(sessions.length, '재작성할 세션 이력이 없습니다.', 409);
    const closed = new Set(integrations.closedSessions().map(session => session.id));
    const references = [];
    const input = { format, sessions: sessions.map(s => {
      const previous = integrations.summary(s.id);
      const summaryOnly = format === 'work-item-metadata' && closed.has(s.id) && previous?.state === 'completed'
        && previous.accepted_digest === s.source_digest && previous.text?.trim();
      if (automatic) references.push({ id: s.id, agent_id: s.agent_id, first_event_id: s.first_event_id,
        original_work_item_id: s.original_work_item_id, start_at: s.start_at,
        ...(summaryOnly ? { summary: previous.text, source_digest: s.source_digest } : { events: eventReferences(s.id) }) });
      return { id: s.id, engine: s.engine, start_at: s.start_at, end_at: s.end_at,
        // An open window already supplies its raw history. Including its
        // concurrently generated summary duplicates context and invalidates a
        // metadata rewrite even when the underlying conversation is unchanged.
        summary: summaryOnly ? previous.text
          : legacyOpenSummaries && format === 'work-item-metadata' && previous?.accepted_digest === s.source_digest ? previous.text : null,
        events: summaryOnly ? [] : s.source.events };
    }) };
    validateSchema(inputSchema, input, '재작성 입력');
    return { input, source_digest: detail ? digest(json(input)) : sessions[0].source_digest,
      work_item_id: detail?.item.id || sessions[0].original_work_item_id,
      visibility_revision: store.visibilityRevision(detail?.item.id || sessions[0].work_item_id),
      base_version: detail?.item.version ?? null,
      ...(detail && !legacyOpenSummaries ? { metadata_source_policy: 'closed-summaries-v1' } : {}),
      session: detail ? null : { id: sessions[0].id, source: sessions[0].source, source_digest: sessions[0].source_digest },
      ...(automatic ? { automatic: { references, covered } } : {}) };
  }
  function isCurrent(row) {
    if (latest(row.format, row.target_id)?.operation_id !== row.operation_id) return false;
    try {
      if (row.source === 'automatic' && row.format === 'work-item-metadata') {
        const source = row.snapshot, item = db.prepare('SELECT * FROM work_items WHERE id=?').get(row.target_id);
        if (!item || item.merged_into || item.metadata_protected || store.isDeleted(item.id) || item.version !== source.base_version
          || store.visibilityRevision(item.id) !== source.visibility_revision) return false;
        if (source.automatic.admission_failure) return true;
        const currentSessions = new Map(store.sessionList(item.id).map(session => [session.id, session]));
        for (const ref of source.automatic.references) {
          const current = currentSessions.get(ref.id);
          if (!current || ['agent_id', 'first_event_id', 'original_work_item_id', 'start_at'].some(key => current[key] !== ref[key])) return false;
          if (ref.events) {
            const events = eventReferences(ref.id);
            if (events.length < ref.events.length || ref.events.some((event, index) => json(event) !== json(events[index]))) return false;
          } else {
            const summary = integrations.summary(ref.id), [session] = integrations.sessionSnapshots([current]);
            if (summary?.state !== 'completed' || summary.text !== ref.summary || summary.accepted_digest !== ref.source_digest
              || session.source_digest !== ref.source_digest) return false;
          }
        }
        return true;
      }
      if (row.source === 'automatic' && row.snapshot.summary_trigger?.reason === 'missing_output'
        && !store.sessionList().find(session => session.id === row.target_id)?.stale_pending) return false;
      const current = snapshot(row.format, row.target_id, false, null,
        { legacyOpenSummaries: row.format === 'work-item-metadata' && !row.snapshot.metadata_source_policy });
      return current.source_digest === row.snapshot.source_digest && current.base_version === row.snapshot.base_version
        && current.visibility_revision === (row.snapshot.visibility_revision || 0)
        && (row.format !== 'work-item-metadata' || current.work_item_id === row.snapshot.work_item_id);
    } catch { return false; }
  }
  function summaryState(row, state, result, message) {
    if (row.format !== 'session-summary' || store.isDeleted(row.snapshot.work_item_id)) return;
    integrations.ensureSummary(row.snapshot.session);
    integrations.finishSummary(row.snapshot.session, state, { run_id: row.run_id, text: result?.text, message });
  }
  function finish(row, state, result = null, message = null) {
    return transaction(db, () => finishWithinTransaction(row, state, result, message));
  }
  // Call only while the caller owns the DB transaction, including timer batches.
  function finishWithinTransaction(row, state, result = null, message = null) {
    const current = get(row.operation_id);
    if (!active(current)) return current;
    if (!isCurrent(current)) {
      state = 'superseded'; message = '생성 중 이력·요약 또는 업무 정보가 변경되어 결과를 반영하지 않았습니다. 최신 내용으로 다시 작성하세요.';
    }
    if (state === 'completed' && row.format === 'work-item-metadata') {
      db.prepare('UPDATE work_items SET title=?,description=?,manual=1,version=version+1 WHERE id=? AND version=?')
        .run(result.title, result.description, row.snapshot.work_item_id, row.snapshot.base_version);
    }
    if (state === 'completed' && current.source === 'automatic' && current.format === 'session-summary') {
      // Record only accepted completions. Failed, manual and superseded summaries
      // must not split history; the next real input creates the new window.
      db.prepare(`INSERT OR IGNORE INTO summary_window_boundaries(session_id,agent_id,completed_at)
        SELECT id,agent_id,? FROM work_item_sessions WHERE id=? AND active=1`)
        .run(new Date(clock()).toISOString(), current.target_id);
    }
    if (state === 'superseded') db.prepare('INSERT OR IGNORE INTO writing_cancellations(run_id) VALUES(?)').run(current.run_id || stableId('run-', current.run_key));
    db.prepare('UPDATE writing_requests SET state=?,result=?,message=?,updated_at=? WHERE operation_id=?')
      .run(state, result ? json(result) : null, message, now(), row.operation_id);
    if (latest(row.format, row.target_id)?.operation_id === row.operation_id) summaryState(current, state, state === 'completed' ? result : null, message);
    return get(row.operation_id);
  }
  function insert(format, target, source, operation, legacy = null, origin = 'manual') {
    const timestamp = now(), task = legacy ? 'session.summarize' : 'text.rewrite';
    const runKey = legacy ? `summary:${target}:${source.source_digest}` : `rewrite:${operation}`;
    const state = legacy?.state === 'running' && legacy.run_id ? 'running' : 'pending';
    db.prepare(`INSERT INTO writing_requests(operation_id,format,target_id,snapshot,task,run_key,state,run_id,created_at,updated_at,source)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(operation, format, target, json(source), task, runKey, state, legacy?.run_id || null, timestamp, timestamp, origin);
    const row = get(operation); summaryState(row, state); return row;
  }
  function enqueue(format, target, input) {
    return transaction(db, () => {
      assert(input && Object.keys(input).every(k => ['operation_id', 'version'].includes(k)), '재작성 요청을 확인하세요.');
      assert(typeof input.operation_id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation_id), '재작성 요청 식별자가 필요합니다.');
      if (format === 'work-item-metadata') target = store.canonical(target);
      const owner = format === 'work-item-metadata' ? target : db.prepare('SELECT work_item_id FROM work_item_sessions WHERE id=?').get(target)?.work_item_id;
      assert(!owner || !store.isDeleted(owner), '업무를 찾을 수 없습니다.', 404);
      const prior = get(input.operation_id);
      if (prior) {
        assert(prior.format === format && prior.target_id === target && (format !== 'work-item-metadata' || prior.snapshot.base_version === input.version), '같은 재작성 요청 식별자의 대상이 다릅니다.', 409);
        return prior;
      }
      assert(!active(latest(format, target)), '이미 작성 중입니다. 완료 후 다시 작성할 수 있습니다.', 409);
      const source = snapshot(format, target);
      if (format === 'work-item-metadata') assert(source.base_version === input.version, '업무 정보가 변경되었습니다. 최신 내용을 불러오세요.', 409);
      if (format === 'work-item-metadata') consumeMilestones(target, { ...milestones(target), initial_consumed: 1 });
      return insert(format, target, source, input.operation_id);
    });
  }
  function summaryCandidates(closed) {
    const closedIds = new Set(closed.map(session => session.id)), observed = clock();
    const idleSummaryMs = automationSettings().session_summary_idle_minutes * 60000;
    const running = db.prepare('SELECT work_item_id,payload FROM run_views').all()
      .map(row => ({ ...JSON.parse(row.payload), work_item_id: store.canonical(row.work_item_id) }))
      .filter(run => !run.internal && ['pending', 'running'].includes(run.status));
    // Persisted end events keep the backlog eligible across timer ticks/restarts.
    // Only history observed by the end time is covered, never later resumed work.
    const endedItems = new Map(), endedAgents = new Map();
    for (const row of db.prepare(`SELECT e.agent_id,e.event_at,COALESCE((
      SELECT s.work_item_id FROM work_item_sessions s WHERE s.agent_id=e.agent_id AND s.active=1
      AND s.start_at<=e.event_at ORDER BY s.start_at DESC,s.id DESC LIMIT 1),a.work_item_id) AS work_item_id FROM events e
      JOIN agent_sessions a ON a.id=e.agent_id WHERE e.kind='session.ended'
      AND a.role='user' AND a.engine IN ('claude','codex')
      AND json_extract(e.payload,'$.source')='system_hook'`).all()) {
      const owner = store.canonical(row.work_item_id), at = Date.parse(row.event_at);
      endedItems.set(owner, Math.max(endedItems.get(owner) || 0, at));
      endedAgents.set(row.agent_id, Math.max(endedAgents.get(row.agent_id) || 0, at));
    }
    const ended = integrations.sessionSnapshots(store.sessionList().filter(session => userSession(session)
      && !closedIds.has(session.id)
      && Date.parse(session.last_observed_at || session.end_at) <= (endedItems.get(session.work_item_id) || 0)
      && (!session.pending || Date.parse(session.last_observed_at || session.end_at) <= (endedAgents.get(session.agent_id) || 0))
      && !running.some(run => run.origin
        ? run.origin.engine === session.engine && run.origin.agent_session_id === session.agent_session_id
        : run.work_item_id === session.work_item_id)));
    const endedIds = new Set(ended.map(session => session.id));
    const idle = integrations.sessionSnapshots(store.sessionList().filter(session => userSession(session)
      && !closedIds.has(session.id) && !endedIds.has(session.id) && (!session.pending || session.stale_pending) && observed - Date.parse(session.last_observed_at || session.end_at) >= idleSummaryMs
      && !running.some(run => run.origin
        ? run.origin.engine === session.engine && run.origin.agent_session_id === session.agent_session_id
        : run.work_item_id === session.work_item_id)))
      // An interrupted/failed turn is not an observed final response. Likewise,
      // a missing Stop is summarized only as incomplete history, never as completion.
      .filter(session => session.stale_pending || (session.source.events.at(-1)?.kind === 'output'
        && observed - Date.parse(session.ended) >= idleSummaryMs));
    return [...closed.filter(userSession).map(session => ({ session, reason: 'closed' })),
      ...ended.map(session => ({ session, reason: 'session_end' })),
      ...idle.map(session => ({ session, reason: session.stale_pending ? 'missing_output' : 'idle' }))];
  }
  const cancellingSummaryCount = () => {
    const cancelled = new Set(db.prepare('SELECT run_id FROM writing_cancellations').all().map(row => row.run_id));
    return db.prepare("SELECT run_id,run_key FROM writing_requests WHERE source='automatic' AND format='session-summary' AND state='superseded'")
      .all().filter(row => cancelled.has(row.run_id || stableId('run-', row.run_key))).length;
  };
  function schedulePeriodicSummaries(closed) {
    return transaction(db, () => {
      let changed = false;
      // Retire stale work before counting capacity, including a current window
      // that became ineligible when a new input arrived while polling runtime.
      for (const row of db.prepare("SELECT * FROM writing_requests WHERE format='session-summary' AND state IN ('pending','running')").all().map(decode)) {
        if (!isCurrent(row)) { finishWithinTransaction(row, 'superseded'); changed = true; }
      }
      // Give never-attempted history priority over a repeatedly failing source.
      const candidates = summaryCandidates(closed).map(({ session, reason }) => ({ session, reason,
        previous: latest('session-summary', session.id), summary: integrations.summary(session.id) }))
        .sort((a, b) => Number(!!(a.previous || a.summary)) - Number(!!(b.previous || b.summary))
          || (a.previous?.updated_at || a.summary?.updated_at || a.session.start_at).localeCompare(b.previous?.updated_at || b.summary?.updated_at || b.session.start_at)
          || a.session.id.localeCompare(b.session.id));
      const inFlight = db.prepare("SELECT COUNT(*) AS n FROM writing_requests WHERE source='automatic' AND format='session-summary' AND state IN ('pending','running')").get().n;
      // A lost cancellation acknowledgement can still mean a live subprocess.
      const capacity = Math.max(0, 5 - inFlight - cancellingSummaryCount());
      let selected = 0;
      for (const { session, reason, previous, summary } of candidates) {
        if (selected >= capacity) break;
        if (summary?.accepted_digest === session.source_digest && summary.text?.trim()) continue;
        if (active(previous) && isCurrent(previous)) continue;
        // Retry a failed source only through an explicit request or changed
        // history, never once per timer tick (including after a restart).
        if (previous?.state === 'failed' && previous.snapshot.source_digest === session.source_digest) continue;
        if (summary?.state === 'failed' && summary.source_digest === session.source_digest) continue;
        // Invalid input still consumes one bounded admission slot and records a
        // durable failure digest, so a large history cannot spin on every tick.
        selected += 1;
        try {
          const source = snapshot('session-summary', session.id);
          source.summary_trigger = { kind: 'periodic', reason, observed_at: new Date(clock()).toISOString() };
          const legacy = !previous && summary?.source_digest === session.source_digest && active(summary) ? summary : null;
          insert('session-summary', session.id, source, id('auto-'), legacy, 'automatic');
        } catch (error) {
          if (![400, 409].includes(error.status)) throw error;
          integrations.ensureSummary(session); integrations.finishSummary(session, 'failed', { message: error.message });
        }
      }
      return selected > 0 || changed;
    });
  }
  function scheduleAutomatic({ summaries = true, metadata = false } = {}) {
    summaries = summaries && automationSettings().session_summary_enabled;
    metadata = metadata && automationSettings().work_summary_enabled;
    if (!summaries && !metadata) return false;
    let changed = false;
    const closed = integrations.closedSessions();
    if (summaries) changed = schedulePeriodicSummaries(closed) || changed;
    if (metadata) for (const item of store.items()) {
      if (item.metadata_protected || active(latest('work-item-metadata', item.id))) continue;
      const covered = milestones(item.id, closed);
      if (!covered.initial_due && !covered.summary_due) continue;
      transaction(db, () => {
        consumeMilestones(item.id, covered);
        let source, failure;
        try { source = snapshot('work-item-metadata', item.id, true, covered); }
        catch (error) {
          if (![400, 409].includes(error.status)) throw error;
          failure = error.message;
          source = { work_item_id: item.id, base_version: item.version, visibility_revision: store.visibilityRevision(item.id),
            automatic: { admission_failure: true, covered }, input: null, source_digest: null };
        }
        const row = insert('work-item-metadata', item.id, source, id('auto-metadata-'), null, 'automatic');
        if (failure) db.prepare("UPDATE writing_requests SET state='failed',message=? WHERE operation_id=?").run(failure, row.operation_id);
      });
      changed = true;
    }
    return changed;
  }
  function started(row, runId) {
    db.prepare("UPDATE writing_requests SET state='running',run_id=?,updated_at=? WHERE operation_id=? AND state='pending'").run(runId, now(), row.operation_id);
    const current = get(row.operation_id);
    if (latest(row.format, row.target_id)?.operation_id === row.operation_id) summaryState(current, current.state);
  }
  const publicView = row => row ? { operation_id: row.operation_id, source: row.source, state: row.state, run_id: row.run_id, message: row.message,
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
  return { enqueue, scheduleAutomatic, automationSettings, saveAutomationSettings, isCurrent, finish, started, get, publicView, decorate, cancellingSummaryCount,
    cancellations: () => db.prepare('SELECT run_id FROM writing_cancellations').all(),
    cancelled: runId => db.prepare('DELETE FROM writing_cancellations WHERE run_id=?').run(runId),
    pending: () => db.prepare("SELECT * FROM writing_requests WHERE state IN ('pending','running') ORDER BY seq").all().map(decode) };
}
