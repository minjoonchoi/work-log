import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, event, eventually } from '../helpers.mjs';
import { atlFixture, authorize, createIssue } from '../fixtures/atlassian.mjs';

const post = body => ({ method: 'POST', body });
const remove = (h, ids, operation_id = 'delete-selected-items') => h.manager('/items/delete', post({ ids, operation_id }));
const restore = (h, ids, operation_id = 'restore-selected-items') => h.manager('/items/restore', post({ ids, operation_id }));
const missing = fn => assert.rejects(fn, error => error.status === 404);
async function setup(t, { runtime = false, fixture = {} } = {}) {
  const h = new Harness(); h.env = { HARNESS_TEST_WRITING_FIXTURE: JSON.stringify(fixture) };
  t.after(() => h.close()); if (runtime) await h.start('runtime'); await h.start('manager'); return h;
}
function dbRows(h, sql) {
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); }
}

test('bulk soft delete hides a merged canonical group and preserves late hooks, sessions and history across restart and restore', async t => {
  const h = await setup(t);
  await h.ingest([
    ...pair('deleted-author', '09:00:00', '09:05:00', 'one', { work_item_id: 'group-a', text: '설계 업무' }),
    ...pair('deleted-peer', '09:03:00', '09:08:00', 'one', { work_item_id: 'group-b', text: '연결된 구현' }),
    event('deleted-author', 'input', '09:10:00', 'pending', { work_item_id: 'group-a', text: '계속 작업 중' }),
    ...pair('preserved-author', '10:00:00', '10:05:00', 'one', { work_item_id: 'preserved', text: '다른 업무' })
  ]);
  const alias = (await h.manager('/items')).find(item => item.id === 'group-b');
  await h.manager('/items/group-b', { method: 'PATCH', body: { version: alias.version, title: alias.title, description: '병합 전 설명 검색' } });
  await h.manager('/merge', post({ ids: ['group-a', 'group-b'], target: 'group-a', operation_id: 'merge-before-deletion' }));
  assert.equal((await h.manager('/items?q=' + encodeURIComponent('  병합 전 설명  ')))[0].id, 'group-a');
  assert.equal((await h.manager('/sessions?q=' + encodeURIComponent('병합 전 설명'))).length, 2);
  const before = await h.manager('/items/group-a'), originalIds = before.sessions.map(session => session.id).sort();
  const originals = dbRows(h, 'SELECT id,payload FROM events ORDER BY seq');
  assert.deepEqual(await remove(h, ['group-b']), { ids: ['group-a'], repeated: false });
  assert.deepEqual((await h.manager('/items')).map(item => item.id), ['preserved']);
  assert.equal((await h.manager('/quick')).counts.total, 1);
  assert.ok((await h.manager('/sessions')).every(session => session.work_item_id === 'preserved'));
  assert.ok((await h.manager('/calendar?start=2026-09-17T00:00:00Z&end=2026-09-18T00:00:00Z')).every(session => session.work_item_id === 'preserved'));
  await missing(h.manager('/items/group-a')); await missing(h.manager('/items/group-b'));
  await missing(h.manager(`/items/group-a/history?session_id=${originalIds[0]}`));
  await missing(h.manager('/calendar?start=2026-09-17T00:00:00Z&end=2026-09-18T00:00:00Z&item_id=group-b'));
  await missing(h.manager('/items/group-a', { method: 'PATCH', body: { version: before.item.version, title: '숨겨진 변경', description: '' } }));
  await missing(h.manager('/merge', post({ ids: ['group-b', 'preserved'], target: 'preserved', operation_id: 'reject-hidden-merge' })));
  await missing(h.manager(`/sessions/${originalIds[0]}/summary/regenerate`, post({ operation_id: 'reject-hidden-summary' })));
  assert.deepEqual(dbRows(h, 'SELECT id,payload FROM events ORDER BY seq'), originals);

  await h.stop('manager');
  h.hook('codex', { session_id: 'deleted-author', turn_id: 'pending', hook_event_name: 'Stop', last_assistant_message: '삭제 후에도 에이전트 응답은 보존됩니다.' });
  await h.start('manager');
  await eventually(() => h.manager('/health'), result => result.events === originals.length + 1);
  assert.deepEqual((await h.manager('/items')).map(item => item.id), ['preserved']);
  const [deleted] = await h.manager('/items?trash=true');
  assert.equal(deleted.id, 'group-a'); assert.ok(deleted.deleted_at); assert.equal(deleted.session_count, 2);
  assert.equal((await h.manager('/items?trash=true&q=' + encodeURIComponent('연결된 구현'))).length, 1);
  assert.deepEqual(await restore(h, ['group-b']), { ids: ['group-a'], repeated: false });
  const recovered = await h.manager('/items/group-a');
  assert.deepEqual(recovered.sessions.map(session => session.id).sort(), originalIds);
  assert.equal(recovered.item.deleted_at, null); assert.equal(recovered.item.title, before.item.title);
  assert.ok(recovered.events.some(e => e.text === '삭제 후에도 에이전트 응답은 보존됩니다.'));
  assert.deepEqual(await h.manager('/items?trash=true'), []);
  assert.equal((await h.manager('/items')).length, 2);
});

