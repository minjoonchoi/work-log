import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, pair, eventually } from '../helpers.mjs';
import { atlFixture, authorize, createIssue } from '../fixtures/atlassian.mjs';

async function setup(t) {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('runtime'); await h.start('manager'); await authorize(h);
  await h.ingest(pair('jira-issues', '09:00:00', '09:05:00', 'first', { text: '권한 모델을 설계합니다.' }));
  const item = (await h.manager('/items'))[0]; return { h, f, item };
}
const preview = (h, key) => h.manager(`/integrations/atlassian/jira-preview?cloud_id=cloud-test&key=${encodeURIComponent(key)}`);
const connect = (h, item, issue, extra = {}) => h.manager(`/items/${item.id}/jira/link`, { method: 'POST', body: {
  operation_id: 'link-existing-issue', version: item.version, cloud_id: 'cloud-test', issue_id: issue.id, key: issue.key, ...extra } });
const detail = (h, item) => h.manager(`/items/${item.id}`);
const ready = (h, item) => eventually(() => detail(h, item), d => !!d.jira_links[0]?.view?.data);
const refresh = (h, op = 'link-existing-issue') => h.manager(`/jira-links/${op}/refresh`, { method: 'POST', body: {} });
const change = (h, current, extra = {}) => h.manager(`/jira-links/${current.operation_id}/transition`, { method: 'POST', body: {
  operation_id: 'change-issue-status', transition_id: '21', expected_status_id: current.view.data.issue.status.id,
  expected_updated: current.view.data.issue.updated, ...extra } });
const posts = f => f.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/transitions'));
const search = (h, query, cursor) => h.manager(`/integrations/atlassian/jira-search?${new URLSearchParams({ cloud_id: 'cloud-test', query, ...(cursor ? { next_page_token: cursor } : {}) })}`);

test('title search pages through accessible Jira issues; key and URL queries resolve directly without external writes', async t => {
  const { h, f } = await setup(t);
  for (let i = 0; i < 23; i++) f.addIssue({ summary: `권한 관리 기능 ${i}` });
  f.addIssue({ summary: '검색에 포함하지 않을 일정' });
  f.addIssue({ summary: '권한 관리 비공개' }).hidden = true;
  const first = await search(h, '권한 관리');
  assert.equal(first.issues.length, 20); assert.ok(first.next_page_token);
  const next = await search(h, '권한 관리', first.next_page_token);
  assert.equal(next.issues.length, 3); assert.equal(next.next_page_token, null);
  assert.equal(new Set([...first.issues, ...next.issues].map(i => i.id)).size, 23);
  assert.equal((await search(h, 'team-12')).issues[0].key, 'TEAM-12');
  assert.equal((await search(h, 'https://fixture.atlassian.net/browse/TEAM-2')).issues[0].id, '2');
  assert.deepEqual((await search(h, 'TEAM-999')).issues, []);
  assert.equal(f.state.calls.filter(c => c.method !== 'GET').length, 0);
  assert.ok(f.state.calls.filter(c => c.path.endsWith('/search/jql')).every(c => c.query.fields === 'summary,status,updated' && c.query.maxResults === '20'));
});

test('search text cannot inject JQL; empty, oversized, denied and failed searches return clear errors', async t => {
  const { h, f } = await setup(t); f.addIssue({ summary: '정상 업무' });
  assert.deepEqual((await search(h, '제목" OR project = SECRET ORDER BY created')).issues, []);
  const jql = f.state.calls.find(c => c.path.endsWith('/search/jql')).query.jql;
  assert.ok(!jql.includes('OR project =')); assert.ok(!jql.includes('ORDER BY created'));
  await assert.rejects(search(h, '   '), /입력/);
  await assert.rejects(search(h, '*?()'), /단어/);
  await assert.rejects(search(h, '가'.repeat(201)), /200자/);
  f.state.searchFailure = 429; await assert.rejects(search(h, '정상'), /호출 한도/);
  f.state.searchFailure = null; f.state.scopes = ['read:page:confluence'];
  await assert.rejects(search(h, '정상'), /OAuth 권한/);
  assert.equal(f.state.calls.filter(c => c.method !== 'GET').length, 0);
});

