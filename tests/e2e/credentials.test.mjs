import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { AtlassianClient } from '../../src/atlassian.mjs';
import { atlFixture, authorize, oauthClient } from '../fixtures/atlassian.mjs';

const endpoint = '/integrations/atlassian';
const save = (h, body = oauthClient) => h.manager(endpoint, { method: 'PUT', body });
const begin = h => h.manager(`${endpoint}/authorize`, { method: 'POST', body: {} });
const reveal = (h, client_id = oauthClient.client_id) => h.manager(`${endpoint}/client-secret`, { method: 'POST', body: { client_id } });
const configFile = h => path.join(h.dir, 'integrations/atlassian.json');
const stored = h => JSON.parse(fs.readFileSync(configFile(h)));
const keychainCalls = f => fs.existsSync(f.keychainCalls) ? fs.readFileSync(f.keychainCalls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function setup(t, configured = true) {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('manager');
  if (configured) await save(h);
  return { h, f };
}
async function publicState(h) {
  return JSON.stringify({ status: await h.manager(endpoint), logs: h.logs,
    config: fs.existsSync(configFile(h)) ? stored(h) : null });
}

// The only credentials used here are fabricated values handled by isolated subprocesses.
test('direct OAuth credentials survive restart and refresh in separate Keychain items without op or plaintext settings', async t => {
  const { h, f } = await setup(t), config = stored(h);
  assert.deepEqual(Object.keys(config).sort(), ['client_id', 'credential_version']);
  assert.equal(config.client_id, oauthClient.client_id); assert.ok(config.credential_version);
  const credential = JSON.parse(fs.readFileSync(f.clientRecord));
  assert.equal(credential.client_secret, oauthClient.client_secret);
  assert.equal(credential.credential_version, config.credential_version);
  await authorize(h);
  assert.deepEqual(stored(h), config, 'resaving the same credentials must preserve the generation');
  f.expire();
  await Promise.all(Array.from({ length: 5 }, () => h.manager(`${endpoint}/sites`)));
  assert.equal(f.state.tokenCalls.length, 2, 'concurrent refreshes share one exchange');
  assert.equal(JSON.parse(fs.readFileSync(f.record)).refresh_token, 'fixture-refresh-2');
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager(endpoint)).connected, true);
  assert.equal((await reveal(h)).client_secret, oauthClient.client_secret);
  assert.ok(!(await publicState(h)).includes(oauthClient.client_secret));
  assert.ok(!fs.readFileSync(f.record, 'utf8').includes(oauthClient.client_secret));
  assert.equal(fs.existsSync(f.opCalls), false);
  const calls = keychainCalls(f);
  assert.ok(calls.some(call => call.account.startsWith('client-')));
  assert.ok(calls.some(call => call.account.startsWith('oauth-')));
  assert.ok(calls.every(call => call.args.length === 0), 'secrets are never passed in process arguments');
});

test('stored secret is returned only by the authenticated matching-client reveal action with no-store', async t => {
  const { h, f } = await setup(t);
  const status = await h.manager(endpoint);
  assert.deepEqual(status.config, { client_id: oauthClient.client_id }); assert.equal(status.has_client_secret, true);
  assert.ok(!JSON.stringify(status).includes(oauthClient.client_secret));
  const saved = await save(h, { client_id: oauthClient.client_id });
  assert.ok(!JSON.stringify(saved).includes(oauthClient.client_secret));
  await assert.rejects(reveal(h, 'other-app'));
  await assert.rejects(h.manager(`${endpoint}/client-secret`));
  const origin = `http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`, url = `${origin}/api${endpoint}/client-secret`;
  const body = JSON.stringify({ client_id: oauthClient.client_id });
  const token = fs.readFileSync(path.join(h.dir, 'token'), 'utf8').trim();
  assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', body, headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.test' } })).status, 403);
  const response = await fetch(url, { method: 'POST', body, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { client_secret: oauthClient.client_secret });
  assert.equal(f.state.tokenCalls.length, 0); assert.equal(f.state.calls.length, 0);
});

