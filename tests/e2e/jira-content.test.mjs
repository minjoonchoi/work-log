import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, pair, eventually } from '../helpers.mjs';
import { atlFixture, authorize } from '../fixtures/atlassian.mjs';
import { jiraDescription } from '../../src/jira-adf.mjs';

const post = body => ({ method: 'POST', body });
const linkOperation = 'link-content-issue';
const description = '## 작업 배경\n기존 절차를 확인했습니다.\n\n## 목적\n요청한 동작을 지원합니다.\n\n## 범위\n- 서버\n- 화면\n\n## 결과\n검증 완료';
const detail = (h, item) => h.manager(`/items/${item.id}`);
const refresh = h => h.manager(`/jira-links/${linkOperation}/refresh`, post({}));
const send = (h, request) => h.manager(`/jira-links/${linkOperation}/content`, post(request));
const puts = f => f.state.calls.filter(call => call.method === 'PUT' && /\/issue\/\d+$/.test(call.path));
const requestFor = (data, operation = 'update-content-request') => ({ operation_id: operation, version: data.item.version,
  expected_updated: data.jira_links[0].view.data.issue.updated });
async function edit(h, item, title = '확정한 업무', content = description) {
  return h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title, description: content } });
}
async function setup(t) {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('manager'); await authorize(h);
  await h.ingest(pair('jira-content', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0], issue = f.addIssue({ summary: '기존 원격 제목' });
  await h.manager(`/items/${item.id}/jira/link`, post({ operation_id: linkOperation, version: item.version,
    cloud_id: 'cloud-test', issue_id: issue.id, key: issue.key }));
  await eventually(() => detail(h, item), data => !!data.jira_links[0]?.view?.data);
  return { h, f, item, issue };
}

test('editing and viewing remain local; explicit content command sends one ADF update and duplicate operation IDs never resend', async t => {
  const { h, f, item, issue } = await setup(t);
  await edit(h, item); const data = await detail(h, item), request = requestFor(data);
  await refresh(h); assert.equal(puts(f).length, 0); assert.equal(issue.fields.summary, '기존 원격 제목');
  f.state.issueUpdateDelay = 150;
  const replies = await Promise.all([send(h, request), send(h, request)]);
  assert.equal(replies[0].state, 'applied'); assert.equal(replies[1].repeated, true); assert.equal(puts(f).length, 1);
  assert.equal(issue.fields.summary, '확정한 업무'); assert.deepEqual(issue.fields.description, jiraDescription(description));
  let changed = await detail(h, item);
  assert.equal(changed.jira_links[0].content_change.state, 'applied');
  assert.equal(changed.jira_links[0].view.data.issue.title, '확정한 업무');
  await edit(h, changed.item, '아직 반영하지 않은 새 제목');
  assert.equal((await send(h, request)).repeated, true); assert.equal(puts(f).length, 1);
  await assert.rejects(send(h, { ...request, version: request.version + 1 }), /내용이 다릅니다/);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await send(h, request)).repeated, true); assert.equal(puts(f).length, 1);
});

test('stale local metadata and stale remote updated timestamp both prevent PUT', async t => {
  const { h, f, item, issue } = await setup(t);
  const initial = await detail(h, item), staleLocal = requestFor(initial, 'stale-local-version');
  await edit(h, initial.item);
  await assert.rejects(send(h, staleLocal), /work item이 변경/); assert.equal(puts(f).length, 0);
  const current = await detail(h, item), staleRemote = requestFor(current, 'stale-remote-version');
  f.setStatus(issue, 'progress');
  await assert.rejects(send(h, staleRemote), /Jira 이슈가 변경/); assert.equal(puts(f).length, 0);
  assert.equal((await detail(h, item)).jira_links[0].content_change.state, 'failed');
});

test('editing while the remote version is being checked rejects the frozen content before PUT', async t => {
  const { h, f, item } = await setup(t), current = await detail(h, item);
  const before = f.state.calls.length; f.state.issueReadDelay = 300;
  const rejected = assert.rejects(send(h, requestFor(current)), /work item이 변경/);
  await eventually(() => f.state.calls.slice(before).some(call => call.method === 'GET' && call.path.endsWith('/issue/1')));
  await edit(h, current.item, '검사 중 바뀐 제목');
  await rejected; assert.equal(puts(f).length, 0);
});

test('editing during final authorization is rechecked immediately before the outgoing PUT', async t => {
  const { h, f, item } = await setup(t), current = await detail(h, item);
  f.state.resourceDelayAt = f.state.resourceCalls + 2; f.state.resourceDelay = 300;
  const rejected = assert.rejects(send(h, requestFor(current)), /work item이 변경/);
  await eventually(() => f.state.resourceCalls === f.state.resourceDelayAt);
  await edit(h, current.item, '전송 직전에 바뀐 제목');
  await rejected; assert.equal(puts(f).length, 0);
  assert.equal((await detail(h, item)).jira_links[0].content_change.state, 'failed');
});

