// A synchronous, short-lived local spool writer. It never runs a model or blocks an agent turn.
import fs from 'node:fs';
import path from 'node:path';

// Executor records worker I/O and lifecycle. Skip before reading stdin, loading
// the database module, or touching the data directory, including malformed input.
if (process.env.HARNESS_WORKER === '1') process.exit(0);
const { dataRoot, initRoot, database, transaction, id, stableId, now, json, atomic, redact } = await import('./shared.mjs');

try {
  const dir = dataRoot(); initRoot(dir);
  const rawText = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(rawText) > 2 * 1024 * 1024) throw new Error('훅 입력 한도 초과');
  const raw = JSON.parse(rawText);
  const engine = process.argv[2] || process.env.HARNESS_ENGINE || 'unknown';
  const map = { SessionStart: 'session.started', SessionEnd: 'session.ended', UserPromptSubmit: 'input', Stop: 'output',
    PreToolUse: 'tool.started', PostToolUse: 'tool.finished', PostToolUseFailure: 'tool.finished', StopFailure: 'turn.failed', Interrupt: 'turn.interrupted' };
  const kind = map[raw.hook_event_name];
  if (kind && raw.session_id) {
    const db = database(path.join(dir, 'hook-state.sqlite'), `CREATE TABLE IF NOT EXISTS turns(agent TEXT PRIMARY KEY,turn_id TEXT,ambiguous INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS hook_events(id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
    const key = `${engine}:${raw.session_id}`, stamp = now();
    transaction(db, () => {
      const sourceKey = raw.event_id ? `${key}:${raw.event_id}` : null;
      const replay = sourceKey && db.prepare('SELECT payload FROM hook_events WHERE id=?').get(sourceKey);
      if (replay) {
        atomic(path.join(dir, 'spool', `${stableId('spool-', sourceKey)}.json`), replay.payload);
        return JSON.parse(replay.payload);
      }
      const state = db.prepare('SELECT * FROM turns WHERE agent=?').get(key);
      let turn = raw.turn_id || null;
      if (kind === 'input') {
        turn ||= id('local-turn-');
        db.prepare('INSERT INTO turns VALUES(?,?,?) ON CONFLICT(agent) DO UPDATE SET turn_id=excluded.turn_id,ambiguous=excluded.ambiguous')
          .run(key, turn, state?.turn_id ? 1 : 0);
      } else if (['output', 'turn.failed', 'turn.interrupted'].includes(kind)) {
        turn ||= state && !state.ambiguous ? state.turn_id : null;
        db.prepare('DELETE FROM turns WHERE agent=?').run(key);
      } else turn ||= state && !state.ambiguous ? state.turn_id : null;
      const text = kind === 'input' ? raw.prompt : kind === 'output' ? raw.last_assistant_message
        : kind.startsWith('tool.') ? json({ name: raw.tool_name, input: raw.tool_input, response: raw.tool_response, error: raw.error }) : null;
      const e = { id: raw.event_id || id('hook-'), engine,
        agent_session_id: raw.session_id,
        source_session_id: raw.session_id, kind, event_at: stamp, observed_at: stamp, time_source: 'hook_observed',
        turn_id: turn, call_id: raw.tool_use_id || raw.tool_call_id || null, role: 'user',
        text: text == null ? null : redact(text), source: 'system_hook', hook_event_name: raw.hook_event_name };
      // Stable source IDs deduplicate retries; identical prompt contents deliberately do not.
      const spoolId = stableId('spool-', `${engine}:${raw.session_id}:${e.id}`);
      atomic(path.join(dir, 'spool', `${spoolId}.json`), json(e));
      if (sourceKey) db.prepare('INSERT INTO hook_events VALUES(?,?)').run(sourceKey, json(e));
      return e;
    });
    db.close();
  }
} catch (error) {
  // Tracking failure must be observable, while the hook remains non-blocking.
  try {
    const dir = dataRoot(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomic(path.join(dir, 'hook-error.json'), json({ at: now(), message: error.message }));
  } catch {}
}
// No stdout: do not add tracking data to the model context or request Stop continuation.
