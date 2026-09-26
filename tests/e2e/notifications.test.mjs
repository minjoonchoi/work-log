import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, event, eventually } from '../helpers.mjs';
import { atlFixture, authorize, createIssue } from '../fixtures/atlassian.mjs';

const post = body => ({ method: 'POST', body });
const dismiss = (h, row) => h.manager(`/notifications/${row.id}/dismiss`, post({ revision: row.revision }));
async function setup(t) { const h = await new Harness().start('manager'); t.after(() => h.close()); return h; }
const runEvent = (id, status, at, extra = {}) => event(`agent-${id}`, 'run.updated', at, 'first', {
  work_item_id: `item-${id}`, run: { id, task: 'prd.create', internal: false, status, updated_at: `2026-09-17T${at}Z`, message: `${id} ${status}`, ...extra }
});

test('notifications use incident time, preserve failure records when dismissed, and resurface only for a new current revision', async t => {
  const h = await setup(t);
  await h.ingest([runEvent('a', 'failed', '09:00:00'), runEvent('b', 'blocked', '10:00:00'),
    runEvent('c', 'interrupted', '11:00:00'), runEvent('internal', 'failed', '12:00:00', { internal: true }),
    runEvent('cancelled', 'cancelled', '13:00:00'), runEvent('running', 'running', '14:00:00')]);
  assert.deepEqual(await h.manager('/items'), []); assert.deepEqual(await h.manager('/notifications'), []);
  await h.ingest(['a', 'b', 'c', 'internal', 'cancelled', 'running'].flatMap(id =>
    pair(`agent-${id}`, '08:00:00', '08:01:00', 'first', { work_item_id: `item-${id}`, source: 'system_hook' })));
  let rows = await h.manager('/notifications');
  assert.deepEqual(rows.map(row => row.run_id), ['c', 'b', 'a']);
  const original = rows[0], before = await h.manager('/items/item-c');
  assert.equal(before.item.notification_count, 1); assert.equal(before.item.state, 'tracked');
  assert.equal((await dismiss(h, original)).repeated, false);
  assert.equal((await dismiss(h, original)).repeated, true);
  const after = await h.manager('/items/item-c');
  assert.deepEqual(after.runs, before.runs); assert.deepEqual(after.events, before.events);
  assert.equal(after.item.notification_count, 0); assert.equal(after.runs[0].status, 'interrupted');
  await h.stop('manager'); await h.start('manager');
  assert.deepEqual((await h.manager('/notifications')).map(row => row.run_id), ['b', 'a']);
  await h.ingest([runEvent('c', 'pending', '15:00:00')]);
  assert.equal((await h.manager('/notifications')).some(row => row.run_id === 'c'), false);
  await h.ingest([runEvent('c', 'failed', '16:00:00')]);
  rows = await h.manager('/notifications');
  assert.equal(rows[0].id, original.id); assert.notEqual(rows[0].revision, original.revision);
  await assert.rejects(dismiss(h, original), error => error.status === 409);
  await h.ingest([runEvent('c', 'completed', '17:00:00')]);
  assert.equal((await h.manager('/notifications')).some(row => row.run_id === 'c'), false);
  await assert.rejects(dismiss(h, rows[0]), error => error.status === 409);
  await assert.rejects(h.manager(`/notifications/${original.id}/dismiss`, post({ revision: 'invalid' })), error => error.status === 400);
});

test('canonical merges and deleted visibility follow notifications without inferring that a different successful run resolved an older failure', async t => {
  const h = await setup(t);
  await h.ingest(['older', 'newer'].flatMap(id =>
    pair(`agent-${id}`, '08:00:00', '08:01:00', 'first', { work_item_id: `item-${id}`, source: 'system_hook' })));
  await h.ingest([runEvent('older', 'failed', '09:00:00'), runEvent('newer', 'completed', '10:00:00')]);
  await h.manager('/merge', post({ ids: ['item-older', 'item-newer'], target: 'item-newer', operation_id: 'merge-notification-work' }));
  const [failure] = await h.manager('/notifications'); assert.equal(failure.work_item_id, 'item-newer');
  assert.equal(failure.run_id, 'older'); assert.equal((await h.manager('/items'))[0].notification_count, 1);
  await h.manager('/items/delete', post({ ids: ['item-newer'], operation_id: 'hide-notification-work' }));
  assert.deepEqual(await h.manager('/notifications'), []); assert.equal((await h.manager('/quick')).counts.notifications, 0);
  await h.manager('/items/restore', post({ ids: ['item-newer'], operation_id: 'restore-notification-work' }));
  assert.equal((await h.manager('/notifications'))[0].revision, failure.revision);
  await dismiss(h, failure); assert.deepEqual(await h.manager('/notifications'), []);
});

