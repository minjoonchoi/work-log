import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { assert, atomic, digest, json } from './shared.mjs';
import { KeychainClientCredentials, KeychainTokens } from './credentials.mjs';
import { jiraDescription, plainTextADF } from './jira-adf.mjs';
import { certificatePath, readCertificates, AtlassianTransport, connectionFailure } from './atlassian-transport.mjs';
export { jiraDescription } from './jira-adf.mjs';

export const ATLASSIAN_CALLBACK = 'http://127.0.0.1:47831/oauth/atlassian/callback';
export const ATLASSIAN_SCOPES = ['offline_access', 'read:jira-work', 'read:jira-user', 'write:jira-work', 'read:page:confluence', 'read:space:confluence', 'write:page:confluence'];
const clientId = value => {
  assert(typeof value === 'string' && value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value), 'Client ID를 확인하세요.');
  return value.trim();
};
const siteUrl = value => {
  assert(typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value), '회사 Jira 사이트 주소를 확인하세요.');
  const input = value.trim(); if (!input) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url;
  try { url = new URL(candidate); }
  catch { assert(false, '회사 Jira 사이트 주소를 확인하세요.'); }
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash
    && url.pathname === '/' && url.hostname.endsWith('.atlassian.net')
    && url.hostname.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
    && /^https:\/\/[^/?#@\\]+\/?$/i.test(candidate), 'https://회사명.atlassian.net 형식의 사이트 주소를 입력하세요. 경로·계정·비표준 포트는 넣지 마세요.');
  return url.origin;
};
// Site selection and CA trust are preferences, not OAuth client identity. Keep
// this exact legacy shape so existing token digests remain valid.
const oauthConfiguration = config => config && ({ client_id: config.client_id, credential_version: config.credential_version });
const publicConfiguration = config => ({ client_id: config.client_id, ...(config.site_url ? { site_url: config.site_url } : {}),
  ...(config.ca_cert_path ? { ca_cert_path: config.ca_cert_path } : {}) });
