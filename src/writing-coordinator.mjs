import fs from 'node:fs';
import path from 'node:path';
import { assert, request, digest, stableId } from './shared.mjs';
import { parseTextRewrite } from './text-rewrite.mjs';
import { parseSessionSummary } from './session-summary.mjs';

export function writingCoordinator({ dir, writings, notify, automatic = true, automaticMetadata = true, fixture = false }) {
  let busy = false;
  const automaticSummary = row => row.source === 'automatic' && row.format === 'session-summary';
  async function cancelSuperseded() {
    for (const { run_id } of writings.cancellations()) {
      try {
        const run = await request(dir, 'runtime', `/runs/${run_id}`);
        // Cancel only this coordinator's internal work, never a user-requested run.
        if (run.internal && run.origin?.engine === 'harness-writing' && ['pending', 'running', 'interrupted'].includes(run.status))
          await request(dir, 'runtime', `/runs/${run_id}/cancel`, { method: 'POST', body: {} });
        writings.cancelled(run_id);
      } catch (error) {
        if (error.status === 404) writings.cancelled(run_id);
        // Persist the intention across unavailable runtime and manager restarts.
      }
    }
  }
  async function processRow(row) {
    try {
      if (row.state === 'pending') {
        // Older accepted submissions carried the source engine. Recover a
        // lost receipt before submitting the new settings-driven declaration.
        if (row.snapshot.engine) {
          try {
            const existing = await request(dir, 'runtime', `/runs/${stableId('run-', row.run_key)}`);
            assert(existing.internal && existing.origin?.engine === 'harness-writing' && existing.origin.agent_session_id === row.operation_id,
              '기존 작성 실행의 소유권이 다릅니다.', 409);
            writings.started(row, existing.id); notify(); return;
          } catch (error) { if (error.status !== 404) throw error; }
        }
        const run = await request(dir, 'runtime', '/runs', { method: 'POST', body: {
          task: row.task, input: row.task === 'session.summarize' ? row.snapshot.session.source : row.snapshot.input,
          ...(fixture ? { engine: 'fixture' } : {}), internal: true, work_item_id: row.snapshot.work_item_id,
          origin: { engine: 'harness-writing', agent_session_id: row.operation_id, turn_id: row.operation_id },
          idempotency_key: row.run_key,
          ...(fixture ? { fixture: JSON.parse(process.env.HARNESS_TEST_WRITING_FIXTURE || '{}') } : {})
        } });
        writings.started(row, run.id); notify(); return;
      }
      const run = await request(dir, 'runtime', `/runs/${row.run_id}`);
      if (run.status === 'completed') {
        const file = fs.realpathSync(run.artifact.file), root = fs.realpathSync(path.join(dir, 'runs', run.id, 'artifacts')) + path.sep;
        assert(file.startsWith(root), '재작성 산출물 경로가 잘못되었습니다.');
        const bytes = fs.readFileSync(file); assert(digest(bytes) === run.artifact.content_digest, '검증 후 재작성 산출물이 변경되었습니다.');
        const result = row.task === 'session.summarize' ? parseSessionSummary(bytes.toString('utf8')) : parseTextRewrite(bytes.toString('utf8'), row.format);
        writings.finish(row, 'completed', result); notify();
      } else if (!['pending', 'running'].includes(run.status)) {
        writings.finish(row, 'failed', null, run.message || '재작성을 완료하지 못했습니다. 기존 내용을 유지합니다.'); notify();
      }
    } catch (e) {
      // Runtime absence is recoverable. A rejected input or invalid final artifact is terminal.
      if ((e.status && e.status < 500) || e.code === 'ENOENT' || e instanceof SyntaxError) {
        writings.finish(row, 'failed', null, e.message); notify();
      }
    }
  }
  async function parallel(rows) {
    const results = await Promise.allSettled(rows.map(processRow));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  async function tick() {
    if (busy) return; busy = true;
    try {
      // Reconcile completed/obsolete requests before filling the timer's five
      // slots. Model execution is never awaited by the input hook.
      for (const row of writings.pending()) if (!writings.isCurrent(row)) { writings.finish(row, 'superseded'); notify(); }
      await cancelSuperseded();
      await parallel(writings.pending().filter(row => row.state === 'running'));
      if (writings.scheduleAutomatic({ summaries: automatic, metadata: automaticMetadata })) notify();
      await cancelSuperseded();
      const pending = writings.pending();
      const available = Math.max(0, 5 - pending.filter(row => row.state === 'running' && automaticSummary(row)).length - writings.cancellingSummaryCount());
      // Cap legacy queued batches as well as newly admitted periodic batches.
      await parallel(pending.filter(row => row.state === 'pending' && automaticSummary(row)).slice(0, available));
      for (const row of pending.filter(row => row.state === 'pending' && !automaticSummary(row))) await processRow(row);
    } finally { busy = false; }
  }
  return { tick };
}
