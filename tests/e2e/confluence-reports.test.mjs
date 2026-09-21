import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, eventually } from '../helpers.mjs';
import { digest } from '../../src/shared.mjs';
import { atlFixture, authorize } from '../fixtures/atlassian.mjs';
import { confluenceStorage } from '../../src/confluence-storage.mjs';
import { buildReportStorage } from '../../src/confluence-reports.mjs';

const post = body => ({ method: 'POST', body });
const request = operation_id => ({ operation_id, cloud_id: 'cloud-test', space_id: '10' });
const writes = fixture => fixture.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/wiki/api/v2/pages'));
async function setup(t, env = {}) {
  const h = new Harness(), f = await atlFixture(h);
  h.env = { ...h.env, ...env };
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('runtime'); await h.start('manager');
  await h.ingest([
    ...pair('report-agent', '09:00:00', '09:05:00', 'report-1', { work_item_id: 'report-item', text: '권한 관리 화면 기획과 검증' }),
    ...pair('report-agent', '09:30:00', '09:35:00', 'report-2', { text: '오류 상태 확인과 안내 보완' })
  ]);
  return { h, f };
}
async function report(h, operation_id = 'create-report-for-publishing') {
  const created = await h.manager('/reports', post({ operation_id, dates: ['2026-09-17'], timezone: 'UTC', report_type: 'work' }));
  const id = created.report?.id || created.id;
  assert.ok(id, 'created report must expose its durable id');
  const detail = await eventually(() => h.manager(`/reports/${id}`), value => ['completed', 'failed'].includes(value.report.state), 20000);
  assert.equal(detail.report.state, 'completed', detail.report.message); return detail;
}
const publish = (h, id, input) => h.manager(`/reports/${id}/publish`, post(input));
const resolve = (h, id, op, page_id) => h.manager(`/reports/${id}/publications/${op}/resolve`, post({ page_id }));

test('Confluence storage preserves semantic report text while raw HTML, resource tags and unsafe URLs stay inert', () => {
  const body = confluenceStorage('# 작업 요약\n\n## 결과\n- **완료** 및 `x < y`\n- [명세](https://example.com/a?x=1&y=2)\n\n1. 첫째\n2. 둘째\n\n```html\n<script>alert(1)</script>\n```\n\n<img src=x onerror=alert(1)>\n[금지](javascript:alert)\n![외부 이미지](https://example.com/tracking)\n[계정](https://user:secret@example.com/)');
  assert.match(body, /<h1>작업 요약<\/h1>/); assert.match(body, /<h2>결과<\/h2>/);
  assert.match(body, /<ul><li><strong>완료<\/strong> 및 <code>x &lt; y<\/code>/);
  assert.match(body, /<ol><li>첫째<\/li><li>둘째<\/li><\/ol>/);
  assert.match(body, /<pre><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
  assert.match(body, /href="https:\/\/example.com\/a\?x=1&amp;y=2"/);
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(body, /<(?:img|script|iframe)|href="(?:javascript|data|https:\/\/user:)/i);
  assert.match(body, /!\[외부 이미지\]\(https:\/\/example.com\/tracking\)/);
});

test('local report generation performs no external writes; paged space selection and explicit publication create exactly one page across replay and restart', async t => {
  const { h, f } = await setup(t), original = await report(h);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.tokenCalls.length, 0);
  assert.equal((await h.runtime(`/runs/${original.report.run_id}`)).status, 'completed');
  await authorize(h);
  const first = await h.manager('/integrations/atlassian/confluence-spaces?cloud_id=cloud-test');
  assert.deepEqual(first.spaces.map(space => space.id), ['10', '20']); assert.ok(first.next_cursor);
  const second = await h.manager('/integrations/atlassian/confluence-spaces?cloud_id=cloud-test&cursor=' + encodeURIComponent(first.next_cursor));
  assert.deepEqual(second.spaces.map(space => space.id), ['30']); assert.equal(second.next_cursor, null);
  assert.equal(writes(f).length, 0);
  const input = request('publish-report-once'), id = original.report.id;
  const results = await Promise.all([publish(h, id, input), publish(h, id, input)]);
  assert.ok(results.every(row => row.state === 'published')); assert.equal(results.filter(row => row.repeated).length, 1);
  assert.equal(writes(f).length, 1); assert.equal(f.state.pages.length, 1);
  assert.equal(writes(f)[0].body.title, original.report.title);
  assert.equal(writes(f)[0].body.body.value, buildReportStorage(original));
  assert.doesNotMatch(writes(f)[0].body.body.value, /작성 근거|근거 세션|\[(?:session|part):/);
  for (const session of original.sessions) assert.ok(!writes(f)[0].body.body.value.includes(session.id));
  assert.ok(!writes(f)[0].body.body.value.includes('오류 상태 확인과 안내 보완'), 'raw conversation is not appended to the report');
  assert.match(results[0].url, /^https:\/\/fixture\.atlassian\.net\/wiki\/pages\/viewpage\.action\?pageId=1000$/);
  const another = await publish(h, id, request('another-click-same-report'));
  assert.equal(another.operation_id, input.operation_id); assert.equal(another.repeated, true);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await publish(h, id, input)).repeated, true); assert.equal(writes(f).length, 1);
  const detail = await h.manager(`/reports/${id}`);
  assert.equal(detail.report.body, original.report.body); assert.equal(detail.publications.length, 1);
  assert.equal(detail.publications[0].state, 'published'); assert.equal(detail.publications[0].page_id, '1000');
  assert.equal(Object.hasOwn(detail.publications[0], 'storage'), false);
});

