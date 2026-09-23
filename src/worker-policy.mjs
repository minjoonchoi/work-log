import { StringDecoder } from 'node:string_decoder';
import { assert } from './shared.mjs';

export function validateWorkerPolicy(policy) {
  if (policy == null) return null;
  assert(['direct', 'artifact'].includes(policy.mode), '알 수 없는 worker 실행 방식입니다.');
  assert(Number.isSafeInteger(policy.max_tool_calls) && policy.max_tool_calls >= 0 && policy.max_tool_calls <= 1000, 'worker 도구 호출 한도가 필요합니다.');
  assert(Number.isSafeInteger(policy.max_model_turns) && policy.max_model_turns >= 1 && policy.max_model_turns <= 1001, 'worker 모델 턴 한도가 필요합니다.');
  assert(policy.mode !== 'direct' || (policy.max_tool_calls === 0 && policy.max_model_turns === 1), '직접 생성은 도구 없이 한 번만 수행해야 합니다.');
  return { mode: policy.mode, max_tool_calls: policy.max_tool_calls, max_model_turns: policy.max_model_turns };
}

// These are invocation-only overrides, never writes to a user's Codex config.
// --ignore-user-config retains CODEX_HOME authentication. --strict-config makes
// unsupported configuration fail instead of silently weakening this profile.
export function codexDirectArguments() {
  const config = [
    'project_doc_max_bytes=0', 'skills.include_instructions=false', 'skills.bundled.enabled=false',
    'features.skip_host_skill_discovery=true', 'features.skill_search=false', 'features.skill_mcp_dependency_install=false',
    'features.plugins=false', 'features.remote_plugin=false', 'features.apps=false', 'orchestrator.mcp.enabled=false',
    'orchestrator.skills.enabled=false', 'agents.enabled=false', 'features.multi_agent=false', 'features.multi_agent_v2=false',
    'features.shell_tool=false', 'features.unified_exec=false', 'features.code_mode=false', 'features.code_mode_host=false',
    'features.browser_use=false', 'features.browser_use_external=false', 'features.computer_use=false',
    'features.image_generation=false', 'features.imagegenext=false', 'features.view_image=false',
    'features.js_repl=false', 'features.goals=false', 'features.sleep_tool=false', 'features.tool_suggest=false',
    'features.memories=false', 'features.memory_tool=false', 'tools.update_plan.enabled=false',
    'tools.experimental_request_user_input.enabled=false', 'web_search="disabled"'
  ];
  return ['--ignore-user-config', '--strict-config', '--ephemeral', ...config.flatMap(value => ['-c', value])];
}

const codexTools = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'collab_tool_call', 'tool_call', 'function_call']);

// A subprocess is not one model request. Codex's exec JSONL only exposes user
// turns, so its internal model-call count remains unknown. Tool limits below
// stop on observed events; they are not a sandbox or a pre-execution authorizer.
export function observeWorker(engine, policy) {
  const decoder = new StringDecoder('utf8'), toolIds = new Set(), messageIds = new Set();
  let buffer = '', violation = null, toolCalls = 0, userTurns = 0, modelTurns = 0, final = null;
  const consume = event => {
    if (!event || typeof event !== 'object') return;
    if (engine === 'codex') {
      if (event.type === 'turn.started') userTurns += 1;
      const item = event.item;
      if (/^item\.(started|completed|updated)$/.test(event.type || '') && codexTools.has(item?.type)) {
        const key = item.id || `${item.type}:${toolCalls}`;
        if (!toolIds.has(key)) { toolIds.add(key); toolCalls += 1; }
      }
    } else if (engine === 'claude') {
      if (event.type === 'assistant') {
        const message = event.message || {}, key = message.id || event.uuid || `message-${modelTurns}`;
        if (!messageIds.has(key)) { messageIds.add(key); modelTurns += 1; }
        for (const part of message.content || []) if (part.type === 'tool_use' && part.name !== 'StructuredOutput') {
          const key = part.id || `tool-${toolCalls}`;
          if (!toolIds.has(key)) { toolIds.add(key); toolCalls += 1; }
        }
      }
      if (event.type === 'result' || Object.hasOwn(event, 'structured_output')) {
        final = event;
        if (Number.isSafeInteger(event.num_turns)) modelTurns = Math.max(modelTurns, event.num_turns);
      }
    }
    if (policy && toolCalls > policy.max_tool_calls) violation ||= 'worker_tool_limit';
    if (policy && engine === 'claude' && modelTurns > policy.max_model_turns) violation ||= 'worker_model_turn_limit';
    if (policy && engine === 'codex' && userTurns > 1) violation ||= 'worker_user_turn_limit';
  };
  const line = value => { try { consume(JSON.parse(value)); } catch { /* Protocol parsing remains executor-owned. */ } };
  return {
    push(chunk) {
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      return violation;
    },
    finish() { buffer += decoder.end(); if (buffer.trim()) line(buffer); buffer = ''; return violation; },
    get final() { return final; },
    metrics() { return { worker_policy: policy, observed_tool_calls: toolCalls,
      observed_user_turns: engine === 'codex' ? userTurns : null,
      observed_model_turns: engine === 'claude' ? modelTurns : null,
      model_turn_limit_enforcement: engine === 'claude' && policy ? 'cli_max_turns' : 'not_exposed_by_cli',
      tool_limit_enforcement: policy ? 'stop_on_observed_event' : null }; }
  };
}
