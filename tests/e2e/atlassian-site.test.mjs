import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';
import { atlFixture, authorize, oauthClient } from '../fixtures/atlassian.mjs';
import { AtlassianClient } from '../../src/atlassian.mjs';
import { KeychainClientCredentials, KeychainTokens } from '../../src/credentials.mjs';
import { digest, json } from '../../src/shared.mjs';

const endpoint = '/integrations/atlassian';
const save = (h, site_url, extra = {}) => h.manager(endpoint, { method: 'PUT', body: {
  client_id: oauthClient.client_id, ...(site_url === undefined ? {} : { site_url }), ...extra
} });
const config = h => JSON.parse(fs.readFileSync(path.join(h.dir, 'integrations/atlassian.json')));
async function setup(t, connected = true) {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('manager');
  if (connected) await authorize(h);
  else await h.manager(endpoint, { method: 'PUT', body: oauthClient });
  const client = new AtlassianClient({ dir: h.dir, apiOrigin: f.origin, authOrigin: f.origin,
    credentials: new KeychainClientCredentials(h.dir, h.env.HARNESS_KEYCHAIN_BIN),
    tokens: new KeychainTokens(h.dir, h.env.HARNESS_KEYCHAIN_BIN) });
  t.after(() => client.close());
  return { h, f, client };
}
function resources(f) {
  f.state.resources = [
    { id: 'cloud-other', name: '다른 Jira', url: 'https://other.atlassian.net', scopes: ['read:jira-work', 'write:jira-work'] },
    { id: 'cloud-test', name: '회사 사이트', url: 'https://fixture.atlassian.net', scopes: f.state.scopes },
    { id: 'cloud-docs', name: '문서 사이트', url: 'https://docs.atlassian.net', scopes: ['read:page:confluence', 'read:space:confluence'] }
  ];
}

test('company site saves canonical Cloud origins while preserving legacy credentials, tokens and identity digest', async t => {
  const { h, f } = await setup(t), original = config(h), credentials = fs.readFileSync(f.clientRecord, 'utf8'), token = fs.readFileSync(f.record, 'utf8');
  const identity = digest(json({ client_id: original.client_id, credential_version: original.credential_version }));
  assert.equal(JSON.parse(token).config_digest, identity);
  for (const value of ['fixture.atlassian.net', ' HTTPS://FIXTURE.atlassian.net/ ', 'https://fixture.atlassian.net:443/', 'fixture.atlassian.net:443']) {
    const saved = await save(h, value);
    assert.deepEqual(saved.config, { client_id: oauthClient.client_id, site_url: 'https://fixture.atlassian.net' });
    assert.equal(config(h).credential_version, original.credential_version);
    assert.equal(fs.readFileSync(f.clientRecord, 'utf8'), credentials); assert.equal(fs.readFileSync(f.record, 'utf8'), token);
    assert.equal((await h.manager(endpoint)).connected, true);
  }
  assert.equal(f.state.tokenCalls.length, 1, 'site saves never initiate OAuth or refresh');
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager(endpoint)).config.site_url, 'https://fixture.atlassian.net');
  assert.equal((await h.manager(endpoint)).connected, true);
});

test('omitted site preserves the preference and an empty site clears it without touching OAuth state', async t => {
  const { h, f } = await setup(t), before = fs.readFileSync(f.record, 'utf8'), identity = config(h).credential_version;
  await save(h, 'fixture.atlassian.net'); await save(h, undefined, { client_secret: '' });
  assert.equal(config(h).site_url, 'https://fixture.atlassian.net');
  await save(h, '');
  assert.deepEqual((await h.manager(endpoint)).config, { client_id: oauthClient.client_id });
  assert.deepEqual(Object.keys(config(h)).sort(), ['client_id', 'credential_version']);
  assert.equal(config(h).credential_version, identity); assert.equal(fs.readFileSync(f.record, 'utf8'), before);
  assert.equal((await h.manager(endpoint)).connected, true);
});

test('site rejects unsafe or non-Cloud destinations before storing or making any request', async t => {
  const { h, f } = await setup(t), before = config(h), calls = f.state.calls.length;
  for (const value of [null, 42, {}, 'http://fixture.atlassian.net', 'https://name:password@fixture.atlassian.net',
    'https://@fixture.atlassian.net', 'https://fixture.atlassian.net/wiki', 'https://fixture.atlassian.net/./',
    'https://fixture.atlassian.net/%2e', 'https://fixture.atlassian.net?query=yes', 'https://fixture.atlassian.net?',
    'https://fixture.atlassian.net#fragment', 'https://fixture.atlassian.net#', 'https://fixture.atlassian.net:8443',
    'https://fixture.atlassian.net.evil.test', 'https://evil-atlassian.net', 'https://atlassian.net', 'https://fixture..atlassian.net',
    'https://fixture.atlassian.net\\', 'https://fixture.atlassian.net\n', 'https://jira.company.test', '//fixture.atlassian.net']) {
    await assert.rejects(save(h, value), error => error.status === 400);
    assert.deepEqual(config(h), before);
  }
  assert.equal(f.state.calls.length, calls); assert.equal(f.state.tokenCalls.length, 1);
});

