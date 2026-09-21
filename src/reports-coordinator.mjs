import fs from 'node:fs';
import path from 'node:path';
import { assert, request, digest } from './shared.mjs';
import { parseWorkReport } from './work-report.mjs';

export function reportsCoordinator({ dir, reports, notify, fixture = false }) {
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      if (reports.advance()) notify();
      let admitted = 0;
      for (const part of reports.pending()) {
        const report = reports.execution(part.report_id);
        if (!['pending', 'running'].includes(report.state)) continue;
        try {
          if (part.state === 'pending') {
            if (++admitted > 3) continue;
            const run = await request(dir, 'runtime', '/runs', { method: 'POST', body: {
              task: 'work.report.create', input: part.input, internal: true, work_item_id: report.owner_id,
              origin: { engine: 'harness-report', agent_session_id: part.id, turn_id: part.id }, idempotency_key: part.id,
              ...(fixture ? { engine: 'fixture', fixture: JSON.parse(process.env.HARNESS_TEST_REPORT_FIXTURE || '{}') } : {})
            } });
            reports.started(part.id, run.id); notify(); continue;
          }
          const run = await request(dir, 'runtime', `/runs/${part.run_id}`);
          if (run.status === 'completed') {
            const file = fs.realpathSync(run.artifact.file), root = fs.realpathSync(path.join(dir, 'runs', run.id, 'artifacts')) + path.sep;
            assert(file.startsWith(root), '업무 요약 산출물 경로가 잘못되었습니다.');
            const bytes = fs.readFileSync(file); assert(digest(bytes) === run.artifact.content_digest, '검증 후 업무 요약 산출물이 변경되었습니다.');
            reports.finish(part.id, 'completed', parseWorkReport(bytes.toString('utf8'), part.input)); notify();
          } else if (!['pending', 'running'].includes(run.status)) {
            reports.finish(part.id, 'failed', null, run.message || `업무 요약 실행이 ${run.status} 상태로 종료되었습니다.`); notify();
          }
        } catch (error) {
          if ((error.status && error.status < 500) || error.code === 'ENOENT' || error instanceof SyntaxError) {
            reports.finish(part.id, 'failed', null, error.message); notify();
          }
        }
      }
      if (reports.advance()) notify();
      for (const part of reports.aborting()) {
        try {
          const run = await request(dir, 'runtime', `/runs/${part.run_id}`);
          if (['pending', 'running'].includes(run.status)) await request(dir, 'runtime', `/runs/${part.run_id}/cancel`, { method: 'POST', body: {} });
          reports.aborted(part.id); notify();
        } catch { /* Reconnect before settling a sibling process; never cancel unrelated user runs. */ }
      }
    } finally { busy = false; }
  }
  return { tick };
}