test('delete and restore batches are atomic and operation identities do not replay over later user choices', async t => {
  const h = await setup(t);
  await h.ingest([...pair('batch-a', '09:00:00', '09:05:00', 'one', { work_item_id: 'batch-a' }), ...pair('batch-b', '10:00:00', '10:05:00', 'one', { work_item_id: 'batch-b' })]);
  const before = await h.manager('/items');
  await missing(remove(h, ['batch-a', 'missing-item'], 'atomic-invalid-delete'));
  assert.deepEqual(await h.manager('/items'), before);
  for (const ids of [[], ['batch-a', 'batch-a'], [''], ['x'.repeat(201)], [42]]) {
    await assert.rejects(remove(h, ids, 'invalid-input-delete'), error => error.status === 400);
  }
  const command = { ids: ['batch-a', 'batch-b'], operation_id: 'stable-delete-command' };
  const first = await h.manager('/items/delete', post(command));
  assert.equal(first.repeated, false); assert.equal((await h.manager('/items?trash=true')).length, 2);
  assert.equal((await h.manager('/items/delete', post({ ...command, ids: [...command.ids].reverse() }))).repeated, true);
  await assert.rejects(remove(h, ['batch-a'], command.operation_id), error => error.status === 409);
  await assert.rejects(restore(h, command.ids, command.operation_id), error => error.status === 409);
  await missing(restore(h, ['batch-a', 'missing-item'], 'atomic-invalid-restore'));
  assert.deepEqual(await h.manager('/items'), []);
  await restore(h, ['batch-a', 'batch-b']);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager('/items/delete', post(command))).repeated, true);
  assert.equal((await h.manager('/items')).length, 2, 'retrying the old delete does not undo the subsequent restore');
  assert.equal((await restore(h, command.ids)).repeated, true);
  assert.equal(dbRows(h, 'SELECT COUNT(*) AS count FROM events')[0].count, 4);
});

