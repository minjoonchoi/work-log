import { assert, digest, readEndpoint, request } from './shared.mjs';
import { canonicalJson } from './schema.mjs';

function contextError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function unavailable(error) {
  return error.name === 'TimeoutError'
    || ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error.cause?.code);
}

async function managerContext(dir, endpoint) {
  try {
    return await request(dir, 'manager', endpoint, { signal: AbortSignal.timeout(1500) });
  } catch (error) {
    if ((error.status === 503 && !readEndpoint(dir, 'manager')) || unavailable(error)) {
      throw contextError('agent_context_unavailable', '현재 에이전트 세션의 업무 연결 정보를 조회할 수 없습니다. WorkLog 관리 서비스를 확인한 뒤 다시 실행하세요.');
    }
    throw error;
  }
}

// Read only observed hook data. Collection failure is not a missing preference
// and must never be repaired by inventing a prompt, turn, or standalone item.
export async function inspectAgentContext(dir, { engine = 'codex', session_id } = {}) {
  session_id ??= engine === 'codex' ? process.env.CODEX_THREAD_ID : undefined;
  if (!['codex', 'claude'].includes(engine) || typeof session_id !== 'string' || !session_id.trim())
    throw contextError('agent_identity_unavailable', '원본 에이전트 세션 식별자가 없습니다. 실제 세션 ID를 확인해야 하며 새 ID를 만들지 마세요.');
  let context;
  try {
    context = await managerContext(dir, `/api/agent-context?${new URLSearchParams({ engine, session_id })}`);
  } catch (error) {
    if (error.status === 404) throw contextError('agent_input_unobserved',
      '현재 원본 입력을 확인할 수 없습니다. WorkLog 연결 설정의 이력 수집과 Codex/Claude 훅 수신 상태를 확인하세요. 분석 관점이나 작업 내용에 대한 질문으로 해결할 수 없습니다.');
    throw error;
  }
  assert(context && typeof context.work_item_id === 'string' && context.work_item_id.trim(),
    '에이전트의 현재 업무 연결 정보를 확인할 수 없습니다.');
  if (!context.origin) throw contextError('agent_input_unobserved',
    '현재 원본 입력을 확인할 수 없습니다. 현재 요청의 입력 훅이 수집되었는지 확인하세요. 이미 받은 작업 요구나 답변을 다시 묻지 마세요.');
  const { engine: sourceEngine, agent_session_id: sourceSession, turn_id: turn } = context.origin;
  assert(sourceEngine === engine && sourceSession === session_id && typeof turn === 'string' && turn.trim(),
    '에이전트의 현재 원본 입력 연결 정보가 일치하지 않습니다.');
  return { work_item_id: context.work_item_id, origin: { engine: sourceEngine, agent_session_id: sourceSession, turn_id: turn } };
}

// A merge may change only the owning item in an otherwise identical accepted
// declaration. Preserve its original digest and verify both aliases with the
// manager; an unavailable or unrelated owner is never an idempotent retry.
export async function isMergedWorkItemRetry(dir, input, originalOwner, originalDigest) {
  if (typeof input.work_item_id !== 'string' || !input.work_item_id.trim()
    || typeof originalOwner !== 'string' || !originalOwner.trim() || input.work_item_id === originalOwner) return false;
  if (digest(canonicalJson({ ...input, work_item_id: originalOwner })) !== originalDigest) return false;
  try {
    const identities = await Promise.all([originalOwner, input.work_item_id].map(item =>
      managerContext(dir, `/api/items/${encodeURIComponent(item)}/identity`)));
    return typeof identities[0]?.id === 'string' && identities[0].id.length > 0 && identities[0].id === identities[1]?.id;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

// Only the manager's observed user input can bind a CLI request to a native turn.
// Explicit origins and standalone CLI requests retain their existing behavior.
export async function attachAgentOrigin(dir, payload) {
  if (Object.hasOwn(payload, 'origin')) return payload;
  const sessionId = process.env.CODEX_THREAD_ID;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return payload;
  const context = await inspectAgentContext(dir, { engine: 'codex', session_id: sessionId });
  const { engine, agent_session_id: agentSessionId, turn_id: turnId } = context.origin;
  assert(engine === 'codex' && agentSessionId === sessionId && typeof turnId === 'string' && turnId.trim(),
    '에이전트의 현재 원본 입력 연결 정보가 일치하지 않습니다.');
  if (payload.work_item_id !== undefined && payload.work_item_id !== context.work_item_id) {
    assert(typeof payload.work_item_id === 'string' && payload.work_item_id.trim(), '업무 식별자를 확인하세요.');
    let identity;
    try { identity = await managerContext(dir, `/api/items/${encodeURIComponent(payload.work_item_id)}/identity`); }
    catch (error) { if (error.status !== 404) throw error; }
    assert(identity?.id === context.work_item_id, '현재 에이전트 세션과 다른 업무를 지정할 수 없습니다.');
  }
  return { ...payload, origin: { engine, agent_session_id: agentSessionId, turn_id: turnId }, work_item_id: context.work_item_id };
}
