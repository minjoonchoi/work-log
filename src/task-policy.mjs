import { assert } from './shared.mjs';

// Trusted catalog policy, inherited by custom tasks from their template. Neither
// request text nor a local instruction override can increase these limits.
export function taskPolicy(job, workflow, limits) {
  const checked = workflow.review_required === false;
  const direct = checked || job.worker_mode === 'direct';
  const stage = { mode: direct ? 'direct' : 'artifact',
    max_tool_calls: direct ? 0 : job.kind === 'code_bundle' || job.kind === 'html' ? 64 : 24,
    max_model_turns: direct ? 1 : job.kind === 'code_bundle' || job.kind === 'html' ? 65 : 25 };
  return {
    ...stage,
    max_agent_attempts: checked ? 1 : 2 + 2 * limits.maxRepairs,
    max_repairs: checked ? 0 : limits.maxRepairs,
    stages: Object.fromEntries(Object.values(workflow.nodes).filter(node => ['produce', 'plan', 'review', 'repair'].includes(node.task))
      .map(node => [node.task, { ...stage }]))
  };
}

// Frozen runs without per-stage settings retain their original worker policy.
// Direct transport removes tools, not an independent review or repair gate.
export function workerStagePolicy(policy, stage) {
  if (policy == null) return null;
  const selected = policy.stages?.[stage] || policy;
  return { mode: selected.mode, max_tool_calls: selected.max_tool_calls, max_model_turns: selected.max_model_turns };
}

export const directResponseSchema = {
  type: 'object', additionalProperties: false, required: ['status', 'result'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    result: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { type: 'string', minLength: 1, maxLength: 500000 } } },
      { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: 5000 } } }
    ] }
  }
};

export function directContent(response) {
  const key = response.status === 'done' ? 'content' : 'message';
  assert(Object.keys(response.result).length === 1 && typeof response.result[key] === 'string' && response.result[key].trim(),
    `직접 응답의 ${response.status}에는 result.${key}가 필요합니다.`);
  return response.status === 'done' ? response.result.content : null;
}