test('versioned delete rejects changed representatives and merged-in histories atomically, while journal replays remain idempotent', async t => {
  const h = await setup(t);
  await h.ingest(['a', 'b', 'c', 'd'].flatMap(id => pair(`version-${id}`, '09:00:00', '09:05:00', 'first', { work_item_id: `version-${id}` })));
  const original = await h.manager('/items'), versions = Object.fromEntries(original.map(item => [item.id, item.version]));
  const request = { ids: ['version-a', 'version-c'], operation_id: 'versioned-delete-request',
    versions: { 'version-a': versions['version-a'], 'version-c': versions['version-c'] } };
  for (const invalid of [null, [], {}, { 'version-a': 1 }, { ...request.versions, extra: 1 },
    { ...request.versions, 'version-a': 0 }, { ...request.versions, 'version-a': 1.5 }, { ...request.versions, 'version-a': Number.MAX_SAFE_INTEGER + 1 },
    { ...request.versions, 'version-a': '1' }]) {
    await assert.rejects(h.manager('/items/delete', post({ ...request, versions: invalid })), error => error.status === 400);
  }
  await h.manager('/merge', post({ ids: ['version-a', 'version-b'], target: 'version-b', operation_id: 'merge-new-representative' }));
  await assert.rejects(h.manager('/items/delete', post(request)), error => error.status === 409);
  assert.equal((await h.manager('/items')).length, 3); assert.deepEqual(await h.manager('/items?trash=true'), []);
  const currentB = (await h.manager('/items')).find(item => item.id === 'version-b');
  const fresh = { ids: ['version-b'], operation_id: 'fresh-versioned-delete', versions: { 'version-b': currentB.version } };
  assert.deepEqual(await h.manager('/items/delete', post(fresh)), { ids: ['version-b'], repeated: false });
  assert.deepEqual(await h.manager('/items/delete', post(fresh)), { ids: ['version-b'], repeated: true }, 'replay wins before the delete-induced version change');
  await assert.rejects(h.manager('/items/delete', post({ ...fresh, versions: { 'version-b': currentB.version + 1 } })), error => error.status === 409);
  const deletedB = (await h.manager('/items?trash=true'))[0];
  const restoration = { ids: ['version-b'], operation_id: 'versioned-restore-request', versions: { 'version-b': deletedB.version } };
  await h.manager('/items/restore', post(restoration));
  assert.equal((await h.manager('/items/restore', post(restoration))).repeated, true);
  await assert.rejects(h.manager('/items/restore', post({ ...restoration, operation_id: 'stale-versioned-restore' })), error => error.status === 409);
  assert.equal((await h.manager('/items')).length, 3);

  const staleC = { ids: ['version-c'], operation_id: 'reject-newly-merged-history', versions: { 'version-c': versions['version-c'] } };
  await h.manager('/merge', post({ ids: ['version-c', 'version-d'], target: 'version-c', operation_id: 'merge-into-selected-target' }));
  await assert.rejects(h.manager('/items/delete', post(staleC)), error => error.status === 409);
  assert.deepEqual(await h.manager('/items?trash=true'), []);
  assert.equal((await h.manager('/items/version-c')).sessions.length, 2);
  const currentC = (await h.manager('/items')).find(item => item.id === 'version-c');
  assert.equal((await h.manager('/items/delete', post({ ...staleC, versions: { 'version-c': currentC.version } }))).repeated, false);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager('/items/delete', post(fresh))).repeated, true);
  assert.equal((await h.manager('/items')).some(item => item.id === 'version-b'), true, 'old delete replay does not hide a restored representative');
});

test('a selection larger than 100 items is deleted and restored in one atomic versioned command', async t => {
  const h = await setup(t);
  await h.ingest(Array.from({ length: 101 }, (_, index) => {
    const id = `bulk-${String(index).padStart(3, '0')}`;
    return pair(id, '09:00:00', '09:05:00', 'first', { work_item_id: id });
  }).flat());
  const items = await h.manager('/items'), ids = items.map(item => item.id);
  assert.equal(items.length, 101);
  const removed = await h.manager('/items/delete', post({ ids, operation_id: 'delete-all-101-items', versions: Object.fromEntries(items.map(item => [item.id, item.version])) }));
  assert.equal(removed.ids.length, 101); assert.deepEqual(await h.manager('/items'), []);
  assert.deepEqual(await h.manager('/sessions'), []);
  const trash = await h.manager('/items?trash=true'); assert.equal(trash.length, 101);
  const restored = await h.manager('/items/restore', post({ ids, operation_id: 'restore-all-101-items', versions: Object.fromEntries(trash.map(item => [item.id, item.version])) }));
  assert.equal(restored.ids.length, 101); assert.equal((await h.manager('/items')).length, 101);
  assert.equal((await h.manager('/sessions')).length, 101);
  assert.deepEqual(await h.manager('/items?trash=true'), []);
  assert.equal(dbRows(h, 'SELECT COUNT(*) AS count FROM events')[0].count, 202);
});