test('merging into a different work item with the same numeric version cannot publish the previous item snapshot', async t => {
  const { h, f, item } = await setup(t);
  await edit(h, item); await h.ingest(pair('merge-target', '10:00:00', '10:05:00'));
  const current = await detail(h, item), target = (await h.manager('/items')).find(row => row.id !== item.id);
  assert.equal(target.version + 1, current.item.version, 'merge recreates the version number collision');
  f.state.resourceDelayAt = f.state.resourceCalls + 2; f.state.resourceDelay = 300;
  const rejected = assert.rejects(send(h, requestFor(current)), /work item이 변경/);
  await eventually(() => f.state.resourceCalls === f.state.resourceDelayAt);
  await h.manager('/merge', post({ ids: [item.id, target.id], target: target.id, operation_id: 'merge-during-content-send' }));
  await rejected; assert.equal(puts(f).length, 0);
  const merged = await detail(h, item); assert.equal(merged.item.id, target.id); assert.equal(merged.item.version, current.item.version);
});

test('lost PUT response stays unknown until refresh; stable ID and reordered ADF keys reconcile without another write', async t => {
  const { h, f, item, issue } = await setup(t);
  await edit(h, item); const current = await detail(h, item), request = requestFor(current);
  f.state.issueUpdateResponseLost = true;
  await assert.rejects(send(h, request), /응답을 확인하지 못/);
  assert.equal((await detail(h, item)).jira_links[0].content_change.state, 'unknown');
  assert.equal((await send(h, request)).state, 'unknown'); assert.equal(puts(f).length, 1);
  await assert.rejects(send(h, { ...request, operation_id: 'blocked-unconfirmed-write' }), /먼저 새로고침/);
  const reordered = value => Array.isArray(value) ? value.map(reordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reordered(entry)])) : value;
  issue.fields.description = reordered(issue.fields.description); issue.key = 'MOVED-2';
  await refresh(h);
  const reconciled = await detail(h, item);
  assert.equal(reconciled.jira_links[0].content_change.state, 'observed');
  assert.match(reconciled.jira_links[0].content_change.message, /이전 전송 응답은 확인하지 못/);
  assert.equal(puts(f).length, 1);
  assert.ok(f.state.calls.some(call => call.path.endsWith('/issue/1') && call.query.fields === 'summary,description,updated'));
});

test('refresh with different remote content reports uncertainty and requires a fresh explicit operation to overwrite', async t => {
  const { h, f, item, issue } = await setup(t);
  await edit(h, item); const current = await detail(h, item), request = requestFor(current);
  f.state.issueUpdateResponseLost = true; await assert.rejects(send(h, request));
  issue.fields.summary = '외부에서 수정한 내용'; f.setStatus(issue, 'progress');
  await refresh(h); let refreshed = await detail(h, item);
  assert.equal(refreshed.jira_links[0].content_change.state, 'different');
  assert.match(refreshed.jira_links[0].content_change.message, /반영 여부는 미확인/);
  assert.equal((await send(h, request)).state, 'different'); assert.equal(puts(f).length, 1);
  assert.equal((await send(h, requestFor(refreshed, 'confirmed-new-content-write'))).state, 'applied');
  assert.equal(puts(f).length, 2); assert.equal(issue.fields.summary, '확정한 업무');
});

test('confirmed REST rejection is failed; a successful PUT followed by read failure remains applied and cannot resend', async t => {
  const { h, f, item } = await setup(t), current = await detail(h, item);
  const request = requestFor(current); f.state.issueUpdateFailure = 403;
  await assert.rejects(send(h, request), /접근 권한/);
  assert.equal((await detail(h, item)).jira_links[0].content_change.state, 'failed');
  f.state.issueUpdateFailure = null; f.state.issueUpdateDelay = 200;
  const next = { ...request, operation_id: 'read-failure-after-put' }, pending = send(h, next);
  await eventually(() => puts(f).length === 2); f.state.issueReadFailure = 503;
  assert.equal((await pending).state, 'applied');
  const observed = await detail(h, item);
  assert.equal(observed.jira_links[0].content_change.state, 'applied'); assert.ok(observed.jira_links[0].view.error);
  assert.equal((await send(h, next)).repeated, true); assert.equal(puts(f).length, 2);
});

test('manager crash after PUT starts recovers the sending intent as unknown and reconciles after restart', async t => {
  const { h, f, item, issue } = await setup(t);
  await edit(h, item); const request = requestFor(await detail(h, item));
  f.state.issueUpdateDelay = 300;
  const rejected = assert.rejects(send(h, request));
  await eventually(() => puts(f).length === 1); await h.stop('manager', 'SIGKILL'); await rejected;
  await eventually(() => issue.fields.summary === '확정한 업무');
  await h.start('manager');
  assert.equal((await send(h, request)).state, 'unknown');
  await refresh(h);
  assert.equal((await detail(h, item)).jira_links[0].content_change.state, 'observed'); assert.equal(puts(f).length, 1);
});