test('only the current summary and metadata failures notify; pending retries and successful replacements retire previous incidents', async t => {
  const h = new Harness(); h.env = { HARNESS_TEST_WRITING_FIXTURE: JSON.stringify({ scenario: 'rewrite-blank' }) };
  t.after(() => h.close()); await h.start('runtime'); await h.start('manager');
  await h.ingest(pair('writing-notifications', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0], sid = (await h.manager(`/items/${item.id}`)).sessions[0].id;
  await h.manager(`/items/${item.id}/metadata/regenerate`, post({ operation_id: 'notify-metadata-failure', version: item.version }));
  await h.manager(`/sessions/${sid}/summary/regenerate`, post({ operation_id: 'notify-summary-failure' }));
  const failures = await eventually(() => h.manager('/notifications'), rows => rows.length === 2);
  assert.deepEqual(failures.map(row => row.kind).sort(), ['metadata', 'summary']);
  const summary = failures.find(row => row.kind === 'summary');
  assert.equal(summary.session_id, sid); assert.ok(summary.run_id); await dismiss(h, summary);
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: '직접 정리한 업무', description: '수동으로 정리했습니다.' } });
  assert.deepEqual(await h.manager('/notifications'), []);
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = JSON.stringify({ delayMs: 900 }); await h.start('manager');
  await h.manager(`/sessions/${sid}/summary/regenerate`, post({ operation_id: 'notify-summary-retry' }));
  assert.deepEqual(await h.manager('/notifications'), []);
  await eventually(() => h.manager('/writing/notify-summary-retry'), row => row.state === 'completed', 20000);
  assert.deepEqual(await h.manager('/notifications'), []);
  assert.equal((await h.manager('/writing/notify-summary-failure')).state, 'failed');
});

test('a later summary admission failure is not hidden by a completed writer for an older source snapshot', async t => {
  const h = new Harness(); h.env = { HARNESS_TEST_SESSION_SUMMARIES: '1' };
  t.after(() => h.close()); await h.start('runtime'); await h.start('manager');
  await h.ingest(pair('admission-notification', '09:00:00', '09:05:00', 'first'));
  const item = (await h.manager('/items'))[0], sid = (await h.manager(`/items/${item.id}`)).sessions[0].id;
  await h.manager(`/sessions/${sid}/summary/regenerate`, post({ operation_id: 'accepted-small-summary' }));
  await eventually(() => h.manager('/writing/accepted-small-summary'), row => row.state === 'completed', 20000);
  const events = Array.from({ length: 1000 }, (_, index) => pair('admission-notification', '09:10:00', '09:15:00', `more-${index}`)).flat();
  for (let offset = 0; offset < events.length; offset += 500) await h.ingest(events.slice(offset, offset + 500));
  await h.ingest(pair('admission-notification', '09:35:00', '09:40:00', 'closed', { source: 'system_hook' }));
  const [notification] = await eventually(() => h.manager('/notifications'), rows => rows.length === 1);
  assert.equal(notification.kind, 'summary'); assert.equal(notification.session_id, sid); assert.match(notification.message, /2000/);
  assert.equal('run_id' in notification, false); assert.equal((await h.manager('/writing/accepted-small-summary')).state, 'completed');
});

