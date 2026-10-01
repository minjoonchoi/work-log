import fs from 'node:fs';
import path from 'node:path';
import { stableId, now, transaction } from './shared.mjs';
import { claudeProgress } from './claude-progress.mjs';
import { readNativeSession, isNativeBackgroundEvent } from './native-session.mjs';

// Codex commentary and confirmed Claude progress are imported. Reasoning, tool payloads
// and final answers remain excluded; final answers belong to the Stop hook.
export function transcriptProgress(store) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS transcript_progress_cursors (
    path TEXT PRIMARY KEY, identity TEXT NOT NULL, offset INTEGER NOT NULL,
    turn_id TEXT, dropping INTEGER NOT NULL DEFAULT 0)`);
  let next = 0;
  function collect() {
    const sources = db.prepare(`SELECT e.agent_id,e.payload FROM events e JOIN agent_sessions a ON a.id=e.agent_id
      WHERE a.role='user' AND a.engine IN ('codex','claude') AND e.seq IN (
        SELECT MAX(seq) FROM events WHERE json_extract(payload,'$.source')='system_hook'
        AND json_extract(payload,'$.transcript_path') IS NOT NULL GROUP BY agent_id)
      ORDER BY e.agent_id`).all();
    let inserted = 0;
    // Bound each timer turn, including old sessions; resumed files are revisited.
    for (let n = 0; n < Math.min(sources.length, 16); n++) {
      const source = sources[(next + n) % sources.length], hook = JSON.parse(source.payload), file = hook.transcript_path;
      if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
      const claude = hook.engine === 'claude';
      const meta = claude ? hook.native_session : readNativeSession('codex', hook.agent_session_id, file);
      if (claude ? isNativeBackgroundEvent(hook) : !meta || !['cli', 'vscode'].includes(meta.kind)) continue;
      let fd;
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd); if (!stat.isFile()) continue;
        const identity = `${stat.dev}:${stat.ino}`;
        const saved = db.prepare('SELECT * FROM transcript_progress_cursors WHERE path=?').get(file);
        let offset = saved?.identity === identity && saved.offset <= stat.size ? saved.offset : 0;
        let turn = offset ? saved.turn_id : null, dropping = offset ? saved.dropping : 0;
        if (offset === stat.size) continue;
        const buffer = Buffer.alloc(Math.min(1024 * 1024, stat.size - offset));
        const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
        let start = 0; const events = [];
        const inputs = db.prepare("SELECT payload FROM events WHERE agent_id=? AND kind='input'").all(source.agent_id)
          .map(row => JSON.parse(row.payload));
        const history = claude ? db.prepare("SELECT id,event_at,payload FROM events WHERE agent_id=? AND kind IN ('input','output','turn.failed','turn.interrupted','session.ended','tool.started','tool.finished') ORDER BY event_at,seq").all(source.agent_id) : [];
        const following = [];
        if (claude) for (let a = 0, b = buffer.indexOf(10); b >= 0 && b < length; b = buffer.indexOf(10, a)) {
          try { following.push({ end: b, row: JSON.parse(buffer.subarray(a, b).toString('utf8')) }); } catch { /* Incomplete/unknown rows are ignored. */ }
          a = b + 1;
        }
        for (let end = buffer.indexOf(10); end >= 0 && end < length; end = buffer.indexOf(10, start)) {
          const position = offset + start, bytes = buffer.subarray(start, end); start = end + 1;
          if (dropping) { dropping = 0; continue; }
          let row; try { row = JSON.parse(bytes.toString('utf8')); } catch { continue; }
          if (claude) {
            const result = claudeProgress(row, following.filter(next => next.end > end).map(next => next.row), hook, history);
            if (result.wait) { start = position - offset; break; }
            if (result.event) events.push(result.event);
            continue;
          }
          const value = row.payload;
          if (row.type === 'turn_context' || (row.type === 'event_msg' && value?.type === 'task_started')) {
            turn = typeof value?.turn_id === 'string' ? value.turn_id : null;
          }
          if (row.type !== 'response_item' || value?.type !== 'message' || value.role !== 'assistant'
            || value.phase !== 'commentary' || !turn || !Number.isFinite(Date.parse(row.timestamp))) continue;
          const matches = inputs.filter(input => (input.source_turn_id || input.turn_id) === turn);
          if (!matches.length && (!inputs.length || Date.parse(row.timestamp) >= Math.max(...inputs.map(input => Date.parse(input.event_at))))) {
            // The transcript may be flushed before the matching hook reaches
            // the spool. Keep this record unread until that prompt is admitted.
            start = position - offset; break;
          }
          if (matches.length !== 1) continue; // Never guess across overlapping prompts.
          const text = (Array.isArray(value.content) ? value.content : []).filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('\n');
          if (!text.trim()) continue;
          events.push({ ...matches[0], id: stableId('progress-', `${hook.agent_session_id}:${position}:${turn}:${text}`),
            kind: 'progress', event_at: row.timestamp, observed_at: now(), time_source: 'transcript',
            hook_event_name: 'TranscriptCommentary', transcript_path: file, native_session: meta,
            source_turn_id: turn, turn_id: turn, turn_source: 'native', text });
        }
        if (!start && length === buffer.length && length === 1024 * 1024) { start = length; dropping = 1; }
        if (!start) continue; // A partial last JSONL record is retried after append.
        transaction(db, () => {
          inserted += store.ingestMany(events, null, true).inserted;
          db.prepare(`INSERT INTO transcript_progress_cursors VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
            identity=excluded.identity,offset=excluded.offset,turn_id=excluded.turn_id,dropping=excluded.dropping`)
            .run(file, identity, offset + start, turn, dropping);
        });
      } catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw error;
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    next = sources.length ? (next + 16) % sources.length : 0;
    return inserted;
  }
  return { collect };
}