test('changing the site during authorization leaves the original OAuth callback and identity valid', async t => {
  const { h, f } = await setup(t, false), original = config(h);
  const url = new URL((await h.manager(`${endpoint}/authorize`, { method: 'POST', body: {} })).authorization_url);
  await save(h, 'fixture.atlassian.net');
  assert.equal((await h.manager(endpoint)).connecting, true);
  assert.equal(config(h).credential_version, original.credential_version);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' });
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await h.manager(endpoint)).connected, true);
  assert.equal(JSON.parse(fs.readFileSync(f.record)).config_digest, digest(json(original)));
  assert.equal(f.state.tokenCalls.length, 1);
});

test('product site listing prefers the configured site without dropping other allowed sites', async t => {
  const { h, f } = await setup(t); resources(f);
  assert.deepEqual((await h.manager(`${endpoint}/sites`)).map(site => site.id), ['cloud-other', 'cloud-test']);
  assert.deepEqual((await h.manager(`${endpoint}/sites?product=confluence`)).map(site => site.id), ['cloud-test', 'cloud-docs']);
  await save(h, 'fixture.atlassian.net');
  const jira = await h.manager(`${endpoint}/sites?product=jira`);
  assert.deepEqual(jira.map(site => site.id), ['cloud-test', 'cloud-other']);
  assert.equal(jira[0].preferred, true); assert.equal(jira[1].preferred, undefined);
  assert.equal((await h.manager(`${endpoint}/sites?product=confluence`))[0].preferred, true);
  for (const query of ['?product=unknown', '?product=jira&product=confluence', '?unknown=yes']) {
    await assert.rejects(h.manager(`${endpoint}/sites${query}`), error => error.status === 400);
  }
});

test('configured inaccessible or wrong-product sites fail explicitly instead of selecting another site', async t => {
  const { h, f } = await setup(t); resources(f);
  await save(h, 'docs.atlassian.net');
  await assert.rejects(h.manager(`${endpoint}/sites`), error => error.status === 403 && /회사 사이트.*Jira/.test(error.message));
  assert.equal((await h.manager(`${endpoint}/sites?product=confluence`))[0].id, 'cloud-docs');
  await save(h, 'not-authorized.atlassian.net');
  for (const product of ['jira', 'confluence']) await assert.rejects(h.manager(`${endpoint}/sites?product=${product}`), error => error.status === 403);
});

test('site preference never changes OAuth/API routing and existing cloud links still work on other sites', async t => {
  const { h, f, client } = await setup(t); resources(f);
  await save(h, 'not-authorized.atlassian.net');
  const raw = f.addIssue(), issue = { id: raw.id, cloud_id: 'cloud-test' };
  assert.equal((await client.issueState(issue)).issue.id, raw.id);
  await client.writeWorklog(issue, { operation_id: 'existing-cloud-worklog', session_id: 'existing-session', source_digest: 'source',
    payload: JSON.stringify({ comment: '기존 연결 유지', started: '2026-09-17T09:00:00Z', seconds: 60 }) });
  const created = await client.createJiraIssue({ cloud_id: issue.cloud_id, project: 'TEAM', issue_type: '10001', title: '기존 대상',
    description: '기존 사이트 연결', operation_id: 'existing-cloud-create', work_item_id: 'existing-item' }, {
    beforeSend: () => save(h, 'other.atlassian.net')
  });
  assert.equal(created.cloud_id, 'cloud-test'); assert.equal(client.apiOrigin, f.origin); assert.equal(client.authOrigin, f.origin);
  assert.ok(f.state.calls.some(call => call.path === `/ex/jira/cloud-test/rest/api/3/issue/${raw.id}/worklog`));
  const production = new AtlassianClient({ dir: h.dir });
  assert.equal(production.apiOrigin, 'https://api.atlassian.com'); assert.equal(production.authOrigin, 'https://auth.atlassian.com');
});

test('site changes during resource lookup reject stale choices including change-and-restore', async t => {
  const { h, f } = await setup(t); resources(f); await save(h, 'fixture.atlassian.net');
  f.state.resourceDelayAt = (f.state.resourceCalls || 0) + 1; f.state.resourceDelay = 400;
  const pending = assert.rejects(h.manager(`${endpoint}/sites`), error => error.status === 409 && /설정이 변경/.test(error.message));
  await eventually(() => f.state.resourceCalls === f.state.resourceDelayAt);
  await save(h, 'other.atlassian.net'); await save(h, 'fixture.atlassian.net');
  await pending;
  assert.equal((await h.manager(`${endpoint}/sites`))[0].id, 'cloud-test');
});

test('site change queued behind token refresh preserves the legacy OAuth digest and rejects the old selection', async t => {
  const { h, f } = await setup(t); resources(f); await save(h, 'fixture.atlassian.net');
  const identity = config(h), expected = digest(json({ client_id: identity.client_id, credential_version: identity.credential_version }));
  f.expire(); f.state.refreshDelay = 400;
  // The queued save reads Keychain after refresh; keep resource I/O open until
  // that setting change commits so the selection is genuinely stale.
  f.state.resourceDelayAt = (f.state.resourceCalls || 0) + 1; f.state.resourceDelay = 400;
  const pending = assert.rejects(h.manager(`${endpoint}/sites`), error => error.status === 409);
  await eventually(() => f.state.tokenCalls.some(call => call.grant_type === 'refresh_token'));
  await save(h, 'other.atlassian.net'); await pending;
  assert.equal(JSON.parse(fs.readFileSync(f.record)).config_digest, expected);
  assert.equal((await h.manager(endpoint)).connected, true);
  assert.equal((await h.manager(`${endpoint}/sites`))[0].id, 'cloud-other');
  assert.equal(f.state.tokenCalls.filter(call => call.grant_type === 'refresh_token').length, 1);
});
