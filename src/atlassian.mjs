import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { assert, atomic, digest, json } from './shared.mjs';
import { OnePasswordCredentials, KeychainTokens } from './credentials.mjs';

export const ATLASSIAN_CALLBACK = 'http://127.0.0.1:47831/oauth/atlassian/callback';
export const ATLASSIAN_SCOPES = ['offline_access', 'read:jira-work', 'write:jira-work', 'read:page:confluence'];
const configuration = input => {
  assert(input && Object.keys(input).every(k => ['vault', 'item'].includes(k)), '설정에는 vault와 item 이름만 저장할 수 있습니다.');
  for (const key of ['vault', 'item']) assert(typeof input[key] === 'string' && input[key].trim().length > 0 && input[key].length <= 200 && !/[\u0000-\u001f]/.test(input[key]) && !input[key].startsWith('-'), `${key} 이름을 확인하세요.`);
  return { vault: input.vault.trim(), item: input.item.trim() };
};
const sameState = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const error = (message, status = 400, code) => Object.assign(new Error(message), { status, code });
export function jiraDescription(text) {
  const content = [];
  String(text).split('\n').forEach((line, i) => {
    if (i) content.push({ type: 'hardBreak' });
    if (line) content.push({ type: 'text', text: line });
  });
  return { version: 1, type: 'doc', content: [{ type: 'paragraph', content }] };
}

