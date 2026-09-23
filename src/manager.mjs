import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getAgentConnections, connectAgent, disconnectAgent } from '../scripts/agent-connections.mjs';
import { withAgentCollection } from './agent-collection.mjs';
import { ROOT, dataRoot, lockService, serve, body, request, json, assert, digest, atomic, now, id } from './shared.mjs';
import { managerStore } from './manager-store.mjs';
import { integrationStore } from './integration-store.mjs';
import { atlassianClient } from './atlassian.mjs';
import { integrationCoordinator } from './integration-coordinator.mjs';
import { writingStore } from './writing-store.mjs';
import { writingCoordinator } from './writing-coordinator.mjs';
import { jiraService } from './jira-service.mjs';
import { stopCredentialProcesses } from './credentials.mjs';
import { notificationStore } from './notifications.mjs';
import { reportStore } from './reports.mjs';
import { reportsCoordinator } from './reports-coordinator.mjs';
import { confluenceReports } from './confluence-reports.mjs';

const dir = dataRoot(); lockService(dir, 'manager');
// Test and development data roots must never fall back to the user's agent settings.
const connectionHome = process.env.HARNESS_TEST_MODE === '1' ? process.env.HARNESS_TEST_HOME : os.homedir();
const connectionOptions = connectionHome && path.resolve(dir) === path.join(path.resolve(connectionHome), 'Library/Application Support/WorkLog')
  ? { homeDir: path.resolve(connectionHome) } : null;
const unavailableConnections = () => ({ available: false, connections: ['claude', 'codex'].map(engine => ({ engine,
  state: 'disconnected', message: '설치된 WorkLog 앱에서 에이전트를 연결할 수 있습니다.', paths: [] })) });
let writings;
const store = managerStore(dir);
const spoolDir = path.join(dir, 'spool'); fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
let collecting = false, runtimeConnected = false, lastError = null, timer, stopping = false;
const subscribers = new Set();
let revision = 0;
function notify() {
  const frame = `event: change\ndata: ${json({ revision: ++revision })}\n\n`;
  // A slow/disconnected GUI reconnects and reads the authoritative snapshot.
  for (const res of subscribers) if (!res.write(frame)) res.destroy();
}
const integrations = integrationStore(store), atlassian = atlassianClient(dir, notify);
const jira = jiraService({ dir, store, integrations, client: atlassian, notify, fixture: process.env.HARNESS_TEST_MODE === '1' });
const automaticSummaries = process.env.HARNESS_TEST_MODE !== '1' || process.env.HARNESS_TEST_SESSION_SUMMARIES === '1';
writings = writingStore(store, integrations);
const writer = writingCoordinator({ dir, writings, notify, automatic: automaticSummaries,
  automaticMetadata: process.env.HARNESS_TEST_MODE !== '1' || process.env.HARNESS_TEST_AUTOMATIC_METADATA === '1', fixture: process.env.HARNESS_TEST_MODE === '1' });
