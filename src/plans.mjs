import fs from 'node:fs';
import { ROOT, assert, id, stableId, now, json, digest, transaction, redactExecutionRequest } from './shared.mjs';
import { validateSchema, canonicalJson } from './schema.mjs';
import { parseCodeBundle, validateCodeInput } from './code-bundle.mjs';
import { executionInputDigest } from './artifact-handoff.mjs';
import { isMergedWorkItemRetry } from './agent-origin.mjs';

const schema = JSON.parse(fs.readFileSync(`${ROOT}/contracts/plan-request.schema.json`, 'utf8'));
const terminalStates = new Set(['completed', 'blocked', 'failed', 'cancelled', 'interrupted']);

// A plan owns scheduling, while each run retains its frozen workflow, gates and attempt history.
export function planOrchestrator({ db, dir, jobs, workflows, prepare, register, getRun, cancelRun, resumeRun, canResume, emitIO, schedule }) {
  db.exec(`CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,status TEXT NOT NULL,payload TEXT NOT NULL,
    request_digest TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,message TEXT);
    CREATE TABLE IF NOT EXISTS plan_steps(plan_id TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,
    prepared TEXT NOT NULL,run_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',message TEXT,
    PRIMARY KEY(plan_id,id),UNIQUE(run_id),FOREIGN KEY(plan_id) REFERENCES plans(id));`);
  const get = planId => db.prepare('SELECT * FROM plans WHERE id=?').get(planId);
  const rows = planId => db.prepare('SELECT * FROM plan_steps WHERE plan_id=? ORDER BY position').all(planId);
  const payload = row => JSON.parse(row.payload);
  function view(planId) {
    const plan = get(planId); assert(plan, '계획이 없습니다.', 404);
    const input = payload(plan);
    const steps = rows(planId).map(row => {
      const run = getRun(row.run_id), step = input.steps[row.position], prepared = JSON.parse(row.prepared);
      return { id: row.id, task: step.task, label: prepared.definition.job.label, output_key: step.output_key,
        depends_on: step.depends_on, request_excerpt: step.request_excerpt,
        review: prepared.definition.review_decision || null,
        status: run?.status || row.status, stage: run?.stage || null, run_id: run?.id || null,
        artifact: run?.status === 'completed' ? run.artifact : null, message: run?.message || row.message || null };
    });
    const progress = Object.fromEntries(['completed', 'running', 'pending', 'blocked', 'failed', 'cancelled', 'interrupted'].map(state => [state, steps.filter(step => step.status === state).length]));
    return { id: plan.id, status: plan.status, work_item_id: input.work_item_id, origin: input.origin, workspace: input.workspace || null,
      created_at: plan.created_at, updated_at: plan.updated_at, message: plan.message, steps,
      progress: { total: steps.length, ...progress },
      artifacts: steps.filter(step => step.artifact).map(step => ({ step_id: step.id, task: step.task, output_key: step.output_key, ...step.artifact })) };
  }
  function checkGraph(input) {
    const byId = new Map(input.steps.map(step => [step.id, step]));
    assert(byId.size === input.steps.length, '계획의 작업 ID가 중복됩니다.');
    const outputs = input.steps.map(step => step.output_key.trim().normalize('NFC').toLowerCase());
    assert(new Set(outputs).size === outputs.length, '산출물마다 하나의 담당 작업만 지정하세요. output_key가 중복됩니다.');
    const signatures = new Set();
    for (const step of input.steps) {
      assert(Object.hasOwn(jobs, step.task), `지원하지 않는 업무입니다: ${step.task}`);
      assert(workflows[jobs[step.task].workflow].mode === 'artifact' && !jobs[step.task].allow_internal, '계획에는 사용자 산출물 업무만 지정할 수 있습니다. 검사 실행과 보고서는 별도로 요청하세요.');
      assert(input.prompt.includes(step.request_excerpt), '각 작업에는 원래 요청의 정확한 인용 request_excerpt가 필요합니다.');
      assert(step.depends_on.every(dep => dep !== step.id && byId.has(dep)), '선행 작업이 없거나 자기 자신을 참조합니다.');
      const signature = canonicalJson({ task: step.task, input: step.input, input_files: step.input_files || [], depends_on: [...step.depends_on].sort() });
      assert(!signatures.has(signature), '동일 입력의 같은 업무를 중복 예약할 수 없습니다.'); signatures.add(signature);
    }
    const ancestors = new Map(), visiting = new Set();
    function visit(stepId) {
      assert(!visiting.has(stepId), '작업 의존성에 순환이 있습니다.');
      if (ancestors.has(stepId)) return ancestors.get(stepId);
      visiting.add(stepId); const found = new Set();
      for (const dep of byId.get(stepId).depends_on) { found.add(dep); for (const predecessor of visit(dep)) found.add(predecessor); }
      visiting.delete(stepId); ancestors.set(stepId, found); return found;
    }
    input.steps.forEach(step => visit(step.id));
    // Ordered edits overlay exact file names. Reject aliases before starting a
    // predecessor that would make a later source snapshot invalid on macOS.
    const spellings = new Map();
    for (const step of input.steps) {
      if (jobs[step.task].kind !== 'code_bundle') continue;
      const paths = [
        ...(Array.isArray(step.input.allowed_paths) ? step.input.allowed_paths : []),
        ...(Array.isArray(step.input.source_files) ? step.input.source_files.map(file => file?.path) : [])
      ];
      for (const file of paths) {
        if (typeof file !== 'string') continue; // Per-job schemas validate shapes below.
        const key = file.normalize('NFC').toLowerCase();
        assert(!spellings.has(key) || spellings.get(key) === file,
          `계획의 코드 경로 대소문자 또는 문자 정규화가 다릅니다: ${file}`);
        spellings.set(key, file);
      }
    }
    // Two independent bundles cannot both own the same eventual project path.
    for (let i = 0; i < input.steps.length; i++) for (let j = i + 1; j < input.steps.length; j++) {
      const a = input.steps[i], b = input.steps[j];
      const pathsOf = step => Array.isArray(step.input.allowed_paths) ? step.input.allowed_paths.filter(file => typeof file === 'string').map(file => file.normalize('NFC').toLowerCase()) : [];
      const paths = new Set(pathsOf(a)), bPaths = pathsOf(b);
      const overlap = bPaths.some(file => paths.has(file));
      assert(!bPaths.some(file => [...paths].some(other => file.startsWith(`${other}/`) || other.startsWith(`${file}/`))),
        '서로 다른 작업의 코드 파일과 디렉터리 경로가 충돌합니다.');
      assert(!overlap || ancestors.get(a.id).has(b.id) || ancestors.get(b.id).has(a.id), '같은 코드 경로를 소유하는 작업은 의존 순서를 지정하거나 하나로 합치세요.');
    }
    return ancestors;
  }
  async function create(raw) {
    const input = redactExecutionRequest(raw);
    // These are filesystem identities, not prose. The runtime validates their
    // paths and source contents; text redaction must not silently rename them.
    if (raw?.workspace !== undefined) input.workspace = raw.workspace;
    if (Array.isArray(raw?.steps)) raw.steps.forEach((step, index) => {
      if (step?.input_files !== undefined) input.steps[index].input_files = step.input_files;
    });
    validateSchema(schema, input, '작업 계획');
    const requestDigest = digest(canonicalJson(input));
    const planId = input.idempotency_key ? stableId('plan-', input.idempotency_key) : id('plan-');
    const prior = get(planId);
    if (prior) {
      assert(prior.request_digest === requestDigest || await isMergedWorkItemRetry(dir, input,
        payload(prior).work_item_id, prior.request_digest), '같은 계획 요청 키에 다른 입력이 있습니다.', 409);
      return view(planId);
    }
    checkGraph(input);
    input.record_io = !input.origin;
    input.origin ||= { engine: 'harness', agent_session_id: id('cli-'), turn_id: id('turn-') };
    input.work_item_id ||= stableId('item-', stableId('agent-', `${input.origin.engine}:${input.origin.agent_session_id}`));
    // Validate and freeze every contract and local model preference before any child can start.
    const prepared = input.steps.map(step => prepare({ task: step.task, input: step.input,
      ...(input.engine ? { engine: input.engine } : {}), ...(input.fixture ? { fixture: input.fixture } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}), ...(step.input_files ? { input_files: step.input_files } : {}),
      ...(step.review ? { review: step.review } : {}),
      origin: input.origin, work_item_id: input.work_item_id }, { runId: stableId('run-', `${planId}:${step.id}`), planId }));
    if (input.workspace) input.workspace = prepared[0].request.workspace;
    transaction(db, () => {
      db.prepare('INSERT INTO plans VALUES(?,?,?,?,?,?,?)').run(planId, 'pending', json(input), requestDigest, now(), now(), null);
      for (let i = 0; i < prepared.length; i++) db.prepare('INSERT INTO plan_steps(plan_id,id,position,prepared,run_id) VALUES(?,?,?,?,?)')
        .run(planId, input.steps[i].id, i, json(prepared[i]), prepared[i].runId);
      // One user input/output pair per plan; child runs remain visible as execution events.
      if (!raw.origin) emitIO(input, `input-${planId}`, 'input', input.prompt);
    });
    queueMicrotask(schedule); return view(planId);
  }
  function setStatus(plan, status, message) {
    if (plan.status === status && plan.message === message) return;
    db.prepare('UPDATE plans SET status=?,updated_at=?,message=? WHERE id=?').run(status, now(), message, plan.id);
    if (payload(plan).record_io && terminalStates.has(status) && plan.status !== status) emitIO(payload(plan), `terminal-${plan.id}-${id()}`,
      status === 'completed' ? 'output' : ['cancelled', 'interrupted'].includes(status) ? 'turn.interrupted' : 'turn.failed', message);
  }
  function verifiedArtifactBytes(artifact, message, status = 400) {
    assert(artifact, message, status);
    let bytes;
    for (const file of new Set([artifact.file, ...(artifact.output_file ? [artifact.output_file] : [])])) {
      let content;
      try { content = fs.readFileSync(file); } catch { assert(false, message, status); }
      assert(digest(content) === artifact.content_digest, message, status);
      if (file === artifact.file) bytes = content;
    }
    return bytes;
  }
  function sourcesFor(plan, step, allRows) {
    const input = payload(plan), byId = new Map(input.steps.map(value => [value.id, value]));
    const ordered = [], visited = new Set();
    function add(dep) { if (visited.has(dep)) return; visited.add(dep); byId.get(dep).depends_on.forEach(add); ordered.push(dep); }
    step.depends_on.forEach(add);
    const sources = ordered.map(dep => {
      const row = allRows.find(value => value.id === dep), run = getRun(row.run_id);
      assert(run?.status === 'completed' && run.artifact, '선행 작업의 검증된 산출물이 없습니다.');
      const bytes = verifiedArtifactBytes(run.artifact, '선행 산출물이 검증 후 변경되었거나 없어졌습니다.');
      return { step_id: dep, task: byId.get(dep).task, output_key: byId.get(dep).output_key, output_file: run.artifact.output_file || run.artifact.file,
        content_digest: run.artifact.content_digest, content: bytes.toString('utf8') };
    });
    assert(Buffer.byteLength(json(sources)) <= 2 * 1024 * 1024, '선행 자료가 입력 한도를 초과했습니다. 요청 산출물 범위를 나누어 다시 요청하세요.');
    return sources;
  }
  let ticking = false;
  function tick() {
    if (ticking) return; ticking = true;
    try {
      for (const plan of db.prepare("SELECT * FROM plans WHERE status IN ('pending','running') ORDER BY created_at").all()) {
        const input = payload(plan), allRows = rows(plan.id);
        if (allRows.some(row => getRun(row.run_id)?.status === 'interrupted')) {
          setStatus(plan, 'interrupted', '실행 서비스 중단 후 기존 작업 상태를 확인하고 계획을 재개하세요.'); continue;
        }
        const ordered = [], visited = new Set();
        const order = row => {
          if (visited.has(row.id)) return; visited.add(row.id);
          input.steps[row.position].depends_on.forEach(dep => order(allRows.find(value => value.id === dep)));
          ordered.push(row);
        };
        allRows.forEach(order);
        for (const row of ordered) {
          if (getRun(row.run_id) || row.status !== 'pending') continue;
          const step = input.steps[row.position], deps = step.depends_on.map(dep => {
            const predecessor = allRows.find(value => value.id === dep);
            return getRun(predecessor.run_id)?.status || predecessor.status;
          });
          if (deps.some(status => terminalStates.has(status) && status !== 'completed')) {
            row.status = 'blocked';
            db.prepare('UPDATE plan_steps SET status=?,message=? WHERE plan_id=? AND id=?')
              .run('blocked', '선행 작업이 완료되지 않아 시작하지 않았습니다.', plan.id, row.id); continue;
          }
          if (!deps.every(status => status === 'completed')) continue;
          try {
            const prepared = JSON.parse(row.prepared);
            const upstream = sourcesFor(plan, step, allRows);
            // Sequential edits consume the preceding approved file content, never stale original code.
            if (prepared.definition.job.kind === 'code_bundle') {
              const sourceFiles = new Map(prepared.request.input.source_files.map(file => [file.path, file]));
              for (const source of upstream) {
                const sourcePrepared = JSON.parse(allRows.find(value => value.id === source.step_id).prepared);
                if (sourcePrepared.definition.job.kind !== 'code_bundle') continue;
                for (const file of parseCodeBundle(source.content, sourcePrepared.request.input).files) sourceFiles.set(file.path, file);
              }
              prepared.request.input.source_files = [...sourceFiles.values()];
              validateSchema(prepared.definition.job.input_schema, prepared.request.input, '선행 코드 입력');
              validateCodeInput(prepared.request.input);
              prepared.definition.request_digest = executionInputDigest(prepared.request, prepared.definition);
            }
            prepared.definition.upstream = upstream;
            prepared.definition.plan_scope = { request_excerpt: step.request_excerpt, output_key: step.output_key };
            db.prepare('UPDATE plan_steps SET prepared=? WHERE plan_id=? AND id=?').run(json(prepared), plan.id, row.id);
            row.prepared = json(prepared); register(prepared);
          } catch (e) {
            row.status = 'blocked';
            db.prepare('UPDATE plan_steps SET status=?,message=? WHERE plan_id=? AND id=?').run('blocked', e.message, plan.id, row.id);
          }
        }
        const snapshot = view(plan.id), statuses = snapshot.steps.map(step => step.status);
        if (statuses.every(status => status === 'completed')) {
          try {
            for (const result of snapshot.artifacts) verifiedArtifactBytes(result, '최종 산출물이 검증 후 변경되었거나 없어졌습니다.');
            setStatus(plan, 'completed', `${statuses.length}/${statuses.length}개 작업의 검증·검토를 완료했습니다.`);
          } catch (e) { setStatus(plan, 'blocked', e.message); }
        } else if (statuses.some(status => status === 'running' || status === 'pending')) setStatus(plan, 'running', null);
        else {
          const status = statuses.includes('interrupted') ? 'interrupted' : statuses.includes('failed') ? 'failed' : 'blocked';
          setStatus(plan, status, `${snapshot.progress.completed}/${statuses.length}개 완료. 미완료 작업의 사유를 확인하세요.`);
        }
      }
    } finally { ticking = false; }
  }
  function cancel(planId) {
    const plan = get(planId); assert(plan, '계획이 없습니다.', 404);
    if (['completed', 'cancelled'].includes(plan.status)) return view(planId);
    // Persist cancellation before cancelling children; later callbacks cannot start a waiting node.
    setStatus(plan, 'cancelled', '사용자가 계획을 취소했습니다.');
    for (const row of rows(planId)) {
      if (getRun(row.run_id)) cancelRun(row.run_id);
      else db.prepare("UPDATE plan_steps SET status='cancelled',message='계획 취소' WHERE plan_id=? AND id=?").run(planId, row.id);
    }
    return view(planId);
  }
  function resume(planId) {
    const plan = get(planId); assert(plan, '계획이 없습니다.', 404);
    assert(['blocked', 'failed', 'cancelled', 'interrupted'].includes(plan.status), '재개 가능한 계획 상태가 아닙니다.', 409);
    for (const row of rows(planId)) {
      const run = getRun(row.run_id);
      if (run?.status === 'completed') verifiedArtifactBytes(run.artifact,
        '완료 산출물이 변경되었거나 없어져 같은 계획을 재사용할 수 없습니다. 새 입력으로 요청하세요.', 409);
      if (run && run.status !== 'completed' && !['pending', 'running'].includes(run.status)) canResume(row.run_id);
    }
    // resumeRun enforces worker liveness and frozen runtime version, preserving completed branches.
    for (const row of rows(planId)) {
      const run = getRun(row.run_id);
      if (run && run.status !== 'completed' && !['pending', 'running'].includes(run.status)) resumeRun(row.run_id);
      if (!run) db.prepare("UPDATE plan_steps SET status='pending',message=NULL WHERE plan_id=? AND id=?").run(planId, row.id);
    }
    setStatus(plan, 'pending', null); queueMicrotask(schedule); return view(planId);
  }
  return { create, view, tick, cancel, resume,
    canSchedule: planId => ['pending', 'running'].includes(get(planId)?.status),
    list: () => db.prepare('SELECT id FROM plans ORDER BY created_at DESC').all().map(row => view(row.id)) };
}
