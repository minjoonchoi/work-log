import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managerStore } from '../../src/manager-store.mjs';
import { integrationStore } from '../../src/integration-store.mjs';
import { writingStore } from '../../src/writing-store.mjs';
import { Harness, pair, event } from '../helpers.mjs';
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-session-actions-'));
  let store = managerStore(dir); let integrations = integrationStore(store);
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.ingestMany([...pair('source', '09:00:00', '09:05:00', 'one'), ...pair('source', '09:30:00', '09:35:00', 'two'), ...pair('target', '10:00:00', '10:05:00')]);
  const [source, target] = ['source', 'target'].map(id => store.sessionList().find(s => s.agent_session_id === id).work_item_id);
  return { get store() { return store; }, get integrations() { return integrations; }, source, target,
    reopen() { store.db.close(); store = managerStore(dir); integrations = integrationStore(store); } };
}
const request = (c, ids, extra = {}) => ({ item_id: c.source, version: c.store.detail(c.source).item.version, session_ids: ids, operation_id: 'session-action-123', ...extra });
test('move is atomic, idempotent, preserves summaries and Jira logs, survives late records and restart', t => {
  const c = setup(t), [session, other] = c.store.sessionList(c.source), original = c.store.sessionMessages(session.id);
  const snapshot = c.integrations.sessionSnapshots([session])[0];
  c.integrations.ensureSummary(snapshot); c.integrations.finishSummary(snapshot, 'completed', { text: '기존 요약' });
  c.integrations.beginWorklog(snapshot, { operation_id: 'original-jira-link' }, '기존 요약');
  c.integrations.finishWorklog(session.id, 'synced', '123');
  const log = c.integrations.worklog(session.id), input = request(c, [session.id], { target_id: c.target });
  c.store.changeSessions('move', input);
  assert.equal(c.store.changeSessions('move', input).repeated, true);
  assert.deepEqual(c.store.sessionMessages(session.id), original);
  assert.equal(c.integrations.isSessionCurrent(snapshot), false);
  assert.equal(c.integrations.summary(session.id).text, '기존 요약');
  assert.deepEqual(c.integrations.worklog(session.id), log);
  assert.deepEqual(c.store.sessionList(c.source).map(s => s.id), [other.id]);
  assert.throws(() => c.store.history(c.source, { session_id: session.id }), /찾을 수 없습니다/);
  assert.equal(c.store.history(c.target, { session_id: session.id }).records.length, 2);
  // This late activity would normally collapse the two windows.
  c.store.ingestMany([event('source', 'output', '09:20:00', 'one', { text: '늦은 응답' }), ...pair('source', '11:00:00', '11:05:00', 'three')]);
  assert.equal(c.store.sessionList(c.target).filter(s => s.id === session.id).length, 1);
  assert.ok(c.store.sessionList(c.source).some(s => s.id === other.id));
  assert.ok(c.store.sessionList(c.source).some(s => s.start_at.includes('11:00:00')));
  c.reopen(); assert.equal(c.store.sessionList(c.target).filter(s => s.id === session.id).length, 1);
  assert.deepEqual(c.integrations.worklog(session.id), log);
});
test('delete hides selected sessions from history, calendar and automation and restore retains raw records', t => {
  const c = setup(t), sessions = c.store.sessionList(c.source), ids = sessions.map(s => s.id);
  const rawCount = c.store.db.prepare('SELECT COUNT(*) n FROM events').get().n;
  const writings = writingStore(c.store, c.integrations);
  writings.enqueue('session-summary', ids[0], { operation_id: 'pending-summary-delete' });
  c.store.changeSessions('delete', request(c, ids));
  assert.equal(c.store.sessionList(c.source).length, 0);
  assert.equal(c.store.detail(c.source).sessions.length, 0);
  assert.equal(c.store.deletedSessions(c.source).length, 2);
  assert.equal(c.integrations.worklogSessions().some(s => ids.includes(s.id)), false);
  assert.equal(writings.isCurrent(writings.get('pending-summary-delete')), false);
  assert.throws(() => c.store.history(c.source, { session_id: ids[0] }), /찾을 수 없습니다/);
  assert.throws(() => c.store.sessionMessages(ids[0]), /삭제된/);
  assert.equal(c.store.calendar({ start: '2026-09-17T00:00:00Z', end: '2026-09-18T00:00:00Z' }).some(s => ids.includes(s.id)), false);
  c.store.ingestMany([event('source', 'output', '09:03:00', 'one', { text: '뒤늦게 수집' })]);
  c.reopen(); assert.equal(c.store.sessionList(c.source).length, 0);
  c.store.changeSessions('restore', request(c, ids, { operation_id: 'restore-session-123' }));
  assert.equal(c.store.sessionList(c.source).length, 2); assert.equal(c.store.deletedSessions(c.source).length, 0);
  assert.equal(c.store.db.prepare('SELECT COUNT(*) n FROM events').get().n, rawCount + 1);
});
test('stale, mixed-owner, duplicate and invalid-target operations never partially apply', t => {
  const c = setup(t), [s] = c.store.sessionList(c.source), [foreign] = c.store.sessionList(c.target);
  for (const input of [request(c, [s.id], { version: -1 }), request(c, [s.id, foreign.id]), request(c, [s.id, s.id])]) assert.throws(() => c.store.changeSessions('delete', input));
  assert.throws(() => c.store.changeSessions('move', request(c, [s.id], { target_id: c.source })));
  assert.throws(() => c.store.changeSessions('move', request(c, [s.id], { target_id: 'missing' })));
  assert.equal(c.store.sessionList(c.source).length, 2);
  c.store.changeSessions('delete', request(c, [s.id]));
  assert.throws(() => c.store.changeSessions('move', request(c, [s.id], { target_id: c.target })), /식별자/);
});
test('session action API validates ownership and exposes restore list', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  await h.ingest(pair('session-actions-api', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0], session = (await h.manager(`/items/${item.id}`)).sessions[0];
  await h.manager('/sessions/delete', { method: 'POST', body: { item_id: item.id, version: item.version, session_ids: [session.id], operation_id: 'api-session-delete' } });
  assert.equal((await h.manager(`/items/${item.id}`)).sessions.length, 0);
  assert.equal((await h.manager(`/items/${item.id}/deleted-sessions`)).length, 1);
});

test('multiple sessions move together and in-flight writing cannot follow them into another item', t => {
  const c = setup(t), ids = c.store.sessionList(c.source).map(s => s.id);
  c.store.db.prepare('INSERT INTO work_item_deletions VALUES(?,NULL,?,1)').run(c.source, 'initial-revision');
  const writings = writingStore(c.store, c.integrations);
  writings.enqueue('session-summary', ids[0], { operation_id: 'pending-summary-move' });
  const row = writings.get('pending-summary-move');
  assert.equal(writings.isCurrent(row), true);
  c.store.changeSessions('move', request(c, ids, { target_id: c.target }));
  assert.equal(c.store.visibilityRevision(c.target), row.snapshot.visibility_revision);
  assert.equal(writings.isCurrent(row), false);
  assert.equal(c.store.sessionList(c.source).length, 0);
  assert.equal(c.store.sessionList(c.target).length, 3);
});
