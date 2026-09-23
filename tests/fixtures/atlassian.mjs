import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Protocol simulators: never contact Atlassian, op, or the user's Keychain.
export const oauthClient = { client_id: 'fixture-client', client_secret: 'fixture-secret' };
export async function atlFixture(h, { tls } = {}) {
  const state = { tokenCalls: [], calls: [], issues: [], worklogs: [], comments: [], pages: [],
    spaces: [{ id: '10', key: 'TEAM', name: '팀 업무', status: 'current' }, { id: '20', key: 'DOCS', name: '프로젝트 문서', status: 'current' }, { id: '30', key: 'OPS', name: '운영 기록', status: 'current' }],
    pageFailure: null, losePage: false, refresh: 'fixture-refresh-1', access: 'fixture-access-1', revision: 1,
    scopes: ['read:jira-work', 'read:jira-user', 'write:jira-work', 'read:page:confluence', 'read:space:confluence', 'write:page:confluence'], rejectRefresh: false, rejectAccessOnce: false, worklogFailure: null, loseIssue: false, loseWorklog: false,
    user: { accountId: 'fixture-current-user', active: true, displayName: 'Fixture 사용자' }, myselfFailure: null,
    commentFailure: null, commentReadFailure: null, loseComment: false,
    transitionFailure: null, issueReadFailure: null, issueUpdateFailure: null, issueUpdateResponseLost: false,
    loseTransition: false, noTransitions: false, updated: 0 };
  const statuses = { todo: { id: '10000', name: '해야 할 일', statusCategory: { key: 'new' } },
    progress: { id: '3', name: '진행 중', statusCategory: { key: 'indeterminate' } }, done: { id: '10002', name: '완료', statusCategory: { key: 'done' } } };
  function setStatus(issue, name) {
    issue.fields.status = statuses[name]; issue.fields.updated = new Date(Date.UTC(2026, 8, 17, 0, 0, ++state.updated)).toISOString();
  }
  function addIssue(fields = {}, key = `TEAM-${state.issues.length + 1}`) {
    const issue = { id: String(state.issues.length + 1), key, fields: { summary: '기존 Jira 이슈', description: { type: 'doc', version: 1, content: [] }, ...fields }, properties: [] };
    setStatus(issue, 'todo'); state.issues.push(issue); return issue;
  }
  function transitions(issue) {
    if (state.noTransitions) return [];
    return [ ...(issue.fields.status.id === statuses.todo.id ? [{ id: '21', name: '작업 시작', to: statuses.progress, fields: {} }] : []),
      ...(issue.fields.status.id !== statuses.done.id ? [{ id: '31', name: '작업 완료', to: statuses.done, fields: {} }] : []),
      { id: '41', name: '사유 입력 후 완료', to: statuses.done, fields: { resolution: { name: '해결 사유', required: true } } } ];
  }
  const createServer = tls ? handler => https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'); let raw = ''; for await (const bytes of req) raw += bytes;
      const body = raw ? JSON.parse(raw) : null;
      const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (url.pathname === '/oauth/token') {
        state.tokenCalls.push(body);
        if (state.tokenFailure) { res.writeHead(state.tokenFailure, { 'Content-Type': 'text/html' }); res.end('upstream-private-diagnostic'); return; }
        assert.equal(body.client_id, 'fixture-client'); assert.equal(body.client_secret, 'fixture-secret');
        if (body.grant_type === 'refresh_token') {
          if (state.rejectRefresh || body.refresh_token !== state.refresh) return send({ error: 'invalid_grant' }, 400);
          state.revision++; state.refresh = `fixture-refresh-${state.revision}`; state.access = `fixture-access-${state.revision}`;
          await new Promise(resolve => setTimeout(resolve, state.refreshDelay || 40));
        } else assert.equal(body.code, 'fixture-code');
        return send({ access_token: state.access, refresh_token: state.refresh, expires_in: 3600 });
      }
      state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      if (state.rejectAccessOnce) { state.rejectAccessOnce = false; return send({}, 401); }
      if (req.headers.authorization !== `Bearer ${state.access}`) return send({}, 401);
      if (url.pathname === '/oauth/token/accessible-resources') {
        state.resourceCalls = (state.resourceCalls || 0) + 1;
        if (state.resourceDelayAt === state.resourceCalls) await new Promise(resolve => setTimeout(resolve, state.resourceDelay || 250));
        return send(state.resources || [{ id: 'cloud-test', name: 'Fixture 팀', url: 'https://fixture.atlassian.net', scopes: state.scopes }]);
      }
      if (/^\/ex\/jira\/[a-zA-Z0-9-]+\/rest\/api\/3\/myself$/.test(url.pathname)) {
        assert.equal(req.method, 'GET');
        const user = structuredClone(state.user);
        if (state.myselfDelay) await new Promise(resolve => setTimeout(resolve, state.myselfDelay));
        if (state.myselfFailure) return send({}, state.myselfFailure);
        if (!state.scopes.includes('read:jira-user')) return send({}, 403);
        return send(user);
      }
      if (url.pathname.endsWith('/search/jql')) {
        const jql = url.searchParams.get('jql'), token = url.searchParams.get('nextPageToken');
        const terms = [...jql.matchAll(/summary ~ "([^"]+)\*"/g)].map(m => m[1].toLowerCase());
        assert.ok(terms.length); assert.equal(url.searchParams.get('fields'), 'summary,status,updated');
        if (state.searchDelay) await new Promise(resolve => setTimeout(resolve, state.searchDelay));
        if (state.searchFailure) return send({}, state.searchFailure);
        let start = 0;
        if (token) { const cursor = JSON.parse(Buffer.from(token, 'base64url')); assert.equal(cursor.jql, jql); start = cursor.start; }
        const matching = state.issues.filter(i => !i.hidden && terms.every(term => i.fields.summary.toLowerCase().includes(term)));
        const size = Math.min(Number(url.searchParams.get('maxResults')), state.searchPageSize || 20), rows = matching.slice(start, start + size);
        const next = start + rows.length < matching.length ? Buffer.from(JSON.stringify({ start: start + rows.length, jql })).toString('base64url') : null;
        (state.searchCompleted ||= []).push(jql);
        return send({ issues: rows, isLast: !next, ...(next ? { nextPageToken: next } : {}) });
      }
      if (url.pathname.endsWith('/project/search')) {
        const start = Number(url.searchParams.get('startAt') || 0);
        return send({ values: [{ id: String(10 + start), key: start ? 'NEXT' : 'TEAM', name: '팀 업무' }], isLast: !state.paged || start === 1, total: state.paged ? 2 : 1 });
      }
      if (url.pathname.endsWith('/issuetypes')) {
        const start = Number(url.searchParams.get('startAt') || 0);
        return send({ issueTypes: [{ id: String(10001 + start), name: start ? 'Bug' : 'Task' }], total: state.paged ? 2 : 1, startAt: start, maxResults: 1 });
      }
      if (url.pathname.endsWith('/wiki/api/v2/spaces')) {
        assert.equal(req.method, 'GET'); assert.equal(url.searchParams.get('status'), 'current');
        const cursor = url.searchParams.get('cursor'), start = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
        assert.ok(Number.isInteger(start) && start >= 0);
        const size = Math.min(2, Number(url.searchParams.get('limit') || 50)), results = state.spaces.slice(start, start + size);
        const next = start + size < state.spaces.length ? `/wiki/api/v2/spaces?cursor=${Buffer.from(String(start + size)).toString('base64url')}&limit=50&status=current` : null;
        return send({ results, _links: { ...(next ? { next } : {}), ...(state.spacesNext !== undefined ? { next: state.spacesNext } : {}) } });
      }
      const spaceId = url.pathname.match(/\/wiki\/api\/v2\/spaces\/(\d+)$/)?.[1];
      if (spaceId) {
        const space = state.spaces.find(row => row.id === spaceId); return send(space || {}, space ? 200 : 404);
      }
      if (url.pathname.endsWith('/wiki/api/v2/pages') && req.method === 'POST') {
        assert.equal(body.body.representation, 'storage'); assert.equal(body.status, 'current');
        if (state.pageDelay) await new Promise(resolve => setTimeout(resolve, state.pageDelay));
        if (state.pageFailure) return send({}, state.pageFailure);
        const page = { id: String(1000 + state.pages.length), spaceId: body.spaceId, title: body.title, status: body.status,
          body: { storage: { representation: 'storage', value: body.body.value } } };
        state.pages.push(page);
        if (state.losePage) { state.losePage = false; return res.destroy(); }
        if (state.malformedPageResponse) return send({ id: page.id });
        return send(page);
      }
      const pageId = url.pathname.match(/\/wiki\/api\/v2\/pages\/(\d+)$/)?.[1];
      if (pageId) {
        if (pageId === '123') return send({ id: '123', title: 'Fixture page', body: { storage: { value: '<p>fixture</p>' } } });
        const page = state.pages.find(row => row.id === pageId); return send(page || {}, page ? 200 : 404);
      }
      if (url.pathname.endsWith('/issue') && req.method === 'POST') {
        if (state.issueCreateFailure) return send({}, state.issueCreateFailure);
        assert.deepEqual(body.fields.reporter, { accountId: state.user.accountId });
        assert.deepEqual(body.fields.assignee, { accountId: state.user.accountId });
        const issue = addIssue(body.fields); issue.properties = body.properties;
        if (state.loseIssue) { state.loseIssue = false; return res.destroy(); }
        return send(issue, 201);
      }
      const identifier = url.pathname.match(/\/issue\/([^/]+)/)?.[1];
      const issue = state.issues.find(i => identifier === i.id || identifier?.toUpperCase() === i.key || i.aliases?.includes(identifier));
      if (issue && url.pathname.endsWith('/transitions')) {
        if (req.method === 'GET') return send({ transitions: transitions(issue) });
        if (state.transitionDelay) await new Promise(resolve => setTimeout(resolve, state.transitionDelay));
        if (state.transitionFailure) return send({}, state.transitionFailure);
        const transition = transitions(issue).find(t => t.id === body.transition?.id);
        if (!transition || Object.values(transition.fields).some(f => f.required)) return send({}, 400);
        setStatus(issue, transition.to.id === '3' ? 'progress' : 'done');
        if (state.failReadAfterTransition) state.issueReadFailure = 503;
        if (state.loseTransition) { state.loseTransition = false; return res.destroy(); }
        res.writeHead(204); return res.end();
      }
      if (issue && url.pathname.endsWith('/properties/work-log')) return send(issue.properties[0]);
      if (issue && url.pathname.endsWith('/comment')) {
        if (req.method === 'GET') {
          if (state.commentReadFailure) return send({}, state.commentReadFailure);
          assert.equal(url.searchParams.get('expand'), 'properties');
          const start = Number(url.searchParams.get('startAt') || 0);
          const size = Math.min(Number(url.searchParams.get('maxResults') || 100), state.commentPageSize || 100);
          const comments = state.comments.filter(comment => comment.issueId === issue.id);
          const result = { comments: comments.slice(start, start + size), startAt: start, maxResults: size, total: comments.length };
          return send(state.commentPageTransform ? state.commentPageTransform(result) : result);
        }
        assert.equal(req.method, 'POST');
        if (state.commentDelay) await new Promise(resolve => setTimeout(resolve, state.commentDelay));
        if (state.commentFailure) return send({}, state.commentFailure);
        assert.equal(body.body.type, 'doc'); assert.equal(body.body.content.length, 1);
        assert.equal(body.body.content[0].type, 'paragraph');
        const comment = { ...body, id: String(state.comments.length + 1000), issueId: issue.id };
        state.comments.push(comment);
        if (state.loseComment) { state.loseComment = false; return res.destroy(); }
        return send(state.malformedCommentResponse ? {} : comment, 201);
      }
      if (issue && /\/worklog(?:\/\d+)?$/.test(url.pathname)) {
        const wid = url.pathname.match(/\/worklog\/(\d+)$/)?.[1];
        if (req.method === 'GET') {
          if (wid) return send(state.worklogs.find(w => w.id === wid));
          const logs = state.worklogs.filter(w => w.issueId === issue.id);
          return send({ worklogs: logs, startAt: 0, total: logs.length });
        }
        if (state.worklogFailure) return send({}, state.worklogFailure);
        const worklog = { ...body, id: wid || String(state.worklogs.length + 100), issueId: issue.id };
        if (wid) state.worklogs[state.worklogs.findIndex(w => w.id === wid)] = worklog;
        else state.worklogs.push(worklog);
        if (state.loseWorklog) { state.loseWorklog = false; return res.destroy(); }
        return send(worklog, wid ? 200 : 201);
      }
      if (issue) {
        if (req.method === 'PUT' && /\/issue\/[^/]+$/.test(url.pathname)) {
          if (state.issueUpdateDelay) await new Promise(resolve => setTimeout(resolve, state.issueUpdateDelay));
          if (state.issueUpdateFailure) return send({}, state.issueUpdateFailure);
          assert.deepEqual(Object.keys(body.fields).sort(), ['description', 'summary']);
          issue.fields.summary = body.fields.summary; issue.fields.description = body.fields.description;
          issue.fields.updated = new Date(Date.UTC(2026, 8, 17, 0, 0, ++state.updated)).toISOString();
          if (state.issueUpdateResponseLost) { state.issueUpdateResponseLost = false; return res.destroy(); }
          res.writeHead(204); return res.end();
        }
        if (state.issueReadDelay) await new Promise(resolve => setTimeout(resolve, state.issueReadDelay));
        if (state.issueReadFailure) return send({}, state.issueReadFailure);
        return send(issue);
      }
      send({ error: 'fixture route not found' }, 404);
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  const helpers = path.join(h.dir, 'test-only-credentials'); fs.mkdirSync(helpers);
  const op = path.join(helpers, 'op.mjs'), keychain = path.join(helpers, 'keychain.mjs');
  const record = path.join(helpers, 'mock-keychain.json'), clientRecord = path.join(helpers, 'mock-client-keychain.json');
  const opCalls = path.join(helpers, 'op-calls.jsonl'), keychainCalls = path.join(helpers, 'keychain-calls.jsonl');
  // A tripwire proves the removed provider is never consulted, even when installed.
  fs.writeFileSync(op, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(opCalls)},'unexpected op invocation\\n');process.exit(3);\n`, { mode: 0o700 });
  fs.writeFileSync(keychain, `#!${process.execPath}\nimport fs from 'node:fs';\nlet raw='';for await(const b of process.stdin)raw+=b;const r=JSON.parse(raw),file=r.account.startsWith('client-')?${JSON.stringify(clientRecord)}:${JSON.stringify(record)};
    if(!/^(oauth|client)-[a-f0-9]{24}$/.test(r.account))process.exit(4);
    fs.appendFileSync(${JSON.stringify(keychainCalls)},JSON.stringify({operation:r.operation,account:r.account,args:process.argv.slice(2)})+'\\n');
    if(fs.existsSync(file+'.locked'))process.exit(3);
    if(fs.existsSync(file+'.response')){process.stdout.write(fs.readFileSync(file+'.response'));process.exit(0);}
    if(r.operation==='set'&&fs.existsSync(file+'.deny-set')){process.stderr.write('fixture-secret: denied');process.exit(3);}
    if(r.operation==='set'){fs.writeFileSync(file,JSON.stringify(r.value),{mode:0o600});}
    if(r.operation==='delete'&&fs.existsSync(file))fs.unlinkSync(file);
    process.stdout.write(JSON.stringify({ok:true,value:r.operation==='get'&&fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null}));\n`, { mode: 0o700 });
  h.env = { ...h.env, HARNESS_ATLASSIAN_TEST_ORIGIN: origin, HARNESS_OP_BIN: op, HARNESS_KEYCHAIN_BIN: keychain, HARNESS_TEST_SESSION_SUMMARIES: '1' };
  return { state, origin, record, clientRecord, opCalls, keychainCalls, addIssue, setStatus,
    expire: () => { const value = JSON.parse(fs.readFileSync(record)); value.expires_at = Date.now() - 1000; fs.writeFileSync(record, JSON.stringify(value)); },
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
export async function authorize(h) {
  await h.manager('/integrations/atlassian', { method: 'PUT', body: oauthClient });
  const { authorization_url } = await h.manager('/integrations/atlassian/authorize', { method: 'POST', body: {} });
  const url = new URL(authorization_url), callback = new URL(url.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' });
  const response = await fetch(callback); assert.equal(response.status, 200, await response.text());
  return callback;
}
export async function createIssue(h, item, operation = 'test-issue-operation') {
  return h.manager(`/items/${item.id}/jira`, { method: 'POST', body: { version: item.version, operation_id: operation, cloud_id: 'cloud-test', project: 'TEAM', issue_type: '10001' } });
}
export function adfText(doc) { return doc.content[0].content.map(n => n.type === 'hardBreak' ? '\n' : n.text || '').join(''); }
