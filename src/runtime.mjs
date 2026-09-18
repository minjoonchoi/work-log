import fs from 'node:fs';
import path from 'node:path';
import { ROOT, dataRoot, lockService, database, transaction, id, stableId, now, json, digest, atomic, serve, body, assert, alive, redactValue } from './shared.mjs';
import { execute, validateResult } from './executor.mjs';
import { verify, artifact } from './verifier.mjs';
import { loadCatalog, compileRequest, buildPrompt } from './catalog.mjs';
import { initialEvidence, saveEvidence, readEvidence, executeChecks, sourceSnapshot, checkEvidenceIntegrity, renderEvidenceReport } from './checks.mjs';
import { validateSchema, canonicalJson } from './schema.mjs';
import { nextStep } from './workflow.mjs';
import { resolveTask } from './intake.mjs';

const dir = dataRoot(); lockService(dir, 'runtime');
const { definitions, rules, responseSchema, taskTypes, workflows, profiles, runSchema, requestSchema } = loadCatalog();
const runtimeDigest = digest([...['runtime', 'executor', 'verifier', 'shared', 'process-runner', 'catalog', 'scenarios', 'checks', 'schema', 'workflow', 'intake', 'session-summary', 'text-rewrite'].map(name => fs.readFileSync(path.join(ROOT, `src/${name}.mjs`), 'utf8')),
  fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')].join('\n'));
const db = database(path.join(dir, 'runtime.sqlite'), `
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, request TEXT NOT NULL, definition TEXT NOT NULL,
 definition_digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
 round INTEGER NOT NULL DEFAULT 0, stage TEXT, message TEXT, artifact TEXT);
 CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,epoch INTEGER NOT NULL,stage TEXT NOT NULL,
 round INTEGER NOT NULL,status TEXT NOT NULL,pid INTEGER,started_at TEXT NOT NULL,ended_at TEXT,result TEXT,directory TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS check_evidence(run_id TEXT NOT NULL,epoch INTEGER NOT NULL,file TEXT NOT NULL,content_digest TEXT NOT NULL,PRIMARY KEY(run_id,epoch));
 CREATE TABLE IF NOT EXISTS workflow_steps(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,epoch INTEGER NOT NULL,sequence INTEGER NOT NULL,
 node TEXT NOT NULL,task TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,outcome TEXT,next_node TEXT,reason TEXT,
 UNIQUE(run_id,epoch,sequence));
 PRAGMA user_version=3;
`);
const get = id => db.prepare('SELECT * FROM runs WHERE id=?').get(id);
const running = new Map(); let shuttingDown = false, activeCheckRun = null;
function view(row) {
  const r = JSON.parse(row.request);
  return { id: row.id, status: row.status, task: r.task, engine: r.engine, origin: r.origin, internal: !!r.internal, stage: row.stage, round: row.round,
    message: row.message, created_at: row.created_at, updated_at: row.updated_at,
    definition_digest: row.definition_digest, request_digest: JSON.parse(row.definition).request_digest || null, artifact: row.artifact ? JSON.parse(row.artifact) : null,
    evidence: db.prepare('SELECT file,content_digest,epoch FROM check_evidence WHERE run_id=? AND epoch=?').get(row.id, row.epoch) || null };
}
function emit(event) { db.prepare('INSERT INTO outbox(payload) VALUES(?)').run(json(event)); }
function eventBase(request) { return { engine: request.origin.engine, agent_session_id: request.origin.agent_session_id, turn_id: request.origin.turn_id, role: request.internal ? 'metadata' : 'user', work_item_id: request.work_item_id, source: 'runtime' }; }
function update(runId, fields) {
  return transaction(db, () => {
    const keys = Object.keys(fields); db.prepare(`UPDATE runs SET ${keys.map(k => `${k}=?`).join(',')},updated_at=? WHERE id=?`).run(...Object.values(fields), now(), runId);
    const row = get(runId), r = JSON.parse(row.request);
    emit({ ...eventBase(r), id: id('state-'), kind: 'run.updated', event_at: now(), run: view(row) });
    return row;
  });
}
function terminal(runId, status, message, epoch) {
  const row = get(runId); if (row.epoch !== epoch || row.status === 'cancelled') return;
  update(runId, { status, message });
  const r = JSON.parse(row.request);
  if (r.record_io !== false) emit({ ...eventBase(r), id: `terminal-${runId}-${epoch}`, kind: status === 'completed' ? 'output' : 'turn.failed',
    event_at: now(), turn_id: r.origin.turn_id, text: message });
}

function create(input) {
  input = redactValue(input);
  validateSchema(runSchema, input, '실행 요청');
  const task = resolveTask(input);
  assert(typeof task === 'string' && Object.hasOwn(definitions.jobs, task), '지원하지 않는 업무입니다.');
  const job = definitions.jobs[task];
  const workflow = workflows[job.workflow];
  const compiled = compileRequest(task, input.input ?? {}, input.prompt, job, requestSchema), normalizedInput = compiled.input;
  const engine = workflow.mode === 'artifact' ? input.engine || 'codex' : 'local';
  assert(workflow.mode !== 'artifact' || ['codex', 'claude'].includes(engine) || (engine === 'fixture' && process.env.HARNESS_TEST_MODE === '1'), '지원하지 않는 엔진입니다.');
  if (task === 'checks.run') {
    assert(Object.hasOwn(profiles, normalizedInput.profile), '등록되지 않은 검사 프로필입니다.');
    assert(!(process.env.HARNESS_CHECK_ACTIVE === '1' && normalizedInput.profile.startsWith('harness.')), '검사 실행 중 하네스 전체 검사를 재귀 실행할 수 없습니다.');
  }
  assert(!input.internal || job.allow_internal === true, '내부 실행은 허용된 기록 작성 작업만 지원합니다.');
  const runId = input.idempotency_key ? stableId('run-', input.idempotency_key) : id('run-'), origin = input.origin || { engine: 'harness', agent_session_id: id('cli-'), turn_id: id('turn-') };
  for (const key of ['engine', 'agent_session_id', 'turn_id']) assert(typeof origin[key] === 'string' && origin[key].length, `origin.${key}가 필요합니다.`);
  const request = { task, prompt: input.prompt || canonicalJson(compiled), input: normalizedInput, engine, origin, internal: !!input.internal, record_io: !input.origin && !input.internal,
    work_item_id: input.work_item_id || stableId('item-', stableId('agent-', `${origin.engine}:${origin.agent_session_id}`)),
    ...(engine === 'fixture' ? { fixture: input.fixture || {} } : {}) };
  const prior = get(runId);
  if (prior) {
    const previous = JSON.parse(prior.request);
    assert(['task', 'engine', 'work_item_id', 'internal'].every(k => previous[k] === request[k]) && canonicalJson(previous.input) === canonicalJson(request.input), '같은 실행 요청 키에 다른 입력이 있습니다.', 409);
    return view(prior);
  }
  const definition = { version: definitions.version, runtime_digest: runtimeDigest, job, workflow, task_types: taskTypes,
    rules: Object.fromEntries(job.rules.map(k => [k, rules[k]])), request_schema: requestSchema,
    response_schema: responseSchema, limits: { ...definitions.limits } };
  if (task === 'checks.run') definition.check_profile = profiles[normalizedInput.profile];
  if (task === 'verification.report') {
    const latest = input.work_item_id || input.origin
      ? db.prepare("SELECT id FROM runs WHERE json_extract(request,'$.task')='checks.run' AND json_extract(request,'$.work_item_id')=? ORDER BY created_at DESC LIMIT 1").get(request.work_item_id)
      : db.prepare("SELECT id FROM runs WHERE json_extract(request,'$.task')='checks.run' ORDER BY created_at DESC LIMIT 1").get();
    const runIds = normalizedInput.run_ids || (latest ? [latest.id] : []);
    assert(runIds.length, '보고할 검사 실행이 없습니다. 먼저 등록된 검사를 실행하세요.');
    definition.evidence_sources = runIds.map(sourceId => {
      const source = get(sourceId); assert(source && JSON.parse(source.request).task === 'checks.run', '검사 실행의 run ID만 보고할 수 있습니다.');
      assert(!['pending', 'running'].includes(source.status), '아직 종료되지 않은 검사는 보고서 근거로 고정할 수 없습니다.');
      const evidence = readEvidence(db, dir, source); checkEvidenceIntegrity(evidence.data);
      const profile = JSON.parse(source.definition).check_profile;
      let sourceCurrent = false;
      try { sourceCurrent = evidence.data.after?.digest === sourceSnapshot(profile.watch).digest; } catch {}
      return { ...evidence, run_status: source.status, source_current: sourceCurrent };
    });
    definition.evidence_captured_at = now();
    request.input = { run_ids: runIds };
  }
  request.input = JSON.parse(canonicalJson(request.input));
  validateSchema(job.input_schema, request.input, `${task} input`);
  definition.request_digest = digest(canonicalJson({ task, input: request.input }));
  if (engine === 'fixture' && input.fixture?.timeoutMs) definition.limits.timeoutMs = Math.max(50, Math.min(180000, input.fixture.timeoutMs));
  transaction(db, () => {
    db.prepare('INSERT INTO runs(id,status,request,definition,definition_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(runId, 'pending', json(request), json(definition), digest(json(definition)), now(), now());
    if (request.record_io) emit({ ...eventBase(request), id: `input-${runId}`, kind: 'input', event_at: now(), turn_id: origin.turn_id, text: request.prompt });
    emit({ ...eventBase(request), id: id('state-'), kind: 'run.updated', event_at: now(), run: view(get(runId)) });
  });
  if (task === 'checks.run') saveEvidence(db, dir, initialEvidence(get(runId), definition.check_profile, request.input.profile));
  queueMicrotask(schedule); return view(get(runId));
}
function stillCurrent(runId, epoch) { const r = get(runId); return !shuttingDown && r.epoch === epoch && r.status === 'running'; }
function newAttempt(row, stage) {
  const attempt = id('attempt-'), directory = path.join(dir, 'runs', row.id, attempt);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(attempt, row.id, row.epoch, stage, 0, 'running', null, now(), null, null, directory);
  return { id: attempt, directory, onSpawn: pid => db.prepare('UPDATE attempts SET pid=? WHERE id=?').run(pid, attempt) };
}
function endAttempt(attempt, result) {
  db.prepare('UPDATE attempts SET status=?,ended_at=?,result=? WHERE id=?').run(result.ok ? 'returned' : 'failed', now(), json(result), attempt);
}
async function performChecks(row, request, definition) {
  update(row.id, { stage: definition.workflow.initial });
  const evidence = readEvidence(db, dir, row).data;
  const result = await executeChecks({ profile: definition.check_profile, evidence, limits: definition.limits,
    createAttempt: () => newAttempt(row, 'verify'), endAttempt,
    setProcess: handle => running.set(row.id, handle), current: () => stillCurrent(row.id, row.epoch),
    save: data => saveEvidence(db, dir, data) });
  return { status: result.status === 'completed' ? 'done' : result.status, result: { message: result.message } };
}
async function performReport(row, request, definition) {
  update(row.id, { stage: definition.workflow.initial });
  const attempt = newAttempt(row, 'render'), cwd = path.join(attempt.directory, 'workspace');
  try {
    for (const source of definition.evidence_sources) {
      assert(digest(fs.readFileSync(source.file)) === source.content_digest, '고정한 검사 근거가 변경되었습니다.');
      checkEvidenceIntegrity(source.data);
    }
    fs.mkdirSync(cwd, { recursive: true });
    atomic(path.join(cwd, definition.job.file), renderEvidenceReport(definition.evidence_sources, definition.evidence_captured_at));
    const report = await verify(cwd, definition.job, request.input, attempt.directory);
    const result = { ok: report.passed, result: { status: 'done', result: { file: definition.job.file } } };
    endAttempt(attempt.id, result);
    if (!stillCurrent(row.id, row.epoch)) return;
    assert(report.passed, '보고서 형식 검증 실패');
    publishArtifact(row, request, { ...report.subject, report: path.join(attempt.directory, 'verification.json') },
      { render_attempt: attempt.id });
    return { status: 'done', result: { message: '검사 근거 보고서를 생성했습니다. 대상 검사의 판정은 보고서에 별도로 표시합니다.' } };
  } catch (e) { endAttempt(attempt.id, { ok: false, error: e.message }); throw e; }
}
function publishArtifact(row, request, candidate, proof) {
  const job = JSON.parse(row.definition).job;
  const destination = path.join(dir, 'runs', row.id, 'artifacts', job.file);
  const publication = { file: destination, content_digest: candidate.content_digest, ...proof, verify_report: candidate.report,
    definition_digest: row.definition_digest, epoch: row.epoch };
  atomic(path.join(dir, 'runs', row.id, 'publication-intent.json'), json(publication));
  atomic(destination, candidate.bytes);
  assert(digest(fs.readFileSync(destination)) === publication.content_digest, '최종 산출물 해시가 다릅니다.');
  if (request.engine === 'fixture' && request.fixture.crashAfterPublish && row.epoch === 0) process.exit(73);
  update(row.id, { artifact: json(publication) }); return publication;
}
async function agentStep(row, request, definition, task, candidate, issues, round) {
  const runId = row.id, job = definition.job, attempt = id('attempt-');
  const attemptDir = path.join(dir, 'runs', runId, attempt), cwd = path.join(attemptDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  if (candidate) atomic(path.join(cwd, job.file), candidate.bytes);
  const parent = { ...request.origin, work_item_id: request.work_item_id, run_id: runId, task_id: attempt };
  const workerBase = { engine: request.engine, agent_session_id: attempt, role: 'worker', work_item_id: request.work_item_id, parent };
  const prompt = buildPrompt({ stage: task, definition, request, candidate, issues });
  db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(attempt, runId, row.epoch, task, round, 'running', null, now(), null, null, attemptDir);
  emit({ ...workerBase, id: `input-${attempt}`, kind: 'input', event_at: now(), turn_id: attempt, text: prompt });
  const processRun = execute({ engine: request.engine, cwd, attemptDir, stage: task, prompt, limits: definition.limits, parent, dataDir: dir,
    schema: definition.response_schema, allowedFile: job.file, fixture: { ...request.fixture, job, round, input: request.input },
    onSpawn: pid => db.prepare('UPDATE attempts SET pid=? WHERE id=?').run(pid, attempt) });
  running.set(runId, processRun);
  const returned = await processRun.promise; endAttempt(attempt, returned);
  emit({ ...workerBase, id: `output-${attempt}`, kind: returned.ok ? 'output' : 'turn.failed', event_at: now(), turn_id: attempt,
    source_session_id: returned.observation.native_session_id, text: returned.ok ? json(returned.result) : json(returned.observation) });
  let outcome;
  if (!returned.ok) outcome = { status: 'failed', result: { message: `실행 실패: ${returned.observation.reason || returned.observation.error || returned.observation.code}` } };
  else {
    try { validateSchema(definition.response_schema, returned.result, 'worker 응답'); outcome = validateResult(returned.result, task, job); }
    catch (e) { outcome = { status: 'failed', result: { message: `protocol_failure: ${e.message}` } }; }
  }
  return { outcome, attempt, cwd, directory: attemptDir };
}
async function perform(row) {
  const runId = row.id, epoch = row.epoch, request = JSON.parse(row.request), definition = JSON.parse(row.definition);
  const { job, limits, workflow } = definition;
  let candidate = null, issues = [], nodeId = workflow?.initial, sequence = 0, budgets = { repairs: 0 };
  update(runId, { status: 'running', message: null });
  try {
    if (definition.runtime_digest !== runtimeDigest) { terminal(runId, 'blocked', '이 실행을 시작한 하네스 버전에서 재개해야 합니다.', epoch); return; }
    validateSchema(definition.request_schema, { task: request.task, input: request.input }, '고정된 작업 요청');
    validateSchema(job.input_schema, request.input, '고정된 업무 입력');
    assert(digest(canonicalJson({ task: request.task, input: request.input })) === definition.request_digest, '입력 버전이 변경되었습니다.');
    while (stillCurrent(runId, epoch)) {
      if (++sequence > workflow.max_steps) { terminal(runId, 'blocked', 'workflow 실행 단계 한도에 도달했습니다.', epoch); return; }
      const node = workflow.nodes[nodeId], task = node.task, stepId = id('step-');
      update(runId, { stage: nodeId, round: budgets.repairs });
      db.prepare('INSERT INTO workflow_steps(id,run_id,epoch,sequence,node,task,status,started_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(stepId, runId, epoch, sequence, nodeId, task, 'running', now());
      let outcome;
      try {
        if (workflow.mode === 'checks') outcome = await performChecks(row, request, definition);
        else if (workflow.mode === 'report') outcome = await performReport(row, request, definition);
        else if (definition.task_types[task].executor === 'agent') {
          const execution = await agentStep(row, request, definition, task, candidate, issues, budgets.repairs);
          outcome = execution.outcome;
          if (task === 'review' && ['done', 'revise'].includes(outcome.status)) {
            assert(artifact(execution.cwd, job.file).content_digest === candidate.content_digest, '검토자가 산출물을 변경했습니다.');
            if (outcome.status === 'done') candidate.review = { digest: candidate.content_digest, attempt: execution.attempt };
          } else if (outcome.status === 'done') {
            candidate = { ...artifact(execution.cwd, job.file), cwd: execution.cwd, directory: execution.directory };
          }
        } else if (task === 'verify') {
          const report = await verify(candidate.cwd, job, request.input, candidate.directory);
          assert(report.subject_digest === candidate.content_digest, '검증 대상 산출물이 변경되었습니다.');
          candidate.report = path.join(candidate.directory, 'verification.json');
          candidate.verified = report.passed ? candidate.content_digest : null;
          outcome = report.passed ? { status: 'done', result: { file: candidate.report, subject_digest: candidate.content_digest } }
            : { status: 'revise', result: { issues: report.checks.filter(c => !c.passed).map(c => ({ rule: c.rule, detail: json(c) })) } };
        } else if (task === 'render') {
          assert(candidate && candidate.verified === candidate.content_digest && candidate.review?.digest === candidate.content_digest, '필수 검증·검토 근거 없이 전달할 수 없습니다.');
          publishArtifact(row, request, candidate, { review_attempt: candidate.review.attempt });
          outcome = { status: 'done', result: { message: `검증과 검토를 통과했습니다: ${job.file}` } };
        } else throw new Error('지원하지 않는 작업 처리기입니다.');
      } catch (e) { outcome = { status: 'failed', result: { message: e.message } }; }
      if (!stillCurrent(runId, epoch)) {
        db.prepare('UPDATE workflow_steps SET status=?,ended_at=?,outcome=?,reason=? WHERE id=?')
          .run(get(runId).status, now(), json(outcome || {}), 'execution_stopped', stepId);
        return;
      }
      const transition = nextStep(workflow, nodeId, outcome.status, budgets, limits);
      db.prepare('UPDATE workflow_steps SET status=?,ended_at=?,outcome=?,next_node=?,reason=? WHERE id=?')
        .run('completed', now(), json(outcome), transition.next, transition.reason || null, stepId);
      budgets = transition.budgets;
      if (outcome.status === 'revise') issues = outcome.result.issues;
      if (transition.next.startsWith('$')) {
        const status = transition.next.slice(1);
        terminal(runId, status, transition.reason === 'repair_limit' ? '수정 한도에 도달했습니다. 미완료 산출물과 검사 근거를 확인하세요.'
          : outcome.result.message || '작업을 완료했습니다.', epoch);
        return;
      }
      nodeId = transition.next;
    }
  } catch (e) { if (stillCurrent(runId, epoch)) terminal(runId, 'failed', e.message, epoch); }
  finally { running.delete(runId); if (activeCheckRun === runId) activeCheckRun = null; schedule(); }
}

function schedule() {
  if (shuttingDown) return;
  const ready = db.prepare("SELECT * FROM runs WHERE status='pending' ORDER BY created_at").all();
  for (const row of ready) {
    if (running.size >= definitions.limits.concurrency) break;
    if (JSON.parse(row.request).task === 'checks.run') { if (activeCheckRun) continue; activeCheckRun = row.id; }
    running.set(row.id, { cancel() {} }); void perform(row);
  }
}
function cancel(runId) {
  const row = get(runId); assert(row, '실행이 없습니다.', 404);
  if (['completed', 'cancelled'].includes(row.status)) return view(row);
  update(runId, { status: 'cancelled', message: '사용자가 취소했습니다.' });
  running.get(runId)?.cancel();
  const r = JSON.parse(row.request);
  if (r.record_io !== false) emit({ ...eventBase(r), id: `cancel-${runId}-${row.epoch}`, kind: 'turn.interrupted', event_at: now(), turn_id: r.origin.turn_id, text: '취소됨' });
  return view(get(runId));
}
function resume(runId) {
  const row = get(runId); assert(row, '실행이 없습니다.', 404);
  assert(['failed', 'blocked', 'interrupted', 'cancelled'].includes(row.status), '재개 가능한 실행 상태가 아닙니다.', 409);
  assert(!running.has(runId), '이전 worker 종료를 기다리고 있습니다.', 409);
  const attempts = db.prepare("SELECT pid FROM attempts WHERE run_id=? AND status='running'").all(runId);
  assert(!attempts.some(a => alive(a.pid)), '이전 worker가 살아 있어 새 쓰기 시도를 시작할 수 없습니다.', 409);
  if (row.status === 'interrupted') {
    try {
      const intent = JSON.parse(fs.readFileSync(path.join(dir, 'runs', runId, 'publication-intent.json'), 'utf8'));
      const definition = JSON.parse(row.definition);
      const proof = db.prepare('SELECT * FROM attempts WHERE id=? AND run_id=? AND epoch=?').get(intent.review_attempt || intent.render_attempt, runId, row.epoch);
      const verified = JSON.parse(fs.readFileSync(intent.verify_report, 'utf8'));
      assert(intent.definition_digest === row.definition_digest && intent.epoch === row.epoch && proof?.status === 'returned', '게시 근거 불일치');
      if (definition.workflow?.mode === 'report') {
        assert(proof.stage === 'render' && validateResult(JSON.parse(proof.result).result, 'render', definition.job).status === 'done', '보고서 생성 근거 불일치');
        assert(digest(renderEvidenceReport(definition.evidence_sources, definition.evidence_captured_at)) === intent.content_digest, '고정한 근거와 보고서가 다릅니다.');
        for (const source of definition.evidence_sources) checkEvidenceIntegrity(source.data);
      } else {
        assert(proof.stage === 'review' && validateResult(JSON.parse(proof.result).result, 'review', definition.job).status === 'done', '검토 미통과');
      }
      assert(verified.passed && verified.subject_digest === intent.content_digest, '검증 근거 불일치');
      const expected = path.join(dir, 'runs', runId, 'artifacts', definition.job.file);
      assert(intent.file === expected && artifact(path.dirname(expected), definition.job.file).content_digest === intent.content_digest, '게시 파일 불일치');
      update(runId, { artifact: json(intent) });
      db.prepare("UPDATE workflow_steps SET status='completed',ended_at=?,outcome=?,next_node='$completed',reason='publication_reconciled' WHERE run_id=? AND epoch=? AND task='render' AND status='interrupted'")
        .run(now(), json({ status: 'done', result: { recovered: true, subject_digest: intent.content_digest } }), runId, row.epoch);
      terminal(runId, 'completed', '중단 전 검증·게시된 산출물을 대조해 완료를 복구했습니다.', row.epoch);
      return view(get(runId));
    } catch { /* No committed publication to reuse: a new isolated attempt is required. */ }
  }
  assert(JSON.parse(row.definition).runtime_digest === runtimeDigest, '실행을 시작한 하네스 버전에서 재개해야 합니다.', 409);
  // First release restarts the frozen request in a new workspace, never reuses unverified partial writes.
  update(runId, { status: 'pending', epoch: row.epoch + 1, round: 0, stage: null, message: null, artifact: null });
  const definition = JSON.parse(row.definition), request = JSON.parse(row.request);
  if (request.task === 'checks.run') saveEvidence(db, dir, initialEvidence(get(runId), definition.check_profile, request.input.profile));
  schedule(); return view(get(runId));
}
db.prepare("UPDATE workflow_steps SET status='interrupted',reason='service_restart' WHERE status='running'").run();
for (const row of db.prepare("SELECT * FROM runs WHERE status='running'").all()) {
  if (JSON.parse(row.request).task === 'checks.run') {
    try {
      const evidence = readEvidence(db, dir, row).data;
      for (const check of evidence.checks) if (check.status === 'running') check.status = 'unknown';
      evidence.overall = 'incomplete'; saveEvidence(db, dir, evidence);
    } catch { /* Missing evidence is not reconstructed as a successful command. */ }
  }
  update(row.id, { status: 'interrupted', message: '실행 서비스 중단 후 상태 대조가 필요합니다.' });
}
const { server, endpoint } = await serve({ dir, role: 'runtime', port: Number(process.env.HARNESS_RUNTIME_PORT || 0), handler: async (req, url) => {
  if (req.method === 'GET' && url.pathname === '/health') return { role: 'execution', version: definitions.version, active: running.size };
  if (req.method === 'GET' && url.pathname === '/catalog') return {
    version: definitions.version, jobs: Object.entries(definitions.jobs).map(([id, job]) => ({ id, label: job.label, workflow: job.workflow, input_schema: job.input_schema })),
    task_types: taskTypes, workflows, check_profiles: Object.entries(profiles).map(([id, p]) => ({ id, label: p.label, validation_scope: p.validation_scope })) };
  if (req.method === 'GET' && url.pathname === '/events') {
    const after = Number(url.searchParams.get('after') || 0); assert(Number.isSafeInteger(after) && after >= 0, '잘못된 커서입니다.');
    const rows = db.prepare('SELECT * FROM outbox WHERE seq>? ORDER BY seq LIMIT 500').all(after);
    return { events: rows.map(r => JSON.parse(r.payload)), cursor: rows.at(-1)?.seq || after };
  }
  if (req.method === 'POST' && url.pathname === '/runs') return create(await body(req));
  if (req.method === 'GET' && url.pathname === '/runs') return db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all().map(view);
  const match = url.pathname.match(/^\/runs\/([^/]+)(?:\/(cancel|resume|evidence))?$/);
  if (match) {
    if (req.method === 'POST' && match[2] === 'cancel') return cancel(match[1]);
    if (req.method === 'POST' && match[2] === 'resume') return resume(match[1]);
    if (req.method === 'GET') {
      const row = get(match[1]); assert(row, '실행이 없습니다.', 404);
      if (match[2] === 'evidence') return readEvidence(db, dir, row);
      const request = JSON.parse(row.request);
      return { ...view(row), request: { task: request.task, input: request.input },
        steps: db.prepare('SELECT * FROM workflow_steps WHERE run_id=? ORDER BY epoch,sequence').all(row.id).map(step => ({ ...step, outcome: step.outcome ? JSON.parse(step.outcome) : null })),
        attempts: db.prepare('SELECT id,stage,round,status,pid,started_at,ended_at,directory FROM attempts WHERE run_id=? ORDER BY started_at').all(row.id) };
    }
  }
  assert(false, 'API를 찾을 수 없습니다.', 404);
} });
console.log(json({ ready: true, role: 'runtime', ...endpoint })); schedule();
function stop() {
  if (shuttingDown) return; shuttingDown = true;
  for (const [runId, processRun] of running) { update(runId, { status: 'interrupted', message: '실행 서비스가 종료되었습니다.' }); processRun.cancel(); }
  server.close(); setTimeout(() => process.exit(0), 750).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