test('Jira creation, transition and content failures have local actions; read-only notification aggregation makes no API calls', async t => {
  const h = new Harness(), f = await atlFixture(h); h.env.HARNESS_TEST_SESSION_SUMMARIES = '0';
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('manager'); await authorize(h);
  await h.ingest(pair('jira-notification', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0]; f.state.loseIssue = true;
  await assert.rejects(createIssue(h, item, 'notify-issue-create'));
  let rows = await h.manager('/notifications'); assert.equal(rows[0].kind, 'jira_issue');
  assert.equal(rows[0].link_operation_id, 'notify-issue-create');
  await h.manager('/jira-links/notify-issue-create/resolve', post({ key: f.state.issues[0].key }));
  assert.deepEqual(await h.manager('/notifications'), []);
  let detail = await eventually(() => h.manager(`/items/${item.id}`), value => value.jira_links[0]?.view?.data);
  f.state.transitionFailure = 403;
  await assert.rejects(h.manager('/jira-links/notify-issue-create/transition', post({ operation_id: 'notify-status-failure', transition_id: '21',
    expected_status_id: detail.jira_links[0].view.data.issue.status.id, expected_updated: detail.jira_links[0].view.data.issue.updated })));
  f.state.issueUpdateFailure = 403;
  await assert.rejects(h.manager('/jira-links/notify-issue-create/content', post({ operation_id: 'notify-content-failure', version: detail.item.version,
    expected_updated: detail.jira_links[0].view.data.issue.updated })));
  const count = f.state.calls.length;
  rows = await h.manager('/notifications'); assert.deepEqual(rows.map(row => row.kind).sort(), ['jira_content', 'jira_transition']);
  assert.ok(rows.every(row => row.link_operation_id === 'notify-issue-create' && row.action_label === 'Jira 연결 확인'));
  await h.manager('/quick'); await h.manager('/items'); assert.equal(f.state.calls.length, count);
  f.state.transitionFailure = null; f.state.issueUpdateFailure = null;
  detail = await h.manager(`/items/${item.id}`);
  await h.manager('/jira-links/notify-issue-create/content', post({ operation_id: 'notify-content-success', version: detail.item.version,
    expected_updated: detail.jira_links[0].view.data.issue.updated }));
  rows = await h.manager('/notifications'); assert.deepEqual(rows.map(row => row.kind), ['jira_transition']);
});

test('unknown Jira creation survives merging with a successfully linked issue and retains its incident identity', async t => {
  const h = new Harness(), f = await atlFixture(h); h.env.HARNESS_TEST_SESSION_SUMMARIES = '0';
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('manager'); await authorize(h);
  await h.ingest([...pair('unknown-item', '09:00:00', '09:05:00', 'first', { work_item_id: 'unknown-item' }),
    ...pair('linked-item', '10:00:00', '10:05:00', 'first', { work_item_id: 'linked-item' })]);
  const items = await h.manager('/items'); f.state.loseIssue = true;
  await assert.rejects(createIssue(h, items.find(item => item.id === 'unknown-item'), 'unknown-creation-source'));
  await createIssue(h, items.find(item => item.id === 'linked-item'), 'linked-creation-target');
  const [original] = await h.manager('/notifications');
  await h.manager('/merge', post({ ids: ['unknown-item', 'linked-item'], target: 'linked-item', operation_id: 'merge-uncertain-creation' }));
  const [merged] = await h.manager('/notifications');
  assert.equal(merged.kind, 'jira_issue'); assert.equal(merged.work_item_id, 'linked-item');
  assert.equal(merged.id, original.id); assert.equal(merged.revision, original.revision);
  await dismiss(h, original); await h.stop('manager'); await h.start('manager');
  assert.deepEqual(await h.manager('/notifications'), []);
});

test('Jira worklog unknown and retired-window review incidents remain actionable without repeated acknowledgement resurfacing', async t => {
  const h = await setup(t);
  await h.ingest([...pair('worklog-notification', '09:00:00', '09:05:00', 'one'), ...pair('worklog-notification', '09:25:00', '09:30:00', 'two')]);
  const item = (await h.manager('/items'))[0], sessions = (await h.manager(`/items/${item.id}`)).sessions;
  await h.stop('manager');
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  for (const [index, session] of sessions.entries()) db.prepare('INSERT INTO jira_worklogs VALUES(?,?,?,?,?,?,?,?,?)').run(session.id, 'journal-link', index ? 'needs_review' : 'unknown',
    `source-${index}`, `operation-${index}`, null, JSON.stringify({ started: session.start_at, seconds: 300, comment: '보존된 내용' }), 'Jira 기록을 확인하세요.', `2026-09-17T1${index}:00:00Z`);
  db.prepare('UPDATE work_item_sessions SET active=0 WHERE id=?').run(sessions[1].id); db.close();
  await h.start('manager');
  const rows = await h.manager('/notifications'); assert.equal(rows.length, 2); assert.ok(rows.every(row => row.kind === 'jira_worklog'));
  assert.equal(rows[0].session_id, sessions[1].id, 'retired window with existing Jira effects still needs explicit review');
  await dismiss(h, rows[1]);
  await h.stop('manager'); await h.start('manager');
  const remaining = await h.manager('/notifications'); assert.equal(remaining.length, 1); assert.equal(remaining[0].id, rows[0].id);
});
