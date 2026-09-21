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
const local = value => new Date(`2026-09-${value}+09:00`);
const button = (page, view) => page.locator(`#calendar-view [data-view="${view}"]`);
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.getByRole('button', { name: '캘린더', exact: true }).click();
  await expect(page.locator('.month-grid')).toBeVisible();
}
async function chooseDate(page, value) {
  await page.locator('#calendar-date').fill(value); await page.locator('#calendar-date').dispatchEvent('change');
  await page.locator('#calendar-date').blur();
}
async function chosen(page, view) {
  for (const candidate of ['day', 'week', 'month']) await expect(button(page, candidate)).toHaveAttribute('aria-pressed', String(candidate === view));
}
async function installClock(page, target) {
  const pending = new Set();
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && !request.url().endsWith('/api/updates')) pending.add(request); });
  for (const name of ['requestfinished', 'requestfailed']) page.on(name, request => pending.delete(request));
  await page.clock.install({ time: new Date(target.getTime() - 60000) });
  await open(page); await page.clock.pauseAt(target);
  // Settle the existing five-second health refresh independently from the calendar clock.
  await page.clock.runFor(250);
  await expect.poll(() => pending.size).toBe(0);
  await expect(page.locator('#calendar-now')).toContainText('현재');
}

test('today is emphasized in month, week and day while past periods never show a misplaced current-time line', async ({ page }) => {
  await h.ingest([
    ...pair('today-review', '2026-09-19T11:15:00+09:00', '2026-09-19T12:00:00+09:00', 'review', { text: '권한 정책 검토' }),
    ...pair('today-design', '2026-09-19T15:00:00+09:00', '2026-09-19T15:45:00+09:00', 'design', { text: 'API 계약 정리' })
  ]);
  await page.clock.setFixedTime(local('19T13:07:00')); await open(page);
  await expect(page.locator('#calendar-now')).toHaveText('현재 9월 19일 (토) 13:07');
  const today = page.locator('.month-day[data-date="2026-09-19"]');
  await expect(today).toHaveClass(/is-today/); await expect(today.locator('[aria-current="date"]')).toHaveCount(1);
  await expect(page.locator('.weekday.is-today')).toHaveText('토');
  await expect(page.locator('.current-time-line')).toHaveCount(0);
  fs.mkdirSync('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/calendar-today-month.png', fullPage: true });
  for (const view of ['week', 'day']) {
    await button(page, view).click(); await chosen(page, view);
    await expect(page.locator('.time-day.is-today')).toHaveAttribute('data-date', '2026-09-19');
    await expect(page.locator('.time-header .is-today')).toContainText('토');
    const line = page.locator('.time-day[data-date="2026-09-19"] .current-time-line');
    await expect(line).toHaveCount(1); await expect(line).toContainText('13:07');
    expect(await line.evaluate(element => parseFloat(element.style.top))).toBe(13 * 60 + 7);
    await expect(line).toHaveAttribute('data-current-time', /.*/);
    await expect(page.locator('.current-time-line')).toHaveCount(1);
    if (view === 'week') await page.screenshot({ path: 'output/playwright/calendar-today-week.png', fullPage: true });
  }
  await chooseDate(page, '2026-08-03');
  for (const view of ['day', 'week', 'month']) {
    await button(page, view).click(); await chosen(page, view);
    await expect(page.locator('#calendar .is-today')).toHaveCount(0);
    await expect(page.locator('.current-time-line')).toHaveCount(0);
    await expect(page.locator('#calendar-now')).toHaveText('현재 9월 19일 (토) 13:07');
  }
});