test('a selected title search result is checked again before linking and keeps existing metadata', async t => {
  const { h, f, item } = await setup(t); f.addIssue({ summary: '동일 제목' }); const selected = f.addIssue({ summary: '동일 제목' });
  const result = await search(h, '동일 제목'); assert.equal(result.issues.length, 2);
  f.state.issueReadFailure = 403;
  await assert.rejects(connect(h, item, result.issues[1]), /권한/);
  assert.equal((await detail(h, item)).jira_links.length, 0);
  f.state.issueReadFailure = null;
  await connect(h, item, result.issues[1]);
  const d = await ready(h, item); assert.equal(d.jira_links[0].issue.id, selected.id);
  assert.equal(d.item.title, item.title); assert.equal(selected.fields.summary, '동일 제목');
});

test('existing key/URL preview → confirmed local link → restart, without creating or editing the remote issue', async t => {
  const { h, f, item } = await setup(t), issue = f.addIssue({ summary: '기존 프로젝트 이슈' }, 'TEAM-42');
  const before = JSON.stringify(issue);
  assert.equal((await preview(h, 'team-42')).id, issue.id);
  assert.equal((await preview(h, 'https://fixture.atlassian.net/browse/TEAM-42?focusedCommentId=1')).status.name, '해야 할 일');
  assert.equal((await detail(h, item)).jira_links.length, 0);
  await assert.rejects(preview(h, 'https://other.atlassian.net/browse/TEAM-42'), /선택한 Jira 사이트/);
  await assert.rejects(preview(h, 'https://fixture.atlassian.net@evil.example/browse/TEAM-42'), /사이트/);
  await assert.rejects(preview(h, 'TEAM-404'), /찾을 수 없습니다/);
  await assert.rejects(connect(h, item, issue, { issue_id: '999' }), /연결 대상/);
  await connect(h, item, issue);
  const d = await ready(h, item);
  assert.equal(d.item.title, item.title); assert.equal(d.item.description, item.description);
  assert.equal(d.jira_links[0].view.data.issue.title, '기존 프로젝트 이슈');
  assert.equal(d.jira_links[0].issue.url, 'https://fixture.atlassian.net/browse/TEAM-42');
  assert.equal(JSON.stringify(issue), before);
  assert.equal(f.state.calls.filter(c => ['POST', 'PUT'].includes(c.method)).length, 0);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await connect(h, item, issue)).repeated, true);
  await assert.rejects(createIssue(h, item, 'create-after-link'), /이미 연결/);
  assert.equal((await detail(h, item)).jira_links.length, 1);
});

test('link confirmation rechecks version and concurrent linkage after the remote lookup', async t => {
  const { h, f, item } = await setup(t), issue = f.addIssue();
  f.state.issueReadDelay = 250;
  const pending = connect(h, item, issue); // Attach rejection immediately, before the intentional race.
  const rejected = assert.rejects(pending, /변경/);
  await eventually(() => f.state.calls.some(c => c.path.endsWith('/issue/TEAM-1')));
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: '변경된 업무', description: item.description } });
  await rejected;
  const fresh = (await detail(h, item)).item;
  const attempts = await Promise.allSettled([connect(h, fresh, issue), connect(h, fresh, issue, { operation_id: 'second-link-request' })]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await detail(h, item)).jira_links.length, 1);
  assert.equal(f.state.issues.length, 1);
});

