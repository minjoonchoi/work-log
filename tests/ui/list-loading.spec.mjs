import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => h.close());
const open = page => page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
for (const [view, route, list, result] of [
  ['items', '**/api/items?*', '#item-list', '아직 기록된 업무가 없습니다'],
  ['notifications', '**/api/notifications', '#notification-list', '새 알림이 없습니다'],
  ['reports', '**/api/reports', '#report-list', '작성한 업무 요약이 없습니다']
]) test(view + ' shows skeleton before data, then the true empty state', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(route, async request => { await gate; await request.continue(); });
  await open(page);
  if (view !== 'items') await page.locator('#nav-' + view).click();
  await expect(page.locator(list + ' .skeleton-row')).toHaveCount(5);
  await expect(page.locator(list)).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator(list)).not.toContainText(result);
  await expect(page.locator(list)).not.toContainText('목록을 불러오는 중');
  release();
  await expect(page.locator(list)).toContainText(result);
  await expect(page.locator(list + ' .list-skeleton')).toHaveCount(0);
  await expect(page.locator(list)).not.toHaveAttribute('aria-busy', 'true');
});

test('list refresh keeps loaded items; a failed initial load offers a retry', async ({ page }) => {
  await h.ingest(pair('loading-work', '09:00:00', '09:05:00', 'first', { text: '로딩 검증 업무' }));
  let fail = true, hold = false, release;
  await page.route('**/api/items?*', async route => {
    if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"조회 실패"}' });
    if (hold) await new Promise(resolve => { release = resolve; });
    await route.continue();
  });
  await open(page);
  await expect(page.locator('#item-list')).toContainText('목록을 불러오지 못했습니다');
  await expect(page.locator('#item-list .list-skeleton')).toHaveCount(0);
  fail = false;
  await page.locator('#item-list').getByRole('button', { name: '다시 불러오기' }).click();
  await expect(page.locator('#item-list')).toContainText('로딩 검증 업무');
  hold = true;
  await page.locator('#refresh').click();
  await expect.poll(() => typeof release).toBe('function');
  await expect(page.locator('#item-list')).toContainText('로딩 검증 업무');
  await expect(page.locator('#item-list .list-skeleton')).toHaveCount(0);
  hold = false; release();
});

test('reports load independently while the unrelated health request is delayed', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/health', async route => { await gate; await route.continue(); });
  await open(page); await page.locator('#nav-reports').click();
  await expect(page.locator('#report-list')).toContainText('작성한 업무 요약이 없습니다');
  release();
  await expect(page.locator('#reports-view')).toBeVisible();
});

test('identical list queries reuse cache while refresh and changed conditions fetch data', async ({ page }) => {
  // Isolate navigation caching from the independently tested change stream.
  await page.route('**/api/updates', route => route.abort());
  const queries = [];
  await page.route('**/api/items?*', async route => {
    queries.push(new URL(route.request().url()).search);
    await route.continue();
  });
  await open(page);
  await expect(page.locator('#item-list')).toContainText('아직 기록된 업무가 없습니다');
  const originalCount = queries.length;
  await page.locator('#nav-items').click();
  await expect(page.locator('#item-list .list-skeleton')).toHaveCount(0);
  expect(queries.length).toBe(originalCount);
  await page.locator('#search').fill('캐시 검색');
  await expect.poll(() => queries.length).toBe(originalCount + 1);
  await expect(page.locator('#item-list')).toContainText('검색 결과가 없습니다');
  await page.locator('#search').fill('');
  await expect(page.locator('#item-list')).toContainText('아직 기록된 업무가 없습니다');
  expect(queries.length).toBe(originalCount + 1);
  await page.locator('#refresh').click();
  await expect.poll(() => queries.length).toBe(originalCount + 2);
});

test('new collected events invalidate cached work items', async ({ page }) => {
  await open(page);
  await expect(page.locator('#item-list')).toContainText('아직 기록된 업무가 없습니다');
  await h.ingest(pair('cache-event', '09:00:00', '09:05:00', 'first', { text: '캐시 갱신 확인 업무' }));
  await expect(page.locator('#item-list')).toContainText('캐시 갱신 확인 업무', { timeout: 10_000 });
});