test('minute and midnight ticks update current position without changing the selected date or scrolling the calendar', async ({ page }) => {
  await installClock(page, local('19T23:58:58'));
  await button(page, 'day').click();
  const scroll = page.locator('.time-calendar');
  await scroll.evaluate(element => { element.scrollTop = 610; element.dataset.clockIdentity = 'original'; });
  const requests = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/calendar') requests.push(request.url()); });
  await page.clock.runFor(2000);
  await expect(page.locator('#calendar-now')).toHaveText('현재 9월 19일 (토) 23:59');
  expect(await page.locator('.current-time-line').evaluate(element => parseFloat(element.style.top))).toBe(1439);
  await expect(scroll).toHaveAttribute('data-clock-identity', 'original');
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(610); expect(requests).toHaveLength(0);
  await page.clock.pauseAt(local('19T23:59:59')); await page.clock.runFor(2000);
  await expect(page.locator('#calendar-now')).toHaveText('현재 9월 20일 (일) 00:00');
  await expect(page.locator('#calendar-date')).toHaveValue('2026-09-19');
  await expect(page.locator('.current-time-line')).toHaveCount(0); await expect(page.locator('#calendar .is-today')).toHaveCount(0);
  await expect(scroll).toHaveAttribute('data-clock-identity', 'original'); expect(await scroll.evaluate(element => element.scrollTop)).toBe(610);
  await button(page, 'month').click();
  await expect(page.locator('.month-day.is-today')).toHaveAttribute('data-date', '2026-09-20');
  await expect(page.locator('.weekday.is-today')).toHaveText('일');
  await button(page, 'week').click(); await expect(page.locator('.current-time-line')).toHaveCount(0);
  await page.getByRole('button', { name: '오늘', exact: true }).click();
  await expect(page.locator('#calendar-date')).toHaveValue('2026-09-20');
  await expect(page.locator('.time-day.is-today')).toHaveAttribute('data-date', '2026-09-20');
  await expect(page.locator('.current-time-line')).toContainText('00:00');
});

test('D/W/M switch views while preserving the selected date and ignore editing, dialogs, modifiers and other pages', async ({ page }) => {
  await page.clock.setFixedTime(local('19T13:07:00')); await open(page); await chooseDate(page, '2026-09-17');
  for (const [key, view] of [['d', 'day'], ['w', 'week'], ['m', 'month']]) {
    await expect(button(page, view)).toHaveAttribute('aria-keyshortcuts', key);
    await page.keyboard.press(key); await chosen(page, view); await expect(page.locator('#calendar-date')).toHaveValue('2026-09-17');
  }
  await page.locator('#calendar-date').dispatchEvent('keydown', { key: 'd', bubbles: true }); await chosen(page, 'month');
  await page.locator('#calendar-mode').focus(); await page.keyboard.press('w'); await chosen(page, 'month');
  // Non-modal editable hosts also keep normal typing; this exercises the guard independently of dialog blocking.
  await page.evaluate(() => {
    for (const kind of ['textarea', 'div']) {
      const element = document.createElement(kind); element.id = `calendar-test-${kind}`;
      if (kind === 'div') element.contentEditable = 'true';
      document.querySelector('#calendar-view').append(element);
    }
  });
  await page.locator('#calendar-test-textarea').fill(''); await page.locator('#calendar-test-textarea').press('d');
  await expect(page.locator('#calendar-test-textarea')).toHaveValue('d'); await chosen(page, 'month');
  await page.locator('#calendar-test-div').focus(); await page.keyboard.press('w');
  await expect(page.locator('#calendar-test-div')).toHaveText('w'); await chosen(page, 'month');
  await page.evaluate(() => {
    document.querySelectorAll('[id^="calendar-test-"]').forEach(element => element.remove());
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }]) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true, ...options }));
    }
    const consumed = new KeyboardEvent('keydown', { key: 'w', bubbles: true, cancelable: true }); consumed.preventDefault(); document.body.dispatchEvent(consumed);
  });
  await chosen(page, 'month');
  await page.locator('#automation-settings').click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '닫기', exact: true }).focus(); await page.keyboard.press('d'); await chosen(page, 'month');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '업무 목록', exact: true }).click(); await page.keyboard.press('d');
  await expect(page.locator('#items-view')).toBeVisible(); await expect(page.locator('#calendar-view')).toBeHidden();
  await page.getByRole('button', { name: '캘린더', exact: true }).click(); await chosen(page, 'month');
});

test('live session updates preserve the timed calendar scroll instead of jumping back to the morning', async ({ page }) => {
  await page.clock.setFixedTime(local('19T13:07:00'));
  await h.ingest(pair('scroll-first', '2026-09-19T10:00:00+09:00', '2026-09-19T10:05:00+09:00', 'first', { text: '첫 캘린더 기록' }));
  await open(page); await button(page, 'day').click(); await expect(page.locator('.calendar-event')).toHaveCount(1);
  await page.locator('.time-calendar').evaluate(element => { element.scrollTop = 610; });
  await h.ingest(pair('scroll-second', '2026-09-19T14:00:00+09:00', '2026-09-19T14:05:00+09:00', 'second', { text: '나중에 수집된 캘린더 기록' }));
  await expect(page.locator('.calendar-event')).toHaveCount(2);
  expect(await page.locator('.time-calendar').evaluate(element => element.scrollTop)).toBe(610);
  await expect(page.locator('.time-day.is-today')).toHaveAttribute('data-date', '2026-09-19');
  await expect(page.locator('.current-time-line')).toContainText('13:07');
  await page.locator('.time-calendar').evaluate(element => { element.scrollTop = 25; element.dataset.focusIdentity = 'preserved'; });
  await page.getByRole('button', { name: '오늘', exact: true }).click();
  await expect(page.locator('.time-calendar')).toHaveAttribute('data-focus-identity', 'preserved');
  await expect.poll(() => page.locator('.time-calendar').evaluate(element => element.scrollTop)).toBeGreaterThan(300);
  const centered = await page.locator('.current-time-line').evaluate(line => {
    const scroller = line.closest('.time-calendar'), position = line.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
    return position.top > viewport.top && position.top < viewport.bottom;
  });
  expect(centered).toBe(true);
});

