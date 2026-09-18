import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, event, pair } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = await new Harness().start('manager');
  await context.addInitScript(token => {
    window.__HARNESS_TOKEN__ = token; window.nativeRoutes = []; window.mainReady = false;
    window.webkit = { messageHandlers: {
      openWorkLog: { postMessage: route => window.nativeRoutes.push(route) },
      mainReady: { postMessage: () => window.mainReady = true }
    } };
  }, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => h.close());
const url = route => `http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}${route}`;
async function openQuick(page) { await page.setViewportSize({ width: 380, height: 600 }); await page.goto(url('/quick')); }
const navigate = (page, route) => page.evaluate(detail => window.dispatchEvent(new CustomEvent('harness:navigate', { detail })), route);

test('compact panel shows bounded groups and opens exact item or full-window destinations without writing data', async ({ page }) => {
  const events = [];
  for (let n = 0; n < 7; n++) events.push(event(`current-${n}`, 'input', '09:00:00', 't1', { text: `권한 관리 기능 설계 ${n}`, work_item_id: `c${n}` }));
  for (let n = 0; n < 6; n++) events.push(...pair(`recent-${n}`, '09:00:00', '09:05:00', 't1', { text: `완료한 업무 ${n}` }));
  await h.ingest(events);
  const writes = []; page.on('request', req => { if (req.method() !== 'GET') writes.push(req.url()); });
  await openQuick(page);
  await expect(page.locator('#current-count')).toHaveText('7');
  await expect(page.locator('[data-group=current] .quick-item')).toHaveCount(5);
  await expect(page.locator('[data-group=current]')).toContainText('+2개 더 보기');
  await expect(page.locator('[data-group=recent] .quick-item')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  expect(await page.locator('.quick-content').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.locator('[data-item=c0]').click();
  await page.locator('[data-group=current] .quick-more').click();
  for (const title of ['오늘 캘린더', '연결 설정', 'Work Log 전체 창 열기']) await page.getByRole('button', { name: title, exact: true }).click();
  expect(await page.evaluate(() => window.nativeRoutes)).toEqual([{ view: 'items', item_id: 'c0' }, { view: 'current' }, { view: 'calendar' }, { view: 'settings' }, { view: 'items' }]);
  expect(writes).toEqual([]);
});

test('input and Stop update the panel live; disconnected service keeps the last snapshot clearly marked until recovery', async ({ page }) => {
  await h.ingest([event('live', 'input', '09:00:00', 't1', { text: '실시간 업무', work_item_id: 'live' })]);
  await openQuick(page); await expect(page.locator('[data-group=current]')).toContainText('실시간 업무');
  await h.ingest([event('live', 'output', '09:02:00')]);
  await expect(page.locator('#current-count')).toHaveText('0');
  await expect(page.locator('[data-group=recent]')).toContainText('실시간 업무');
  await page.route('**/api/quick', route => route.abort());
  await h.ingest([event('live', 'input', '09:03:00', 't2')]);
  await expect(page.locator('#quick-health')).toContainText('연결 끊김');
  await expect(page.locator('[data-group=recent]')).toContainText('실시간 업무');
  await expect(page.locator('body')).toHaveAttribute('data-stale', 'true');
  await page.unroute('**/api/quick');
  await h.ingest([event('live', 'tool.started', '09:04:00', 't2')]);
  await expect(page.locator('#current-count')).toHaveText('1');
  await expect(page.locator('body')).toHaveAttribute('data-stale', 'false');
});

test('a hidden native panel stops snapshot requests, then catches up when reopened', async ({ page }) => {
  await page.addInitScript(() => window.__HARNESS_QUICK_VISIBLE__ = false);
  const requests = []; page.on('request', req => { if (req.url().endsWith('/api/quick')) requests.push(req.url()); });
  await openQuick(page); await expect(page.locator('#current-count')).toHaveText('—');
  expect(requests).toHaveLength(0);
  await h.ingest([event('hidden', 'input', '09:00:00', 't1', { text: '숨겨진 동안의 요청' })]);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('harness:quick-visibility', { detail: true })));
  await expect(page.locator('#current-count')).toHaveText('1');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('harness:quick-visibility', { detail: false })));
  const before = requests.length;
  await h.ingest([event('hidden', 'output', '09:02:00')]);
  await page.clock.install(); await page.clock.fastForward(5000);
  expect(requests).toHaveLength(before); await expect(page.locator('#current-count')).toHaveText('1');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('harness:quick-visibility', { detail: true })));
  await expect(page.locator('#current-count')).toHaveText('0');
});

