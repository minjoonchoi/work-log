import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, event, eventually } from '../helpers.mjs';
import { atlFixture, authorize, createIssue, adfText } from '../fixtures/atlassian.mjs';

async function setup(t) {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('runtime'); await h.start('manager'); return { h, f };
}
test('OAuth settings persist references only; state, rotating refresh, concurrent API clients, revoke and restart', async t => {
  const { h, f } = await setup(t);
  await assert.rejects(h.manager('/integrations/atlassian', { method: 'PUT', body: { vault: 'Team Vault', item: 'Atlassian App', client_secret: 'wrong' } }));
  await h.manager('/integrations/atlassian', { method: 'PUT', body: { vault: 'Team Vault', item: 'Atlassian App' } });
  const start = await h.manager('/integrations/atlassian/authorize', { method: 'POST', body: {} }), u = new URL(start.authorization_url);
  const callback = new URL(u.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: 'wrong-state', code: 'fixture-code' });
  assert.equal((await fetch(callback)).status, 400); assert.equal(f.state.tokenCalls.length, 0);
  callback.searchParams.set('state', u.searchParams.get('state'));
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await h.manager('/integrations/atlassian')).connected, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'integrations/atlassian.json'))), { vault: 'Team Vault', item: 'Atlassian App' });
  assert.match(fs.readFileSync(f.opCalls, 'utf8'), /label=client_id,label=client_secret/);
  f.expire();
  const resources = await Promise.all(Array.from({ length: 6 }, () => h.manager('/integrations/atlassian/sites')));
  assert.equal(resources[0][0].id, 'cloud-test'); assert.equal(f.state.tokenCalls.length, 2);
  const token = JSON.parse(fs.readFileSync(f.record)); assert.equal(token.refresh_token, 'fixture-refresh-2'); assert.equal(token.access_token, 'fixture-access-2');
  f.state.rejectAccessOnce = true;
  assert.equal((await h.manager('/integrations/atlassian/confluence-page?cloud_id=cloud-test&id=123')).title, 'Fixture page');
  assert.equal(f.state.tokenCalls.length, 3);
  f.state.paged = true;
  assert.equal((await h.manager('/integrations/atlassian/projects?cloud_id=cloud-test')).values.length, 2);
  assert.equal((await h.manager('/integrations/atlassian/issue-types?cloud_id=cloud-test&project=TEAM')).issueTypes.length, 2);
  await h.stop('manager'); await h.start('manager'); assert.equal((await h.manager('/integrations/atlassian')).connected, true);
  assert.ok(!JSON.stringify(await h.manager('/integrations/atlassian')).includes('fixture-secret'));
  assert.ok(!h.logs.manager.includes('fixture-secret'));
  f.expire(); f.state.rejectRefresh = true;
  await assert.rejects(h.manager('/integrations/atlassian/sites'), /다시 연결/);
  assert.equal((await h.manager('/integrations/atlassian')).connected, false);
  assert.equal(fs.existsSync(f.record), false);
});

test('hook item is created locally; Jira is manual, preserves exact metadata, rejects stale/duplicate creation', async t => {
  const { h, f } = await setup(t); await authorize(h);
  h.hook('codex', { hook_event_name: 'UserPromptSubmit', session_id: 'hook-manual', turn_id: 'one', event_id: 'one', prompt: '권한 정책 정리' });
  let item = (await eventually(() => h.manager('/items'), r => r.length === 1))[0];
  assert.equal(f.state.issues.length, 0);
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: '정확한 제목 & <태그>', description: '첫째 줄\n\n둘째 줄: 원문 유지' } });
  await assert.rejects(createIssue(h, item), /변경/);
  item = (await h.manager('/items'))[0];
  const result = await createIssue(h, item); assert.equal(result.issue.key, 'TEAM-1');
  assert.equal(f.state.issues[0].fields.summary, item.title); assert.equal(adfText(f.state.issues[0].fields.description), item.description);
  await createIssue(h, item); assert.equal(f.state.issues.length, 1);
  await assert.rejects(createIssue(h, item, 'different-operation'), /이미 연결/);
  assert.equal((await h.manager('/integrations/atlassian/jira-issue?cloud_id=cloud-test&key=TEAM-1')).key, 'TEAM-1');
});

