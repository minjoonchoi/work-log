import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, eventually } from '../helpers.mjs';
import { atlFixture, authorize, createIssue, adfText } from '../fixtures/atlassian.mjs';

const post = body => ({ method: 'POST', body });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const detail = (h, id) => h.manager(`/items/${id}`);
const logs = f => f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/worklog'));
const issues = f => f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/issue'));
const marker = worklog => worklog.properties.find(property => property.key === 'work-log').value;
const finished = (h, operation) => eventually(() => h.manager(`/writing/${operation}`), row => !['pending', 'running'].includes(row.state), 20000);
async function setup(t, { noCredentials = false } = {}) {
  const h = new Harness(), f = await atlFixture(h);
  if (noCredentials) h.env = { ...h.env, HARNESS_OP_BIN: path.join(h.dir, 'not-installed-op'), HARNESS_KEYCHAIN_BIN: path.join(h.dir, 'not-installed-keychain') };
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('runtime'); await h.start('manager'); return { h, f };
}
async function seed(h, agent, id, count = 3) {
  for (let index = 0; index < count; index++) {
    const start = new Date(Date.parse('2026-09-17T09:00:00Z') + index * 30 * 60000);
    await h.ingest(pair(agent, start.toISOString(), new Date(+start + 5 * 60000).toISOString(), `turn-${index}`, { work_item_id: id, text: `${id} 기록 ${index}` }));
  }
  return eventually(() => detail(h, id), value => value.sessions.filter(session => session.closed && session.summary?.state === 'completed').length === count - 1, 20000);
}
const connect = (h, item, issue, operation_id) => h.manager(`/items/${item.id}/jira/link`, post({ version: item.version, operation_id,
  cloud_id: 'cloud-test', key: issue.key, issue_id: issue.id }));
async function synced(h, id, count) {
  return eventually(() => detail(h, id), value => value.sessions.filter(session => session.worklog?.state === 'synced').length === count, 20000);
}

