import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize } from '../fixtures/atlassian.mjs';

let h, f;
test.beforeEach(async ({ context }) => {
  h = new Harness(); f = await atlFixture(h);
  h.env.HARNESS_TEST_SESSION_SUMMARIES = '0';
  h.env.HARNESS_TEST_REPORT_FIXTURE = JSON.stringify({ delayMs: 250 });
  await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => { await h.close(); await f.close(); });
const sample = (agent, day, text = 'API 계약과 검증 결과를 정리했습니다.') => pair(agent, `${day}T09:00:00+09:00`, `${day}T09:05:00+09:00`, 'first', { text });
const pageWrites = () => f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/wiki/api/v2/pages'));
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await expect(page.getByRole('heading', { name: '업무 목록', exact: true })).toBeVisible();
}
async function calendar(page, day = '2026-09-17', view = 'month') {
  await page.locator('#nav-calendar').click();
  await page.locator('#calendar-date').fill(day); await page.locator('#calendar-date').dispatchEvent('change');
  await page.locator(`[data-view="${view}"]`).click();
}
const pick = (page, date) => page.locator(`input[data-report-date="${date}"]`);
async function openSources(page) {
  if (!await page.locator('#report-sources').evaluate(node => node.open)) await page.locator('#report-sources > summary').click();
}
async function submitSelection(page) {
  await page.locator('#create-calendar-report').click();
  await expect(page.getByRole('dialog')).toContainText('자정을 넘긴 세션도 시작일에 한 번만 포함');
  await page.locator('#confirm-create-report').click();
  await expect(page.getByRole('heading', { name: '업무 요약', exact: true })).toBeVisible();
}
async function latestCompleted(page) {
  const rows = await eventually(() => h.manager('/reports'), rows => rows[0]?.state === 'completed', 20000);
  await expect(page.locator('#report-detail .report-state')).toContainText('작성 완료');
  return h.manager(`/reports/${rows[0].id}`);
}
async function createLocal(page, date = '2026-09-17') {
  await open(page); await calendar(page, date); await pick(page, date).check(); await submitSelection(page);
  return latestCompleted(page);
}

test('week/month selection survives live refresh and navigation, and cross-midnight sources are captured once by local start date', async ({ page }) => {
  await h.ingest([...pair('report-midnight', '2026-09-17T23:50:00+09:00', '2026-09-18T00:10:00+09:00', 'first', { text: '자정을 넘겨 계약 확인' }),
    ...sample('report-next', '2026-09-18', '다음 날 구현 확인')]);
  const originals = await h.manager('/sessions');
  await open(page); await calendar(page, '2026-09-17', 'week');
  await expect(page.locator('#create-calendar-report')).toBeDisabled();
  await pick(page, '2026-09-17').check(); await expect(page.locator('#report-selection-count')).toHaveText('1일 선택됨');
  await h.ingest(sample('report-extra', '2026-09-18', '병렬 에이전트의 별도 검토'));
  await expect(pick(page, '2026-09-17')).toBeChecked();
  await page.locator('[data-view="month"]').click(); await expect(pick(page, '2026-09-17')).toBeChecked();
  await pick(page, '2026-09-18').check(); await page.locator('#next').click();
  await expect(page.locator('#report-selection-count')).toHaveText('2일 선택됨');
  await page.locator('#report-selected-dates summary').click();
  await expect(page.locator('#report-selected-dates p')).toHaveText('2026-09-17 · 2026-09-18');
  await page.locator('[data-view="day"]').click(); await expect(page.locator('[data-report-date]')).toHaveCount(0);
  await expect(page.locator('#report-selection-count')).toHaveText('2일 선택됨');
  await submitSelection(page); const first = await latestCompleted(page);
  expect(first.report.dates).toEqual(['2026-09-17', '2026-09-18']); expect(first.report.timezone).toBe('Asia/Seoul');
  expect(first.report.session_count).toBe(3); expect(new Set(first.sessions.map(session => session.id)).size).toBe(3);
  expect(first.sessions.map(session => session.id)).toEqual(expect.arrayContaining(originals.map(session => session.id)));
  await page.locator('#nav-calendar').click(); await page.locator('#clear-report-dates').click();
  await expect(page.locator('#create-calendar-report')).toBeDisabled();
  await calendar(page); await pick(page, '2026-09-18').check(); await submitSelection(page);
  const next = await latestCompleted(page);
  expect(next.report.id).not.toBe(first.report.id); expect(next.report.session_count).toBe(2);
  expect(next.sessions.some(session => session.id === originals.find(session => session.agent_session_id === 'report-midnight').id)).toBe(false);
  expect(f.state.tokenCalls).toHaveLength(0); expect(pageWrites()).toHaveLength(0);
});

