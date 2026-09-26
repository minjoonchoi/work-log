import fs from 'node:fs';
import path from 'node:path';
import { assert, digest, json, now } from './shared.mjs';
import { artifact } from './verifier.mjs';
import { validateSchema } from './schema.mjs';
import { validateResult } from './executor.mjs';

// A cursor references accepted outputs, never a worker's unfinished workspace.
// The runtime commits it with the successful workflow transition. Failed stages
// leave the previous cursor intact so an explicit resume retries just that stage.
export function workflowCheckpoints(db, dir) {
  function proof(run, definition, attemptId, stages) {
    const attempt = db.prepare('SELECT * FROM attempts WHERE id=? AND run_id=?').get(attemptId, run.id);
    assert(attempt && stages.includes(attempt.stage) && attempt.status === 'returned', '재개할 산출물의 실행 근거가 없습니다.', 409);
    assert(attempt.directory === path.join(dir, 'runs', run.id, attempt.id), '재개할 실행 경로가 일치하지 않습니다.', 409);
    const result = JSON.parse(attempt.result);
    assert(result.ok, '재개할 작업의 성공 근거가 없습니다.', 409);
    validateSchema(definition.response_schema, result.result, '재개할 작업 응답');
    assert(validateResult(result.result, attempt.stage, definition.job).status === 'done', '재개할 작업 결과가 완료되지 않았습니다.', 409);
    return attempt;
  }
  function save(run, state, stoppedReason = null) {
    const { candidate, ...cursor } = state;
    let reference = null;
    if (candidate) {
      const { bytes, ...fields } = candidate;
      reference = { ...fields, ...(candidate.report ? { report_digest: digest(fs.readFileSync(candidate.report)) } : {}) };
    }
    db.prepare(`INSERT INTO workflow_checkpoints(run_id,definition_digest,cursor,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET definition_digest=excluded.definition_digest,cursor=excluded.cursor,updated_at=excluded.updated_at`)
      .run(run.id, run.definition_digest, json({ ...cursor, candidate: reference, stopped_reason: stoppedReason }), now());
  }
  function load(run, definition) {
    if (definition.workflow.mode !== 'artifact') return null;
    const saved = db.prepare('SELECT * FROM workflow_checkpoints WHERE run_id=?').get(run.id);
    if (!saved) {
      assert(!db.prepare("SELECT id FROM workflow_steps WHERE run_id=? AND status='completed' LIMIT 1").get(run.id), '기존 실행의 재개 지점이 없습니다. 생성부터 자동 반복하지 않습니다.', 409);
      return null;
    }
    assert(saved.definition_digest === run.definition_digest, '재개할 작업 정의가 변경되었습니다.', 409);
    const cursor = JSON.parse(saved.cursor), workflow = definition.workflow;
    assert(!cursor.stopped_reason, '수정 또는 단계 한도에 도달한 실행은 같은 입력으로 재개할 수 없습니다.', 409);
    assert(Object.hasOwn(workflow.nodes, cursor.nodeId) && Number.isInteger(cursor.sequence) && cursor.sequence >= 0
      && cursor.sequence < workflow.max_steps && Number.isInteger(cursor.budgets?.repairs)
      && cursor.budgets.repairs >= 0 && cursor.budgets.repairs <= definition.limits.maxRepairs && Array.isArray(cursor.issues), '재개 지점이 유효하지 않습니다.', 409);
    if (cursor.candidate) {
      const candidate = cursor.candidate;
      const producer = proof(run, definition, candidate.generation_attempt, ['produce', 'plan', 'repair']);
      assert(candidate.directory === producer.directory && candidate.cwd === path.join(producer.directory, 'workspace'), '재개할 산출물 경로가 다릅니다.', 409);
      const current = artifact(candidate.cwd, definition.job.file);
      assert(current.content_digest === candidate.content_digest && current.path === candidate.path, '재개할 산출물이 변경되었습니다. 자동 재생성하지 않습니다.', 409);
      assert(fs.readdirSync(candidate.cwd).every(file => file === definition.job.file), '재개할 산출물 작업 공간의 범위가 변경되었습니다.', 409);
      if (candidate.report) {
        assert(candidate.report === path.join(producer.directory, 'verification.json'), '재개할 검사 경로가 다릅니다.', 409);
        const bytes = fs.readFileSync(candidate.report), report = JSON.parse(bytes);
        assert(digest(bytes) === candidate.report_digest && report.subject_digest === candidate.content_digest, '재개할 검사 근거가 변경되었습니다.', 409);
        assert(candidate.verified === (report.passed ? candidate.content_digest : null), '재개할 검사 판정이 다릅니다.', 409);
      } else assert(!candidate.verified && !candidate.review, '재개할 필수 검사 근거가 없습니다.', 409);
      if (candidate.review) {
        proof(run, definition, candidate.review.attempt, ['review']);
        assert(candidate.verified === candidate.content_digest && candidate.review.digest === candidate.content_digest, '재개할 검토 대상이 다릅니다.', 409);
      }
      cursor.candidate = { ...candidate, ...current };
    } else assert(cursor.nodeId === workflow.initial, '재개할 선행 산출물이 없습니다.', 409);
    return cursor;
  }
  return { save, load };
}