test('20-minute boundary → structured summary job → exact comment/start/time worklog; late output updates and restart deduplicates', async t => {
  const { h, f } = await setup(t); await authorize(h);
  await h.ingest(pair('summary-agent', '09:00:00', '09:05:00', 'first', { text: '요구사항을 정리했습니다.' }));
  const item = (await h.manager('/items'))[0]; await createIssue(h, item);
  await h.ingest(pair('summary-agent', '09:25:00', '09:26:00', 'next', { text: '목업을 준비합니다.' }));
  let detail = await eventually(() => h.manager(`/items/${item.id}`), d => d.sessions[0]?.worklog?.state === 'synced', 20000);
  const closed = detail.sessions[0], log = f.state.worklogs[0];
  assert.equal(detail.sessions.length, 2); assert.equal((await h.manager('/items')).length, 1);
  assert.equal(log.timeSpentSeconds, 300); assert.equal(log.started, '2026-09-17T09:00:00.000+0000');
  assert.equal(adfText(log.comment), closed.summary.text); assert.ok(closed.summary.text.split('\n').length <= 6);
  assert.equal(detail.runs.filter(r => r.internal).length, 1);
  const posts = () => f.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/worklog')).length;
  assert.equal(posts(), 1);
  await h.stop('manager'); await h.start('manager');
  await h.ingest([event('summary-agent', 'output', '09:04:00', 'first', { text: '늦게 수집된 중간 응답' })]);
  detail = await eventually(() => h.manager(`/items/${item.id}`), d => d.sessions[0]?.worklog?.state === 'synced' && d.sessions[0]?.summary?.text?.includes('늦게'), 20000);
  assert.equal(f.state.worklogs.length, 1); assert.equal(posts(), 1);
  assert.ok(f.state.calls.some(c => c.method === 'PUT' && c.path.includes('/worklog/100')));
  assert.equal(f.state.worklogs[0].timeSpentSeconds, 300);
  assert.equal(f.state.calls.find(c => c.path.endsWith('/worklog') && c.method === 'POST').query.adjustEstimate, 'leave');
});

test('unknown Jira issue POST is reconciled by property, not blindly recreated', async t => {
  const { h, f } = await setup(t); await authorize(h);
  await h.ingest(pair('issue-loss', '09:00:00', '09:05:00')); const item = (await h.manager('/items'))[0];
  f.state.loseIssue = true; await assert.rejects(createIssue(h, item));
  await assert.rejects(createIssue(h, item, 'next-operation'));
  assert.equal(f.state.issues.length, 1);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager(`/items/${item.id}`)).jira_links[0].state, 'unknown');
  await h.manager('/jira-links/test-issue-operation/resolve', { method: 'POST', body: { key: 'TEAM-1' } });
  assert.equal((await h.manager(`/items/${item.id}`)).jira_links[0].state, 'linked');
});