test('rejected publication remains local and durable, repeated failed operation never retries, explicit new operation can retry', async t => {
  const { h, f } = await setup(t), { report: local } = await report(h); await authorize(h);
  f.state.pageFailure = 400;
  await assert.rejects(publish(h, local.id, request('publish-rejected')), error => error.status === 400);
  let detail = await h.manager(`/reports/${local.id}`);
  assert.equal(detail.report.state, 'completed'); assert.equal(detail.publications[0].state, 'failed');
  assert.match(detail.publications[0].message, /Confluence/); assert.equal(writes(f).length, 1);
  f.state.pageFailure = null;
  assert.equal((await publish(h, local.id, request('publish-rejected'))).state, 'failed'); assert.equal(writes(f).length, 1);
  assert.equal((await publish(h, local.id, request('publish-retry-new-operation'))).state, 'published');
  assert.equal(writes(f).length, 2); assert.equal(f.state.pages.length, 1);
  detail = await h.manager(`/reports/${local.id}`); assert.equal(detail.publications.length, 2); assert.equal(detail.report.body, local.body);
  await assert.rejects(publish(h, local.id, { ...request('publish-rejected'), space_id: '20' }), error => error.status === 409);
});

test('response-lost publication is never reposted after restart; explicit page reconciliation checks exact space, title and body', async t => {
  const { h, f } = await setup(t), { report: local } = await report(h); await authorize(h); f.state.losePage = true;
  const input = request('publish-response-lost');
  await assert.rejects(publish(h, local.id, input), error => error.status === 502);
  assert.equal(f.state.pages.length, 1); assert.equal(writes(f).length, 1);
  let detail = await h.manager(`/reports/${local.id}`); assert.equal(detail.publications[0].state, 'unknown');
  await h.stop('manager'); await h.start('manager');
  assert.equal((await publish(h, local.id, input)).state, 'unknown');
  assert.equal((await publish(h, local.id, request('publish-new-op-while-unknown'))).state, 'unknown');
  assert.equal(writes(f).length, 1);
  const page = f.state.pages[0], original = structuredClone(page);
  for (const mutation of [row => { row.spaceId = '20'; }, row => { row.title += ' 다른 제목'; }, row => { row.body.storage.value += '<p>다른 내용</p>'; }]) {
    Object.assign(page, structuredClone(original)); mutation(page);
    await assert.rejects(resolve(h, local.id, input.operation_id, page.id), error => error.status === 409);
    assert.equal((await h.manager(`/reports/${local.id}`)).publications[0].state, 'unknown');
  }
  Object.assign(page, original);
  const resolved = await resolve(h, local.id, input.operation_id, page.id);
  assert.equal(resolved.state, 'published'); assert.equal(resolved.page_id, page.id);
  assert.equal((await resolve(h, local.id, input.operation_id, page.id)).repeated, true);
  assert.equal(writes(f).length, 1); detail = await h.manager(`/reports/${local.id}`); assert.equal(detail.report.body, local.body);
});