test('created issue loads allowed transitions; duplicate POST returns one 204 transition and actual refreshed status', async t => {
  const { h, f, item } = await setup(t); await createIssue(h, item);
  const current = (await ready(h, item)).jira_links[0];
  assert.equal(current.view.data.issue.status.name, '해야 할 일');
  assert.ok(f.state.calls.some(c => c.path.endsWith('/transitions') && c.query.expand === 'transitions.fields'));
  f.state.transitionDelay = 150;
  const results = await Promise.all([change(h, current), change(h, current)]);
  assert.equal(results[0].state, 'applied'); assert.equal(results[1].repeated, true); assert.equal(posts(f).length, 1);
  const updated = (await detail(h, item)).jira_links[0];
  assert.equal(updated.view.data.issue.status.name, '진행 중');
  assert.ok(!updated.view.data.transitions.some(t => t.id === '21'));
  assert.equal((await detail(h, item)).item.state, item.state);
  await assert.rejects(change(h, current, { transition_id: '31' }), /내용이 다릅니다/);
});

test('external status changes, required fields, and revoked transition permissions prevent writes', async t => {
  const { h, f, item } = await setup(t), issue = f.addIssue(); await connect(h, item, issue);
  const old = (await ready(h, item)).jira_links[0]; f.setStatus(issue, 'progress');
  await assert.rejects(change(h, old), /최신 상태/); assert.equal(posts(f).length, 0);
  let current = (await detail(h, item)).jira_links[0];
  await assert.rejects(change(h, current, { operation_id: 'required-field-change', transition_id: '41' }), /추가 필수 입력/);
  f.state.noTransitions = true;
  await assert.rejects(change(h, current, { operation_id: 'removed-transition', transition_id: '31' }), /가능한 상태 변경/);
  f.state.noTransitions = false; f.state.scopes = ['read:jira-work'];
  await refresh(h); current = (await detail(h, item)).jira_links[0];
  assert.equal(current.view.data.can_write, false);
  await assert.rejects(change(h, current, { operation_id: 'read-only-change', transition_id: '31' }), /쓰기 권한/);
  assert.equal(posts(f).length, 0);
});

test('failed status read keeps last observation; explicit refresh recovers moved keys and permission failures', async t => {
  const { h, f, item } = await setup(t), issue = f.addIssue(); await connect(h, item, issue); await ready(h, item);
  f.state.issueReadFailure = 403;
  await assert.rejects(refresh(h), /권한/);
  let current = (await detail(h, item)).jira_links[0];
  assert.equal(current.view.data.issue.status.name, '해야 할 일'); assert.match(current.view.error, /권한/);
  f.state.issueReadFailure = null; issue.key = 'MOVED-7'; f.setStatus(issue, 'done');
  await refresh(h); current = (await detail(h, item)).jira_links[0];
  assert.equal(current.issue.url, 'https://fixture.atlassian.net/browse/MOVED-7');
  assert.equal(current.view.error, null); assert.equal(current.view.data.issue.status.name, '완료');
});

test('rejected write permits deliberate retry; lost successful response is observed after restart without another POST', async t => {
  const { h, f, item } = await setup(t), issue = f.addIssue(); await connect(h, item, issue);
  const current = (await ready(h, item)).jira_links[0];
  f.state.transitionFailure = 403;
  await assert.rejects(change(h, current), /권한/);
  assert.equal((await detail(h, item)).jira_links[0].change.state, 'failed');
  f.state.transitionFailure = null; f.state.loseTransition = true;
  await assert.rejects(change(h, current, { operation_id: 'retry-lost-transition' }), /응답/);
  assert.equal((await detail(h, item)).jira_links[0].change.state, 'unknown');
  await assert.rejects(change(h, current, { operation_id: 'dont-retry-unknown' }), /이전 상태 변경/);
  await h.stop('manager'); await h.start('manager');
  await refresh(h);
  const after = (await detail(h, item)).jira_links[0];
  assert.equal(after.change.state, 'observed'); assert.match(after.change.message, /응답은 확인하지 못했습니다/);
  assert.equal(after.view.data.issue.status.id, '3');
  await change(h, current, { operation_id: 'retry-lost-transition' }); assert.equal(posts(f).length, 2);
});

