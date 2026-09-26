// A synchronous, short-lived local spool writer. It never runs a model or blocks an agent turn.
import fs from 'node:fs';
import path from 'node:path';

// Executor records worker I/O and lifecycle. Skip before reading stdin, loading
// the database module, or touching the data directory, including malformed input.
if (process.env.HARNESS_WORKER === '1') process.exit(0);
const { dataRoot, initRoot, id, stableId, now, json, atomic, redact } = await import('./shared.mjs');
const { spoolHookEvent } = await import('./hook-events.mjs');
const { isWorkerWorkspace } = await import('./worker-context.mjs');

try {
  const dir = dataRoot();
  const rawText = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(rawText) > 2 * 1024 * 1024) throw new Error('훅 입력 한도 초과');
  const raw = JSON.parse(rawText);
  const engine = process.argv[2] || process.env.HARNESS_ENGINE || 'unknown';
  // Keep runtime workers out of user history even when the CLI's hook launcher
  // drops HARNESS_WORKER. Hook commands run in the session cwd; prefer the
  // engine-provided cwd and use the process cwd only when that field is absent.
  if (isWorkerWorkspace(dir, engine, typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : process.cwd())) process.exit(0);
  initRoot(dir);
  const map = { SessionStart: 'session.started', SessionEnd: 'session.ended', UserPromptSubmit: 'input', Stop: 'output',
    PreToolUse: 'tool.started', PostToolUse: 'tool.finished', PostToolUseFailure: 'tool.finished', StopFailure: 'turn.failed', Interrupt: 'turn.interrupted' };
  const kind = map[raw.hook_event_name];
  if (kind && raw.session_id) {
    const eventId = raw.event_id || id('hook-'), stamp = now();
    const sourceTurn = typeof raw.turn_id === 'string' && raw.turn_id ? raw.turn_id : null;
    const turn = sourceTurn || (kind === 'input' ? stableId('local-turn-', `${engine}:${raw.session_id}:${eventId}`) : null);
    const text = kind === 'input' ? raw.prompt : kind === 'output' ? raw.last_assistant_message
      : kind.startsWith('tool.') ? json({ name: raw.tool_name, input: raw.tool_input, response: raw.tool_response, error: raw.error }) : null;
    const event = { id: eventId, engine, agent_session_id: raw.session_id,
      source_session_id: raw.session_id, kind, event_at: stamp, observed_at: stamp, time_source: 'hook_observed',
      observed_order: process.hrtime.bigint().toString().padStart(24, '0'),
      turn_id: turn, source_turn_id: sourceTurn, turn_source: sourceTurn ? 'native' : kind === 'input' ? 'local' : 'missing', hook_schema: 2,
      call_id: raw.tool_use_id || raw.tool_call_id || null, role: 'user',
      ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
      text: text == null ? null : redact(text), source: 'system_hook', hook_event_name: raw.hook_event_name };
    // Stable source IDs deduplicate retries; identical prompt contents do not.
    spoolHookEvent(dir, event, !!raw.event_id);
  }
} catch (error) {
  // Tracking failure must be observable, while the hook remains non-blocking.
  try {
    const dir = dataRoot(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomic(path.join(dir, 'hook-error.json'), json({ at: now(), message: error.message }));
  } catch {}
}
// No stdout: do not add tracking data to the model context or request Stop continuation.
