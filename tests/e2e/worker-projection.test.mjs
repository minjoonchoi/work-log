import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { managerStore } from '../../src/manager-store.mjs';
import { Harness, event, pair } from '../helpers.mjs';

const parent = (agent, turn, owner, engine = 'codex') => ({ engine, agent_session_id: agent, turn_id: turn, work_item_id: owner });
const worker = (agent, source, turn = 'attempt') => pair(agent, '09:30:10', '09:30:20', turn,
  { role: 'worker', work_item_id: source.work_item_id, parent: source });
function database(h, run) {
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  try { db.exec('PRAGMA busy_timeout=5000'); return run(db); } finally { db.close(); }
}
function observeProjections(db) {
  // Count actual link projection writes inside the manager process. No timing
  // threshold or test-only production callback can hide a full-history replay.
  db.exec(`CREATE TABLE projection_writes(agent_id TEXT PRIMARY KEY, writes INTEGER NOT NULL);
    CREATE TRIGGER count_projected_links AFTER INSERT ON event_links BEGIN
      INSERT INTO projection_writes SELECT agent_id,1 FROM events WHERE id=NEW.event_id
        ON CONFLICT(agent_id) DO UPDATE SET writes=writes+1;
    END;`);
}
const counts = h => database(h, db => db.prepare(`SELECT a.source_id,a.role,p.writes FROM projection_writes p
  JOIN agent_sessions a ON a.id=p.agent_id ORDER BY a.source_id`).all().map(row => ({ ...row })));
const clearCounts = h => database(h, db => db.exec('DELETE FROM projection_writes'));
const internalCounts = h => counts(h).filter(row => row.role !== 'user');
function links(h, sources) {
  return database(h, db => db.prepare(`SELECT a.source_id,e.kind,l.session_id,l.resolution FROM event_links l
    JOIN events e ON e.id=l.event_id JOIN agent_sessions a ON a.id=e.agent_id
    WHERE a.source_id IN (${sources.map(() => '?').join(',')}) ORDER BY a.source_id,e.seq`).all(...sources).map(row => ({ ...row })));
}