test('live updates retain focus on the correct date of a cross-midnight event and on a growing month overflow button', async ({ page }) => {
  await page.clock.setFixedTime(local('19T13:07:00'));
  await h.ingest(pair('focus-midnight', '2026-09-17T23:50:00+09:00', '2026-09-18T00:10:00+09:00', 'overnight', { text: '자정을 넘는 설계 검토' }));
  await open(page); await button(page, 'week').click();
  const firstDate = page.locator('.time-day[data-date="2026-09-17"] .calendar-event');
  const secondDate = page.locator('.time-day[data-date="2026-09-18"] .calendar-event');
  await expect(firstDate).toHaveCount(1); await expect(secondDate).toHaveCount(1);
  expect(await firstDate.getAttribute('data-event')).toBe(await secondDate.getAttribute('data-event'));
  await secondDate.focus(); await expect(secondDate).toBeFocused();
  await h.ingest(pair('focus-new-record', '2026-09-18T10:00:00+09:00', '2026-09-18T10:15:00+09:00', 'new', { text: '새로 수집된 별도 기록' }));
  await expect(page.locator('.calendar-event')).toHaveCount(3);
  await expect(page.locator('.time-day[data-date="2026-09-18"] .calendar-event').filter({ hasText: '자정을 넘는 설계 검토' })).toBeFocused();
  await expect(firstDate).not.toBeFocused();

  for (let index = 1; index <= 3; index++) {
    await h.ingest(pair(`focus-overflow-${index}`, '2026-09-19T09:00:00+09:00', '2026-09-19T09:10:00+09:00', 'same-day', { text: `오늘의 세션 ${index}` }));
  }
  await button(page, 'month').click();
  const today = page.locator('.month-day[data-date="2026-09-19"]');
  await expect(today.locator('.calendar-event')).toHaveCount(2);
  await today.getByRole('button', { name: '+1개 더보기', exact: true }).focus();
  await h.ingest(pair('focus-overflow-4', '2026-09-19T09:00:00+09:00', '2026-09-19T09:10:00+09:00', 'same-day', { text: '오늘의 세션 4' }));
  const more = today.getByRole('button', { name: '+2개 더보기', exact: true });
  await expect(more).toBeFocused(); await expect(today.locator('.calendar-event')).toHaveCount(2);
  await more.press('Enter');
  const dialog = page.getByRole('dialog'); await expect(dialog.locator('.dialog-entry')).toHaveCount(4);
  for (let index = 1; index <= 4; index++) await expect(dialog).toContainText(`오늘의 세션 ${index}`);
});

test.describe('local wall-clock position across daylight saving time', () => {
  test.use({ timezoneId: 'America/New_York' });
  test('current-time position follows local minutes through spring-forward and repeated fall-back hours', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-03-08T07:30:00Z')); await open(page); await button(page, 'day').click();
    await expect(page.locator('#timezone-label')).toHaveText('America/New_York');
    await expect(page.locator('#calendar-date')).toHaveValue('2026-03-08');
    await expect(page.locator('.current-time-line')).toContainText('03:30');
    expect(await page.locator('.current-time-line').evaluate(element => parseFloat(element.style.top))).toBe(210);
    await page.clock.setFixedTime(new Date('2026-11-01T05:30:00Z'));
    await page.getByRole('button', { name: '오늘', exact: true }).click();
    await expect(page.locator('#calendar-date')).toHaveValue('2026-11-01');
    expect(await page.locator('.current-time-line').evaluate(element => parseFloat(element.style.top))).toBe(90);
    await page.clock.setFixedTime(new Date('2026-11-01T06:30:00Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.current-time-line time')).toHaveAttribute('datetime', '2026-11-01T06:30:00.000Z');
    await expect(page.locator('.current-time-line')).toContainText('01:30');
    expect(await page.locator('.current-time-line').evaluate(element => parseFloat(element.style.top))).toBe(90);
  });
});