test('blank secret keeps the same app credentials and repeated saves preserve an in-flight authorization', async t => {
  const { h, f } = await setup(t), config = stored(h), url = new URL((await begin(h)).authorization_url);
  for (const value of [{ client_id: oauthClient.client_id }, { client_id: oauthClient.client_id, client_secret: '' }, oauthClient]) {
    await save(h, value); assert.deepEqual(stored(h), config);
    assert.equal((await h.manager(endpoint)).connecting, true);
  }
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' });
  assert.equal((await fetch(callback)).status, 200);
  const before = fs.readFileSync(f.record, 'utf8');
  await save(h, { client_id: oauthClient.client_id });
  assert.equal((await h.manager(endpoint)).connected, true); assert.equal(fs.readFileSync(f.record, 'utf8'), before);
  await assert.rejects(save(h, { client_id: 'new-app' }));
  assert.deepEqual(stored(h), config);
});

test('credential changes require reconnection and disconnect removes only tokens', async t => {
  const { h, f } = await setup(t); await authorize(h);
  const original = stored(h), tokenRecord = fs.readFileSync(f.record, 'utf8');
  await begin(h);
  await save(h, { ...oauthClient, client_secret: 'replacement-fixture-secret' });
  assert.notEqual(stored(h).credential_version, original.credential_version);
  const status = await h.manager(endpoint); assert.equal(status.connected, false); assert.equal(status.connecting, false);
  assert.equal(fs.readFileSync(f.record, 'utf8'), tokenRecord);
  assert.equal((await reveal(h)).client_secret, 'replacement-fixture-secret');
  await assert.rejects(h.manager(`${endpoint}/sites`));
  assert.equal(f.state.tokenCalls.length, 1, 'saving credentials is not an OAuth login');
  await save(h); assert.notEqual(stored(h).credential_version, original.credential_version);
  assert.equal((await h.manager(endpoint)).connected, false, 'restoring old values does not revive an old token generation');
  await authorize(h);
  await h.manager(endpoint, { method: 'DELETE' });
  assert.equal(fs.existsSync(f.record), false); assert.equal(fs.existsSync(f.clientRecord), true);
  assert.equal((await reveal(h)).client_secret, oauthClient.client_secret);
  assert.equal((await h.manager(endpoint)).has_client_secret, true);
});

test('invalid input and missing first secret are rejected before creating configuration or contacting OAuth', async t => {
  const { h, f } = await setup(t, false);
  for (const value of [null, [], {}, { client_id: 'a' }, { client_id: 'a', client_secret: '' },
    { client_id: '', client_secret: 'fixture-secret' }, { client_id: 'a', client_secret: 123 },
    { client_id: 'a', client_secret: 'x'.repeat(4097) }, { client_id: 'a\n', client_secret: 'fixture-secret' },
    { ...oauthClient, vault: 'Old vault' }, { ...oauthClient, unknown: true }]) {
    await assert.rejects(save(h, value), error => { assert.ok(!error.message.includes('fixture-secret')); return true; });
  }
  await assert.rejects(begin(h));
  assert.equal(fs.existsSync(configFile(h)), false); assert.equal(fs.existsSync(f.clientRecord), false);
  assert.equal(f.state.tokenCalls.length, 0); assert.equal(fs.existsSync(f.opCalls), false);
});

test('locked or malformed client Keychain responses block secret access without a plaintext fallback', async t => {
  const { h, f } = await setup(t); await authorize(h); f.expire();
  const config = stored(h), credential = fs.readFileSync(f.clientRecord, 'utf8'), tokens = fs.readFileSync(f.record, 'utf8');
  for (const [suffix, content] of [['.locked', 'locked'], ...['fixture-secret invalid response', 'null', '[]', '{"ok":"true"}'].map(value => ['.response', value])]) {
    fs.writeFileSync(f.clientRecord + suffix, content);
    for (const request of [() => reveal(h), () => begin(h), () => save(h, { ...oauthClient, client_secret: 'changed-fixture-secret' }), () => h.manager(`${endpoint}/sites`)]) {
      await assert.rejects(request(), error => { assert.ok(!error.message.includes('fixture-secret')); return true; });
    }
    assert.equal((await h.manager(endpoint)).connected, false);
    assert.deepEqual(stored(h), config);
    assert.equal(fs.readFileSync(f.clientRecord, 'utf8'), credential); assert.equal(fs.readFileSync(f.record, 'utf8'), tokens);
    fs.unlinkSync(f.clientRecord + suffix);
  }
  assert.equal((await h.manager(`${endpoint}/sites`))[0].id, 'cloud-test');
  assert.equal(f.state.tokenCalls.length, 2); assert.ok(!(await publicState(h)).includes('fixture-secret'));
});