test('new prompts in another or the same native session do not reproject 3000 historical workers, including after restart', async t => {
  const h = new Harness(); t.after(() => h.close());
  const store = managerStore(h.dir), owner = 'projection-history-owner';
  store.ingestMany(pair('historical-parent', '09:00:00', '09:01:00', 'old', { work_item_id: owner }));
  store.ingestMany(Array.from({ length: 3000 }, (_, index) => worker(`historical-worker-${index}`, parent('historical-parent', 'old', owner))).flat());
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE role='worker'").get().n, 3000);
  const untouched = links(h, ['historical-worker-1', 'historical-worker-2999']);
  observeProjections(store.db); store.db.close();
  await h.start('manager');

  await h.ingest([event('unrelated-user', 'input', '10:00:00', 'new')]);
  assert.deepEqual(counts(h), [{ source_id: 'unrelated-user', role: 'user', writes: 1 }]);
  assert.deepEqual(internalCounts(h), [], 'unrelated first input must perform zero internal projections');
  clearCounts(h);
  await h.ingest(pair('historical-parent', '09:10:00', '09:11:00', 'later', { work_item_id: owner }));
  assert.deepEqual(counts(h), [{ source_id: 'historical-parent', role: 'user', writes: 4 }]);
  clearCounts(h);
  await h.ingest([event('historical-parent', 'input', '10:00:00', 'another-window', { work_item_id: owner })]);
  assert.deepEqual(counts(h), [{ source_id: 'historical-parent', role: 'user', writes: 5 }]);
  clearCounts(h);
  const extra = event('historical-worker-0', 'output', '10:01:00', 'attempt', {
    role: 'worker', work_item_id: owner, parent: parent('historical-parent', 'old', owner)
  });
  await h.ingest([extra]);
  assert.deepEqual(counts(h), [{ source_id: 'historical-worker-0', role: 'worker', writes: 3 }]);
  assert.deepEqual(links(h, ['historical-worker-1', 'historical-worker-2999']), untouched);
  clearCounts(h);
  assert.deepEqual(await h.ingest([extra]), { inserted: 0, duplicates: 1 });
  assert.deepEqual(counts(h), [], 'replayed source events must not project any session');

  await h.stop('manager'); await h.start('manager');
  assert.deepEqual(counts(h), [], 'opening the existing DB must not rebuild historical links');
  await h.ingest([event('unrelated-user', 'output', '10:02:00', 'new')]);
  assert.deepEqual(counts(h), [{ source_id: 'unrelated-user', role: 'user', writes: 2 }]);
  assert.deepEqual(links(h, ['historical-worker-1', 'historical-worker-2999']), untouched);
  clearCounts(h);
  await h.ingest([event('historical-parent', 'output', '10:02:00', 'another-window', { work_item_id: owner })]);
  assert.deepEqual(counts(h), [{ source_id: 'historical-parent', role: 'user', writes: 6 }]);
  // A worker for the new turn is still discovered without reading the other
  // 3000 workers that refer to this same parent's original turn.
  await h.ingest(worker('future-turn-worker', parent('historical-parent', 'future-turn', owner)));
  assert.ok(links(h, ['future-turn-worker']).every(row => row.session_id === null));
  clearCounts(h);
  await h.ingest([event('historical-parent', 'input', '10:10:00', 'future-turn', { work_item_id: owner })]);
  assert.deepEqual(internalCounts(h), [{ source_id: 'future-turn-worker', role: 'worker', writes: 2 }]);
  assert.ok(links(h, ['future-turn-worker']).every(row => row.session_id && row.resolution === 'parent'));
  assert.deepEqual(links(h, ['historical-worker-1', 'historical-worker-2999']), untouched);
  const plan = database(h, db => db.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT a.* FROM events e JOIN agent_sessions a ON a.id=e.agent_id
    WHERE json_extract(e.payload,'$.role')!='user' AND a.role!='user'
    AND json_extract(e.payload,'$.parent.engine')=? AND json_extract(e.payload,'$.parent.agent_session_id')=?
    AND json_extract(e.payload,'$.parent.turn_id') IN (?)`).all('codex', 'historical-parent', 'future-turn'));
  assert.ok(plan.some(row => row.detail.includes('SEARCH e USING INDEX event_internal_parent')), JSON.stringify(plan));
});

test('child-before-parent and descendant links follow delayed window reassignment and merges without touching unrelated workers', async t => {
  const h = new Harness(); t.after(() => h.close());
  const store = managerStore(h.dir);
  store.ingestMany([...pair('unrelated-parent', '08:00:00', '08:01:00', 'unrelated', { work_item_id: 'merge-target' }),
    ...worker('unrelated-worker', parent('unrelated-parent', 'unrelated', 'merge-target'))]);
  observeProjections(store.db); store.db.close(); await h.start('manager');
  const owner = 'delayed-owner', descendants = ['dependent-child', 'dependent-grandchild'];
  // The descendant reaches the service before both its worker parent and the
  // native user input. Dependency order must not depend on event arrival order.
  await h.ingest([
    ...worker('dependent-grandchild', parent('dependent-child', 'attempt', owner)),
    ...worker('dependent-child', parent('delayed-user', 'second', owner))
  ]);
  assert.ok(links(h, descendants).every(row => row.session_id === null && row.resolution === 'unresolved'));
  clearCounts(h);
  await h.ingest([...pair('delayed-user', '09:00:00', '09:01:00', 'first', { work_item_id: owner }),
    ...pair('delayed-user', '09:30:00', '09:31:00', 'second', { work_item_id: owner })]);
  let detail = await h.manager(`/items/${owner}`);
  assert.equal(detail.sessions.length, 2);
  const first = detail.sessions[0].id, second = detail.sessions[1].id;
  assert.ok(links(h, descendants).every(row => row.session_id === second && row.resolution === 'parent'));
  assert.deepEqual(internalCounts(h), descendants.map(source_id => ({ source_id, role: 'worker', writes: 2 })));

  clearCounts(h);
  await h.ingest([event('delayed-user', 'output', '09:20:00', 'first', { work_item_id: owner })]);
  detail = await h.manager(`/items/${owner}`);
  assert.equal(detail.sessions.length, 1); assert.equal(detail.sessions[0].id, first);
  assert.ok(links(h, descendants).every(row => row.session_id === first && row.resolution === 'parent'));
  assert.deepEqual(internalCounts(h), descendants.map(source_id => ({ source_id, role: 'worker', writes: 2 })));

  await h.manager('/merge', { method: 'POST', body: { ids: [owner, 'merge-target'], target: 'merge-target', operation_id: 'merge-projection-owners' } });
  clearCounts(h);
  await h.ingest([event('delayed-user', 'input', '09:35:00', 'third', { work_item_id: 'merge-target' })]);
  const merged = await h.manager('/items/merge-target');
  assert.equal(merged.sessions.length, 2);
  assert.ok(links(h, descendants).every(row => row.session_id === first && row.resolution === 'parent'));
  assert.deepEqual(internalCounts(h), [], 'a merged owner and a new turn do not change the existing parent input links');
  assert.ok(merged.events.filter(row => descendants.includes(row.agent_session_id)).every(row => row.work_item_id === owner));
});

test('the parent index is built from existing DB records without rewriting history and resolves old orphan links on new input', async t => {
  const h = new Harness(); t.after(() => h.close());
  const store = managerStore(h.dir), owner = 'legacy-parent-index-owner';
  store.ingestMany(worker('legacy-orphan-worker', parent('legacy-parent', 'original-turn', owner, 'claude')));
  const before = store.db.prepare('SELECT id,payload FROM events ORDER BY seq').all().map(row => ({ ...row }));
  observeProjections(store.db);
  store.db.exec('DROP INDEX event_internal_parent'); store.db.close();
  await h.start('manager');
  assert.deepEqual(counts(h), []);
  assert.deepEqual(database(h, db => db.prepare('SELECT id,payload FROM events ORDER BY seq').all().map(row => ({ ...row }))), before);
  assert.equal(database(h, db => db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='event_internal_parent'").get().n), 1);
  await h.ingest(pair('legacy-parent', '09:00:00', '09:01:00', 'original-turn', { engine: 'claude', work_item_id: owner }));
  const detail = await h.manager(`/items/${owner}`);
  assert.equal(detail.sessions.length, 1);
  assert.ok(links(h, ['legacy-orphan-worker']).every(row => row.session_id === detail.sessions[0].id && row.resolution === 'parent'));
  assert.deepEqual(internalCounts(h), [{ source_id: 'legacy-orphan-worker', role: 'worker', writes: 2 }]);
  await h.stop('manager'); await h.start('manager'); clearCounts(h);
  await h.ingest([event('different-parent', 'input', '10:00:00', 'new')]);
  assert.deepEqual(internalCounts(h), []);
});