test('recent work sorting follows user run activity and observed I/O, ignoring internal metadata and title edits', async t => {
  const h = await setup(t);
  await h.ingest([
    ...pair('order-a', '09:00:00', '09:05:00', 'one', { work_item_id: 'order-a', text: '오래된 업무' }),
    ...pair('order-b', '10:00:00', '10:05:00', 'one', { work_item_id: 'order-b', text: '최근 업무' }),
    event('order-a', 'run.updated', '11:00:00', 'one', { work_item_id: 'order-a', run: { id: 'real-user-run', status: 'completed', updated_at: '2026-09-17T11:00:00Z', internal: false } }),
    event('metadata-order', 'run.updated', '12:00:00', 'worker', { role: 'worker', work_item_id: 'order-b',
      parent: { work_item_id: 'order-b', engine: 'codex', agent_session_id: 'order-b', turn_id: 'one' },
      run: { id: 'internal-metadata-run', status: 'completed', updated_at: '2026-09-17T12:00:00Z', internal: true } })
  ]);
  const rows = await h.manager('/items');
  assert.deepEqual(rows.map(item => item.id), ['order-a', 'order-b']);
  assert.equal(rows[0].last_activity, '2026-09-17T11:00:00.000Z');
  await h.manager('/items/order-b', { method: 'PATCH', body: { version: rows[1].version, title: '새 제목', description: '특수 키워드 내용' } });
  assert.deepEqual((await h.manager('/items')).map(item => item.id), ['order-a', 'order-b']);
  assert.equal((await h.manager('/items?q=' + encodeURIComponent('특수 키워드')))[0].id, 'order-b');
  await h.ingest(pair('order-b', '13:00:00', '13:05:00', 'two', { work_item_id: 'order-b' }));
  assert.equal((await h.manager('/items'))[0].id, 'order-b');
});

test('deleting and immediately restoring invalidates in-flight metadata and summary snapshots without changing accepted contents', async t => {
  const h = await setup(t, { runtime: true, fixture: { delayMs: 1500 } });
  await h.ingest(pair('writing-delete', '09:00:00', '09:05:00', 'one', { text: '기존 내용 보존' }));
  const item = (await h.manager('/items'))[0], sid = (await h.manager(`/items/${item.id}`)).sessions[0].id;
  await h.manager(`/items/${item.id}/metadata/regenerate`, post({ operation_id: 'metadata-before-delete', version: item.version }));
  await h.manager(`/sessions/${sid}/summary/regenerate`, post({ operation_id: 'summary-before-delete' }));
  await eventually(() => Promise.all(['metadata-before-delete', 'summary-before-delete'].map(op => h.manager(`/writing/${op}`))), rows => rows.every(row => row.state === 'running'));
  await remove(h, [item.id]); await restore(h, [item.id]);
  const done = await eventually(() => Promise.all(['metadata-before-delete', 'summary-before-delete'].map(op => h.manager(`/writing/${op}`))), rows => rows.every(row => !['pending', 'running'].includes(row.state)));
  assert.ok(done.every(row => row.state === 'superseded'));
  for (const row of done) await h.finish({ id: row.run_id });
  const recovered = await h.manager(`/items/${item.id}`);
  assert.equal(recovered.item.title, item.title); assert.equal(recovered.item.description, item.description);
  assert.equal(recovered.sessions[0].summary.text, null);
  assert.equal(dbRows(h, 'SELECT revision FROM work_item_deletions')[0].revision, 2);
});

