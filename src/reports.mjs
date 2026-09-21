import { assert, transaction, json, digest, stableId, now } from './shared.mjs';
import { loadCatalog } from './catalog.mjs';
import { validateSchema } from './schema.mjs';
import { parseWorkReport } from './work-report.mjs';

const MAX_INPUT_BYTES = 120 * 1024, MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024, MAX_PARTS = 10000;
const active = state => ['pending', 'running'].includes(state);
const size = value => Buffer.byteLength(json(value));

export function reportStore(store, integrations) {
  const db = store.db, schema = loadCatalog().definitions.jobs['work.report.create'].input_schema;
  db.exec(`CREATE TABLE IF NOT EXISTS work_reports (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,operation_id TEXT NOT NULL UNIQUE,
    request TEXT NOT NULL,snapshot TEXT NOT NULL,source_digest TEXT NOT NULL,owner_id TEXT NOT NULL,
    state TEXT NOT NULL,title TEXT NOT NULL,body TEXT,run_id TEXT,message TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    session_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS work_report_parts (
    id TEXT PRIMARY KEY,report_id TEXT NOT NULL REFERENCES work_reports(id),level INTEGER NOT NULL,position INTEGER NOT NULL,
    input TEXT NOT NULL,source_ids TEXT NOT NULL,dependencies TEXT NOT NULL,state TEXT NOT NULL,run_id TEXT,
    result TEXT,message TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(report_id,level,position));`);
  if (!db.prepare('PRAGMA table_info(work_reports)').all().some(column => column.name === 'session_count')) transaction(db, () => {
    db.exec('ALTER TABLE work_reports ADD COLUMN session_count INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE work_reports SET session_count=json_array_length(snapshot,'$.sessions')");
  });
  // Keep completed historical reports byte-for-byte. Retired generation requests
  // retain their frozen inputs and use the existing part cancellation path.
  transaction(db, () => {
    for (const row of db.prepare("SELECT id FROM work_reports WHERE state IN ('pending','running') AND json_extract(request,'$.report_type')='performance'").all()) {
      failReport(row.id, '성과 전용 요약 생성은 더 이상 지원하지 않습니다. 일반 업무 요약으로 새로 작성하세요.');
    }
  });
  const decode = row => row && ({ ...row, request: JSON.parse(row.request), snapshot: JSON.parse(row.snapshot) });
  const decodePart = row => row && ({ ...row, input: JSON.parse(row.input), source_ids: JSON.parse(row.source_ids), dependencies: JSON.parse(row.dependencies), result: row.result ? JSON.parse(row.result) : null });
  const get = reportId => decode(db.prepare('SELECT * FROM work_reports WHERE id=?').get(reportId));
  const execution = reportId => db.prepare('SELECT id,state,owner_id FROM work_reports WHERE id=?').get(reportId);
  const part = partId => decodePart(db.prepare('SELECT * FROM work_report_parts WHERE id=?').get(partId));
  const viewColumns = 'id,operation_id,request,state,title,run_id,message,created_at,updated_at,source_digest,session_count';
  const compactParts = reportId => db.prepare(`SELECT id,level,position,state,run_id,message,source_ids,dependencies,
    json_extract(result,'$.title') AS title FROM work_report_parts WHERE report_id=? ORDER BY level,position`).all(reportId)
    .map(row => ({ ...row, source_ids: JSON.parse(row.source_ids), dependencies: JSON.parse(row.dependencies) }));
  function publicView(row, full = false) {
    const progress = db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(state='completed'),0) AS completed FROM work_report_parts WHERE report_id=?").get(row.id);
    return { id: row.id, operation_id: row.operation_id, state: row.state, created_at: row.created_at, updated_at: row.updated_at,
      title: row.title, dates: row.request.dates, timezone: row.request.timezone, report_type: row.request.report_type,
      session_count: row.session_count ?? row.snapshot.sessions.length, run_id: row.run_id, message: row.message, source_digest: row.source_digest,
      progress: { ...progress }, ...(full ? { body: row.body } : {}) };
  }
  function detail(reportId, { summary = false } = {}) {
    assert(typeof summary === 'boolean', '업무 요약 조회 조건이 잘못되었습니다.');
    let row = summary ? db.prepare(`SELECT ${viewColumns},body FROM work_reports WHERE id=?`).get(reportId) : get(reportId);
    assert(row, '업무 요약을 찾을 수 없습니다.', 404);
    if (summary) row = { ...row, request: JSON.parse(row.request) };
    return { report: publicView(row, true), ...(!summary ? { sessions: row.snapshot.sessions } : {}), parts: compactParts(reportId) };
  }
  function partDetail(reportId, partId) {
    assert(execution(reportId), '업무 요약을 찾을 수 없습니다.', 404);
    const row = part(partId); assert(row?.report_id === reportId, '부분 요약을 찾을 수 없습니다.', 404);
    return { part: { id: row.id, title: row.result?.title || null, body: row.result?.body || null,
      ...(Array.isArray(row.result?.source_refs) ? { source_refs: row.result.source_refs } : {}),
      source_ids: row.source_ids, dependencies: row.dependencies, state: row.state, message: row.message } };
  }
  function validateRequest(input) {
    assert(input && typeof input === 'object' && !Array.isArray(input)
      && Object.keys(input).every(key => ['operation_id', 'dates', 'timezone', 'report_type'].includes(key)), '업무 요약 요청 형식이 잘못되었습니다.');
    assert(typeof input.operation_id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation_id), '업무 요약 요청 식별자가 필요합니다.');
    assert(Array.isArray(input.dates) && input.dates.length >= 1 && input.dates.length <= 366
      && new Set(input.dates).size === input.dates.length && input.dates.every(date => typeof date === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
        && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date), '유효한 날짜를 중복 없이 1~366개 선택하세요.');
    assert(typeof input.timezone === 'string' && input.timezone.length <= 100 && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(input.timezone), '유효한 IANA 시간대가 필요합니다.');
    let timezone;
    try { timezone = new Intl.DateTimeFormat('en', { timeZone: input.timezone }).resolvedOptions().timeZone; }
    catch { assert(false, '유효한 IANA 시간대가 필요합니다.'); }
    const report_type = input.report_type ?? 'work';
    assert(report_type === 'work', '일반 업무 요약만 생성할 수 있습니다.');
    return { dates: [...input.dates].sort(), timezone, report_type };
  }
  function snapshot(request) {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: request.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const dateOf = at => {
      const values = Object.fromEntries(formatter.formatToParts(new Date(at)).map(value => [value.type, value.value]));
      return `${values.year.padStart(4, '0')}-${values.month}-${values.day}`;
    };
    const selected = new Set(request.dates), items = new Map(store.items().map(item => [item.id, item]));
    const sessions = store.sessionList().filter(session => selected.has(dateOf(session.start_at))
      && db.prepare("SELECT 1 FROM agent_sessions WHERE id=? AND role='user'").get(session.agent_id));
    assert(sessions.length > 0, '선택한 날짜에 시작한 사용자 세션이 없습니다.', 409);
    assert(sessions.length <= 5000, '업무 요약에는 최대 5000개 세션을 포함할 수 있습니다. 기간을 나누어 선택하세요.');
    const links = integrations.links();
    const captured = integrations.sessionSnapshots(sessions).map(session => {
      const item = items.get(session.work_item_id), accepted = integrations.summary(session.id);
      const summary = accepted?.state === 'completed' && accepted.accepted_digest === session.source_digest && accepted.text?.trim() ? accepted.text : null;
      const refs = links.filter(link => store.canonical(link.work_item_id) === item.id && link.state === 'linked' && link.issue?.key && link.issue.url)
        .map(link => ({ key: link.issue.key, url: link.issue.url }));
      return { id: session.id, engine: session.engine, agent_session_id: session.agent_session_id,
        start_at: session.start_at, end_at: session.end_at, pending: session.pending,
        work_item_id: item.id, original_work_item_id: session.original_work_item_id, work_item_title: item.title, tags: item.tags,
        jira_refs: [...new Map(refs.map(ref => [ref.url, ref])).values()], summary, events: summary ? [] : session.source.events };
    });
    const result = { ...request, sessions: captured };
    assert(size(result) <= MAX_SNAPSHOT_BYTES, '선택 이력이 32MiB를 초과합니다. 요약을 작성하거나 기간을 나누어 선택하세요.');
    return result;
  }
  function pack(values, build) {
    const groups = []; let group = [];
    for (const value of values) {
      assert(size(build([value])) <= MAX_INPUT_BYTES, '한 세션 또는 부분 요약이 입력 한도 120KiB를 초과합니다. 해당 세션 요약을 작성하거나 기간을 나누세요.');
      if (group.length && (group.length >= 100 || size(build([...group, value])) > MAX_INPUT_BYTES)) { groups.push(group); group = []; }
      group.push(value);
    }
    if (group.length) groups.push(group);
    return groups;
  }
  function insertPart(report, level, position, input, sourceIds, dependencies = []) {
    validateSchema(schema, input, '업무 요약 입력');
    assert(size(input) <= MAX_INPUT_BYTES, '부분 요약 입력이 120KiB를 초과했습니다.');
    const partId = stableId('report-part-', `${report.id}:${level}:${position}`), timestamp = now();
    db.prepare('INSERT INTO work_report_parts VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)')
      .run(partId, report.id, level, position, json(input), json(sourceIds), json(dependencies), 'pending', timestamp, timestamp);
  }
  function create(input) {
    const request = validateRequest(input);
    return transaction(db, () => {
      const prior = decode(db.prepare('SELECT * FROM work_reports WHERE operation_id=?').get(input.operation_id));
      if (prior) { assert(json(prior.request) === json(request), '같은 요약 요청 식별자의 내용이 다릅니다.', 409); return publicView(prior); }
      const captured = snapshot(request), reportId = stableId('report-', input.operation_id), timestamp = now();
      const build = sessions => ({ ...request, stage: 'sessions', compact: true, sessions });
      const groups = pack(captured.sessions, build);
      db.prepare(`INSERT INTO work_reports(id,operation_id,request,snapshot,source_digest,owner_id,session_count,state,title,body,run_id,message,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?,NULL,NULL,NULL,?,?)`).run(reportId, input.operation_id, json(request), json(captured), digest(json(captured)), captured.sessions[0].work_item_id, captured.sessions.length,
        '업무 요약 작성 중', timestamp, timestamp);
      const row = get(reportId);
      groups.forEach((sessions, index) => insertPart(row, 0, index, { ...build(sessions), compact: groups.length > 1 }, sessions.map(session => session.id)));
      return publicView(row);
    });
  }
  function started(partId, runId) {
    transaction(db, () => {
      const value = part(partId); if (!value || value.state !== 'pending') return;
      db.prepare("UPDATE work_report_parts SET state='running',run_id=?,updated_at=? WHERE id=?").run(runId, now(), partId);
      db.prepare("UPDATE work_reports SET state='running',run_id=?,updated_at=? WHERE id=? AND state IN ('pending','running')").run(runId, now(), value.report_id);
    });
  }
  function failReport(reportId, message) {
    db.prepare("UPDATE work_reports SET state='failed',message=?,updated_at=? WHERE id=?").run(message, now(), reportId);
    db.prepare("UPDATE work_report_parts SET state='cancelled',message=?,updated_at=? WHERE report_id=? AND state='pending'")
      .run('필수 부분 요약 작성에 실패하여 실행하지 않았습니다.', now(), reportId);
  }
  function finish(partId, state, result = null, message = null) {
    transaction(db, () => {
      const value = part(partId); if (!value || !active(value.state) || !active(execution(value.report_id).state)) return;
      if (state === 'completed') result = parseWorkReport(json(result), value.input);
      db.prepare('UPDATE work_report_parts SET state=?,result=?,message=?,updated_at=? WHERE id=?')
        .run(state, result ? json(result) : null, message, now(), partId);
      if (state === 'failed') failReport(value.report_id, message || '업무 요약 작성을 완료하지 못했습니다.');
    });
  }
  function advance() {
    let changed = false;
    for (const candidate of db.prepare("SELECT id FROM work_reports WHERE state IN ('pending','running') ORDER BY seq").all()) {
      const { count, level } = db.prepare('SELECT COUNT(*) AS count,MAX(level) AS level FROM work_report_parts WHERE report_id=?').get(candidate.id);
      if (!count || db.prepare("SELECT 1 FROM work_report_parts WHERE report_id=? AND level=? AND state!='completed' LIMIT 1").get(candidate.id, level)) continue;
      const report = get(candidate.id), children = db.prepare('SELECT * FROM work_report_parts WHERE report_id=? AND level=? ORDER BY position')
        .all(report.id, level).map(decodePart);
      transaction(db, () => {
        try {
          const expected = report.snapshot.sessions.map(session => session.id).sort(), observed = children.flatMap(child => child.source_ids).sort();
          assert(new Set(observed).size === observed.length && json(expected) === json(observed), '부분 요약의 원본 세션 집합이 선택 이력과 다릅니다.');
          if (children.length === 1) {
            const final = children[0];
            db.prepare("UPDATE work_reports SET state='completed',title=?,body=?,run_id=?,message=NULL,updated_at=? WHERE id=?")
              .run(final.result.title, final.result.body, final.run_id, now(), report.id);
          } else {
            const build = values => ({ ...report.request, stage: 'consolidate', compact: true,
              parts: values.map(child => ({ id: child.id, title: child.result.title, body: child.result.body, session_count: child.source_ids.length })) });
            const groups = pack(children, build);
            assert(groups.length < children.length && count + groups.length <= MAX_PARTS, '부분 요약을 입력 한도 안에서 더 통합할 수 없습니다. 기간을 나누어 다시 작성하세요.');
            groups.forEach((group, index) => {
              // Carry a lone remainder as a deterministic local node, without another model call.
              if (group.length === 1) {
                const old = group[0], nodeId = stableId('report-part-', `${report.id}:${level + 1}:${index}`), timestamp = now();
                db.prepare('INSERT INTO work_report_parts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(nodeId, report.id, level + 1, index,
                  json(old.input), json(old.source_ids), json([old.id]), 'completed', old.run_id, json(old.result), null, timestamp, timestamp);
              } else insertPart(report, level + 1, index, { ...build(group), compact: groups.length > 1 }, group.flatMap(child => child.source_ids), group.map(child => child.id));
            });
          }
        } catch (error) {
          failReport(report.id, error.message);
        }
      });
      changed = true;
    }
    return changed;
  }
  return { create, get, detail, partDetail, started, finish, advance, execution,
    list: () => db.prepare(`SELECT ${viewColumns} FROM work_reports ORDER BY created_at DESC,seq DESC`).all()
      .map(row => publicView({ ...row, request: JSON.parse(row.request) })),
    aborting: () => db.prepare("SELECT p.id,p.run_id FROM work_report_parts p JOIN work_reports r ON r.id=p.report_id WHERE p.state='running' AND r.state='failed'").all(),
    aborted: partId => db.prepare("UPDATE work_report_parts SET state='cancelled',message=?,updated_at=? WHERE id=? AND state='running'")
      .run('다른 필수 부분 요약의 실패로 결과를 사용하지 않았습니다.', now(), partId),
    pending: () => db.prepare("SELECT p.* FROM work_report_parts p JOIN work_reports r ON r.id=p.report_id WHERE p.state IN ('pending','running') AND r.state IN ('pending','running') ORDER BY r.seq,p.level,p.position").all().map(decodePart) };
}
