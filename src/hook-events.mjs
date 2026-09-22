import fs from 'node:fs';
import path from 'node:path';
import { id, stableId, json, atomic } from './shared.mjs';

export const currentHookEvent = event => event.source === 'system_hook' && event.hook_schema === 2;
export const receivedTurn = event => currentHookEvent(event)
  ? event.turn_source === 'local' ? event.turn_id : event.source_turn_id
  : event.turn_id;

export function spoolHookEvent(dir, event, hasSourceId) {
  const spoolId = stableId('spool-', `${event.engine}:${event.agent_session_id}:${event.id}`);
  let payload = json(event);
  if (hasSourceId) {
    const receipts = path.join(dir, 'hook-receipts');
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
    const receipt = path.join(receipts, `${spoolId}.json`), temp = path.join(receipts, `${spoolId}.${id()}.tmp`);
    try {
      fs.writeFileSync(temp, payload, { flag: 'wx', mode: 0o600 });
      // Publish only a complete immutable record. Concurrent deliveries choose
      // one original observation without a database lock or partial JSON reads.
      try { fs.linkSync(temp, receipt); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      payload = fs.readFileSync(receipt, 'utf8');
    } finally { try { fs.unlinkSync(temp); } catch {} }
  }
  atomic(path.join(dir, 'spool', `${spoolId}.json`), payload);
}

export function resolveHookTurns(rows) {
  const open = new Map();
  return rows.map(row => {
    const event = JSON.parse(row.payload), current = currentHookEvent(event);
    if (event.kind === 'input') {
      open.set(row.id, event);
      return event;
    }
    const closing = ['output', 'turn.failed', 'turn.interrupted'].includes(event.kind);
    if (current) {
      const source = event.source_turn_id;
      const exact = source ? [...open.entries()].filter(([, input]) => input.turn_id === source) : [];
      const single = open.size === 1 ? [...open.entries()][0] : null;
      const match = exact.length === 1 ? exact[0] : !exact.length && single
        && (!source || (currentHookEvent(single[1]) && single[1].turn_source === 'local')) ? single : null;
      event.turn_id = match ? match[1].turn_id : source || null;
      if (closing) {
        if (match) open.delete(match[0]);
        else open.clear(); // Ambiguous inputs remain pending in the projection.
      }
    } else if (closing) {
      for (const [key, input] of open) if (input.turn_id === event.turn_id) open.delete(key);
    }
    if (event.kind === 'session.ended') open.clear();
    return event;
  });
}