test('soft deletion does not cancel a user-requested runtime job and its completed result returns with restore', async t => {
  const h = await setup(t, { runtime: true });
  await h.ingest(pair('running-delete', '09:00:00', '09:05:00', 'one', { work_item_id: 'running-work' }));
  const run = await h.run({ work_item_id: 'running-work', fixture: { delayMs: 1200 } });
  await remove(h, ['running-work']);
  const result = await h.finish(run); assert.equal(result.status, 'completed'); assert.ok(result.artifact);
  await eventually(() => h.manager('/items?trash=true'), rows => rows[0]?.state === 'completed'
    && Date.parse(rows[0].last_activity) >= Date.parse(result.updated_at));
  assert.deepEqual(await h.manager('/items'), []);
  await restore(h, ['running-work']);
  const detail = await h.manager('/items/running-work');
  assert.ok(detail.runs.some(row => row.id === run.id && row.status === 'completed'));
});

test('hiding and restoring legacy split history preserves visible sibling boundaries and synchronized Jira worklogs', async t => {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('runtime'); await h.start('manager'); await authorize(h);
  await h.ingest([
    ...pair('shared-agent', '09:00:00', '09:05:00', 'one', { work_item_id: 'hidden-log' }),
    ...pair('shared-agent', '09:25:00', '09:30:00', 'two', { work_item_id: 'hidden-log' }),
    ...pair('shared-agent', '09:50:00', '09:55:00', 'three', { work_item_id: 'hidden-log' })
  ]);
  const originalSessions = (await h.manager('/items/hidden-log')).sessions;
  assert.deepEqual(originalSessions.map(session => session.start_at), [
    '2026-09-17T09:00:00.000Z', '2026-09-17T09:25:00.000Z', '2026-09-17T09:50:00.000Z'
  ], 'twenty-minute gaps retain three windows within the same agent-bound item');
  await h.stop('manager');
  // Older versions permitted later turns from one agent to point at another item.
  // Seed that persisted history directly; new ingestion must not recreate the split.
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  try {
    db.exec('BEGIN');
    db.prepare('INSERT INTO work_items(id,title,created_at) VALUES(?,?,?)').run('visible-log', '이전 버전 분리 이력', originalSessions[1].start_at);
    db.prepare('UPDATE work_item_sessions SET work_item_id=? WHERE id=?').run('visible-log', originalSessions[1].id);
    const rows = db.prepare("SELECT id,payload FROM events WHERE json_extract(payload,'$.agent_session_id')='shared-agent' AND json_extract(payload,'$.turn_id')='two'").all();
    assert.equal(rows.length, 2);
    for (const row of rows) db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.payload), work_item_id: 'visible-log' }), row.id);
    db.exec('COMMIT');
  } finally { db.close(); }
  await h.start('manager');
  assert.equal((await h.manager('/items/visible-log')).sessions[0].id, originalSessions[1].id);
  assert.deepEqual((await h.manager('/items/hidden-log')).sessions.map(session => session.id), [originalSessions[0].id, originalSessions[2].id]);
  // A new user prompt requests the closed summaries; restart alone is not a trigger.
  await h.ingest(pair('shared-agent', '09:56:00', '09:57:00', 'after-legacy-restore', { source: 'system_hook' }));
  for (const item of await h.manager('/items')) await createIssue(h, item, `jira-log-${item.id}`);
  await eventually(() => h.manager('/items/visible-log'), detail => detail.sessions[0].worklog?.state === 'synced', 20000);
  await eventually(() => h.manager('/items/hidden-log'), detail => detail.sessions[0].worklog?.state === 'synced', 20000);
  const originalLogs = structuredClone(f.state.worklogs), originalWrites = f.state.calls.filter(call => ['POST', 'PUT'].includes(call.method) && /\/worklog/.test(call.path)).length;
  await remove(h, ['hidden-log']);
  await h.stop('manager'); await h.start('manager');
  await eventually(() => h.manager('/health'), health => health.runtime_connected);
  const sibling = await h.manager('/items/visible-log');
  assert.equal(sibling.sessions[0].closed, true, 'hidden newer sessions still define the original window boundary');
  assert.equal(sibling.sessions[0].worklog.state, 'synced');
  assert.ok(dbRows(h, 'SELECT state FROM jira_worklogs').every(row => row.state === 'synced'));
  await restore(h, ['hidden-log']);
  assert.equal((await h.manager('/items/hidden-log')).sessions[0].worklog.state, 'synced');
  assert.deepEqual(f.state.worklogs, originalLogs);
  assert.equal(f.state.calls.filter(call => ['POST', 'PUT'].includes(call.method) && /\/worklog/.test(call.path)).length, originalWrites);

  f.state.worklogFailure = 403;
  h.env.HARNESS_TEST_WRITING_FIXTURE = JSON.stringify({ rewriteVariant: true });
  await h.stop('manager'); await h.start('manager');
  const sid = (await h.manager('/items/hidden-log')).sessions[0].id;
  await h.manager(`/sessions/${sid}/summary/regenerate`, post({ operation_id: 'changed-summary-for-retry' }));
  await eventually(() => h.manager('/items/hidden-log'), detail => detail.sessions[0].worklog?.state === 'failed', 20000);
  await remove(h, ['hidden-log'], 'delete-failed-worklog'); await restore(h, ['hidden-log'], 'restore-failed-worklog');
  f.state.worklogFailure = null;
  await h.manager(`/sessions/${sid}/worklog/retry`, post({}));
  await eventually(() => h.manager('/items/hidden-log'), detail => detail.sessions[0].worklog?.state === 'synced', 20000);
  assert.equal(f.state.worklogs.length, originalLogs.length, 'restored work retries the same worklog rather than creating a duplicate');
});