test('local reports show newest creation first and retain captured metadata after edits, deletion and service restart', async ({ page }) => {
  await h.ingest(sample('report-snapshot', '2026-09-17', '최초 요구와 수용 조건 근거'));
  const item = (await h.manager('/items'))[0];
  await h.manager(`/items/${item.id}/tags`, { method: 'PUT', body: { version: item.version, tags: ['설계'] } });
  const first = await createLocal(page), source = JSON.stringify(first.sessions);
  expect(first.report.body).not.toMatch(/근거 세션|\[(?:session|part):/);
  await expect(page.locator('#report-detail .report-body .report-reference')).toHaveCount(0);
  await expect(page.locator('#report-sources')).not.toHaveAttribute('open', '');
  await page.locator('#regenerate-report').click(); await page.locator('#confirm-create-report').click();
  const second = await latestCompleted(page); expect(second.report.id).not.toBe(first.report.id);
  await expect(page.locator('.report-row')).toHaveCount(2);
  expect(await page.locator('.report-row').evaluateAll(rows => rows.map(row => row.dataset.reportId))).toEqual([second.report.id, first.report.id]);
  const current = (await h.manager(`/items/${item.id}`)).item;
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: current.version, title: '나중에 바꾼 업무 이름', description: '요약 캡처 이후 설명' } });
  await h.manager('/items/delete', { method: 'POST', body: { ids: [item.id], operation_id: 'delete-report-source-item' } });
  expect(JSON.stringify((await h.manager(`/reports/${first.report.id}`)).sessions)).toBe(source);
  await h.stop('manager'); await h.start('manager'); await open(page); await page.locator('#nav-reports').click();
  await expect(page.locator('.report-row')).toHaveCount(2);
  await page.locator(`.report-row[data-report-id="${first.report.id}"] .report-open`).click();
  await expect(page.locator('#report-detail .report-body')).toBeVisible();
  await page.locator('#report-sources summary').click(); await expect(page.locator('#report-sources')).toContainText('최초 요구와 수용 조건 근거');
  await expect(page.locator('#report-sources')).toContainText('설계'); await expect(page.locator('#report-sources')).not.toContainText('나중에 바꾼 업무 이름');
  await page.locator('#report-sources > summary').click();
  await page.screenshot({ path: 'output/playwright/work-report-local.png', fullPage: true });
  await openSources(page);
  await page.locator('#report-sources .report-reference[data-reference-kind="session"]').first().click();
  const sourceDialog = page.getByRole('dialog');
  await expect(sourceDialog.getByRole('heading', { name: '요약의 근거 세션', exact: true })).toBeVisible();
  await expect(sourceDialog).toContainText('작성 시점의 이력');
  await expect(sourceDialog.locator('.report-source-text')).toHaveText(['최초 요구와 수용 조건 근거', '최초 요구와 수용 조건 근거']);
  await expect(sourceDialog).not.toContainText('나중에 바꾼 업무 이름');
  expect(pageWrites()).toHaveLength(0); expect(f.state.tokenCalls).toHaveLength(0);
});

test('quarter, half-year and leap-year work reports submit complete local date periods without an interview mode', async ({ page }) => {
  await h.ingest([...sample('report-period-2026', '2026-09-17'), ...sample('report-leap', '2024-02-29', '윤년 업무 근거')]);
  await open(page); await page.locator('#nav-reports').click();
  const cases = [
    { period: 'quarter', year: '2026', part: '3', start: '2026-07-01', end: '2026-09-30', length: 92 },
    { period: 'half', year: '2026', part: '2', start: '2026-07-01', end: '2026-12-31', length: 184 },
    { period: 'year', year: '2024', start: '2024-01-01', end: '2024-12-31', length: 366 }
  ];
  for (const value of cases) {
    await page.locator('#create-period-report').click();
    await page.locator('#report-period').selectOption(value.period); await page.locator('#report-year').fill(value.year);
    if (value.part) await page.locator('#report-period-part').selectOption(value.part);
    await expect(page.getByRole('dialog')).not.toContainText('성과 면담');
    await expect(page.getByRole('combobox', { name: '요약 유형' })).toHaveCount(0);
    const sent = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/reports');
    await page.locator('#confirm-create-report').click();
    const body = (await sent).postDataJSON();
    expect(body.dates).toHaveLength(value.length); expect(new Set(body.dates).size).toBe(value.length);
    expect(body.dates[0]).toBe(value.start); expect(body.dates.at(-1)).toBe(value.end); expect(body).not.toHaveProperty('report_type');
    const result = await latestCompleted(page); expect(result.report.report_type).toBe('work');
    expect(result.report.dates).toEqual(body.dates); await expect(page.locator('#report-detail .eyebrow')).toHaveText('WORK SUMMARY');
  }
  await expect(page.locator('.report-row')).toHaveCount(3); expect(pageWrites()).toHaveLength(0);
});