test('an unconfirmed rejected write remains blocked across restarts; reads do not invent completion', async t => {
  const { h, f, item } = await setup(t), issue = f.addIssue(); await connect(h, item, issue);
  const current = (await ready(h, item)).jira_links[0]; f.state.transitionFailure = 503;
  await assert.rejects(change(h, current));
  await h.stop('manager'); await h.start('manager');
  f.state.transitionFailure = null; await refresh(h);
  const after = (await detail(h, item)).jira_links[0];
  assert.equal(after.change.state, 'unknown'); assert.equal(after.view.data.issue.status.id, '10000');
  await assert.rejects(change(h, current, { operation_id: 'new-blocked-request' }), /먼저 새로고침/);
  assert.equal(posts(f).length, 1);
});

test('confirmed 204 with a failed follow-up read preserves success and blocks stale UI changes until refresh', async t => {
  const { h, f, item } = await setup(t), issue = f.addIssue(); await connect(h, item, issue);
  const current = (await ready(h, item)).jira_links[0]; f.state.failReadAfterTransition = true;
  assert.equal((await change(h, current)).state, 'applied');
  const cached = (await detail(h, item)).jira_links[0];
  assert.equal(cached.change.state, 'applied'); assert.ok(cached.view.error);
  assert.equal(cached.view.data.issue.status.id, '10000');
  await change(h, current); assert.equal(posts(f).length, 1);
  f.state.issueReadFailure = null; await refresh(h);
  assert.equal((await detail(h, item)).jira_links[0].view.data.issue.status.id, '3');
});

test('manager crash during a transition preserves the intent and recovers by observation, without replay', async t => {
  const { h, f, item } = await setup(t), issue = f.addIssue(); await connect(h, item, issue);
  const current = (await ready(h, item)).jira_links[0]; f.state.transitionDelay = 600;
  const pending = change(h, current).catch(() => null);
  await eventually(() => posts(f).length === 1);
  await h.stop('manager', 'SIGKILL'); await pending;
  await eventually(() => issue.fields.status.id === '3');
  await h.start('manager');
  assert.equal((await detail(h, item)).jira_links[0].change.state, 'unknown');
  await refresh(h);
  assert.equal((await detail(h, item)).jira_links[0].change.state, 'observed');
  assert.equal(posts(f).length, 1);
});

test('linked existing issue receives closed session worklogs; merged issues keep independent status and mappings', async t => {
  const { h, f, item } = await setup(t), issue = f.addIssue({}, 'PLAN-80'); await connect(h, item, issue);
  await h.ingest(pair('another-jira-item', '09:00:00', '09:05:00', 'first', { text: '다른 업무' }));
  const second = (await h.manager('/items')).find(i => i.id !== item.id), other = f.addIssue({}, 'DEV-81');
  await connect(h, second, other, { operation_id: 'other-issue-link' });
  await h.manager('/merge', { method: 'POST', body: { ids: [item.id, second.id], target: item.id, operation_id: 'jira-merge-items' } });
  await h.ingest([...pair('jira-issues', '09:25:00', '09:26:00', 'next', { source: 'system_hook' }),
    ...pair('another-jira-item', '09:25:00', '09:26:00', 'next', { source: 'system_hook' })]);
  const d = await eventually(() => detail(h, item), d => d.sessions.filter(s => s.worklog?.state === 'synced').length === 2, 20000);
  assert.equal(d.jira_links.length, 2); assert.equal(f.state.worklogs.length, 2);
  assert.deepEqual(f.state.worklogs.map(w => w.issueId).sort(), [issue.id, other.id].sort());
  const current = d.jira_links.find(l => l.issue.id === other.id);
  await change(h, current);
  assert.equal(issue.fields.status.id, '10000'); assert.equal(other.fields.status.id, '3');
  assert.equal(f.state.issues.length, 2);
});
