import fs from 'node:fs';
import path from 'node:path';
import { ROOT, dataRoot, lockService, serve, body, request, json, assert, digest, atomic, now, id } from './shared.mjs';
import { managerStore } from './manager-store.mjs';
import { integrationStore } from './integration-store.mjs';
import { atlassianClient } from './atlassian.mjs';
import { integrationCoordinator } from './integration-coordinator.mjs';
import { writingStore } from './writing-store.mjs';
import { writingCoordinator } from './writing-coordinator.mjs';
import { jiraService } from './jira-service.mjs';

const dir = dataRoot(); lockService(dir, 'manager');
const store = managerStore(dir);
const spoolDir = path.join(dir, 'spool'); fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
let collecting = false, runtimeConnected = false, lastError = null, timer;
const subscribers = new Set();
let revision = 0;
function notify() {
  const frame = `event: change\ndata: ${json({ revision: ++revision })}\n\n`;
  // A slow/disconnected GUI reconnects and reads the authoritative snapshot.
  for (const res of subscribers) if (!res.write(frame)) res.destroy();
}
const integrations = integrationStore(store), atlassian = atlassianClient(dir, notify);
const jira = jiraService({ store, integrations, client: atlassian, notify });
const automaticSummaries = process.env.HARNESS_TEST_MODE !== '1' || process.env.HARNESS_TEST_SESSION_SUMMARIES === '1';
const writings = writingStore(store, integrations);
const writer = writingCoordinator({ dir, writings, notify, automatic: automaticSummaries, fixture: process.env.HARNESS_TEST_MODE === '1' });
const coordinator = integrationCoordinator({ integrations, client: atlassian, notify, writings: writer, enabled: automaticSummaries });
async function collect() {
  if (collecting) return; collecting = true;
  const wasConnected = runtimeConnected, previousError = lastError;
  let changed = false;
  try {
    for (const file of fs.readdirSync(spoolDir).filter(f => f.endsWith('.json')).slice(0, 100)) {
      const source = path.join(spoolDir, file);
      try {
        const event = JSON.parse(fs.readFileSync(source, 'utf8'));
        changed = store.ingestMany([event]).inserted > 0 || changed; fs.unlinkSync(source);
      } catch (e) {
        lastError = `훅 이벤트 보류: ${e.message}`;
        const quarantine = path.join(dir, 'quarantine'); fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
        fs.renameSync(source, path.join(quarantine, file));
        atomic(path.join(quarantine, `${file}.error`), e.message);
      }
    }
    try {
      const batch = await request(dir, 'runtime', `/events?after=${store.cursor('runtime')}`, { signal: AbortSignal.timeout(1500) });
      changed = store.ingestMany(batch.events, { source: 'runtime', value: batch.cursor }).inserted > 0 || changed; runtimeConnected = true;
    } catch { runtimeConnected = false; }
  } finally {
    collecting = false;
    if (changed || wasConnected !== runtimeConnected || previousError !== lastError) notify();
  }
}
function health() {
  return { role: 'management', version: '0.3.1', runtime_connected: runtimeConnected,
    last_error: lastError || (fs.existsSync(path.join(dir, 'hook-error.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'hook-error.json'))).message : null),
    quarantined: fs.existsSync(path.join(dir, 'quarantine')) ? fs.readdirSync(path.join(dir, 'quarantine')).filter(f => f.endsWith('.json')).length : 0,
    ...store.stats() };
}
const { server, endpoint } = await serve({ dir, role: 'manager', port: Number(process.env.HARNESS_MANAGER_PORT || 0),
  streamHandler: (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/updates') return false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    subscribers.add(res);
    res.write(`event: change\ndata: ${json({ revision })}\n\n`);
    const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.destroy(); }, 15000);
    res.on('close', () => { clearInterval(heartbeat); subscribers.delete(res); });
    return true;
  },
  publicHandler: async (req, res, url) => {
    const routes = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/history.js': ['history.js', 'text/javascript'], '/integrations.js': ['integrations.js', 'text/javascript'], '/jira.js': ['jira.js', 'text/javascript'], '/writing.js': ['writing.js', 'text/javascript'], '/execution-settings.js': ['execution-settings.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
      '/quick': ['quick.html', 'text/html; charset=utf-8'], '/quick.js': ['quick.js', 'text/javascript'], '/quick.css': ['quick.css', 'text/css'] };
    if (req.method !== 'GET' || !routes[url.pathname]) return false;
    const [file, type] = routes[url.pathname];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' about:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    res.end(fs.readFileSync(path.join(ROOT, 'apps/web', file))); return true;
  },
  handler: async (req, url) => {
    const p = url.pathname;
    if (p === '/api/integrations/atlassian' && req.method === 'GET') return atlassian.status();
    if (p === '/api/integrations/atlassian' && req.method === 'PUT') return atlassian.save(await body(req));
    if (p === '/api/integrations/atlassian' && req.method === 'DELETE') return atlassian.disconnect();
    if (p === '/api/integrations/atlassian/authorize' && req.method === 'POST') return atlassian.begin();
    if (p === '/api/integrations/atlassian/sites' && req.method === 'GET') return atlassian.resources();
    if (p === '/api/integrations/atlassian/projects' && req.method === 'GET') return atlassian.jiraProjects(url.searchParams.get('cloud_id'));
    if (p === '/api/integrations/atlassian/issue-types' && req.method === 'GET') return atlassian.jiraIssueTypes(url.searchParams.get('cloud_id'), url.searchParams.get('project'));
    if (p === '/api/integrations/atlassian/jira-issue' && req.method === 'GET') return atlassian.jiraIssue(url.searchParams.get('cloud_id'), url.searchParams.get('key'));
    if (p === '/api/integrations/atlassian/jira-preview' && req.method === 'GET') return atlassian.lookupIssue(url.searchParams.get('cloud_id'), url.searchParams.get('key'));
    if (p === '/api/integrations/atlassian/jira-search' && req.method === 'GET') return atlassian.searchIssues(url.searchParams.get('cloud_id'), url.searchParams.get('query'), url.searchParams.get('next_page_token'));
    if (p === '/api/integrations/atlassian/confluence-page' && req.method === 'GET') return atlassian.confluencePage(url.searchParams.get('cloud_id'), url.searchParams.get('id'));
    if (p === '/api/execution-settings' && req.method === 'GET') return request(dir, 'runtime', '/execution-settings');
    let executionSetting = p.match(/^\/api\/execution-settings\/([^/]+)$/);
    if (executionSetting && ['PUT', 'DELETE'].includes(req.method)) return request(dir, 'runtime', `/execution-settings/${executionSetting[1]}`, { method: req.method, body: await body(req) });
    if (req.method === 'GET' && p === '/api/health') return health();
    if (req.method === 'GET' && p === '/api/quick') return { ...store.quickOverview(), health: health(), observed_at: now() };
    if (req.method === 'GET' && p === '/api/items') return store.items(url.searchParams.get('q') || '');
    if (req.method === 'GET' && p === '/api/calendar') return store.calendar(Object.fromEntries(url.searchParams));
    if (req.method === 'POST' && p === '/api/events') {
      const data = await body(req); assert(Array.isArray(data.events) && data.events.length <= 500, '이벤트 배열이 필요합니다.');
      const result = store.ingestMany(data.events); if (result.inserted) notify(); return result;
    }
    if (req.method === 'POST' && p === '/api/merge') {
      const result = store.merge(await body(req)); if (!result.repeated) notify(); return result;
    }
    let m = p.match(/^\/api\/items\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const detail = jira.decorate(writings.decorate(integrations.decorate(store.detail(m[1], { summary: url.searchParams.get('view') === 'summary' }))));
      jira.refreshItem(detail.item.id); return detail;
    }
    if (m && req.method === 'PATCH') { const result = store.edit(m[1], await body(req)); notify(); return result; }
    m = p.match(/^\/api\/items\/([^/]+)\/history$/);
    if (m && req.method === 'GET') return store.history(m[1], Object.fromEntries(url.searchParams));
    m = p.match(/^\/api\/items\/([^/]+)\/runs\/([^/]+)\/events$/);
    if (m && req.method === 'GET') return { records: store.runEvents(m[1], m[2]) };
    m = p.match(/^\/api\/items\/([^/]+)\/metadata\/regenerate$/);
    if (m && req.method === 'POST') {
      const result = writings.enqueue('work-item-metadata', m[1], await body(req)); notify(); return writings.publicView(result);
    }
    m = p.match(/^\/api\/sessions\/([^/]+)\/summary\/regenerate$/);
    if (m && req.method === 'POST') {
      const result = writings.enqueue('session-summary', m[1], await body(req)); notify(); return writings.publicView(result);
    }
    m = p.match(/^\/api\/writing\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const result = writings.get(m[1]); assert(result, '재작성 요청이 없습니다.', 404); return writings.publicView(result);
    }
    m = p.match(/^\/api\/items\/([^/]+)\/jira$/);
    if (m && req.method === 'POST') {
      const intent = integrations.beginIssue(m[1], await body(req));
      if (intent.repeated) return intent;
      notify();
      try {
        const issue = await atlassian.createJiraIssue(intent.request);
        integrations.finishIssue(intent.operation_id, 'linked', issue); notify(); jira.refreshItem(m[1]); return { state: 'linked', issue };
      } catch (e) {
        integrations.finishIssue(intent.operation_id, !e.not_sent && (e.code === 'unconfirmed' || e.status >= 500) ? 'unknown' : 'failed', null, e.message); notify(); throw e;
      }
    }
    m = p.match(/^\/api\/items\/([^/]+)\/jira\/link$/);
    if (m && req.method === 'POST') return jira.link(m[1], await body(req));
    m = p.match(/^\/api\/jira-links\/([^/]+)\/refresh$/);
    if (m && req.method === 'POST') return jira.refresh(m[1], true);
    m = p.match(/^\/api\/jira-links\/([^/]+)\/transition$/);
    if (m && req.method === 'POST') return jira.transition(m[1], await body(req));
    m = p.match(/^\/api\/jira-links\/([^/]+)\/resolve$/);
    if (m && req.method === 'POST') {
      const link = integrations.links().find(l => l.operation_id === m[1]);
      assert(link?.state === 'unknown', '결과 확인이 필요한 Jira 생성 요청이 없습니다.', 409);
      const issue = await atlassian.resolveIssue(link, (await body(req)).key);
      integrations.finishIssue(link.operation_id, 'linked', issue); notify(); jira.refreshItem(link.work_item_id); return { state: 'linked', issue };
    }
    m = p.match(/^\/api\/sessions\/([^/]+)\/worklog\/retry$/);
    if (m && req.method === 'POST') { coordinator.retry(m[1]); return { queued: true }; }
    m = p.match(/^\/api\/sessions\/([^/]+)\/summary\/retry$/);
    if (m && req.method === 'POST') {
      assert(integrations.summary(m[1])?.state === 'failed', '재시도할 세션 요약이 없습니다.', 409);
      const input = await body(req);
      const result = writings.enqueue('session-summary', m[1], { operation_id: id('retry-'), ...input }); notify(); return writings.publicView(result);
    }
    m = p.match(/^\/api\/runs\/([^/]+)\/(cancel|resume)$/);
    if (m && req.method === 'POST') return request(dir, 'runtime', `/runs/${m[1]}/${m[2]}`, { method: 'POST', body: {} });
    m = p.match(/^\/api\/evidence\/([^/]+)$/);
    if (m && req.method === 'GET') return request(dir, 'runtime', `/runs/${m[1]}/evidence`);
    m = p.match(/^\/api\/artifacts\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const run = await request(dir, 'runtime', `/runs/${m[1]}`);
      assert(run.artifact && run.status === 'completed', '검증된 산출물이 없습니다.', 404);
      const file = fs.realpathSync(run.artifact.file), expected = fs.realpathSync(path.join(dir, 'runs', run.id, 'artifacts')) + path.sep;
      assert(file.startsWith(expected), '산출물 경로가 잘못되었습니다.', 403);
      const bytes = fs.readFileSync(file); assert(digest(bytes) === run.artifact.content_digest, '검증 후 산출물이 변경되었습니다.', 409);
      return { name: path.basename(file), task: run.task, text: bytes.toString('utf8'), digest: run.artifact.content_digest };
    }
    assert(false, 'API를 찾을 수 없습니다.', 404);
  }
});
console.log(json({ ready: true, role: 'manager', ...endpoint }));
timer = setInterval(collect, 200); void collect();
const integrationTimer = setInterval(() => void coordinator.tick().catch(() => {}), 1000);
function stop() {
  clearInterval(timer); clearInterval(integrationTimer); atlassian.close();
  for (const res of subscribers) res.end();
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
