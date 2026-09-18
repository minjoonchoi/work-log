import fs from 'node:fs';
import path from 'node:path';
import { assert, request, digest } from './shared.mjs';
import { parseTextRewrite } from './text-rewrite.mjs';
import { parseSessionSummary } from './session-summary.mjs';

export function writingCoordinator({ dir, writings, notify, automatic = true, fixture = false }) {
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      if (automatic && writings.scheduleAutomatic()) notify();
      for (const row of writings.pending()) {
        if (!writings.isCurrent(row)) { writings.finish(row, 'superseded'); notify(); continue; }
        try {
          if (row.state === 'pending') {
            const run = await request(dir, 'runtime', '/runs', { method: 'POST', body: {
              task: row.task, input: row.task === 'session.summarize' ? row.snapshot.session.source : row.snapshot.input,
              engine: fixture ? 'fixture' : row.snapshot.engine, internal: true, work_item_id: row.snapshot.work_item_id,
              origin: { engine: 'harness-writing', agent_session_id: row.operation_id, turn_id: row.operation_id },
              idempotency_key: row.run_key,
              ...(fixture ? { fixture: JSON.parse(process.env.HARNESS_TEST_WRITING_FIXTURE || '{}') } : {})
            } });
            writings.started(row, run.id); notify(); continue;
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
    } finally { busy = false; }
  }
  return { tick };
}