export class AtlassianClient {
  constructor({ dir, credentials = new OnePasswordCredentials(), tokens = new KeychainTokens(dir), onChange = () => {},
    authOrigin = 'https://auth.atlassian.com', apiOrigin = 'https://api.atlassian.com', callback = ATLASSIAN_CALLBACK }) {
    this.file = path.join(dir, 'integrations', 'atlassian.json');
    this.credentials = credentials; this.tokens = tokens; this.onChange = onChange;
    this.authOrigin = authOrigin; this.apiOrigin = apiOrigin; this.callback = callback;
    this.mutations = Promise.resolve(); this.refreshing = null; this.flow = null; this.listener = null; this.flowError = null;
  }
  config() {
    try { return configuration(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch (e) { if (e.code === 'ENOENT') return null; throw error('Atlassian 연결 설정을 확인하세요.'); }
  }
  exclusive(fn) {
    const next = this.mutations.then(fn, fn); this.mutations = next.catch(() => {}); return next;
  }
  async status() {
    const config = this.config();
    const result = { config, callback_url: this.callback, connected: false, connecting: !!this.flow, scopes: ATLASSIAN_SCOPES, message: this.flowError };
    if (!config) return result;
    try {
      const record = await this.tokens.read();
      result.connected = !!record?.refresh_token && record.config_digest === digest(json(config));
      result.expires_at = result.connected ? new Date(record.expires_at).toISOString() : null;
      result.needs_reconnect = !!record && !result.connected;
    } catch (e) { result.message = e.message; }
    return result;
  }
  save(input) {
    return this.exclusive(async () => {
      const value = configuration(input);
      this.close(); this.flowError = null;
      atomic(this.file, JSON.stringify(value, null, 2)); this.onChange();
      return { config: value };
    });
  }
  async begin() {
    return this.exclusive(async () => {
      const config = this.config(); assert(config, '먼저 1Password vault와 item 이름을 저장하세요.');
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
    const listener = this.listener;
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
        assert(json(this.config()) === json(flow.config), '연결 중 설정이 변경되었습니다. 다시 연결하세요.');
        const response = await this.tokenRequest({ grant_type: 'authorization_code', ...flow.credentials, code, redirect_uri: flow.callback });
        await this.saveTokens(response, flow.config, flow.credentials.client_id);
      });
      this.flowError = null; res.end('Atlassian 연결이 완료되었습니다. Work Log로 돌아가세요.');
    } catch (e) {
      this.flowError = e.message;
      res.statusCode = e.status || 502; res.end(e.message);
    } finally {
      if (!this.flow && this.listener === listener) { listener?.close(); this.listener = null; }
      this.onChange();
    }
  }
  async tokenRequest(payload) {
    let response;
    try { response = await fetch(new URL('/oauth/token', this.authOrigin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json(payload), redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw error('Atlassian 토큰 서버에 연결할 수 없습니다. 다시 시도하세요.', 503); }
    let data; try { data = await response.json(); } catch { throw error('Atlassian 토큰 응답 형식이 올바르지 않습니다.', 502); }
    if (!response.ok) throw error(data.error === 'invalid_grant' ? 'Atlassian 인증이 만료되었습니다. 다시 연결하세요.' : 'Atlassian 인증 요청이 거부되었습니다. OAuth 앱 설정을 확인하세요.', 401, data.error === 'invalid_grant' ? 'reauth_required' : 'oauth_rejected');
    return data;
  }
  async saveTokens(data, config, clientId) {
    assert(typeof data.access_token === 'string' && data.access_token && typeof data.refresh_token === 'string' && data.refresh_token && Number.isFinite(data.expires_in) && data.expires_in > 0, 'Atlassian 토큰과 offline_access 권한을 확인하세요.', 502);
    const record = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000,
      config_digest: digest(json(config)), client_digest: digest(clientId) };
    // Access and rotating refresh tokens are replaced together, in one Keychain item.
    await this.tokens.write(record); this.onChange(); return record;
  }
  async accessToken(rejectedToken) {
    const config = this.config(); assert(config, 'Atlassian 연결 설정이 필요합니다.', 401);
    const record = await this.tokens.read();
    assert(record?.refresh_token && record.config_digest === digest(json(config)), 'Atlassian OAuth를 연결하세요.', 401);
    if (rejectedToken ? record.access_token !== rejectedToken : record.expires_at > Date.now() + 60000) return record.access_token;
    if (!this.refreshing) {
      this.refreshing = this.exclusive(async () => {
        const current = await this.tokens.read();
        assert(current?.refresh_token && current.config_digest === digest(json(this.config())), 'Atlassian OAuth를 다시 연결하세요.', 401);
        if (current.access_token !== record.access_token && current.expires_at > Date.now() + 60000) return current.access_token;
        const credentials = await this.credentials.read(this.config());
        assert(digest(credentials.client_id) === current.client_digest, 'OAuth 앱이 변경되었습니다. 다시 연결하세요.', 401);
        try {
          const data = await this.tokenRequest({ grant_type: 'refresh_token', ...credentials, refresh_token: current.refresh_token });
          return (await this.saveTokens(data, this.config(), credentials.client_id)).access_token;
        } catch (e) {
          if (e.code === 'reauth_required') { await this.tokens.remove(); this.flowError = e.message; this.onChange(); }
          throw e;
        }
      }).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async request(apiPath, { method = 'GET', body } = {}) {
    assert(apiPath.startsWith('/') && !apiPath.startsWith('//') && !apiPath.includes('..'), 'API 경로가 올바르지 않습니다.');
    const send = async token => {
      try { return await fetch(new URL(apiPath, this.apiOrigin), { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: json(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) }); }
      catch { throw error('Atlassian API 응답을 확인하지 못했습니다.', 502, 'unconfirmed'); }
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
          return { id: t.id, name: t.name, to: { id: t.to.id, name: t.to.name }, required_fields };
        });
      } catch (e) { transition_message = e.message; }
    } else transition_message = 'Jira 쓰기 권한으로 OAuth를 다시 연결하면 상태를 변경할 수 있습니다.';
    return { issue: current, transitions, transition_message, can_write };
  }
  async transitionIssue(issue, transitionId) {
    assert(typeof transitionId === 'string' && /^\d+$/.test(transitionId), 'Jira 상태 변경 항목을 확인하세요.');
    return this.request(`${this.issuePath(issue.cloud_id, issue.id)}/transitions`, { method: 'POST', body: { transition: { id: transitionId } } });
  }
  async confluencePage(cloudId, id) {
    await this.site(cloudId, 'confluence'); assert(/^\d+$/.test(id), 'Confluence 페이지 ID를 확인하세요.');
    return this.request(`/ex/confluence/${cloudId}/wiki/api/v2/pages/${id}?body-format=storage`);
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
  async createJiraIssue({ cloud_id, project, issue_type, title, description, operation_id, work_item_id }) {
    let site;
    try { site = await this.site(cloud_id, 'jira'); } catch (e) { e.not_sent = true; throw e; }
    assert(site.scopes.includes('write:jira-work'), 'Jira 쓰기 권한으로 OAuth를 다시 연결하세요.', 403);
    assert(/^[a-zA-Z0-9_]+$/.test(project) && /^\d+$/.test(issue_type), 'Jira 프로젝트와 티켓 유형을 선택하세요.');
    const result = await this.request(`/ex/jira/${cloud_id}/rest/api/3/issue`, { method: 'POST', body: {
      fields: { project: { key: project }, issuetype: { id: issue_type }, summary: title, description: jiraDescription(description) },
      properties: [{ key: 'work-log', value: { operation_id, work_item_id } }]
    } });
    assert(typeof result.id === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*-\d+$/.test(result.key), 'Jira 티켓 생성 결과를 확인하지 못했습니다.', 502);
    const url = new URL(site.url); assert(url.protocol === 'https:' || this.apiOrigin.startsWith('http://127.0.0.1:'), 'Jira 사이트 주소를 확인하세요.', 502);
    return { id: result.id, key: result.key, url: new URL(`/browse/${result.key}`, url).href, cloud_id };
  }
  async resolveIssue(link, key) {
    const issue = await this.jiraIssue(link.request.cloud_id, key);
    const property = await this.request(`/ex/jira/${link.request.cloud_id}/rest/api/3/issue/${encodeURIComponent(key)}/properties/work-log`);
    assert(property.value?.operation_id === link.operation_id, '이 생성 요청으로 만든 Jira 티켓인지 확인할 수 없습니다.', 409);
    const site = await this.site(link.request.cloud_id, 'jira');
    return { id: issue.id, key: issue.key, url: new URL(`/browse/${issue.key}`, site.url).href, cloud_id: link.request.cloud_id };
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
  async writeWorklog(issue, row) {
    const payload = JSON.parse(row.payload), base = this.worklogPath(issue);
    assert(Number.isInteger(payload.seconds) && payload.seconds > 0 && Number.isFinite(Date.parse(payload.started)), '관측된 작업 시간과 시작 시각이 필요합니다.');
    if (row.worklog_id) {
      assert(/^\d+$/.test(row.worklog_id), '업무 로그 ID를 확인하세요.');
      const current = await this.request(`${base}/${row.worklog_id}?expand=properties`);
      assert(current.properties?.some(p => p.key === 'work-log' && p.value?.operation_id === row.operation_id), '기존 업무 로그의 출처를 확인할 수 없습니다.', 409);
    }
    const result = await this.request(`${base}${row.worklog_id ? `/${row.worklog_id}` : ''}?adjustEstimate=leave&notifyUsers=false`, {
      method: row.worklog_id ? 'PUT' : 'POST', body: {
        started: new Date(payload.started).toISOString().replace('Z', '+0000'), timeSpentSeconds: payload.seconds,
        comment: jiraDescription(payload.comment), properties: [{ key: 'work-log', value: { operation_id: row.operation_id, session_id: row.session_id, source_digest: row.source_digest } }]
      }
    });
    assert(typeof result.id === 'string' && /^\d+$/.test(result.id), '업무 로그 생성 결과를 확인하지 못했습니다.', 502);
    return result;
  }
  disconnect() {
    return this.exclusive(async () => { this.close(); await this.tokens.remove(); this.flowError = null; this.onChange(); return { connected: false }; });
  }
  close() { this.flow = null; clearTimeout(this.flowTimer); this.listener?.close(); this.listener = null; }
}

export function atlassianClient(dir, onChange) {
  const options = { dir, onChange };
  // Local protocol simulators are only reachable in explicit E2E mode with isolated credential helpers.
  if (process.env.HARNESS_TEST_MODE === '1' && process.env.HARNESS_ATLASSIAN_TEST_ORIGIN) {
    const origin = new URL(process.env.HARNESS_ATLASSIAN_TEST_ORIGIN);
    assert(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && process.env.HARNESS_OP_BIN && process.env.HARNESS_KEYCHAIN_BIN, 'Atlassian 테스트 환경은 로컬 모의 서버와 격리된 자격증명 도우미가 필요합니다.');
    Object.assign(options, { authOrigin: origin.origin, apiOrigin: origin.origin, callback: 'http://127.0.0.1:0/oauth/atlassian/callback' });
  }
  return new AtlassianClient(options);
}