const configuration = input => {
  assert(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(k => ['client_id', 'credential_version', 'site_url', 'ca_cert_path'].includes(k))
    && typeof input.credential_version === 'string' && /^[a-f0-9]{32}$/.test(input.credential_version), 'Atlassian 연결 설정을 다시 저장하세요.');
  const site = input.site_url === undefined ? null : siteUrl(input.site_url);
  const ca = input.ca_cert_path === undefined ? null : certificatePath(input.ca_cert_path);
  return { client_id: clientId(input.client_id), credential_version: input.credential_version, ...(site ? { site_url: site } : {}), ...(ca ? { ca_cert_path: ca } : {}) };
};
const sameState = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const error = (message, status = 400, code) => Object.assign(new Error(message), { status, code });
export class AtlassianClient {
  constructor({ dir, credentials = new KeychainClientCredentials(dir), tokens = new KeychainTokens(dir), onChange = () => {},
    authOrigin = 'https://auth.atlassian.com', apiOrigin = 'https://api.atlassian.com', callback = ATLASSIAN_CALLBACK }) {
    this.file = path.join(dir, 'integrations', 'atlassian.json');
    this.credentials = credentials; this.tokens = tokens; this.onChange = onChange;
    this.authOrigin = authOrigin; this.apiOrigin = apiOrigin; this.callback = callback;
    this.mutations = Promise.resolve(); this.flow = null; this.listener = null; this.flowError = null; this.legacyConfig = false;
    this.authorizationGeneration = 0; this.siteGeneration = 0; this.transport = new AtlassianTransport();
  }
  config() {
    this.legacyConfig = false;
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value && typeof value === 'object' && ('vault' in value || 'item' in value)) { this.legacyConfig = true; return null; }
      return configuration(value);
    }
    catch (e) { if (e.code === 'ENOENT') return null; throw error('Atlassian 연결 설정을 확인하세요.'); }
  }
  exclusive(fn) {
    const next = this.mutations.then(fn, fn); this.mutations = next.catch(() => {}); return next;
  }
  status() { return this.exclusive(() => this.statusValue()); }
  async statusValue() {
    const config = this.config();
    const result = { config: config ? publicConfiguration(config) : null, has_client_secret: false,
      callback_url: this.callback, connected: false, connecting: !!this.flow && json(oauthConfiguration(this.flow.config)) === json(oauthConfiguration(config)), scopes: ATLASSIAN_SCOPES,
      message: this.legacyConfig ? '기존 1Password 설정은 더 이상 사용하지 않습니다. Client ID와 Client Secret을 입력해 다시 저장하세요.' : this.flowError };
    if (!config) return result;
    try {
      await this.credentials.read(config); result.has_client_secret = true;
      const record = await this.tokens.read();
      result.connected = !!record?.refresh_token && record.config_digest === digest(json(oauthConfiguration(config)));
      result.expires_at = result.connected ? new Date(record.expires_at).toISOString() : null;
      result.needs_reconnect = !!record && !result.connected;
    } catch (e) { result.message = e.message; }
    return result;
  }
  save(input) {
    return this.exclusive(async () => {
      assert(input && typeof input === 'object' && !Array.isArray(input)
        && Object.keys(input).every(k => ['client_id', 'client_secret', 'site_url', 'ca_cert_path'].includes(k)), 'Client ID·Client Secret·회사 Jira 사이트·추가 CA 인증서 경로만 입력하세요.');
      const client_id = clientId(input.client_id);
      assert(input.client_secret === undefined || (typeof input.client_secret === 'string' && input.client_secret.length <= 4096
        && !/[\u0000-\u001f\u007f]/.test(input.client_secret)), 'Client Secret을 확인하세요.');
      const supplied = input.client_secret?.trim() ? input.client_secret : null, current = this.config();
      const site = Object.hasOwn(input, 'site_url') ? siteUrl(input.site_url) : current?.site_url || null;
      const ca = Object.hasOwn(input, 'ca_cert_path') ? certificatePath(input.ca_cert_path) : current?.ca_cert_path || null;
      readCertificates(ca);
      assert(supplied || current?.client_id === client_id, '처음 저장하거나 Client ID를 변경할 때는 Client Secret을 입력하세요.');
      const previous = await this.credentials.stored();
      const matches = current && previous?.client_id === current.client_id && previous.credential_version === current.credential_version
        && typeof previous.client_secret === 'string' && previous.client_secret.trim() && previous.client_secret.length <= 4096
        && !/[\u0000-\u001f\u007f]/.test(previous.client_secret);
      assert(supplied || matches, '저장된 Client Secret을 확인할 수 없습니다. 다시 입력하세요.');
      const client_secret = supplied || previous.client_secret;
      if (current?.client_id === client_id && matches && sameState(previous.client_secret, client_secret)) {
        const value = { ...oauthConfiguration(current), ...(site ? { site_url: site } : {}), ...(ca ? { ca_cert_path: ca } : {}) };
        if ((current.site_url || null) !== site || (current.ca_cert_path || null) !== ca) {
          try { atomic(this.file, JSON.stringify(value, null, 2)); }
          catch { throw error('Atlassian 연결 설정을 저장하지 못했습니다. 로컬 저장 경로를 확인하세요.', 503); }
          if ((current.site_url || null) !== site) this.siteGeneration++;
          if ((current.ca_cert_path || null) !== ca) { this.transport.close(); this.flowError = null; }
          this.onChange();
        }
        return { config: publicConfiguration(value), has_client_secret: true };
      }
      const value = { client_id, credential_version: crypto.randomBytes(16).toString('hex'), ...(site ? { site_url: site } : {}), ...(ca ? { ca_cert_path: ca } : {}) };
      try {
        await this.credentials.write({ ...oauthConfiguration(value), client_secret });
        atomic(this.file, JSON.stringify(value, null, 2));
      } catch {
        try { if (previous) await this.credentials.write(previous); else await this.credentials.remove(); }
        catch { this.close(); throw error('Keychain 자격증명 저장 상태를 확인할 수 없습니다. Client ID와 Client Secret을 다시 저장하세요.', 503); }
        throw error('Atlassian 연결 설정을 저장하지 못했습니다. Keychain 접근 권한과 로컬 저장 경로를 확인하세요.', 503);
      }
      if ((current?.site_url || null) !== site) this.siteGeneration++;
      this.close(); this.flowError = null; this.onChange();
      return { config: publicConfiguration(value), has_client_secret: true };
    });
  }
  clientSecret(input) {
    return this.exclusive(async () => {
      assert(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1
        && Object.hasOwn(input, 'client_id'), '확인할 Client ID를 입력하세요.');
      const requested = clientId(input.client_id), config = this.config();
      assert(config && requested === config.client_id, '저장된 Client ID와 일치하지 않습니다. 설정을 다시 확인하세요.', 409);
      const credentials = await this.credentials.read(config);
      return { client_secret: credentials.client_secret };
    });
  }
  async begin() {
    return this.exclusive(async () => {
      const config = this.config(); assert(config, '먼저 Client ID와 Client Secret을 입력해 저장하세요.');
      readCertificates(config.ca_cert_path);
      this.close(); this.flowError = null;
      const credentials = await this.credentials.read(config);
      const callback = new URL(this.callback);
      assert(callback.protocol === 'http:' && callback.hostname === '127.0.0.1' && callback.pathname === '/oauth/atlassian/callback', 'OAuth 콜백은 지정된 로컬 경로여야 합니다.');
      const server = http.createServer((req, res) => void this.receiveCallback(req, res));
      await new Promise((resolve, reject) => {
        server.once('error', () => reject(error('OAuth 콜백 포트를 사용할 수 없습니다. 실행 중인 다른 연결을 확인하세요.', 409)));
        server.listen(Number(callback.port), '127.0.0.1', resolve);
      });
      callback.port = String(server.address().port);
      this.listener = server;
      const state = crypto.randomBytes(32).toString('hex');
      this.flow = { state, credentials, config, callback: callback.href, expires: Date.now() + 10 * 60 * 1000 };
      this.flowTimer = setTimeout(() => { this.flowError = '연결 시간이 만료되었습니다. 다시 연결하세요.'; this.close(); this.onChange(); }, 10 * 60 * 1000);
      this.flowTimer.unref();
      const authorize = new URL('/authorize', this.authOrigin);
      authorize.search = new URLSearchParams({ audience: 'api.atlassian.com', client_id: credentials.client_id,
        scope: ATLASSIAN_SCOPES.join(' '), redirect_uri: callback.href, state, response_type: 'code', prompt: 'consent' });
      this.onChange(); return { authorization_url: authorize.href };
    });
  }
  async receiveCallback(req, res) {
    const listener = this.listener, generation = this.authorizationGeneration;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    try {
      const url = new URL(req.url, this.callback), flow = this.flow;
      assert(req.method === 'GET' && url.pathname === '/oauth/atlassian/callback', '잘못된 콜백입니다.', 404);
      assert(flow && Date.now() < flow.expires && sameState(url.searchParams.get('state'), flow.state), 'OAuth state가 일치하지 않거나 만료되었습니다.', 400);
      this.flow = null; clearTimeout(this.flowTimer);
      if (url.searchParams.has('error')) throw error('Atlassian 연결이 취소되었거나 거부되었습니다.');
      const code = url.searchParams.get('code'); assert(code && code.length < 10000, '인증 코드가 없습니다.');
      await this.exclusive(async () => {
        // A disconnect or replacement flow can run while this callback waits for
        // the mutation queue. Its unchanged client configuration is not consent.
        const current = () => assert(this.authorizationGeneration === generation, '취소되었거나 대체된 OAuth 연결입니다. 다시 연결하세요.', 409);
        current();
        assert(json(oauthConfiguration(this.config())) === json(oauthConfiguration(flow.config)), '연결 중 설정이 변경되었습니다. 다시 연결하세요.');
        const saved = await this.credentials.read(flow.config);
        current();
        assert(sameState(saved.client_secret, flow.credentials.client_secret), '연결 중 자격증명이 변경되었습니다. 다시 연결하세요.', 409);
        const response = await this.tokenRequest({ grant_type: 'authorization_code', ...flow.credentials, code, redirect_uri: flow.callback });
        current();
        await this.saveTokens(response, flow.config, flow.credentials.client_id);
      });
      if (this.authorizationGeneration === generation) this.flowError = null;
      res.end('Atlassian 연결이 완료되었습니다. WorkLog로 돌아가세요.');
    } catch (e) {
      if (this.authorizationGeneration === generation) this.flowError = e.message;
      res.statusCode = e.status || 502; res.end(e.message);
    } finally {
      if (!this.flow && this.listener === listener) { listener?.close(); this.listener = null; }
      this.onChange();
    }
  }
  async tokenRequest(payload) {
    let response;
    try { response = await this.transport.fetch(new URL('/oauth/token', this.authOrigin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json(payload), redirect: 'error', signal: AbortSignal.timeout(15000) }, this.config()?.ca_cert_path); }
    catch (cause) { throw connectionFailure(cause, 'Atlassian 토큰 서버', 503, 'token_connection_failed'); }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel();
      throw error(`Atlassian 토큰 서버가 HTTP ${response.status}을 반환했습니다. 잠시 후 다시 연결하세요.`, response.status, 'token_server_error');
    }
    let data; try { data = await response.json(); } catch { throw error('Atlassian 토큰 응답 형식이 올바르지 않습니다.', 502); }
    if (!response.ok) throw error(data.error === 'invalid_grant' ? 'Atlassian 인증이 만료되었습니다. 다시 연결하세요.' : 'Atlassian 인증 요청이 거부되었습니다. OAuth 앱 설정을 확인하세요.', 401, data.error === 'invalid_grant' ? 'reauth_required' : 'oauth_rejected');
    return data;
  }
  async saveTokens(data, config, clientId) {
    assert(typeof data.access_token === 'string' && data.access_token && typeof data.refresh_token === 'string' && data.refresh_token && Number.isFinite(data.expires_in) && data.expires_in > 0, 'Atlassian 토큰과 offline_access 권한을 확인하세요.', 502);
    const record = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000,
      config_digest: digest(json(oauthConfiguration(config))), client_digest: digest(clientId) };
    // Access and rotating refresh tokens are replaced together, in one Keychain item.
    await this.tokens.write(record); this.onChange(); return record;
  }
  accessToken(rejectedToken) {
    // Serialize credential snapshots, token refreshes and configuration updates.
    // A queued concurrent caller observes the refreshed token instead of rotating twice.
    return this.exclusive(async () => {
      const config = this.config(); assert(config, 'Client ID와 Client Secret을 저장하고 Atlassian OAuth를 연결하세요.', 401);
      const credentials = await this.credentials.read(config), record = await this.tokens.read();
      assert(record?.refresh_token && record.config_digest === digest(json(oauthConfiguration(config)))
        && record.client_digest === digest(credentials.client_id), 'Atlassian OAuth를 다시 연결하세요.', 401);
      if (rejectedToken ? record.access_token !== rejectedToken : record.expires_at > Date.now() + 60000) return record.access_token;
      try {
        const data = await this.tokenRequest({ grant_type: 'refresh_token', ...credentials, refresh_token: record.refresh_token });
        return (await this.saveTokens(data, config, credentials.client_id)).access_token;
      } catch (e) {
        if (e.code === 'reauth_required') { await this.tokens.remove(); this.flowError = e.message; this.onChange(); }
        throw e;
      }
    });
  }
  async request(apiPath, { method = 'GET', body, beforeSend, authorization } = {}) {
    assert(apiPath.startsWith('/') && !apiPath.startsWith('//') && !apiPath.includes('..'), 'API 경로가 올바르지 않습니다.');
    const send = async token => {
      // Recheck local snapshots after token/site I/O, immediately before a write.
      try {
        authorization?.(token);
        const pending = beforeSend?.();
        if (pending?.then) await pending;
        authorization?.(token);
      } catch (e) { e.not_sent = true; throw e; }
      try { return await this.transport.fetch(new URL(apiPath, this.apiOrigin), { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: json(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) }, this.config()?.ca_cert_path); }
      catch (cause) { throw connectionFailure(cause, 'Atlassian API 응답을 확인하지 못했습니다', 502, 'unconfirmed'); }
    };
    let token;
    try { token = await this.accessToken(); } catch (e) { e.not_sent = true; throw e; }
    let response = await send(token);
    if (response.status === 401) {
      await response.body?.cancel();
      try { token = await this.accessToken(token); } catch (e) { e.not_sent = true; throw e; }
      response = await send(token);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const messages = { 400: 'Jira 필수 필드와 프로젝트 설정을 확인하세요.', 401: 'Atlassian OAuth를 다시 연결하세요.', 403: 'Atlassian 사이트·프로젝트 접근 권한을 확인하세요.', 404: '요청한 Atlassian 항목을 찾을 수 없습니다.', 429: 'Atlassian 호출 한도에 도달했습니다. 잠시 후 다시 시도하세요.' };
      throw error(messages[response.status] || 'Atlassian API 요청이 실패했습니다.', response.status, response.status >= 500 ? 'unconfirmed' : 'rejected');
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw error('Atlassian API 응답 형식을 확인하지 못했습니다.', 502, 'unconfirmed'); }
  }
  async resources() {
    const rows = await this.request('/oauth/token/accessible-resources');
    assert(Array.isArray(rows), 'Atlassian 사이트 응답을 확인하세요.', 502);
    return rows.map(({ id, name, url, scopes }) => ({ id, name, url, scopes }));
  }
  async selectableSites(product = 'jira') {
    assert(['jira', 'confluence'].includes(product), 'Jira 또는 Confluence 사이트를 선택하세요.');
    const configured = this.config()?.site_url || null, generation = this.siteGeneration, authorization = this.authorizationGeneration;
    const resources = await this.resources();
    assert((this.config()?.site_url || null) === configured && this.siteGeneration === generation
      && this.authorizationGeneration === authorization, '사이트 또는 연결 설정이 변경되었습니다. 사이트 목록을 다시 불러오세요.', 409);
    const permission = product === 'jira' ? 'read:jira-work' : 'read:page:confluence';
    const available = resources.filter(site => Array.isArray(site.scopes) && site.scopes.includes(permission));
    if (!configured) return available;
    const preferred = available.find(site => {
      try { const url = new URL(site.url); return !url.username && !url.password && url.origin === configured; }
      catch { return false; }
    });
    assert(preferred, `설정한 회사 사이트에 ${product === 'jira' ? 'Jira' : 'Confluence'} 접근 권한이 없습니다. 사이트 주소와 연결 계정을 확인하세요.`, 403);
    return [{ ...preferred, preferred: true }, ...available.filter(site => site !== preferred)];
  }
  async site(cloudId, product) {
    assert(typeof cloudId === 'string' && /^[a-zA-Z0-9-]+$/.test(cloudId), 'Atlassian 사이트를 선택하세요.');
    const permission = product === 'jira' ? 'read:jira-work' : 'read:page:confluence';
    const site = (await this.resources()).find(s => s.id === cloudId && s.scopes?.includes(permission));
    assert(site, '선택한 사이트에 필요한 OAuth 권한이 없습니다.', 403);
    return site;
  }
  async jiraIssue(cloudId, key) {
    await this.site(cloudId, 'jira'); assert(/^[a-zA-Z][a-zA-Z0-9_]*-\d+$/.test(key), 'Jira 티켓 키를 확인하세요.');
    return this.request(`/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(key)}`);
  }
  async issueContent(issue) {
    await this.site(issue.cloud_id, 'jira');
    const raw = await this.request(`${this.issuePath(issue.cloud_id, issue.id)}?fields=summary,description,updated`);
    assert(raw?.id === issue.id && typeof raw.fields?.summary === 'string'
      && Object.hasOwn(raw.fields, 'description'), 'Jira 제목·설명 응답을 확인하세요.', 502);
    return raw;
  }
  issuePath(cloudId, identifier) {
    assert(typeof cloudId === 'string' && /^[a-zA-Z0-9-]+$/.test(cloudId) && typeof identifier === 'string' && /^(?:\d+|[a-zA-Z][a-zA-Z0-9_]*-\d+)$/.test(identifier), 'Jira 이슈 식별자를 확인하세요.');
    return `/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(identifier)}`;
  }
  async lookupIssue(cloudId, value) {
    const site = await this.site(cloudId, 'jira');
    assert(typeof value === 'string' && value.trim().length > 0 && value.length <= 1000, 'Jira 이슈 키 또는 URL을 입력하세요.');
    let key = value.trim();
    if (/^https?:/i.test(key)) {
      let url; try { url = new URL(key); } catch { throw error('Jira 이슈 URL을 확인하세요.'); }
      assert(url.protocol === 'https:' && !url.username && !url.password && url.origin === new URL(site.url).origin && /^\/browse\/[a-zA-Z][a-zA-Z0-9_]*-\d+\/?$/.test(url.pathname), '선택한 Jira 사이트의 이슈 URL을 입력하세요.');
      key = url.pathname.split('/')[2];
    }
    assert(/^[a-zA-Z][a-zA-Z0-9_]*-\d+$/.test(key), 'Jira 이슈 키를 확인하세요.');
    return this.issueDetails(cloudId, key.toUpperCase(), site);
  }
  async issueDetails(cloudId, identifier, site) {
    site ||= await this.site(cloudId, 'jira');
    const raw = await this.request(`${this.issuePath(cloudId, identifier)}?fields=summary,status,updated`);
    return this.normalizeIssue(raw, cloudId, site);
  }
  normalizeIssue(raw, cloudId, site) {
    const status = raw?.fields?.status;
    assert(typeof raw?.id === 'string' && /^\d+$/.test(raw.id) && /^[A-Z][A-Z0-9_]*-\d+$/i.test(raw.key)
      && typeof raw.fields?.summary === 'string' && typeof status?.id === 'string' && typeof status.name === 'string'
      && Number.isFinite(Date.parse(raw.fields.updated)), 'Jira 이슈 상태 응답을 확인하세요.', 502);
    const url = new URL(site.url);
    assert(url.protocol === 'https:' && !url.username && !url.password && url.hostname.endsWith('.atlassian.net'), 'Jira 사이트 주소를 확인하세요.', 502);
    return { id: raw.id, key: raw.key, cloud_id: cloudId, url: new URL(`/browse/${raw.key}`, url).href, title: raw.fields.summary,
      status: { id: status.id, name: status.name, category: status.statusCategory?.key || 'undefined' }, updated: raw.fields.updated };
  }
  async searchIssues(cloudId, query, nextPageToken = null) {
    assert(typeof query === 'string' && query.trim() && query.length <= 1000, '이슈 키 또는 제목을 입력하세요.');
    assert(nextPageToken === null || (typeof nextPageToken === 'string' && nextPageToken.length > 0 && nextPageToken.length <= 4096), '검색 페이지를 다시 불러오세요.');
    const text = query.trim();
    if (/^https?:/i.test(text) || /^[a-zA-Z][a-zA-Z0-9_]*-\d+$/.test(text)) {
      assert(!nextPageToken, '이슈 키 조회에는 다음 페이지가 없습니다.');
      try { return { issues: [await this.lookupIssue(cloudId, text)], next_page_token: null }; }
      catch (e) { if (e.status === 404) return { issues: [], next_page_token: null }; throw e; }
    }
    assert(text.length <= 200, '제목 검색어는 200자 이내로 입력하세요.');
    // Build a bounded query from words only. User input can never become a JQL operator.
    const terms = [...new Set(text.match(/[\p{L}\p{N}_]+/gu) || [])];
    assert(terms.length > 0 && terms.length <= 20, '검색할 제목의 단어를 1~20개 입력하세요.');
    const jql = terms.map(term => `summary ~ "${term}*"`).join(' AND ') + ' ORDER BY updated DESC, key ASC';
    const site = await this.site(cloudId, 'jira');
    const params = new URLSearchParams({ jql, fields: 'summary,status,updated', maxResults: '20' });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);
    let result;
    try { result = await this.request(`/ex/jira/${cloudId}/rest/api/3/search/jql?${params}`); }
    catch (e) { if (e.status === 400) e.message = 'Jira에서 검색을 처리하지 못했습니다. 검색어를 바꾸거나 처음부터 다시 검색하세요.'; throw e; }
    assert(Array.isArray(result?.issues) && result.issues.length <= 20, 'Jira 검색 결과를 확인하세요.', 502);
    const next = result.isLast === true ? null : result.nextPageToken || null;
    assert((result.isLast !== false || next) && (!next || (typeof next === 'string' && next.length <= 4096 && next !== nextPageToken)), 'Jira 검색 페이지 정보를 확인하세요.', 502);
    return { issues: result.issues.map(raw => this.normalizeIssue(raw, cloudId, site)), next_page_token: next };
  }
  async issueState(issue) {
    const site = await this.site(issue.cloud_id, 'jira');
    const current = await this.issueDetails(issue.cloud_id, issue.id, site);
    let transitions = [], transition_message = null;
    const can_write = site.scopes.includes('write:jira-work');
    if (can_write) {
      try {
        const result = await this.request(`${this.issuePath(issue.cloud_id, issue.id)}/transitions?expand=transitions.fields`);
        assert(Array.isArray(result.transitions), 'Jira 상태 변경 목록을 확인하세요.', 502);
        transitions = result.transitions.filter(t => t.isAvailable !== false).map(t => {
          assert(typeof t.id === 'string' && /^\d+$/.test(t.id) && typeof t.name === 'string' && typeof t.to?.id === 'string' && typeof t.to.name === 'string', 'Jira 상태 변경 항목을 확인하세요.', 502);
          const required_fields = Object.entries(t.fields || {}).filter(([, f]) => f.required).map(([key, f]) => ({ key, name: f.name || key }));
          return { id: t.id, name: t.name, to: { id: t.to.id, name: t.to.name, category: t.to.statusCategory?.key || 'undefined' }, required_fields };
        });
      } catch (e) { transition_message = e.message; }
    } else transition_message = 'Jira 쓰기 권한으로 OAuth를 다시 연결하면 상태를 변경할 수 있습니다.';
    return { issue: current, transitions, transition_message, can_write };
  }
  async transitionIssue(issue, transitionId, { beforeSend } = {}) {
    assert(typeof transitionId === 'string' && /^\d+$/.test(transitionId), 'Jira 상태 변경 항목을 확인하세요.');
    return this.request(`${this.issuePath(issue.cloud_id, issue.id)}/transitions`, { method: 'POST', beforeSend, body: { transition: { id: transitionId } } });
  }
  async confluencePage(cloudId, id) {
    await this.site(cloudId, 'confluence'); assert(/^\d+$/.test(id), 'Confluence 페이지 ID를 확인하세요.');
    return this.request(`/ex/confluence/${cloudId}/wiki/api/v2/pages/${id}?body-format=storage`);
  }
  confluenceUrl(site, pageId) {
    assert(typeof pageId === 'string' && /^\d+$/.test(pageId), 'Confluence 페이지 ID를 확인하세요.', 502);
    const url = new URL(site.url);
    assert(url.protocol === 'https:' && !url.username && !url.password && url.hostname.endsWith('.atlassian.net'), 'Confluence 사이트 주소를 확인하세요.', 502);
    return new URL(`/wiki/pages/viewpage.action?pageId=${pageId}`, url).href;
  }
  async confluenceSpaces(cloudId, cursor = null) {
    assert(cursor === null || (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(cursor)), 'Confluence 공간 페이지를 다시 불러오세요.');
    const site = await this.site(cloudId, 'confluence');
    assert(site.scopes.includes('read:space:confluence'), 'Confluence 공간 읽기 권한으로 OAuth를 다시 연결하세요.', 403);
    const base = `/ex/confluence/${cloudId}/wiki/api/v2/spaces`, params = new URLSearchParams({ status: 'current', limit: '50' });
    if (cursor) params.set('cursor', cursor);
    const result = await this.request(`${base}?${params}`);
    assert(Array.isArray(result?.results) && result.results.length <= 50, 'Confluence 공간 목록 응답을 확인하세요.', 502);
    const spaces = result.results.map(row => {
      assert(typeof row.id === 'string' && /^\d+$/.test(row.id) && typeof row.name === 'string' && typeof row.key === 'string', 'Confluence 공간 정보를 확인하세요.', 502);
      return { id: row.id, key: row.key, name: row.name };
    });
    let next_cursor = null;
    if (result._links?.next) {
      // Treat the server link only as a cursor source, never as a request destination.
      let next; try { next = new URL(result._links.next, this.apiOrigin); } catch { assert(false, 'Confluence 공간 페이지 정보를 확인하세요.', 502); }
      assert([new URL(this.apiOrigin).origin, new URL(site.url).origin].includes(next.origin) && !next.username && !next.password
        && [base, '/wiki/api/v2/spaces'].includes(next.pathname) && !next.hash
        && [...next.searchParams.keys()].every(k => ['cursor', 'limit', 'status'].includes(k))
        && next.searchParams.getAll('cursor').length === 1, 'Confluence 공간 페이지 정보를 확인하세요.', 502);
      next_cursor = next.searchParams.get('cursor');
      assert(next_cursor && next_cursor.length <= 4096 && next_cursor !== cursor && !/[\u0000-\u001f\u007f]/.test(next_cursor), 'Confluence 공간 페이지 정보를 확인하세요.', 502);
    }
    return { spaces, next_cursor };
  }
  async createConfluencePage({ cloud_id, space_id, title, storage }, { beforeSend } = {}) {
    let site;
    try {
      site = await this.site(cloud_id, 'confluence');
      assert(site.scopes.includes('write:page:confluence') && site.scopes.includes('read:space:confluence'), 'Confluence 공간 읽기·페이지 쓰기 권한으로 OAuth를 다시 연결하세요.', 403);
      assert(typeof space_id === 'string' && /^\d+$/.test(space_id) && typeof title === 'string' && title.trim() && title.length <= 255
        && typeof storage === 'string' && storage.length > 0, '게시할 Confluence 공간과 보고서를 확인하세요.');
      // Validate the accessible target before initiating the irreversible POST.
      const space = await this.request(`/ex/confluence/${cloud_id}/wiki/api/v2/spaces/${space_id}`);
      assert(space?.id === space_id && space.status === 'current', '현재 사용할 수 있는 Confluence 공간을 선택하세요.', 409);
      this.confluenceUrl(site, '0');
    } catch (e) { e.not_sent = true; throw e; }
    let result;
    try {
      result = await this.request(`/ex/confluence/${cloud_id}/wiki/api/v2/pages`, { method: 'POST', beforeSend,
        body: { spaceId: space_id, status: 'current', title, body: { representation: 'storage', value: storage } } });
      assert(typeof result?.id === 'string' && /^\d+$/.test(result.id) && result.spaceId === space_id
        && result.title === title && result.status === 'current', 'Confluence 페이지 생성 결과를 확인하지 못했습니다.', 502);
    } catch (e) {
      if (e.status === 400) e.message = 'Confluence 페이지 제목·본문과 공간 설정을 확인하세요.';
      throw e;
    }
    return { page_id: result.id, url: this.confluenceUrl(site, result.id) };
  }
  async confluencePageForPublication(cloudId, pageId) {
    const site = await this.site(cloudId, 'confluence');
    assert(typeof pageId === 'string' && /^\d+$/.test(pageId), 'Confluence 페이지 ID를 확인하세요.');
    const page = await this.request(`/ex/confluence/${cloudId}/wiki/api/v2/pages/${pageId}?body-format=storage`);
    return { page, url: this.confluenceUrl(site, pageId) };
  }
  async jiraProjects(cloudId) {
    await this.site(cloudId, 'jira');
    return { values: await this.pages(`/ex/jira/${cloudId}/rest/api/3/project/search?action=create`, 'values') };
  }
  async jiraIssueTypes(cloudId, project) {
    await this.site(cloudId, 'jira'); assert(/^[a-zA-Z0-9_]+$/.test(project), 'Jira 프로젝트 키를 확인하세요.');
    return { issueTypes: await this.pages(`/ex/jira/${cloudId}/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes?`, 'issueTypes') };
  }
  async pages(base, field) {
    const values = []; let start = 0;
    for (let page = 0; page < 100; page++) {
      const result = await this.request(`${base}&startAt=${start}&maxResults=100`);
      const batch = result[field] || result.values;
      assert(Array.isArray(batch), 'Jira 목록 응답을 확인하세요.', 502);
      values.push(...batch); start += batch.length;
      if (result.isLast === true || start >= result.total) return values;
      assert(batch.length && (result.isLast === false || (Number.isInteger(result.total) && start < result.total)), 'Jira 목록의 페이지 정보를 확인하세요.', 502);
    }
    throw error('Jira 목록 조회 한도를 초과했습니다.', 409);
  }
  async createJiraIssue({ cloud_id, project, issue_type, title, description, operation_id, work_item_id }, { beforeSend } = {}) {
    let site, accountId, identityToken, observedToken, authorization;
    try {
      const generation = this.authorizationGeneration, config = json(oauthConfiguration(this.config()));
      authorization = token => {
        assert(this.authorizationGeneration === generation && json(oauthConfiguration(this.config())) === config
          && (!identityToken || sameState(token, identityToken)), 'Jira 생성 중 Atlassian 인증이 변경되었습니다. 현재 계정을 확인하고 다시 시도하세요.', 409);
        observedToken = token;
      };
      site = await this.site(cloud_id, 'jira');
      assert(site.scopes.includes('write:jira-work'), 'Jira 쓰기 권한으로 OAuth를 다시 연결하세요.', 403);
      assert(site.scopes.includes('read:jira-user'), 'Jira 현재 사용자 읽기 권한(read:jira-user)으로 OAuth를 다시 연결하세요.', 403);
      assert(/^[a-zA-Z0-9_]+$/.test(project) && /^\d+$/.test(issue_type), 'Jira 프로젝트와 티켓 유형을 선택하세요.');
      const user = await this.request(`/ex/jira/${cloud_id}/rest/api/3/myself`, { authorization });
      accountId = user?.accountId;
      assert(typeof accountId === 'string' && accountId.length > 0 && accountId.length <= 256
        && !/\s|[\u0000-\u001f\u007f]/.test(accountId) && !/^(?:unknown|anonymous)$/i.test(accountId)
        && user.active !== false, 'Jira 현재 사용자를 확인할 수 없습니다. OAuth 계정과 사용자 읽기 권한을 확인하세요.', 502);
      // Pin the credential that identified this user. A refresh or another OAuth
      // connection must never reuse that identity with a different bearer token.
      identityToken = observedToken;
    } catch (e) { e.not_sent = true; throw e; }
    const result = await this.request(`/ex/jira/${cloud_id}/rest/api/3/issue`, { method: 'POST', beforeSend, authorization, body: {
      fields: { project: { key: project }, issuetype: { id: issue_type }, summary: title, description: jiraDescription(description),
        reporter: { accountId }, assignee: { accountId } },
      properties: [{ key: 'work-log', value: { operation_id, work_item_id } }]
    } });
    assert(typeof result.id === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*-\d+$/.test(result.key), 'Jira 티켓 생성 결과를 확인하지 못했습니다.', 502);
    const url = new URL(site.url); assert(url.protocol === 'https:' || this.apiOrigin.startsWith('http://127.0.0.1:'), 'Jira 사이트 주소를 확인하세요.', 502);
    return { id: result.id, key: result.key, url: new URL(`/browse/${result.key}`, url).href, cloud_id };
  }
  async updateJiraIssue(issue, { title, description }, { beforeSend } = {}) {
    assert(typeof title === 'string' && title.trim() && title.length <= 200
      && typeof description === 'string' && description.length <= 5000, 'Jira에 반영할 제목과 설명을 확인하세요.');
    let site;
    try { site = await this.site(issue.cloud_id, 'jira'); } catch (e) { e.not_sent = true; throw e; }
    assert(site.scopes.includes('write:jira-work'), 'Jira 쓰기 권한으로 OAuth를 다시 연결하세요.', 403);
    return this.request(this.issuePath(issue.cloud_id, issue.id), { method: 'PUT', beforeSend,
      body: { fields: { summary: title, description: jiraDescription(description) } } });
  }
  async resolveIssue(link, key) {
    const issue = await this.jiraIssue(link.request.cloud_id, key);
    const property = await this.request(`/ex/jira/${link.request.cloud_id}/rest/api/3/issue/${encodeURIComponent(key)}/properties/work-log`);
    assert(property.value?.operation_id === link.operation_id, '이 생성 요청으로 만든 Jira 티켓인지 확인할 수 없습니다.', 409);
    const site = await this.site(link.request.cloud_id, 'jira');
    return { id: issue.id, key: issue.key, url: new URL(`/browse/${issue.key}`, site.url).href, cloud_id: link.request.cloud_id };
  }
  resultCommentPath(issue) {
    assert(typeof issue?.id === 'string' && /^\d+$/.test(issue.id), 'Jira 결과 댓글의 이슈 ID를 확인하세요.');
    return `${this.issuePath(issue.cloud_id, issue.id)}/comment`;
  }
  async postResultComment(issue, { operation_id, work_item_id, text, source_digest }, { beforeSend } = {}) {
    let base;
    try {
      base = this.resultCommentPath(issue);
      assert([operation_id, work_item_id, source_digest].every(value => typeof value === 'string' && value.trim()
        && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value))
        && typeof text === 'string' && text.trim() && text.length <= 32767, 'Jira 결과 댓글과 출처를 확인하세요.');
      const site = await this.site(issue.cloud_id, 'jira');
      assert(site.scopes.includes('write:jira-work'), 'Jira 쓰기 권한으로 OAuth를 다시 연결하세요.', 403);
    } catch (e) { e.not_sent = true; throw e; }
    const result = await this.request(base, { method: 'POST', beforeSend, body: {
      body: plainTextADF(text), properties: [{ key: 'work-log-result', value: {
        operation_id, work_item_id, source_digest, cloud_id: issue.cloud_id, issue_id: issue.id
      } }]
    } });
    assert(typeof result?.id === 'string' && /^\d+$/.test(result.id), 'Jira 결과 댓글 생성 결과를 확인하지 못했습니다.', 502);
    return { id: result.id };
  }
  async findResultComment(issue, operationId) {
    const base = this.resultCommentPath(issue);
    assert(typeof operationId === 'string' && operationId.trim() && operationId.length <= 256
      && !/[\u0000-\u001f\u007f]/.test(operationId), 'Jira 결과 댓글 요청 ID를 확인하세요.');
    await this.site(issue.cloud_id, 'jira');
    let start = 0, total = null, match = null;
    const seen = new Set();
    for (let page = 0; page < 100; page++) {
      const result = await this.request(`${base}?startAt=${start}&maxResults=100&orderBy=created&expand=properties`);
      assert(Array.isArray(result?.comments) && result.comments.length <= 100 && result.startAt === start
        && Number.isSafeInteger(result.total) && result.total >= 0
        && start + result.comments.length <= result.total && (total === null || total === result.total), 'Jira 결과 댓글 페이지가 변경되었거나 올바르지 않습니다. 다시 확인하세요.', 502);
      total = result.total;
      for (const comment of result.comments) {
        assert(typeof comment?.id === 'string' && /^\d+$/.test(comment.id) && !seen.has(comment.id)
          && (comment.properties === undefined || Array.isArray(comment.properties)), 'Jira 결과 댓글 조회 응답을 확인하세요.', 502);
        seen.add(comment.id);
        const markers = (comment.properties || []).filter(property => property?.key === 'work-log-result');
        const marker = markers.find(property => property.value?.operation_id === operationId)?.value;
        if (!marker) continue;
        assert(markers.length === 1 && marker.cloud_id === issue.cloud_id && marker.issue_id === issue.id
          && typeof marker.work_item_id === 'string' && marker.work_item_id.trim()
          && typeof marker.source_digest === 'string' && marker.source_digest.trim(), 'Jira 결과 댓글의 이슈와 출처를 확인할 수 없습니다.', 409);
        assert(!match, '같은 요청의 Jira 결과 댓글이 여러 개입니다. 직접 확인하세요.', 409);
        match = comment;
      }
      start += result.comments.length;
      if (start === total) return match;
      assert(result.comments.length > 0, 'Jira 결과 댓글 조회가 끝나지 않았습니다.', 502);
    }
    throw error('Jira 결과 댓글 조회 한도를 초과했습니다. 직접 확인하세요.', 409);
  }
  worklogPath(issue) {
    // Stable numeric IDs keep worklog ownership intact when Jira moves an issue to another project.
    return `${this.issuePath(issue.cloud_id, issue.id)}/worklog`;
  }
  async findWorklog(issue, operationId) {
    const base = this.worklogPath(issue); let start = 0;
    const matches = [];
    for (let page = 0; page < 1000; page++) {
      const result = await this.request(`${base}?startAt=${start}&maxResults=100&expand=properties`);
      assert(Array.isArray(result.worklogs) && Number.isInteger(result.total), '업무 로그 조회 결과를 확인하세요.', 502);
      matches.push(...result.worklogs.filter(w => w.properties?.some(p => p.key === 'work-log' && p.value?.operation_id === operationId)));
      start += result.worklogs.length;
      if (start >= result.total) { assert(matches.length <= 1, '같은 세션의 Jira 업무 로그가 여러 개입니다. 직접 확인하세요.', 409); return matches[0] || null; }
      assert(result.worklogs.length, '업무 로그 조회가 끝나지 않았습니다.', 502);
    }
    throw error('업무 로그 조회 한도를 초과했습니다. 직접 확인하세요.', 409);
  }
  async writeWorklog(issue, row, { beforeSend } = {}) {
    const payload = JSON.parse(row.payload), base = this.worklogPath(issue);
    assert(Number.isInteger(payload.seconds) && payload.seconds > 0 && Number.isFinite(Date.parse(payload.started)), '관측된 작업 시간과 시작 시각이 필요합니다.');
    if (row.worklog_id) {
      assert(/^\d+$/.test(row.worklog_id), '업무 로그 ID를 확인하세요.');
      const current = await this.request(`${base}/${row.worklog_id}?expand=properties`);
      assert(current.properties?.some(p => p.key === 'work-log' && p.value?.operation_id === row.operation_id), '기존 업무 로그의 출처를 확인할 수 없습니다.', 409);
    }
    const result = await this.request(`${base}${row.worklog_id ? `/${row.worklog_id}` : ''}?adjustEstimate=leave&notifyUsers=false`, {
      method: row.worklog_id ? 'PUT' : 'POST', beforeSend, body: {
        started: new Date(payload.started).toISOString().replace('Z', '+0000'), timeSpentSeconds: payload.seconds,
        comment: plainTextADF(payload.comment), properties: [{ key: 'work-log', value: { operation_id: row.operation_id, session_id: row.session_id, source_digest: row.source_digest } }]
      }
    });
    assert(typeof result.id === 'string' && /^\d+$/.test(result.id), '업무 로그 생성 결과를 확인하지 못했습니다.', 502);
    return result;
  }
  disconnect() {
    return this.exclusive(async () => { this.close(); await this.tokens.remove(); this.flowError = null; this.onChange(); return { connected: false }; });
  }
  close() { this.transport.close(); this.authorizationGeneration++; this.flow = null; clearTimeout(this.flowTimer); this.listener?.close(); this.listener = null; }
}

export function atlassianClient(dir, onChange) {
  const options = { dir, onChange };
  // Local protocol simulators are only reachable in explicit E2E mode with isolated credential helpers.
  if (process.env.HARNESS_TEST_MODE === '1' && process.env.HARNESS_ATLASSIAN_TEST_ORIGIN) {
    const origin = new URL(process.env.HARNESS_ATLASSIAN_TEST_ORIGIN);
    assert(['http:', 'https:'].includes(origin.protocol) && origin.hostname === '127.0.0.1' && process.env.HARNESS_KEYCHAIN_BIN, 'Atlassian 테스트 환경은 로컬 모의 서버와 격리된 Keychain 도우미가 필요합니다.');
    Object.assign(options, { authOrigin: origin.origin, apiOrigin: origin.origin, callback: 'http://127.0.0.1:0/oauth/atlassian/callback' });
  }
  return new AtlassianClient(options);
}
