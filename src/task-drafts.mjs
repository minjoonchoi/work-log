import fs from 'node:fs';
import path from 'node:path';
import { assert, digest, stableId } from './shared.mjs';
import { parseTaskTypeDraft } from './task-type-draft.mjs';
import { artifact } from './verifier.mjs';

// Setup drafts use the ordinary persisted executor, but never mutate the task
// registry. Only the existing, explicit custom-task registration endpoint does.
export function taskDrafts({ settings, createRun, getRun, cancelRun }) {
  const task = 'task.type.draft';
  function rowFor(id) {
    const row = getRun(id);
    assert(row, '등록 내용 작성 작업을 찾을 수 없습니다.', 404);
    const request = JSON.parse(row.request);
    assert(request.task === task && request.internal, '등록 내용 작성 작업이 아닙니다.', 404);
    return { row, request };
  }
  function detail(id) {
    const { row, request } = rowFor(id);
    const result = { id: row.id, status: row.status, message: row.message, draft: null };
    if (row.status !== 'completed') return result;
    try {
      const publication = JSON.parse(row.artifact);
      assert(publication?.file && publication.content_digest, '등록 초안의 검증 근거가 없습니다.');
      const subject = artifact(path.dirname(publication.file), path.basename(publication.file));
      assert(subject.content_digest === publication.content_digest, '검증 후 등록 초안이 변경되었습니다.');
      result.draft = parseTaskTypeDraft(subject.bytes.toString('utf8'), request.input);
    } catch (error) {
      // Never prefill unverified or subsequently edited output, even when the
      // original generation run completed successfully.
      result.status = 'failed'; result.message = error.message;
    }
    return result;
  }
  function create(input) {
    assert(input && typeof input === 'object' && !Array.isArray(input)
      && Object.keys(input).every(key => ['request', 'idempotency_key'].includes(key)), '등록 내용 작성 요청 형식이 잘못되었습니다.');
    assert(typeof input.request === 'string' && input.request.trim() && input.request.length <= 12000, '만들 작업의 설명을 1~12000자로 입력하세요.');
    assert(typeof input.idempotency_key === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(input.idempotency_key), '등록 내용 작성 요청 키가 필요합니다.');
    const key = `task-type-draft:${input.idempotency_key}`, id = stableId('run-', key), sourceDigest = digest(input.request);
    if (getRun(id)) {
      const { request } = rowFor(id);
      assert(request.origin.turn_id === sourceDigest, '같은 작성 요청 키에 다른 설명이 있습니다.', 409);
      return detail(id);
    }
    const fixture = process.env.HARNESS_TEST_MODE === '1' ? {
      engine: 'fixture', fixture: { scenario: process.env.HARNESS_TEST_TASK_DRAFT_SCENARIO || 'success',
        delayMs: Number(process.env.HARNESS_TEST_TASK_DRAFT_DELAY_MS || 0) }
    } : {};
    const run = createRun({ task, internal: true, idempotency_key: key,
      origin: { engine: 'harness', agent_session_id: 'task-type-drafts', turn_id: sourceDigest },
      input: settings.draftInput(input.request), ...fixture });
    return detail(run.id);
  }
  function cancel(id) { rowFor(id); cancelRun(id); return detail(id); }
  return { create, detail, cancel };
}