test('native item route waits for main readiness, clears old search/detail and opens current work, today and settings', async ({ page }) => {
  await h.ingest([event('pending', 'input', '09:00:00', 't1', { text: '진행할 업무', work_item_id: 'current' }),
    ...pair('previous', '09:00:00', '09:05:00', 't1', { text: '이전 업무', work_item_id: 'previous' })]);
  await page.goto(url('/')); await expect.poll(() => page.evaluate(() => window.mainReady)).toBe(true);
  await page.locator('#search').fill('이전'); await expect(page.locator('.item-open')).toHaveCount(1);
  await navigate(page, { view: 'items', item_id: 'current' });
  await expect(page.locator('#detail h2').first()).toHaveText('진행할 업무');
  await expect(page.locator('#search')).toHaveValue('');
  await navigate(page, { view: 'current' });
  await expect(page.locator('#detail')).toBeHidden();
  await expect(page.locator('.item-open')).toHaveText(['진행할 업무']);
  await navigate(page, { view: 'calendar' });
  await page.locator('#calendar-date').fill('2026-01-01'); await page.locator('#calendar-date').dispatchEvent('change');
  await navigate(page, { view: 'calendar' });
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await expect(page.locator('#calendar-date')).toHaveValue(today);
  await navigate(page, { view: 'settings' }); await expect(page.getByRole('dialog')).toBeVisible();
});

test('empty, interrupted-runtime and long untrusted titles remain readable in the fixed panel', async ({ page }) => {
  await openQuick(page); await expect(page.locator('#current-count')).toHaveText('0');
  await expect(page.locator('[data-group=recent]')).toContainText('에이전트에서 작업하면');
  await h.ingest([...pair('preview', '09:00:00', '09:05:00', 't1', { text: '권한 관리 기능의 PRD와 화면 흐름 검토', work_item_id: 'preview' }),
    event('preview', 'run.updated', '09:06:00', 't1', { work_item_id: 'preview', run: { id: 'preview-run', task: 'prd.create', status: 'running' } }),
    event('waiting', 'input', '09:07:00', 't1', { text: 'HTML 목업 — 검색과 저장 동작 확인' }),
    ...pair('done', '08:10:00', '08:20:00', 't1', { text: '주간 진행 보고 정리' }),
    ...pair('blocked', '08:30:00', '08:40:00', 't1', { text: '엔티티 관계 설계', work_item_id: 'blocked' }),
    event('blocked', 'run.updated', '08:40:00', 't1', { work_item_id: 'blocked', run: { id: 'blocked-run', status: 'blocked' } })]);
  await expect(page.locator('[data-item=preview]')).toContainText('실행 상태 미확인');
  fs.mkdirSync('output/screenshots', { recursive: true });
  await page.screenshot({ path: 'output/screenshots/menu-bar-quick-panel.png' });
  const item = (await h.manager('/items')).find(i => i.id === 'preview');
  await h.manager('/items/preview', { method: 'PATCH', body: { version: item.version, title: '<img src=x onerror=alert(1)> ' + '긴 제목 '.repeat(30), description: '' } });
  await expect(page.locator('[data-item=preview]')).toContainText('<img');
  await expect(page.locator('.quick-item img')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const title = page.locator('[data-item=preview] .quick-item-title');
  expect(await title.evaluate(el => el.clientHeight <= parseFloat(getComputedStyle(el).lineHeight) * 2 + 1)).toBe(true);
});