test('Confluence capability checks block page writes without new scopes and restricted pagination never follows arbitrary links', async t => {
  const { h, f } = await setup(t), { report: local } = await report(h); await authorize(h);
  f.state.scopes = f.state.scopes.filter(scope => scope !== 'write:page:confluence');
  await assert.rejects(publish(h, local.id, request('publish-missing-scope')), error => error.status === 403);
  assert.equal(writes(f).length, 0); assert.equal((await h.manager(`/reports/${local.id}`)).publications[0].state, 'failed');
  f.state.scopes.push('write:page:confluence');
  await assert.rejects(publish(h, local.id, { ...request('publish-invalid-space'), space_id: '999' }), error => error.status === 404);
  assert.equal(writes(f).length, 0);
  for (const next of ['https://example.invalid/steal?cursor=abc', '/wiki/api/v2/pages?cursor=abc', '/wiki/api/v2/spaces?cursor=abc&cursor=def', '/wiki/api/v2/spaces?cursor=abc&inject=bad']) {
    f.state.spacesNext = next;
    await assert.rejects(h.manager('/integrations/atlassian/confluence-spaces?cloud_id=cloud-test'), error => error.status === 502);
  }
  assert.equal(writes(f).length, 0);
  assert.ok(f.state.calls.every(call => !call.path.includes('steal')));
});

test('pending and failed headless reports cannot publish or create any external publication intent', async t => {
  const { h, f } = await setup(t, { HARNESS_TEST_REPORT_FIXTURE: JSON.stringify({ delayMs: 800, scenario: 'report-invalid' }) });
  const created = await h.manager('/reports', post({ operation_id: 'create-invalid-report', dates: ['2026-09-17'], timezone: 'UTC', report_type: 'work' }));
  assert.equal(created.state, 'pending');
  await assert.rejects(publish(h, created.id, request('publish-pending-report')), error => error.status === 409);
  const failed = await eventually(() => h.manager(`/reports/${created.id}`), value => value.report.state === 'failed', 20000);
  assert.equal((await h.runtime(`/runs/${failed.report.run_id}`)).attempts.length, 1);
  await assert.rejects(publish(h, created.id, request('publish-failed-report')), error => error.status === 409);
  assert.deepEqual((await h.manager(`/reports/${created.id}`)).publications, []);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.tokenCalls.length, 0);
});

test('malformed page success response is an unknown write, never a safe failed retry', async t => {
  const { h, f } = await setup(t), { report: local } = await report(h); await authorize(h);
  f.state.malformedPageResponse = true;
  await assert.rejects(publish(h, local.id, request('publish-malformed-success')), error => error.status === 502);
  assert.equal(f.state.pages.length, 1);
  assert.equal((await h.manager(`/reports/${local.id}`)).publications[0].state, 'unknown');
  f.state.malformedPageResponse = false;
  assert.equal((await publish(h, local.id, request('publish-after-malformed'))).state, 'unknown');
  assert.equal(writes(f).length, 1);
});