test('unknown worklog POST reconciles after response loss; rejected writes require deliberate retry', async t => {
  const { h, f } = await setup(t); await authorize(h);
  await h.ingest(pair('lost-log', '09:00:00', '09:05:00')); const item = (await h.manager('/items'))[0]; await createIssue(h, item);
  f.state.loseWorklog = true;
  await h.ingest(pair('lost-log', '09:25:00', '09:26:00', 'next'));
  await eventually(() => h.manager(`/items/${item.id}`), d => d.sessions[0]?.worklog?.state === 'synced', 20000);
  assert.equal(f.state.worklogs.length, 1);
  assert.equal(f.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/worklog')).length, 1);
  f.state.worklogFailure = 403;
  await h.ingest(pair('lost-log', '09:46:00', '09:47:00', 'third'));
  let detail = await eventually(() => h.manager(`/items/${item.id}`), d => d.sessions[1]?.worklog?.state === 'failed', 20000);
  f.state.worklogFailure = null;
  await h.manager(`/sessions/${detail.sessions[1].id}/worklog/retry`, { method: 'POST', body: {} });
  detail = await eventually(() => h.manager(`/items/${item.id}`), d => d.sessions[1]?.worklog?.state === 'synced', 15000);
  assert.equal(f.state.worklogs.length, 2);
  // A late event bridges the old boundary: retain remote evidence and flag manual reconciliation.
  await h.ingest([event('lost-log', 'output', '09:10:00', 't1', { text: '경계를 바꾸는 늦은 출력' })]);
  await eventually(() => h.manager(`/items/${item.id}`), d => d.sessions[0]?.worklog?.state === 'needs_review', 10000);
});

test('summary job enforces six-line bound, idempotent scheduling and failure budget without model API use', async t => {
  const { h } = await setup(t);
  const input = { title: '세션 작업', events: [{ kind: 'input', event_at: '2026-09-17T09:00:00Z', text: '요구를 정리해 주세요' }] };
  const config = { task: 'session.summarize', input, internal: true, work_item_id: 'summary-test', idempotency_key: 'summary-test-key', origin: { engine: 'harness-summary', agent_session_id: 'test', turn_id: 'test' } };
  const run = await h.run(config); assert.equal((await h.run(config)).id, run.id);
  assert.equal((await h.finish(run)).status, 'completed');
  await assert.rejects(h.run({ ...config, input: { ...input, title: 'changed' } }), /다른 입력/);
  const invalid = await h.finish(await h.run({ ...config, idempotency_key: 'invalid-summary', fixture: { scenario: 'summary-too-long' } }));
  assert.notEqual(invalid.status, 'completed'); assert.ok(invalid.round <= 2);
});

test('merged work items preserve each agent window and original Jira issue mapping across days', async t => {
  const { h, f } = await setup(t); await authorize(h);
  await h.ingest([...pair('merge-a', '09:00:00', '09:05:00', 'first-a', { text: '기획' }), ...pair('merge-b', '09:00:00', '09:10:00', 'first-b', { text: '설계' })]);
  const items = await h.manager('/items'), a = items.find(i => i.title === '기획'), b = items.find(i => i.title === '설계');
  await createIssue(h, a, 'merge-operation-a'); await createIssue(h, b, 'merge-operation-b');
  await h.manager('/merge', { method: 'POST', body: { ids: [a.id, b.id], target: a.id, operation_id: 'merge-two-jira' } });
  await h.ingest([...pair('merge-a', '2026-09-18T09:00:00Z', '2026-09-18T09:01:00Z', 'next-a'), ...pair('merge-b', '2026-09-18T09:00:00Z', '2026-09-18T09:02:00Z', 'next-b')]);
  const d = await eventually(() => h.manager(`/items/${a.id}`), d => d.sessions.filter(s => s.worklog?.state === 'synced').length === 2, 20000);
  assert.equal(d.sessions.length, 4); assert.equal(d.jira_links.length, 2); assert.equal((await h.manager('/items')).length, 1);
  assert.equal(f.state.worklogs.find(w => w.issueId === '1').timeSpentSeconds, 300);
  assert.equal(f.state.worklogs.find(w => w.issueId === '2').timeSpentSeconds, 600);
});

test('missing op, locked credential store and denied scopes surface actionable errors without creating Jira issues', async t => {
  const { h, f } = await setup(t);
  await h.manager('/integrations/atlassian', { method: 'PUT', body: { vault: 'wrong vault', item: 'Atlassian App' } });
  await assert.rejects(h.manager('/integrations/atlassian/authorize', { method: 'POST', body: {} }), /접근 실패/);
  await authorize(h);
  fs.writeFileSync(f.record + '.locked', 'fixture locked');
  const status = await h.manager('/integrations/atlassian'); assert.equal(status.connected, false); assert.match(status.message, /접근 실패/);
  await h.ingest(pair('blocked-creds', '09:00:00', '09:05:00')); let item = (await h.manager('/items'))[0];
  await assert.rejects(createIssue(h, item));
  assert.equal((await h.manager(`/items/${item.id}`)).jira_links[0].state, 'failed');
  fs.unlinkSync(f.record + '.locked'); f.state.scopes = ['read:jira-work'];
  await assert.rejects(createIssue(h, item, 'denied-scope-operation'), /쓰기 권한/); assert.equal(f.state.issues.length, 0);
  await h.stop('manager'); h.env.HARNESS_OP_BIN = path.join(h.dir, 'missing-op'); await h.start('manager');
  await assert.rejects(h.manager('/integrations/atlassian/authorize', { method: 'POST', body: {} }), /실행 파일/);
});

test('zero duration is never rounded up or sent as invented Jira work time', async t => {
  const { h, f } = await setup(t); await authorize(h);
  await h.ingest(pair('zero-time', '09:00:00', '09:00:00')); const item = (await h.manager('/items'))[0]; await createIssue(h, item);
  await h.ingest(pair('zero-time', '09:20:00', '09:21:00', 'next'));
  const d = await eventually(() => h.manager(`/items/${item.id}`), d => d.sessions[0]?.worklog?.state === 'failed', 20000);
  assert.match(d.sessions[0].worklog.message, /양수 작업 시간/); assert.equal(f.state.worklogs.length, 0);
});
