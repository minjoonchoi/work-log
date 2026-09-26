// Configuration presence and actual hook delivery are separate observations.
export function withAgentCollection(store, snapshot) {
  const last = store.db.prepare(`SELECT e.event_at,e.ingested_at,e.kind FROM events e
    WHERE json_extract(e.payload,'$.engine')=? AND json_extract(e.payload,'$.role')='user'
    AND json_extract(e.payload,'$.source')='system_hook'
    ORDER BY e.event_at DESC,e.seq DESC LIMIT 1`);
  return { ...snapshot, connections: snapshot.connections.map(connection => {
    const observed = last.get(connection.engine);
    const current = observed && (!connection.connected_at || observed.event_at >= connection.connected_at);
    return { ...connection, collection: {
      state: connection.state !== 'connected' ? 'inactive' : current ? 'observed' : 'awaiting_hook',
      last_event_at: observed?.event_at || null, last_ingested_at: observed?.ingested_at || null,
      last_event_kind: observed?.kind || null
    } };
  }) };
}