test('a callback queued behind disconnect cannot recreate tokens after the user disconnected', async t => {
  const { h } = await setup(t);
  let writes = 0, exchanges = 0, removals = 0;
  // A deterministic queue barrier exercises the production callback handler without
  // timing assumptions about requests on two HTTP listeners or real credentials.
  const client = new AtlassianClient({ dir: h.dir, callback: 'http://127.0.0.1:0/oauth/atlassian/callback',
    credentials: { read: async () => ({ ...oauthClient }) },
    tokens: { remove: async () => { removals++; }, write: async () => { writes++; } }
  });
  t.after(() => client.close());
  client.tokenRequest = async () => { exchanges++; return { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600 }; };
  const authorization = new URL((await client.begin()).authorization_url);
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'fixture-code' });
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const held = client.exclusive(async () => { enter(); await gate; });
  await entered;
  const disconnected = client.disconnect();
  const response = { statusCode: 200, setHeader() {}, end(text) { this.text = text; } };
  const received = client.receiveCallback({ method: 'GET', url: callback.pathname + callback.search }, response);
  release(); await Promise.all([held, disconnected, received]);
  assert.equal(removals, 1); assert.equal(exchanges, 0); assert.equal(writes, 0);
  assert.notEqual(response.statusCode, 200);
});

test('a rejected credential write preserves previous settings and credentials', async t => {
  const { h, f } = await setup(t); await authorize(h);
  const config = stored(h), credential = fs.readFileSync(f.clientRecord, 'utf8'), tokens = fs.readFileSync(f.record, 'utf8');
  fs.writeFileSync(f.clientRecord + '.deny-set', 'deny');
  await assert.rejects(save(h, { ...oauthClient, client_secret: 'replacement-fixture-secret' }));
  assert.deepEqual(stored(h), config); assert.equal(fs.readFileSync(f.clientRecord, 'utf8'), credential);
  assert.equal(fs.readFileSync(f.record, 'utf8'), tokens);
  fs.unlinkSync(f.clientRecord + '.deny-set');
  assert.equal((await h.manager(endpoint)).connected, true);
});

test('legacy 1Password settings request direct credentials without invoking op or discarding old tokens', async t => {
  const { h, f } = await setup(t, false);
  const legacy = { vault: 'Old vault', item: 'Old app' };
  fs.mkdirSync(path.dirname(configFile(h)), { recursive: true }); fs.writeFileSync(configFile(h), JSON.stringify(legacy));
  fs.writeFileSync(f.record, JSON.stringify({ refresh_token: 'legacy-fake-refresh', expires_at: 0, config_digest: 'legacy' }));
  const old = fs.readFileSync(f.record, 'utf8');
  await h.stop('manager'); await h.start('manager');
  const status = await h.manager(endpoint);
  assert.equal(status.connected, false); assert.equal(status.has_client_secret, false); assert.match(status.message, /Client|직접|입력/i);
  await assert.rejects(begin(h)); assert.equal(fs.existsSync(f.opCalls), false);
  assert.deepEqual(stored(h), legacy); assert.equal(fs.readFileSync(f.record, 'utf8'), old);
  await save(h);
  assert.equal((await h.manager(endpoint)).has_client_secret, true);
  assert.equal(fs.readFileSync(f.record, 'utf8'), old);
  await authorize(h); assert.equal((await h.manager(endpoint)).connected, true);
});