test('hierarchical headless reports publish only the final report while session snapshots and the complete part graph remain local', async t => {
  const { h, f } = await setup(t), events = [];
  for (let index = 0; index < 99; index++) {
    const turn = pair(`annual-source-${index}`, '11:00:00', '11:05:00', `annual-${index}`, { work_item_id: `annual-item-${index}`, text: `분기 작업 ${index}` });
    turn[1].text = `PRIVATE_ASSISTANT_SOURCE_${index}`; events.push(...turn);
  }
  await h.ingest(events);
  const detail = await report(h, 'create-hierarchical-publish-report');
  assert.equal(detail.sessions.length, 101);
  assert.ok(detail.parts.length > 1); assert.ok(detail.parts.every(part => part.state === 'completed'));
  const parts = new Map();
  for (const part of detail.parts) parts.set(part.id, await h.manager(`/reports/${detail.report.id}/parts/${part.id}`));
  await authorize(h);
  const result = await publish(h, detail.report.id, request('publish-hierarchical-report'));
  assert.equal(result.state, 'published'); assert.equal(writes(f).length, 1);
  const storage = f.state.pages[0].body.storage.value;
  assert.equal(storage, buildReportStorage(detail));
  assert.doesNotMatch(storage, /PRIVATE_ASSISTANT_SOURCE_|작성 근거|근거 세션|\[(?:session|part):/);
  for (const part of detail.parts) assert.ok(!storage.includes(part.id));
  for (const session of detail.sessions) assert.ok(!storage.includes(session.id));
  const after = await h.manager(`/reports/${detail.report.id}`);
  assert.deepEqual(after.sessions, detail.sessions); assert.deepEqual(after.parts, detail.parts); assert.equal(after.report.body, detail.report.body);
  for (const part of detail.parts) assert.deepEqual(await h.manager(`/reports/${detail.report.id}/parts/${part.id}`), parts.get(part.id));
});

test('publication retains the storage size limit and does not silently truncate oversized business text', () => {
  assert.throws(() => buildReportStorage({ report: { body: 'x'.repeat(8 * 1024 * 1024) } }), error => error.status === 413);
  assert.throws(() => buildReportStorage({ report: { body: '' } }), error => error.status === 409);
});

test('legacy reports publish without inline references or evidence sections while existing publication bytes still reconcile unchanged', async t => {
  const { h, f } = await setup(t), original = await report(h); await authorize(h); await h.stop('manager');
  const sessionId = original.sessions[0].id;
  const legacyBody = `## 업무 개요\n권한 관리의 빈 상태를 명확히 합니다. [session:${sessionId}]\n\n## 수행 내용\n### 권한 안내\n관련 Jira: [TEAM-17](https://fixture.atlassian.net/browse/TEAM-17)\n오류 안내를 보완했습니다. [session:${sessionId}]\n\n## 미완료·확인 사항\n실서비스 적용은 미확인입니다.\n\n## 근거 세션\n- [session:${sessionId}] LOCAL_EVIDENCE_ONLY\n\n## 작성 근거\nLOCAL_APPENDIX_ONLY`;
  const oldStorage = confluenceStorage(legacyBody) + '<h3>기존 세션 부록</h3>', time = new Date().toISOString();
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  db.prepare('UPDATE work_reports SET body=? WHERE id=?').run(legacyBody, original.report.id);
  db.prepare('INSERT INTO confluence_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-frozen-publication', original.report.id, 'cloud-test', '20', original.report.title,
    oldStorage, digest(oldStorage), 'unknown', null, null, '이전 게시 응답 미확인', time, time); db.close();
  f.state.pages.push({ id: '555', spaceId: '20', status: 'current', title: original.report.title, body: { storage: { representation: 'storage', value: oldStorage } } });
  await h.start('manager');
  const result = await publish(h, original.report.id, request('publish-legacy-clean-body'));
  assert.equal(result.state, 'published'); assert.equal(writes(f).length, 1);
  const storage = writes(f)[0].body.body.value;
  assert.match(storage, /권한 관리의 빈 상태|오류 안내를 보완|실서비스 적용은 미확인/);
  assert.match(storage, /href="https:\/\/fixture\.atlassian\.net\/browse\/TEAM-17">TEAM-17<\/a>/);
  assert.doesNotMatch(storage, /LOCAL_EVIDENCE_ONLY|LOCAL_APPENDIX_ONLY|작성 근거|근거 세션|\[(?:session|part):/);
  assert.equal((await publish(h, original.report.id, { ...request('legacy-frozen-publication'), space_id: '20' })).state, 'unknown');
  assert.equal((await resolve(h, original.report.id, 'legacy-frozen-publication', '555')).state, 'published');
  assert.equal(writes(f).length, 1); assert.equal((await h.manager(`/reports/${original.report.id}`)).report.body, legacyBody);
  const saved = new DatabaseSync(path.join(h.dir, 'memory.sqlite'), { readOnly: true });
  assert.equal(saved.prepare('SELECT storage FROM confluence_publications WHERE operation_id=?').get('legacy-frozen-publication').storage, oldStorage); saved.close();
});
