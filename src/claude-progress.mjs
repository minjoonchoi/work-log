import { resolveHookTurns } from './hook-events.mjs';
import { stableId, now } from './shared.mjs';

// Claude transcripts can split text and tool_use into separate assistant rows,
// with stop_reason=null on the text row. Defer that row until later evidence
// distinguishes a progress message from the final answer owned by Stop.
export function claudeProgress(row, following, hook, history) {
  if (row.sessionId !== hook.agent_session_id || row.isSidechain || row.isMeta
    || row.type !== 'assistant' || row.message?.role !== 'assistant'
    || !Number.isFinite(Date.parse(row.timestamp))) return {};
  const content = Array.isArray(row.message.content) ? row.message.content : [];
  const text = content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  if (!text.trim() || ['end_turn', 'stop_sequence', 'max_tokens'].includes(row.message.stop_reason)) return {};
  const before = history.filter(record => Date.parse(record.event_at) <= Date.parse(row.timestamp));
  const { pending } = resolveHookTurns(before, { withPending: true });
  if (pending.length !== 1) return {}; // No timestamp-based guessing between overlapping prompts.
  const input = pending[0];
  const stop = history.map(record => JSON.parse(record.payload)).find(event => event.kind === 'output'
    && event.turn_id === input.turn_id && Date.parse(event.event_at) >= Date.parse(row.timestamp));
  if (stop?.text?.trim() === text.trim()) return {};
  const continuedByHook = history.map(record => JSON.parse(record.payload)).some(event =>
    ['tool.started', 'tool.finished'].includes(event.kind) && event.turn_id === input.turn_id
    && Date.parse(event.event_at) >= Date.parse(row.timestamp)
    && (!stop || Date.parse(event.event_at) < Date.parse(stop.event_at)));
  let intermediate = continuedByHook || row.message.stop_reason === 'tool_use' || content.some(part => part.type === 'tool_use');
  for (const next of following) {
    if (next.sessionId !== hook.agent_session_id || next.isSidechain || next.isMeta) continue;
    if (next.type === 'user') {
      if (Array.isArray(next.message?.content) && next.message.content.some(part => part.type === 'tool_result')) intermediate = true;
      break;
    }
    if (next.type === 'assistant' && Array.isArray(next.message?.content)) {
      if (next.message.content.some(part => part.type === 'tool_use')) { intermediate = true; break; }
      // Another completed API message continues the same prompt. Repeated
      // snapshots of this same message are not evidence of continuation.
      if (next.message.id && row.message.id && next.message.id !== row.message.id
        && next.message.content.some(part => part.type === 'text')) { intermediate = true; break; }
    }
  }
  if (!intermediate) return { wait: !stop };
  const key = row.uuid || `${row.message.id}:${row.timestamp}:${text}`;
  return { event: { ...input, id: stableId('progress-', `claude:${hook.agent_session_id}:${key}`), kind: 'progress',
    event_at: row.timestamp, observed_at: now(), time_source: 'transcript', hook_event_name: 'TranscriptCommentary',
    transcript_path: hook.transcript_path, text,
    // Keep the local turn identity supplied by UserPromptSubmit when Claude's
    // hooks have no native turn_id. A progress record never closes that turn.
    source_turn_id: input.source_turn_id || null, turn_id: input.turn_id, turn_source: input.turn_source,
    native_session: hook.native_session } };
}
