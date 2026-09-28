import { request } from './shared.mjs';

// A read-only projection: never reserve work items or submit work from this view.
export async function taskQueue(dir, writings) {
  let runs = [], plans = [], runtimeConnected = true;
  try { ({ runs, plans } = await request(dir, 'runtime', '/task-queue', { signal: AbortSignal.timeout(2000) })); }
  catch { runtimeConnected = false; }
  const active = state => ['pending', 'running'].includes(state);
  const rows = runs.filter(run => active(run.status)).map(run => ({
    id: run.id, task: run.task, status: run.status, stage: run.stage,
    kind: run.internal ? 'internal' : 'user', created_at: run.created_at, message: run.message || ''
  }));
  for (const row of writings.pending()) {
    if (row.run_id && runtimeConnected) continue;
    rows.push({ id: row.operation_id, task: row.task, status: !runtimeConnected && row.run_id ? 'unknown' : 'pending', stage: null,
      kind: 'internal', created_at: row.created_at,
      message: row.source === 'automatic' && row.format === 'session-summary' && !writings.automationSettings().session_summary_enabled
        ? '자동 요약 꺼짐 · 다시 켜면 재개' : '실행 서비스 접수 대기' });
  }
  for (const plan of plans.filter(plan => active(plan.status))) for (const step of plan.steps) {
    if (step.run_id || !active(step.status)) continue;
    rows.push({ id: `${plan.id}:${step.id}`, task: step.task, status: 'pending', stage: null, kind: 'user', created_at: plan.created_at,
      message: step.depends_on.length ? '선행 작업 완료 대기' : '실행 준비 대기' });
  }
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return { runtime_connected: runtimeConnected, observed_at: new Date().toISOString(), rows };
}