test('an empty selected date gives a useful error and a failed generated report remains visible for a fresh retry', async ({ page }) => {
  await open(page); await calendar(page); await pick(page, '2026-09-17').check(); await page.locator('#create-calendar-report').click();
  await page.locator('#confirm-create-report').click(); await expect(page.locator('#report-create-error')).toBeVisible();
  expect(await h.manager('/reports')).toEqual([]);
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
  await h.stop('manager'); h.env.HARNESS_TEST_REPORT_FIXTURE = JSON.stringify({ scenario: 'report-invalid' }); await h.start('manager');
  await h.ingest(sample('report-fail', '2026-09-17')); await open(page); await calendar(page); await pick(page, '2026-09-17').check(); await submitSelection(page);
  const failed = await eventually(() => h.manager('/reports'), rows => rows[0]?.state === 'failed', 20000);
  await expect(page.locator('#report-detail .report-state')).toContainText('작성 실패'); await expect(page.locator('#publish-report')).toHaveCount(0);
  await h.stop('manager'); h.env.HARNESS_TEST_REPORT_FIXTURE = JSON.stringify({ delayMs: 100 }); await h.start('manager');
  await open(page); await page.locator('#nav-reports').click(); await page.locator('.report-open').click();
  await page.locator('#regenerate-report').click(); await page.locator('#confirm-create-report').click();
  const retried = await latestCompleted(page); expect(retried.report.id).not.toBe(failed[0].id);
  await expect(page.locator('.report-row')).toHaveCount(2); expect(pageWrites()).toHaveLength(0);
});

test('Confluence space paging and confirmation publish the completed local report once to the chosen space', async ({ page }) => {
  await h.ingest(sample('report-publish', '2026-09-17')); const data = await createLocal(page);
  await authorize(h); await page.locator('#publish-report').click();
  await expect(page.locator('#report-confluence-space option')).toHaveCount(2);
  await page.locator('#report-spaces-more').click(); await expect(page.locator('#report-confluence-space option')).toHaveCount(3);
  await page.locator('#report-confluence-space').selectOption('30'); expect(pageWrites()).toHaveLength(0);
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click(); expect(pageWrites()).toHaveLength(0);
  await page.locator('#publish-report').click(); await page.locator('#report-spaces-more').click(); await page.locator('#report-confluence-space').selectOption('30');
  await page.locator('#confirm-publish-report').click(); await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.report-publication')).toContainText('Confluence 게시됨');
  expect(pageWrites()).toHaveLength(1); expect(pageWrites()[0].body.spaceId).toBe('30'); expect(pageWrites()[0].body.title).toBe(data.report.title);
  await expect(page.locator('[data-report-url]')).toHaveAttribute('href', /https:\/\/fixture\.atlassian\.net\/wiki\//);
  const saved = await h.manager(`/reports/${data.report.id}`); expect(saved.report.body).toBe(data.report.body); expect(saved.publications[0].state).toBe('published');
});

test('lost Confluence response stays uncertain without duplicate pages and resolves only after checking a page ID', async ({ page }) => {
  await h.ingest(sample('report-unknown', '2026-09-17')); const data = await createLocal(page); await authorize(h); f.state.losePage = true;
  await page.locator('#publish-report').click(); await expect(page.locator('#confirm-publish-report')).toBeEnabled(); await page.locator('#confirm-publish-report').click();
  await expect(page.locator('#report-publish-error')).toBeVisible(); expect(pageWrites()).toHaveLength(1);
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.locator('.report-publication')).toContainText('게시 결과 확인 필요');
  await page.locator('#publish-report').click(); await expect(page.locator('#confirm-publish-report')).toBeEnabled(); await page.locator('#confirm-publish-report').click();
  await expect(page.locator('#report-publish-error')).toBeVisible(); expect(pageWrites()).toHaveLength(1); expect(f.state.pages).toHaveLength(1);
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
  await page.locator('[data-resolve-publication]').click(); await page.locator('#report-page-id').fill(f.state.pages[0].id); await page.locator('#resolve-report-publication').click();
  await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.locator('.report-publication')).toContainText('Confluence 게시됨');
  expect(pageWrites()).toHaveLength(1); expect((await h.manager(`/reports/${data.report.id}`)).publications[0].state).toBe('published');
});

