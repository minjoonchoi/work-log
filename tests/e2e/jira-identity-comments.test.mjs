import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, eventually } from '../helpers.mjs';
import { atlFixture, oauthClient, adfText } from '../fixtures/atlassian.mjs';
import { AtlassianClient, ATLASSIAN_SCOPES } from '../../src/atlassian.mjs';

async function setup(t) {
  const h = new Harness(), f = await atlFixture(h);
  // Memory stores isolate authorization races without a real account or Keychain.
  let credential = null, token = null;
  const credentials = { stored: async () => credential, read: async () => credential,
    write: async value => { credential = value; }, remove: async () => { credential = null; } };
  const tokens = { read: async () => token, write: async value => { token = value; }, remove: async () => { token = null; } };
  const client = new AtlassianClient({ dir: h.dir, apiOrigin: f.origin, authOrigin: f.origin, credentials, tokens,
    callback: 'http://127.0.0.1:0/oauth/atlassian/callback' });
  t.after(async () => { client.close(); await f.close(); await h.close(); });
  await client.save(oauthClient);
  const { authorization_url } = await client.begin(), url = new URL(authorization_url);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' });
  assert.equal((await fetch(callback)).status, 200);
  const raw = f.addIssue(), issue = { cloud_id: 'cloud-test', id: raw.id, key: raw.key };
  return { f, client, tokens, issue };
}
const create = { cloud_id: 'cloud-test', project: 'TEAM', issue_type: '10001', title: '현재 사용자 업무',
  description: 'h2. 배경\n* 업무 확인', operation_id: 'create-identity', work_item_id: 'work-identity' };
const result = { operation_id: 'result-operation', work_item_id: 'work-item', text: '확인한 변경을 적용했습니다. 검증 3건을 통과했습니다.', source_digest: 'source-snapshot' };
const writes = f => f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/issue'));
const commentWrites = f => f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/comment'));

test('Jira create requests the authenticated cloud user and explicitly assigns both reporter and assignee', async t => {
  const { f, client } = await setup(t);
  assert.ok(ATLASSIAN_SCOPES.includes('read:jira-user'));
  await client.createJiraIssue(create);
  const request = writes(f)[0], lookup = f.state.calls.findIndex(call => call.path.endsWith('/rest/api/3/myself'));
  assert.ok(lookup >= 0 && lookup < f.state.calls.indexOf(request));
  assert.deepEqual(request.body.fields.reporter, { accountId: f.state.user.accountId });
  assert.deepEqual(request.body.fields.assignee, request.body.fields.reporter);
  assert.equal(request.body.fields.summary, create.title);
});

test('missing user scope, failed identity lookup and invalid identities all fail before issue POST', async t => {
  const { f, client } = await setup(t);
  f.state.scopes = f.state.scopes.filter(scope => scope !== 'read:jira-user');
  await assert.rejects(client.createJiraIssue(create), error => error.status === 403 && error.not_sent === true);
  assert.equal(f.state.calls.filter(call => call.path.endsWith('/myself')).length, 0);
  f.state.scopes.push('read:jira-user');
  for (const status of [401, 403, 500]) {
    f.state.myselfFailure = status;
    await assert.rejects(client.createJiraIssue(create), error => error.not_sent === true);
  }
  f.state.myselfFailure = null;
  for (const user of [{}, { accountId: '' }, { accountId: 'unknown' }, { accountId: 'anonymous' }, { accountId: ' bad ' }, { accountId: 'inactive', active: false }]) {
    f.state.user = user;
    await assert.rejects(client.createJiraIssue(create), error => error.not_sent === true);
  }
  assert.equal(writes(f).length, 0);
});

test('the same account is preserved across token refresh before lookup; create permission failures have no fallback', async t => {
  const { f, client, tokens } = await setup(t);
  const token = await tokens.read(); await tokens.write({ ...token, expires_at: 0 });
  await client.createJiraIssue(create);
  assert.equal(f.state.tokenCalls.filter(call => call.grant_type === 'refresh_token').length, 1);
  f.state.issueCreateFailure = 403;
  await assert.rejects(client.createJiraIssue({ ...create, operation_id: 'rejected-create' }), error => error.status === 403 && error.code === 'rejected');
  assert.equal(writes(f).length, 2);
  assert.ok(writes(f).every(call => call.body.fields.reporter.accountId === f.state.user.accountId
    && call.body.fields.assignee.accountId === f.state.user.accountId));
});

test('changing OAuth credentials during myself lookup cannot create under another account', async t => {
  const { f, client, tokens } = await setup(t);
  f.state.myselfDelay = 200;
  const pending = client.createJiraIssue(create);
  await eventually(() => f.state.calls.some(call => call.path.endsWith('/myself')));
  f.state.access = 'fixture-switched-access'; f.state.user.accountId = 'fixture-other-user';
  await tokens.write({ ...await tokens.read(), access_token: f.state.access });
  await assert.rejects(pending, error => error.status === 409 && error.not_sent === true);
  assert.equal(writes(f).length, 0);
});

test('async beforeSend is awaited and OAuth disconnection aborts the issue before POST', async t => {
  const { f, client } = await setup(t);
  let checked = false;
  await assert.rejects(client.createJiraIssue(create, { beforeSend: async () => {
    await client.disconnect(); checked = true;
  } }), error => error.status === 409 && error.not_sent === true);
  assert.equal(checked, true); assert.equal(writes(f).length, 0);
});