test('local history, summaries, metadata, artifacts, calendar, merge and restoration work with no Jira configuration or credential programs', async t => {
  const { h, f } = await setup(t, { noCredentials: true });
  const initial = await seed(h, 'offline-agent', 'offline-item');
  assert.equal((await h.manager('/integrations/atlassian')).connected, false);
  assert.deepEqual(initial.jira_links, []); assert.ok(initial.sessions.every(session => session.worklog === null));
  assert.equal(initial.sessions.filter(session => session.summary?.state === 'completed').length, 2);
  await h.manager('/items/offline-item/metadata/regenerate', post({ operation_id: 'offline-metadata-rewrite', version: initial.item.version }));
  const writing = await finished(h, 'offline-metadata-rewrite'); assert.equal(writing.state, 'completed');
  const generated = await h.runtime(`/runs/${writing.run_id}`); assert.equal(generated.internal, true); assert.equal(generated.attempts.length, 1);
  const current = await detail(h, 'offline-item'); assert.match(current.item.description, /## 작업 배경/);
  const history = await h.manager(`/items/offline-item/history?session_id=${current.sessions[0].id}`);
  assert.equal(history.records.length, 2); assert.equal(history.records[0].kind, 'output');
  assert.equal((await h.manager('/items?q=' + encodeURIComponent('offline-item'))).length, 1);
  assert.equal((await h.manager('/calendar?start=2026-09-17T00:00:00Z&end=2026-09-18T00:00:00Z&mode=sessions')).length, 3);
  const run = await h.finish(await h.run({ work_item_id: 'offline-item' })); assert.equal(run.status, 'completed', run.message);
  const artifact = await h.manager(`/artifacts/${run.id}`); assert.ok(artifact.text.includes('REQ-001'));
  await h.ingest(pair('offline-merged', '11:00:00', '11:05:00', 'merge', { work_item_id: 'offline-secondary', text: '별도 로컬 대화' }));
  await h.manager('/merge', post({ ids: ['offline-item', 'offline-secondary'], target: 'offline-item', operation_id: 'offline-merge-command' }));
  await h.manager('/items/delete', post({ ids: ['offline-item'], operation_id: 'offline-delete-command' }));
  assert.equal((await h.manager('/items')).length, 0);
  await h.stop('manager'); await h.start('manager');
  await h.manager('/items/restore', post({ ids: ['offline-item'], operation_id: 'offline-restore-command' }));
  const restored = await detail(h, 'offline-item');
  assert.ok(restored.sessions.length >= 4); assert.equal(restored.item.title, current.item.title);
  assert.ok(restored.events.some(event => event.text === '별도 로컬 대화'));
  assert.deepEqual(f.state.calls, []); assert.deepEqual(f.state.tokenCalls, []); assert.equal(fs.existsSync(f.opCalls), false);
});

test('linking an existing issue later backfills each closed session once and regenerations or retries retain its worklog identity', async t => {
  const { h, f } = await setup(t), before = await seed(h, 'late-existing', 'late-existing-item');
  assert.equal(f.state.worklogs.length, 0); assert.equal(issues(f).length, 0);
  await authorize(h); const issue = f.addIssue({ summary: '기존 이슈는 그대로 유지' }, 'TEAM-88');
  await pause(1100); assert.equal(f.state.worklogs.length, 0, 'OAuth alone does not assign a Jira issue');
  await connect(h, before.item, issue, 'link-late-existing');
  let current = await synced(h, before.item.id, 2);
  const closed = current.sessions.filter(session => session.closed), original = structuredClone(f.state.worklogs);
  assert.equal(f.state.worklogs.length, 2); assert.equal(logs(f).length, 2); assert.equal(issues(f).length, 0);
  assert.equal(current.sessions.find(session => !session.closed).worklog, null);
  for (const session of closed) {
    const remote = f.state.worklogs.find(worklog => marker(worklog).session_id === session.id);
    assert.equal(remote.issueId, issue.id); assert.equal(remote.timeSpentSeconds, 300);
    assert.equal(remote.started, session.start_at.replace('Z', '+0000')); assert.equal(adfText(remote.comment), session.summary.text);
  }
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = JSON.stringify({ rewriteVariant: true }); await h.start('manager');
  assert.equal((await connect(h, before.item, issue, 'link-late-existing')).repeated, true);
  await h.manager(`/sessions/${closed[0].id}/summary/regenerate`, post({ operation_id: 'rewrite-existing-worklog' }));
  assert.equal((await finished(h, 'rewrite-existing-worklog')).state, 'completed');
  current = await eventually(() => detail(h, before.item.id), value => value.sessions.find(session => session.id === closed[0].id)?.worklog?.state === 'synced'
    && f.state.worklogs.some(worklog => marker(worklog).session_id === closed[0].id && adfText(worklog.comment).includes('작업 기록')), 15000);
  const revised = f.state.worklogs.find(worklog => marker(worklog).session_id === closed[0].id), previous = original.find(worklog => marker(worklog).session_id === closed[0].id);
  assert.equal(revised.id, previous.id); assert.equal(marker(revised).operation_id, marker(previous).operation_id);
  assert.equal(revised.started, previous.started); assert.equal(revised.timeSpentSeconds, previous.timeSpentSeconds); assert.equal(logs(f).length, 2);
  assert.ok(f.state.calls.some(call => call.method === 'PUT' && call.path.endsWith(`/worklog/${previous.id}`)));
  f.state.worklogFailure = 403;
  await h.ingest(pair('late-existing', '10:30:00', '10:35:00', 'turn-3', { text: '연결 후 새 세션' }));
  current = await eventually(() => detail(h, before.item.id), value => value.sessions.some(session => session.worklog?.state === 'failed'), 20000);
  const failed = current.sessions.find(session => session.worklog?.state === 'failed');
  const failedRequest = logs(f).find(call => call.body.properties[0].value.session_id === failed.id);
  f.state.worklogFailure = null;
  await h.manager(`/sessions/${failed.id}/worklog/retry`, post({})); await synced(h, before.item.id, 3);
  assert.equal(f.state.worklogs.length, 3); assert.equal(new Set(f.state.worklogs.map(worklog => marker(worklog).session_id)).size, 3);
  assert.equal(marker(f.state.worklogs.find(worklog => marker(worklog).session_id === failed.id)).operation_id, failedRequest.body.properties[0].value.operation_id);
  const count = logs(f).length; await h.manager(`/sessions/${failed.id}/worklog/retry`, post({}));
  await h.stop('manager'); await h.start('manager'); await pause(1100); assert.equal(logs(f).length, count);
  assert.equal(issue.fields.summary, '기존 이슈는 그대로 유지'); assert.equal(issues(f).length, 0);
});

test('manual issue creation backfills prior local sessions and reconnect catches up without duplicating response-lost writes', async t => {
  const { h, f } = await setup(t), before = await seed(h, 'late-created', 'late-created-item', 2);
  await authorize(h); assert.equal(issues(f).length, 0); f.state.loseWorklog = true;
  await createIssue(h, before.item, 'create-after-local-history');
  await synced(h, before.item.id, 1);
  assert.equal(issues(f).length, 1); assert.equal(logs(f).length, 1); assert.equal(f.state.worklogs.length, 1);
  assert.equal(f.state.issues[0].fields.summary, before.item.title); assert.equal(adfText(f.state.issues[0].fields.description), before.item.description);
  await createIssue(h, before.item, 'create-after-local-history'); assert.equal(issues(f).length, 1);
  await h.manager('/integrations/atlassian', { method: 'DELETE' });
  await h.ingest(pair('late-created', '10:00:00', '10:05:00', 'turn-2', { text: '연결 해제 후에도 로컬 작업은 계속' }));
  const offline = await eventually(() => detail(h, before.item.id), value => value.sessions.filter(session => session.summary?.state === 'completed').length === 2, 20000);
  assert.equal(f.state.worklogs.length, 1); assert.equal(offline.sessions.length, 3);
  const local = await h.finish(await h.run({ work_item_id: before.item.id })); assert.equal(local.status, 'completed');
  await h.stop('manager'); await h.start('manager'); await authorize(h);
  await synced(h, before.item.id, 2); assert.equal(f.state.worklogs.length, 2); assert.equal(logs(f).length, 2); assert.equal(issues(f).length, 1);
  assert.equal(new Set(f.state.worklogs.map(worklog => marker(worklog).session_id)).size, 2);
});

test('merging linked work preserves each agent session original Jira issue across subsequent closures and summary rewrites', async t => {
  const { h, f } = await setup(t), a = await seed(h, 'original-agent-a', 'original-a', 2), b = await seed(h, 'original-agent-b', 'original-b', 2);
  await authorize(h); const issueA = f.addIssue({ summary: '원래 기획 이슈' }), issueB = f.addIssue({ summary: '원래 개발 이슈' });
  await connect(h, a.item, issueA, 'link-original-issue-a'); await connect(h, b.item, issueB, 'link-original-issue-b');
  await synced(h, a.item.id, 1); await synced(h, b.item.id, 1); const previousIds = f.state.worklogs.map(worklog => worklog.id).sort();
  await h.manager('/merge', post({ ids: [a.item.id, b.item.id], target: a.item.id, operation_id: 'merge-preserving-remote-owners' }));
  await h.ingest([
    ...pair('original-agent-a', '10:00:00', '10:05:00', 'turn-2', { text: '기획 이어가기' }),
    ...pair('original-agent-b', '10:00:00', '10:05:00', 'turn-2', { text: '개발 이어가기' })
  ]);
  const merged = await synced(h, a.item.id, 4);
  assert.equal(merged.jira_links.length, 2); assert.equal(merged.sessions.length, 6); assert.equal((await h.manager('/items')).length, 1);
  for (const session of merged.sessions.filter(session => session.worklog?.state === 'synced')) {
    const remote = f.state.worklogs.find(worklog => marker(worklog).session_id === session.id);
    assert.equal(remote.issueId, session.agent_session_id === 'original-agent-a' ? issueA.id : issueB.id);
  }
  assert.ok(previousIds.every(id => f.state.worklogs.some(worklog => worklog.id === id)));
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = JSON.stringify({ rewriteVariant: true }); await h.start('manager');
  const fromB = merged.sessions.find(session => session.agent_session_id === 'original-agent-b' && session.worklog?.state === 'synced');
  const old = structuredClone(f.state.worklogs.find(worklog => marker(worklog).session_id === fromB.id));
  await h.manager(`/sessions/${fromB.id}/summary/regenerate`, post({ operation_id: 'rewrite-after-local-merge' }));
  assert.equal((await finished(h, 'rewrite-after-local-merge')).state, 'completed');
  await eventually(() => f.state.worklogs.find(worklog => worklog.id === old.id), row => adfText(row.comment).includes('작업 기록'), 15000);
  const updated = f.state.worklogs.find(worklog => worklog.id === old.id);
  assert.equal(updated.issueId, issueB.id); assert.equal(marker(updated).operation_id, marker(old).operation_id);
  assert.equal(f.state.worklogs.length, 4); assert.equal(logs(f).length, 4); assert.equal(issues(f).length, 0);
});