test.describe('report local dates across DST', () => {
  test.use({ timezoneId: 'America/New_York' });
  test('the repeated local hour keeps both distinct sessions and excludes the previous local date', async ({ page }) => {
    await h.ingest([...pair('report-dst', '2026-11-01T05:10:00Z', '2026-11-01T05:20:00Z', 'first', { text: '첫 번째 1시 작업' }),
      ...pair('report-dst', '2026-11-01T06:10:00Z', '2026-11-01T06:20:00Z', 'second', { text: '두 번째 1시 작업' }),
      ...pair('report-previous-local', '2026-11-01T03:30:00Z', '2026-11-01T03:40:00Z', 'first', { text: '이전 현지 날짜 작업' })]);
    await open(page); await calendar(page, '2026-11-01'); await pick(page, '2026-11-01').check(); await submitSelection(page);
    const data = await latestCompleted(page); expect(data.report.timezone).toBe('America/New_York'); expect(data.report.session_count).toBe(2);
    expect(data.sessions.map(session => session.start_at).sort()).toEqual(['2026-11-01T05:10:00.000Z', '2026-11-01T06:10:00.000Z']);
    expect(pageWrites()).toHaveLength(0);
  });
});

test('regenerating a New York report from the Korean GUI preserves its original timezone and session selection', async ({ page, browser }) => {
  await h.ingest([...pair('report-ny-day', '2026-09-18T02:00:00Z', '2026-09-18T02:05:00Z', 'first', { text: '뉴욕 17일에 수행한 작업' }),
    ...pair('report-korea-day', '2026-09-17T00:00:00Z', '2026-09-17T00:05:00Z', 'first', { text: '한국 17일에만 속한 작업' })]);
  const nyContext = await browser.newContext({ timezoneId: 'America/New_York', locale: 'ko-KR' });
  await nyContext.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
  let original;
  try { original = await createLocal(await nyContext.newPage()); } finally { await nyContext.close(); }
  expect(original.report.timezone).toBe('America/New_York'); expect(original.report.session_count).toBe(1);
  await open(page); expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Seoul');
  await page.locator('#nav-reports').click(); await page.locator('.report-open').click(); await page.locator('#regenerate-report').click();
  await expect(page.getByRole('dialog')).toContainText('America/New_York 기준');
  const sent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/reports');
  await page.locator('#confirm-create-report').click(); const response = await sent;
  expect(response.request().postDataJSON().timezone).toBe('America/New_York');
  const created = await response.json();
  const regenerated = await eventually(() => h.manager(`/reports/${created.id}`), data => data.report.state === 'completed', 20000);
  expect(regenerated.report.id).not.toBe(original.report.id);
  expect(regenerated.sessions.map(session => session.id)).toEqual(original.sessions.map(session => session.id));
  expect(pageWrites()).toHaveLength(0);
});