test('localized transition names include stable Done status categories', async t => {
  const { client, issue } = await setup(t);
  const state = await client.issueState(issue);
  assert.equal(state.transitions.find(transition => transition.id === '21').to.category, 'indeterminate');
  assert.equal(state.transitions.find(transition => transition.id === '31').to.category, 'done');
});

test('result comments are ordinary issue comments with a literal single paragraph and source marker', async t => {
  const { f, client, issue } = await setup(t);
  const text = '## 결과\n- **문자 그대로**\n[확인](https://example.test)';
  const posted = await client.postResultComment(issue, { ...result, text });
  assert.deepEqual(posted, { id: '1000' }); assert.equal(commentWrites(f).length, 1);
  assert.equal(f.state.worklogs.length, 0);
  const comment = f.state.comments[0];
  assert.equal(comment.body.content.length, 1); assert.equal(comment.body.content[0].type, 'paragraph');
  assert.equal(adfText(comment.body), text);
  assert.deepEqual(comment.properties, [{ key: 'work-log-result', value: {
    operation_id: result.operation_id, work_item_id: result.work_item_id, source_digest: result.source_digest,
    cloud_id: issue.cloud_id, issue_id: issue.id
  } }]);
  assert.equal((await client.findResultComment(issue, result.operation_id)).id, posted.id);
});

test('lost result-comment response reconciles across bounded pages without posting again', async t => {
  const { f, client, issue } = await setup(t);
  f.state.comments.push({ id: '1', issueId: issue.id, body: {}, properties: [] }, { id: '2', issueId: issue.id, body: {} });
  f.state.commentPageSize = 1; f.state.loseComment = true;
  await assert.rejects(client.postResultComment(issue, result), error => error.code === 'unconfirmed');
  const found = await client.findResultComment(issue, result.operation_id);
  assert.equal(adfText(found.body), result.text); assert.equal(commentWrites(f).length, 1);
  assert.equal(await client.findResultComment(issue, 'missing-operation'), null);
  const pages = f.state.calls.filter(call => call.method === 'GET' && call.path.endsWith('/comment'));
  assert.deepEqual(pages.slice(0, 3).map(call => call.query.startAt), ['0', '1', '2']);
});

test('comment scope, local preflight and remote rejections never silently fall back or retry', async t => {
  const { f, client, issue } = await setup(t);
  f.state.scopes = ['read:jira-work'];
  await assert.rejects(client.postResultComment(issue, result), error => error.not_sent === true && error.status === 403);
  f.state.scopes.push('write:jira-work');
  await assert.rejects(client.postResultComment(issue, result, { beforeSend: async () => { throw new Error('source changed'); } }), error => error.not_sent === true);
  assert.equal(commentWrites(f).length, 0);
  f.state.commentFailure = 403;
  await assert.rejects(client.postResultComment(issue, result), error => error.status === 403 && error.code === 'rejected');
  assert.equal(commentWrites(f).length, 1); assert.equal(f.state.comments.length, 0);
});

test('reconciliation rejects duplicate operation markers and markers belonging to another issue', async t => {
  const { f, client, issue } = await setup(t);
  await client.postResultComment(issue, result);
  f.state.comments.push({ ...structuredClone(f.state.comments[0]), id: '1001' });
  await assert.rejects(client.findResultComment(issue, result.operation_id), error => error.status === 409);
  f.state.comments.pop();
  f.state.comments[0].properties[0].value.issue_id = '999';
  await assert.rejects(client.findResultComment(issue, result.operation_id), error => error.status === 409);
  f.state.comments[0].properties[0].value.issue_id = issue.id;
  f.state.comments[0].properties[0].value.cloud_id = 'another-cloud';
  await assert.rejects(client.findResultComment(issue, result.operation_id), error => error.status === 409);
});

test('incomplete, repeated and changing pages cannot establish comment absence', async t => {
  const { f, client, issue } = await setup(t);
  await client.postResultComment(issue, result);
  for (const transform of [page => ({ ...page, comments: [], total: 1 }), page => ({ ...page, startAt: 1 }),
    page => ({ ...page, comments: [page.comments[0], page.comments[0]], total: 2 }), page => ({ ...page, total: '1' })]) {
    f.state.commentPageTransform = transform;
    await assert.rejects(client.findResultComment(issue, result.operation_id), error => error.status === 502);
  }
  f.state.commentPageTransform = page => ({ ...page, total: 2 + page.startAt });
  await assert.rejects(client.findResultComment(issue, result.operation_id), error => error.status === 502);
});

test('result comment pagination stops at its hard limit without treating partial pages as absence', async t => {
  const { f, client, issue } = await setup(t);
  f.state.commentPageTransform = page => ({ ...page, total: 101,
    comments: [{ id: String(page.startAt + 1), properties: [] }] });
  await assert.rejects(client.findResultComment(issue, result.operation_id), error => error.status === 409 && /한도/.test(error.message));
  assert.equal(f.state.calls.filter(call => call.method === 'GET' && call.path.endsWith('/comment')).length, 100);
});
