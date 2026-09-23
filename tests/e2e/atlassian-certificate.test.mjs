import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
import { atlFixture, oauthClient } from '../fixtures/atlassian.mjs';
import { tlsFixture } from '../fixtures/tls.mjs';
import { certificatePath, connectionFailure } from '../../src/atlassian-transport.mjs';

const endpoint = '/integrations/atlassian';
const post = body => ({ method: 'POST', body });
const save = (h, ca, extra = {}) => h.manager(endpoint, { method: 'PUT', body: {
  client_id: oauthClient.client_id, ...(ca === undefined ? {} : { ca_cert_path: ca }), ...extra
} });
const config = h => JSON.parse(fs.readFileSync(path.join(h.dir, 'integrations/atlassian.json')));
async function callback(h) {
  const { authorization_url } = await h.manager(`${endpoint}/authorize`, post({}));
  const start = new URL(authorization_url), result = new URL(start.searchParams.get('redirect_uri'));
  result.search = new URLSearchParams({ state: start.searchParams.get('state'), code: 'fixture-code' });
  return result;
}
async function authorize(h) {
  const response = await fetch(await callback(h));
  assert.equal(response.status, 200, await response.text());
}
async function setup(t, { configured = false } = {}) {
  const h = new Harness(), tls = tlsFixture(h.dir), f = await atlFixture(h, { tls });
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('manager');
  await save(h, configured ? tls.caPath : undefined, { client_secret: oauthClient.client_secret });
  return { h, f, tls };
}

test('real HTTPS token exchange fails without trust and succeeds immediately with a configured CA for OAuth, Jira and Confluence', async t => {
  const { h, f, tls } = await setup(t);
  const response = await fetch(await callback(h)), message = await response.text();
  assert.equal(response.status, 503); assert.match(message, /TLS 인증서/);
  assert.match(message, /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/);
  assert.equal(f.state.tokenCalls.length, 0); assert.equal(fs.existsSync(f.record), false);
  await save(h, tls.caPath); await authorize(h);
  assert.equal((await h.manager(endpoint)).connected, true);
  assert.equal((await h.manager(`${endpoint}/sites`))[0].id, 'cloud-test');
  assert.equal((await h.manager(`${endpoint}/confluence-page?cloud_id=cloud-test&id=123`)).title, 'Fixture page');
  assert.equal(f.state.tokenCalls.length, 1);
  // This setting must not change trust in the test process or arbitrary fetch calls.
  await assert.rejects(fetch(f.origin));
  assert.ok(!h.logs.manager.includes('fixture-secret'));
});

test('CA saves, removal and restart preserve credentials, tokens and pending OAuth while refresh uses current trust', async t => {
  const { h, f, tls } = await setup(t), before = config(h), credentials = fs.readFileSync(f.clientRecord, 'utf8');
  const pending = await callback(h);
  await save(h, tls.caPath);
  assert.equal((await h.manager(endpoint)).connecting, true);
  assert.equal(config(h).credential_version, before.credential_version);
  assert.equal((await fetch(pending)).status, 200);
  const token = fs.readFileSync(f.record, 'utf8');
  await save(h, undefined); assert.equal(config(h).ca_cert_path, tls.caPath);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager(endpoint)).config.ca_cert_path, tls.caPath);
  assert.equal((await h.manager(endpoint)).connected, true);
  await save(h, ''); assert.equal(config(h).ca_cert_path, undefined);
  assert.equal(fs.readFileSync(f.record, 'utf8'), token); assert.equal(fs.readFileSync(f.clientRecord, 'utf8'), credentials);
  f.expire(); const expired = fs.readFileSync(f.record, 'utf8');
  await assert.rejects(h.manager(`${endpoint}/sites`), /TLS 인증서/);
  assert.equal(fs.readFileSync(f.record, 'utf8'), expired, 'a trust error must not delete the rotating refresh token');
  await save(h, tls.caPath);
  assert.equal((await h.manager(`${endpoint}/sites`))[0].id, 'cloud-test');
  assert.equal(f.state.tokenCalls.length, 2); assert.equal(JSON.parse(fs.readFileSync(f.record)).refresh_token, 'fixture-refresh-2');
});