test('deletion during the final worklog token read prevents the pending POST before it reaches Jira', async t => {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('runtime'); await h.start('manager'); await authorize(h);
  await h.ingest(pair('auth-gated-log', '09:00:00', '09:05:00', 'one', { work_item_id: 'gated-log' }));
  const item = (await h.manager('/items'))[0]; await createIssue(h, item, 'create-gated-log');
  const sid = (await h.manager(`/items/${item.id}`)).sessions[0].id;
  await h.manager(`/sessions/${sid}/summary/regenerate`, post({ operation_id: 'summarize-before-auth-gate' }));
  await eventually(() => h.manager('/writing/summarize-before-auth-gate'), row => row.state === 'completed', 20000);
  // Stop the manager so no background reads compete for the deterministic token-read gate.
  await h.stop('manager');
  const executable = h.env.HARNESS_KEYCHAIN_BIN, counter = `${executable}.reads`, waiting = `${executable}.waiting`, release = `${executable}.release`;
  const source = fs.readFileSync(executable, 'utf8');
  const gate = `if(r.operation==='get'&&r.account.startsWith('oauth-')){
    const counter=${JSON.stringify(counter)}, waiting=${JSON.stringify(waiting)}, release=${JSON.stringify(release)};
    const count=fs.existsSync(counter)?Number(fs.readFileSync(counter)):0;fs.writeFileSync(counter,String(count+1));
    if(count+1===2){fs.writeFileSync(waiting,'ready');
      const deadline=Date.now()+10000;while(!fs.existsSync(release)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
      if(!fs.existsSync(release))process.exit(4);
    }
  }`;
  fs.writeFileSync(executable, source.replace("if(fs.existsSync(file+'.locked'))", `${gate}\nif(fs.existsSync(file+'.locked'))`));
  await h.start('manager');
  await h.ingest(pair('auth-gated-log', '09:25:00', '09:30:00', 'two', { work_item_id: 'gated-log' }));
  try {
    await eventually(() => fs.existsSync(waiting));
    assert.equal(dbRows(h, `SELECT state FROM jira_worklogs WHERE session_id='${sid}'`)[0].state, 'sending');
    await remove(h, [item.id], 'delete-at-final-auth');
  } finally { fs.writeFileSync(release, 'continue'); }
  await eventually(() => dbRows(h, `SELECT state FROM jira_worklogs WHERE session_id='${sid}'`)[0]?.state, state => state === 'pending');
  assert.equal(f.state.calls.filter(call => call.method === 'POST' && /\/worklog/.test(call.path)).length, 0);
  assert.equal(f.state.worklogs.length, 0);
});