test('late Confluence sites and partial-report responses cannot replace a newer settings dialog', async ({ page }) => {
  await h.ingest(Array.from({ length: 101 }, (_, index) => sample(`report-modal-${index}`, '2026-09-17', `부분 요약의 근거 ${index}`)).flat());
  await createLocal(page); await authorize(h);
  for (const scenario of [
    { glob: '**/api/integrations/atlassian/sites', trigger: '#publish-report' },
    { glob: '**/api/reports/*/parts/*', trigger: '#report-detail .report-reference[data-reference-kind="part"]' }
  ]) {
    let release, received = false;
    const gate = new Promise(resolve => { release = resolve; });
    const routeHandler = async route => { const response = await route.fetch(); received = true; await gate; await route.fulfill({ response }); };
    await page.route(scenario.glob, routeHandler);
    try {
      if (scenario.glob.includes('/parts/')) { await openSources(page); await page.locator('#report-parts > summary').click(); }
      await page.locator(scenario.trigger).first().click(); await expect.poll(() => received).toBe(true);
      await page.locator('#automation-settings').click();
      const dialog = page.getByRole('dialog'), heading = dialog.getByRole('heading', { name: '자동 작성 설정', exact: true });
      await expect(heading).toBeVisible(); await dialog.getByLabel('에이전트 응답 수').fill('13');
      const finished = page.waitForResponse(response => scenario.glob.includes('/parts/') ? new URL(response.url()).pathname.includes('/parts/') : response.url().endsWith('/api/integrations/atlassian/sites'));
      release(); await (await finished).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(heading).toBeVisible(); await expect(dialog.getByLabel('에이전트 응답 수')).toHaveValue('13');
      await expect(dialog.getByLabel('에이전트 응답 수')).toBeFocused();
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    } finally { release(); await page.unroute(scenario.glob, routeHandler); }
  }
  expect(pageWrites()).toHaveLength(0);
});

test('unchanged report refreshes reuse captured sources while state and publication changes use lightweight details', async ({ page }) => {
  await h.ingest(sample('report-cache', '2026-09-17', '한 번만 읽을 요약 원문'));
  const details = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && /^\/api\/reports\/[^/]+$/.test(url.pathname)) details.push(url);
  });
  const data = await createLocal(page);
  expect(details.filter(url => !url.searchParams.has('view'))).toHaveLength(1);
  expect(details.some(url => url.searchParams.get('view') === 'summary')).toBe(true);
  const before = details.length;
  for (let index = 0; index < 3; index++) {
    const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/reports');
    await page.locator('#nav-reports').click(); await (await refreshed).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  expect(details).toHaveLength(before);
  await authorize(h);
  const updated = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/reports/${data.report.id}` && new URL(response.url()).searchParams.get('view') === 'summary');
  await h.manager(`/reports/${data.report.id}/publish`, { method: 'POST', body: { operation_id: 'report-cache-publication', cloud_id: 'cloud-test', space_id: '10' } });
  expect(Object.hasOwn(await (await updated).json(), 'sessions')).toBe(false);
  await expect(page.locator('.report-publication')).toContainText('Confluence 게시됨');
  expect(details.filter(url => !url.searchParams.has('view'))).toHaveLength(1);
  await openSources(page);
  await page.locator('#report-sources .report-reference[data-reference-kind="session"]').first().click();
  await expect(page.getByRole('dialog').locator('.report-source-text')).toHaveText(['한 번만 읽을 요약 원문', '한 번만 읽을 요약 원문']);
  expect(pageWrites()).toHaveLength(1);
});


test('historical source lists stay stored but are omitted from the reader-facing report', async ({ page }) => {
  await h.ingest(sample('report-legacy-body', '2026-09-17', '보존할 원본 이력'));
  const data = await createLocal(page);
  const original = `## 업무 개요\n권한 안내 개선\n\n## 수행 내용\n관련 Jira: [TEAM-42](https://example.atlassian.net/browse/TEAM-42)\n- 오류 안내를 정리했습니다. [session:${data.sessions[0].id}]\n\n## 미완료·확인 사항\n운영 확인 대기\n\n## 근거 세션\n- 긴 세션 목록 [session:${data.sessions[0].id}]`;
  await h.stop('manager');
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  db.prepare('UPDATE work_reports SET body=? WHERE id=?').run(original, data.report.id); db.close();
  await h.start('manager'); await open(page); await page.locator('#nav-reports').click(); await page.locator('.report-open').click();
  const body = page.locator('#report-detail .report-body');
  await expect(body).toContainText('TEAM-42'); await expect(body).toContainText('오류 안내를 정리했습니다.');
  await expect(body).not.toContainText('근거 세션'); await expect(body).not.toContainText('긴 세션 목록'); await expect(body).not.toContainText('[session:');
  expect((await h.manager(`/reports/${data.report.id}`)).report.body).toBe(original);
  await openSources(page); await page.locator('#report-sources .report-reference').first().click();
  await expect(page.getByRole('dialog').locator('.report-source-text')).toHaveText(['보존할 원본 이력', '보존할 원본 이력']);
});