test('invalid CA paths and bundles cannot replace saved configuration or expose private material', async t => {
  const { h, f, tls } = await setup(t, { configured: true }); await authorize(h);
  const original = config(h), credentials = fs.readFileSync(f.clientRecord, 'utf8'), token = fs.readFileSync(f.record, 'utf8');
  const invalid = path.join(h.dir, 'invalid.pem'), partial = path.join(h.dir, 'partial.pem'), huge = path.join(h.dir, 'large.pem');
  fs.writeFileSync(invalid, 'not a certificate');
  fs.writeFileSync(partial, tls.ca + '\n-----BEGIN CERTIFICATE-----\nnot valid\n-----END CERTIFICATE-----');
  fs.writeFileSync(huge, Buffer.alloc(2 * 1024 * 1024 + 1));
  for (const value of [null, 123, {}, 'relative.pem', 'https://example.test/ca.pem', '/missing/worklog-ca.pem', h.dir,
    invalid, partial, huge, tls.privateKeyPath, tls.serverCertPath, `${tls.caPath}\n`]) {
    await assert.rejects(save(h, value), error => error.status === 400 && !error.message.includes('BEGIN'));
    assert.deepEqual(config(h), original);
    assert.equal(fs.readFileSync(f.record, 'utf8'), token); assert.equal(fs.readFileSync(f.clientRecord, 'utf8'), credentials);
  }
  assert.equal(f.state.tokenCalls.length, 1);
  assert.equal(certificatePath('~/worklog-ca.pem'), path.join(process.env.HOME, 'worklog-ca.pem'));
});

test('a moved, modified or replaced CA is checked before every request instead of reusing stale trusted sockets', async t => {
  const { h, f, tls } = await setup(t, { configured: true }); await authorize(h);
  await h.manager(`${endpoint}/sites`); const token = fs.readFileSync(f.record, 'utf8');
  fs.renameSync(tls.caPath, `${tls.caPath}.moved`);
  await assert.rejects(h.manager(`${endpoint}/sites`), /파일을 읽을 수 없습니다/);
  fs.writeFileSync(tls.caPath, 'broken certificate');
  await assert.rejects(h.manager(`${endpoint}/sites`), /PEM 인증서/);
  const other = tlsFixture(h.dir, 'other-ca'); fs.writeFileSync(tls.caPath, other.ca);
  await assert.rejects(h.manager(`${endpoint}/sites`), /TLS 인증서/);
  fs.writeFileSync(tls.caPath, tls.ca);
  assert.equal((await h.manager(`${endpoint}/sites`))[0].id, 'cloud-test');
  assert.equal(fs.readFileSync(f.record, 'utf8'), token);
  assert.equal(f.state.tokenCalls.length, 1);
});

test('network diagnostics expose only known error codes, distinguish DNS/timeouts and do not reveal request secrets', () => {
  for (const [code, pattern] of [['ENOTFOUND', /DNS/], ['UND_ERR_CONNECT_TIMEOUT', /시간이 초과/], ['SELF_SIGNED_CERT_IN_CHAIN', /TLS 인증서/]]) {
    const cause = new TypeError('secret=do-not-show', { cause: new AggregateError([Object.assign(new Error('Bearer private-token'), { code })]) });
    const error = connectionFailure(cause, 'Atlassian 토큰 서버', 503, 'token_connection_failed');
    assert.match(error.message, pattern); assert.ok(error.message.includes(code));
    assert.doesNotMatch(error.message, /do-not-show|private-token/);
  }
});

test('trusting the CA does not bypass server hostname verification', async t => {
  const h = new Harness(), tls = tlsFixture(h.dir, 'wrong-host', { subjectAltName: 'DNS:another-server.test' });
  const f = await atlFixture(h, { tls });
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('manager'); await save(h, tls.caPath, { client_secret: oauthClient.client_secret });
  const response = await fetch(await callback(h));
  assert.equal(response.status, 503); assert.match(await response.text(), /ERR_TLS_CERT_ALTNAME_INVALID/);
  assert.equal(f.state.tokenCalls.length, 0); assert.equal(fs.existsSync(f.record), false);
});

test('an actual token server HTTP 503 is distinct from a local TLS error and never reveals its body', async t => {
  const { h, f } = await setup(t, { configured: true }); f.state.tokenFailure = 503;
  const response = await fetch(await callback(h)), message = await response.text();
  assert.equal(response.status, 503); assert.match(message, /HTTP 503/);
  assert.doesNotMatch(message, /TLS|upstream-private-diagnostic/);
  assert.equal(fs.existsSync(f.record), false);
  f.state.tokenFailure = null; await authorize(h);
  assert.equal((await h.manager(endpoint)).connected, true);
});