const coordinator = integrationCoordinator({ integrations, client: atlassian, notify, writings: writer, enabled: automaticSummaries });
const reports = reportStore(store, integrations);
const reportWriter = reportsCoordinator({ dir, reports, notify, fixture: process.env.HARNESS_TEST_MODE === '1' });
const reportPublisher = confluenceReports({ store, reports, client: atlassian, notify });
const notifications = notificationStore({ store, writings, integrations });
const notificationCounts = rows => {
  const counts = new Map(); for (const row of rows) counts.set(row.work_item_id, (counts.get(row.work_item_id) || 0) + 1); return counts;
};
// List/calendar views need accepted summary labels, not source snapshots or complete histories.
const sessionSummaries = () => new Map(store.db.prepare('SELECT session_id,state,text FROM session_summaries').all().map(s => [s.session_id, s]));
function itemListing(params) {
  assert([...params.keys()].every(key => ['q', 'jira', 'trash', 'tag', 'untagged'].includes(key))
    && ['q', 'jira', 'trash', 'tag', 'untagged'].every(key => params.getAll(key).length <= 1), '업무 조회 조건이 잘못되었습니다.');
  const q = params.get('q') || '', jiraFilter = params.get('jira') || 'all', trash = params.get('trash') || 'false';
  const untagged = params.get('untagged') ?? 'false';
  assert(q.length <= 500 && ['all', 'unlinked', 'linked'].includes(jiraFilter)
    && ['true', 'false'].includes(trash) && ['true', 'false'].includes(untagged), '업무 조회 조건이 잘못되었습니다.');
  const links = new Map();
  const counts = notificationCounts(notifications.list());
  for (const link of integrations.links()) {
    const itemId = store.canonical(link.work_item_id);
    if (!links.has(itemId)) links.set(itemId, []);
    links.get(itemId).push(link);
  }
  return store.items(q, { trash: trash === 'true', tag: params.get('tag'), untagged: untagged === 'true' }).map(item => {
    const group = links.get(item.id) || [];
    const keys = [...new Set(group.filter(link => link.state === 'linked' && link.issue?.key).map(link => link.issue.key))];
    const jiraState = keys.length ? 'linked' : group.some(link => ['sending', 'unknown'].includes(link.state)) ? 'unknown' : 'unlinked';
    return { ...item, jira_state: jiraState, jira_keys: keys, notification_count: counts.get(item.id) || 0 };
  }).filter(item => jiraFilter === 'all' || item.jira_state === jiraFilter);
}
function collectSpool(context) {
  let changed = false;
  const files = fs.readdirSync(spoolDir).filter(f => f.endsWith('.json'));
  for (const file of context ? files : files.slice(0, 100)) {
    const source = path.join(spoolDir, file);
    try {
      const event = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (context && (event.engine !== context.engine || event.agent_session_id !== context.session_id)) continue;
      changed = store.ingestMany([event]).inserted > 0 || changed; fs.unlinkSync(source);
    } catch (e) {
      lastError = `훅 이벤트 보류: ${e.message}`;
      const quarantine = path.join(dir, 'quarantine'); fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
      fs.renameSync(source, path.join(quarantine, file));
      atomic(path.join(quarantine, `${file}.error`), e.message);
    }
  }
  return changed;
}
async function collect() {
  if (collecting || stopping) return; collecting = true;
  const wasConnected = runtimeConnected, previousError = lastError;
  let changed = false;
  try {
    changed = collectSpool();
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
    ...store.stats(), visible_items: store.db.prepare(`SELECT COUNT(*) AS n FROM work_items w
      WHERE w.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM work_item_deletions d WHERE d.work_item_id=w.id AND d.deleted_at IS NOT NULL)`).get().n };
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
      '/icons.css': ['icons.css', 'text/css'],
      '/agent-connections.js': ['agent-connections.js', 'text/javascript'],
      '/description-syntax.js': ['description-syntax.js', 'text/javascript'],
      '/description.js': ['description.js', 'text/javascript'], '/automation-settings.js': ['automation-settings.js', 'text/javascript'], '/item-tags.js': ['item-tags.js', 'text/javascript'], '/reports.js': ['reports.js', 'text/javascript'], '/report-body.js': ['report-body.js', 'text/javascript'],
      '/quick': ['quick.html', 'text/html; charset=utf-8'], '/quick.js': ['quick.js', 'text/javascript'], '/quick.css': ['quick.css', 'text/css'] };
    if (req.method !== 'GET' || !routes[url.pathname]) return false;
    const [file, type] = routes[url.pathname];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' about:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    res.end(fs.readFileSync(path.join(ROOT, 'apps/web', file))); return true;
  },
  handler: async (req, url) => {
    const p = url.pathname;
    if (p === '/api/agent-context' && req.method === 'GET') {
      assert([...url.searchParams.keys()].every(key => ['engine', 'session_id'].includes(key))
        && url.searchParams.getAll('engine').length === 1 && url.searchParams.getAll('session_id').length === 1,
        'engine과 session_id를 한 번씩 지정하세요.');
      const context = Object.fromEntries(url.searchParams);
      // The requesting CLI may arrive before the periodic collector. Consume
      // its already-recorded hooks before deciding this is a standalone entry.
      if (collectSpool(context)) notify();
      return store.agentContext(context);
    }
    if (p === '/api/agent-connections' && req.method === 'GET')
      return withAgentCollection(store, connectionOptions ? getAgentConnections(connectionOptions) : unavailableConnections());
    const agentConnection = p.match(/^\/api\/agent-connections\/(claude|codex)$/);
    if (agentConnection && ['POST', 'DELETE'].includes(req.method)) {
      assert(connectionOptions, '설치된 WorkLog 앱에서 에이전트를 연결하거나 해제하세요.');
      const input = await body(req);
      assert(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0
        && [...url.searchParams].length === 0, '연결 설정에는 별도의 경로나 실행 명령을 지정할 수 없습니다.');
      const result = await (req.method === 'POST' ? connectAgent : disconnectAgent)(agentConnection[1], connectionOptions);
      notify(); return withAgentCollection(store, result);
    }
    if (p === '/api/integrations/atlassian' && req.method === 'GET') return atlassian.status();
    if (p === '/api/integrations/atlassian' && req.method === 'PUT') return atlassian.save(await body(req));
    if (p === '/api/integrations/atlassian/client-secret' && req.method === 'POST') return atlassian.clientSecret(await body(req));
    if (p === '/api/integrations/atlassian' && req.method === 'DELETE') return atlassian.disconnect();
    if (p === '/api/integrations/atlassian/authorize' && req.method === 'POST') return atlassian.begin();
    if (p === '/api/integrations/atlassian/sites' && req.method === 'GET') {
      assert([...url.searchParams.keys()].every(key => key === 'product') && url.searchParams.getAll('product').length <= 1,
        '사이트 조회 조건을 확인하세요.');
      return atlassian.selectableSites(url.searchParams.get('product') ?? 'jira');
    }
    if (p === '/api/integrations/atlassian/confluence-spaces' && req.method === 'GET') return atlassian.confluenceSpaces(url.searchParams.get('cloud_id'), url.searchParams.get('cursor'));
    if (p === '/api/integrations/atlassian/projects' && req.method === 'GET') return atlassian.jiraProjects(url.searchParams.get('cloud_id'));
    if (p === '/api/integrations/atlassian/issue-types' && req.method === 'GET') return atlassian.jiraIssueTypes(url.searchParams.get('cloud_id'), url.searchParams.get('project'));
    if (p === '/api/integrations/atlassian/jira-issue' && req.method === 'GET') return atlassian.jiraIssue(url.searchParams.get('cloud_id'), url.searchParams.get('key'));
    if (p === '/api/integrations/atlassian/jira-preview' && req.method === 'GET') return atlassian.lookupIssue(url.searchParams.get('cloud_id'), url.searchParams.get('key'));
    if (p === '/api/integrations/atlassian/jira-search' && req.method === 'GET') return atlassian.searchIssues(url.searchParams.get('cloud_id'), url.searchParams.get('query'), url.searchParams.get('next_page_token'));
    if (p === '/api/integrations/atlassian/confluence-page' && req.method === 'GET') return atlassian.confluencePage(url.searchParams.get('cloud_id'), url.searchParams.get('id'));
    if (p === '/api/execution-settings' && req.method === 'GET') return request(dir, 'runtime', '/execution-settings');
    if (p === '/api/execution-settings/custom-task-drafts' && req.method === 'POST')
      return request(dir, 'runtime', '/execution-settings/custom-task-drafts', { method: 'POST', body: await body(req) });
    const taskDraft = p.match(/^\/api\/execution-settings\/custom-task-drafts\/([^/]+)(?:\/(cancel))?$/);
    if (taskDraft && req.method === 'GET' && !taskDraft[2])
      return request(dir, 'runtime', `/execution-settings/custom-task-drafts/${taskDraft[1]}`);
    if (taskDraft && req.method === 'POST' && taskDraft[2] === 'cancel')
      return request(dir, 'runtime', `/execution-settings/custom-task-drafts/${taskDraft[1]}/cancel`, { method: 'POST', body: await body(req) });
    if (p === '/api/execution-settings/custom-tasks' && req.method === 'POST') return request(dir, 'runtime', '/execution-settings/custom-tasks', { method: 'POST', body: await body(req) });
    const customSetting = p.match(/^\/api\/execution-settings\/custom-tasks\/([^/]+)$/);
    if (customSetting && req.method === 'DELETE') return request(dir, 'runtime', `/execution-settings/custom-tasks/${customSetting[1]}`, { method: 'DELETE', body: await body(req) });
    let executionSetting = p.match(/^\/api\/execution-settings\/([^/]+)$/);
    if (executionSetting && ['PUT', 'DELETE'].includes(req.method)) return request(dir, 'runtime', `/execution-settings/${executionSetting[1]}`, { method: req.method, body: await body(req) });
    if (req.method === 'GET' && p === '/api/automation/settings') return writings.automationSettings();
    if (req.method === 'PATCH' && p === '/api/automation/settings') { const result = writings.saveAutomationSettings(await body(req)); notify(); return result; }
    if (req.method === 'GET' && p === '/api/health') return health();
    if (req.method === 'GET' && p === '/api/quick') {
      const overview = store.quickOverview(), rows = notifications.list(), counts = notificationCounts(rows);
      const decorate = item => ({ ...item, notification_count: counts.get(item.id) || 0 });
      return { ...overview, counts: { ...overview.counts, notifications: rows.length }, current: overview.current.map(decorate), recent: overview.recent.map(decorate),
        notifications: rows.slice(0, 3), health: health(), observed_at: now() };
    }
    if (req.method === 'GET' && p === '/api/notifications') {
      assert([...url.searchParams].length === 0, '알림 조회 조건이 잘못되었습니다.'); return notifications.list();
    }
    const notificationRoute = p.match(/^\/api\/notifications\/([^/]+)\/dismiss$/);
    if (req.method === 'POST' && notificationRoute) {
      const result = notifications.dismiss(notificationRoute[1], await body(req)); if (!result.repeated) notify(); return result;
    }
    if (req.method === 'GET' && p === '/api/reports') return reports.list().map(report => ({ ...report, publication_revision: digest(json(reportPublisher.publications(report.id))) }));
    if (req.method === 'POST' && p === '/api/reports') { const result = reports.create(await body(req)); notify(); return result; }
    const reportRoute = p.match(/^\/api\/reports\/([^/]+)$/);
    if (reportRoute && req.method === 'GET') {
      assert([...url.searchParams.keys()].every(key => key === 'view') && url.searchParams.getAll('view').length <= 1
        && (!url.searchParams.has('view') || url.searchParams.get('view') === 'summary'), '보고서 조회 조건이 잘못되었습니다.');
      return { ...reports.detail(reportRoute[1], { summary: url.searchParams.get('view') === 'summary' }), publications: reportPublisher.publications(reportRoute[1]) };
    }
    const reportPartRoute = p.match(/^\/api\/reports\/([^/]+)\/parts\/([^/]+)$/);
    if (reportPartRoute && req.method === 'GET') return reports.partDetail(reportPartRoute[1], reportPartRoute[2]);
    const publishRoute = p.match(/^\/api\/reports\/([^/]+)\/publish$/);
    if (publishRoute && req.method === 'POST') return reportPublisher.publish(publishRoute[1], await body(req));
    const publicationResolve = p.match(/^\/api\/reports\/([^/]+)\/publications\/([^/]+)\/resolve$/);
    if (publicationResolve && req.method === 'POST') return reportPublisher.resolve(publicationResolve[1], publicationResolve[2], await body(req));
    if (req.method === 'GET' && p === '/api/items') return itemListing(url.searchParams);
    if (req.method === 'GET' && p === '/api/tags') {
      assert([...url.searchParams.keys()].every(key => key === 'trash') && url.searchParams.getAll('trash').length <= 1,
        '태그 조회 조건이 잘못되었습니다.');
      const trash = url.searchParams.get('trash') ?? 'false';
      assert(['true', 'false'].includes(trash), '태그 조회 조건이 잘못되었습니다.');
      return store.tagList({ trash: trash === 'true' });
    }
    if (req.method === 'GET' && p === '/api/sessions') {
      assert([...url.searchParams.keys()].every(key => key === 'q') && url.searchParams.getAll('q').length <= 1, '세션 조회 조건이 잘못되었습니다.');
      return store.sessionEntries(Object.fromEntries(url.searchParams), sessionSummaries());
    }
    if (req.method === 'GET' && p === '/api/calendar') return store.calendar(Object.fromEntries(url.searchParams), sessionSummaries());
    if (req.method === 'POST' && p === '/api/events') {
      const data = await body(req); assert(Array.isArray(data.events) && data.events.length <= 500, '이벤트 배열이 필요합니다.');
      const result = store.ingestMany(data.events); if (result.inserted) notify(); return result;
    }
    if (req.method === 'POST' && p === '/api/merge') {
      const result = store.merge(await body(req)); if (!result.repeated) notify(); return result;
    }
    if (req.method === 'POST' && ['/api/items/delete', '/api/items/restore'].includes(p)) {
      const result = p.endsWith('/delete') ? store.deleteItems(await body(req)) : store.restoreItems(await body(req));
      if (!result.repeated) notify(); return result;
    }
    let m = p.match(/^\/api\/items\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const detail = jira.decorate(writings.decorate(integrations.decorate(store.detail(m[1], { summary: url.searchParams.get('view') === 'summary' }))));
      detail.notifications = notifications.list().filter(row => row.work_item_id === detail.item.id);
      detail.item.notification_count = detail.notifications.length;
      jira.refreshItem(detail.item.id); return detail;
    }
    if (m && req.method === 'PATCH') { const result = store.edit(m[1], await body(req)); notify(); return result; }
    m = p.match(/^\/api\/items\/([^/]+)\/tags$/);
    if (m && req.method === 'PUT') { const result = store.editTags(m[1], await body(req)); notify(); return result; }
    m = p.match(/^\/api\/items\/([^/]+)\/history$/);
    if (m && req.method === 'GET') return store.history(m[1], Object.fromEntries(url.searchParams));
    m = p.match(/^\/api\/items\/([^/]+)\/runs\/([^/]+)\/events$/);
    if (m && req.method === 'GET') {
      const records = store.runEvents(m[1], m[2]);
      let attempts = [];
      try {
        const run = await request(dir, 'runtime', `/runs/${m[2]}`, { signal: AbortSignal.timeout(1000) });
        attempts = run.attempts.map(({ id, stage, started_at, ended_at }) => ({ id, stage, started_at, ended_at }));
      } catch { /* Stored diagnostics remain available while the execution service is stopped. */ }
      return { records, attempts };
    }
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
      const owner = store.canonical(m[1]), visibility = store.visibilityRevision(m[1]);
      const intent = integrations.beginIssue(m[1], await body(req));
      if (intent.repeated) return intent;
      notify();
      try {
        const issue = await atlassian.createJiraIssue(intent.request, { beforeSend: () => {
          assert(!store.isDeleted(m[1]) && store.canonical(m[1]) === owner && store.visibilityRevision(m[1]) === visibility, '업무 목록 상태가 변경되었습니다. 다시 확인하세요.', 409);
        } });
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
    m = p.match(/^\/api\/jira-links\/([^/]+)\/content$/);
    if (m && req.method === 'POST') return jira.updateContent(m[1], await body(req));
    m = p.match(/^\/api\/jira-links\/([^/]+)\/result-comment\/(retry|reconcile)$/);
    if (m && req.method === 'POST') return m[2] === 'retry' ? jira.retryResult(m[1], await body(req)) : jira.reconcileResult(m[1], await body(req));
    m = p.match(/^\/api\/jira-links\/([^/]+)\/resolve$/);
    if (m && req.method === 'POST') {
      const link = integrations.links().find(l => l.operation_id === m[1]);
      assert(link?.state === 'unknown', '결과 확인이 필요한 Jira 생성 요청이 없습니다.', 409);
      assert(!store.isDeleted(link.work_item_id), '삭제된 업무입니다. 복원 후 확인하세요.', 404);
      const visibility = store.visibilityRevision(link.work_item_id);
      const issue = await atlassian.resolveIssue(link, (await body(req)).key);
      assert(!store.isDeleted(link.work_item_id) && store.visibilityRevision(link.work_item_id) === visibility, '업무 목록 상태가 변경되었습니다. 다시 확인하세요.', 409);
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
const reportTimer = setInterval(() => void reportWriter.tick().catch(() => {}), 1000);
const resultTimer = setInterval(() => void jira.tickResults().catch(() => {}), 1000);
async function stop() {
  if (stopping) return; stopping = true;
  clearInterval(timer); clearInterval(integrationTimer); clearInterval(reportTimer); clearInterval(resultTimer); atlassian.close();
  for (const res of subscribers) res.end();
  server.close();
  await stopCredentialProcesses();
  server.closeAllConnections(); process.exit(0);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
