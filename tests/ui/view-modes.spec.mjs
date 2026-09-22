import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); h.env = { HARNESS_TEST_WRITING_FIXTURE: JSON.stringify({ rewriteVariant: true }) };
  await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => { await h.close(); });
const post = body => ({ method: 'POST', body });
function sample(agent, input, start = '09:00:00', end = '09:05:00', turn = 'one', output = input) {
  const events = pair(agent, `2026-09-17T${start}+09:00`, `2026-09-17T${end}+09:00`, turn, { text: input });
  events[1].text = output; return events;
}
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await expect(page.getByRole('heading', { name: '업무 목록', exact: true })).toBeVisible();
}
async function summarize(item, session, operation = 'view-mode-summary') {
  await h.manager(`/sessions/${session.id}/summary/regenerate`, post({ operation_id: operation }));
  return eventually(() => h.manager(`/items/${item.id}`), detail => detail.sessions.find(row => row.id === session.id)?.summary?.state === 'completed', 15000);
}
async function calendar(page, mode = 'sessions', view = 'month') {
  await page.getByRole('button', { name: '캘린더', exact: true }).click();
  await page.getByLabel('캘린더 날짜').fill('2026-09-17'); await page.getByLabel('캘린더 날짜').blur();
  await page.getByLabel('캘린더 표시 단위').selectOption(mode);
  await page.locator(`[data-view="${view}"]`).click();
}

test('one item with a 20-minute split becomes two ordered session rows; summary, search and exact detail follow the selected unit', async ({ page }) => {
  await h.ingest([...sample('split', '최초 요구 정리', '09:00:00', '09:05:00', 'one', '독립검색어 검증 완료'),
    ...sample('split', '두 번째 세션 입력', '09:25:00', '09:27:00', 'two')]);
  const item = (await h.manager('/items'))[0], detail = await h.manager(`/items/${item.id}`);
  const sessions = [...detail.sessions].sort((a, b) => a.start_at.localeCompare(b.start_at)), older = sessions[0], newer = sessions[1];
  const summarized = await summarize(item, older), summaryTitle = summarized.sessions.find(row => row.id === older.id).summary.text.split('\n')[0];
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: summarized.item.version, title: '통합 업무 대표', description: '연속 작업 묶음' } });
  await open(page);
  await expect(page.getByLabel('목록 표시 단위')).toHaveValue('items'); await expect(page.locator('.item-row')).toHaveCount(1);
  await page.getByRole('checkbox', { name: '통합 업무 대표 선택' }).check();
  await page.getByLabel('목록 표시 단위').selectOption('sessions');
  const rows = page.locator('.session-row'); await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-session-id', newer.id); await expect(rows.nth(1)).toHaveAttribute('data-session-id', older.id);
  await expect(rows.nth(0).locator('.session-open')).toHaveText('두 번째 세션 입력');
  await expect(rows.nth(1).locator('.session-open')).toHaveText(summaryTitle);
  await expect(rows.nth(1)).toContainText('통합 업무 대표');
  await expect(page.getByRole('button', { name: '선택한 업무 병합' })).toBeHidden(); await expect(page.locator('#item-list input[type=checkbox]')).toHaveCount(0);
  await page.getByLabel('세션 검색').fill('독립검색어'); await expect(rows).toHaveCount(1); await expect(rows).toHaveAttribute('data-session-id', older.id);
  await page.getByLabel('세션 검색').fill('통합 업무 대표'); await expect(rows).toHaveCount(2);
  await page.getByLabel('세션 검색').fill(''); await rows.nth(1).locator('.session-open').click();
  await expect(page.locator('.work-item-title')).toHaveText('통합 업무 대표');
  await expect(page.locator('.session-card[open]')).toHaveCount(1); await expect(page.locator('.session-card[open]')).toHaveAttribute('data-session-id', older.id);
  await page.locator('.session-card[open] .raw-history > summary').click();
  await expect(page.locator('.session-card[open] .event')).toHaveCount(2);
  for (const record of await page.locator('.session-card[open] .event > summary').all()) await record.click();
  await expect(page.locator('.session-card[open] .event pre')).toHaveText(['독립검색어 검증 완료', '최초 요구 정리']);
  await page.getByRole('button', { name: '상세 닫기' }).click(); await page.getByLabel('목록 표시 단위').selectOption('items');
  await expect(page.getByRole('checkbox', { name: '통합 업무 대표 선택' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: '선택한 업무 병합' })).toBeDisabled();
});

test('merged agent sessions retain their own titles and open the exact session under the canonical work item', async ({ page }) => {
  await h.ingest([...sample('design-agent', '화면 정책 검토', '09:00:00', '09:05:00'),
    ...sample('api-agent', '회원 계약 설계', '10:00:00', '10:05:00')]);
  const items = await h.manager('/items'), target = items.find(item => item.title === '화면 정책 검토');
  const allSessions = (await Promise.all(items.map(item => h.manager(`/items/${item.id}`)))).flatMap(detail => detail.sessions);
  await h.manager('/merge', post({ ids: items.map(item => item.id), target: target.id, operation_id: 'merge-session-list-owners' }));
  const merged = (await h.manager(`/items/${target.id}`)).item;
  await h.manager(`/items/${target.id}`, { method: 'PATCH', body: { version: merged.version, title: '공통 회원 기능', description: '두 에이전트의 작업' } });
  await open(page); await page.getByLabel('목록 표시 단위').selectOption('sessions');
  await expect(page.locator('.session-row')).toHaveCount(2);
  expect(await page.locator('.session-row').evaluateAll(rows => rows.map(row => row.dataset.itemId))).toEqual([target.id, target.id]);
  await expect(page.locator('.session-open')).toHaveText(['회원 계약 설계', '화면 정책 검토']);
  for (const session of allSessions) {
    const row = page.locator(`.session-row[data-session-id="${session.id}"]`);
    await expect(row).toContainText('공통 회원 기능'); await row.locator('.session-open').click();
    await expect(page.locator('.session-card[open]')).toHaveAttribute('data-session-id', session.id);
    await expect(page.locator('.work-item-title')).toHaveText('공통 회원 기능');
    await page.getByRole('button', { name: '상세 닫기' }).click();
  }
});

test('list and calendar unit preferences persist independently; special work queues hide the selector and restore normal list mode', async ({ page }) => {
  await h.ingest(sample('preferences', '보기 설정 확인'));
  await open(page); await expect(page.getByLabel('목록 표시 단위')).toHaveValue('items');
  for (const selector of ['#list-mode', '#calendar-mode']) {
    await expect(page.locator(`${selector} option[value=items]`)).toHaveText('업무별 보기');
    await expect(page.locator(`${selector} option[value=sessions]`)).toHaveText('세션별 보기');
  }
  await page.getByRole('button', { name: '캘린더', exact: true }).click(); await expect(page.getByLabel('캘린더 표시 단위')).toHaveValue('sessions');
  await page.getByLabel('캘린더 표시 단위').selectOption('items');
  await page.getByRole('button', { name: '업무 목록', exact: true }).click(); await expect(page.getByLabel('목록 표시 단위')).toHaveValue('items');
  await page.getByLabel('목록 표시 단위').selectOption('sessions'); await page.reload();
  await expect(page.getByLabel('목록 표시 단위')).toHaveValue('sessions'); await expect(page.locator('.session-row')).toHaveCount(1);
  await page.getByRole('button', { name: '캘린더', exact: true }).click(); await expect(page.getByLabel('캘린더 표시 단위')).toHaveValue('items');
  expect(await page.evaluate(() => [localStorage.getItem('worklog.list-mode'), localStorage.getItem('worklog.calendar-mode')])).toEqual(['sessions', 'items']);
  for (const [view, heading] of [['notifications', '알림'], ['current', '현재 작업']]) {
    await page.evaluate(view => window.dispatchEvent(new CustomEvent('harness:navigate', { detail: { view } })), view);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByLabel('목록 표시 단위')).toBeHidden();
    if (view === 'current') {
      await expect(page.getByLabel('업무 검색')).toBeVisible(); await expect(page.locator('.session-row')).toHaveCount(0);
    } else await expect(page.locator('#items-view')).toBeHidden();
    await page.getByRole('button', { name: '업무 목록', exact: true }).click();
    await expect(page.getByLabel('목록 표시 단위')).toHaveValue('sessions'); await expect(page.locator('.session-row')).toHaveCount(1);
  }
});

test('calendar day, week and month count merged work and individual sessions separately and expose all overflow entries', async ({ page }) => {
  for (let index = 0; index < 5; index++) await h.ingest(sample(`calendar-unit-${index}`, `독립 세션 ${index}`, '09:00:00', '09:30:00'));
  const items = await h.manager('/items'), target = items[0];
  await h.manager('/merge', post({ ids: items.map(item => item.id), target: target.id, operation_id: 'merge-calendar-units' }));
  await open(page); await calendar(page);
  for (const view of ['month', 'day', 'week']) {
    await page.locator(`[data-view="${view}"]`).click(); await page.getByLabel('캘린더 표시 단위').selectOption('sessions');
    const day = page.locator(`${view === 'month' ? '.month-day' : '.time-day'}[data-date="2026-09-17"]`);
    await expect(day.locator('.calendar-event')).toHaveCount(2);
    if (view === 'month') await day.getByRole('button', { name: '+3개 더보기', exact: true }).click();
    else await page.locator('.time-header').getByRole('button', { name: '세션 5개 더보기', exact: true }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog.locator('.dialog-entry')).toHaveCount(5);
    for (let index = 0; index < 5; index++) await expect(dialog).toContainText(`독립 세션 ${index}`);
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByLabel('캘린더 표시 단위').selectOption('items');
    await expect(day.locator('.calendar-event')).toHaveCount(1); await expect(day.locator('.more')).toHaveCount(0);
    await expect(page.locator('.time-header .day-more')).toHaveCount(0);
    await expect(day.locator('.calendar-event')).toHaveAttribute('aria-label', new RegExp('세션 5개$'));
  }
});

test('ongoing conversation, a new twenty-minute window and a generated summary update the session list live', async ({ page }) => {
  await h.ingest(sample('live-units', '진행 중 대화', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0];
  await open(page); await page.getByLabel('목록 표시 단위').selectOption('sessions'); await expect(page.locator('.session-row')).toHaveCount(1);
  const first = (await h.manager(`/items/${item.id}`)).sessions[0];
  await h.ingest(sample('live-units', '이어지는 대화', '09:20:00', '09:25:00', 'two'));
  await expect(page.locator('.session-row')).toHaveCount(1); await expect(page.locator('.session-row')).toContainText('09:25');
  await h.ingest(sample('live-units', '새 작업 구간', '09:45:00', '09:47:00', 'three'));
  await expect(page.locator('.session-row')).toHaveCount(2); await expect(page.locator('.session-open').first()).toHaveText('새 작업 구간');
  const latest = (await h.manager(`/items/${item.id}`)).sessions.find(session => session.id !== first.id);
  const summarized = await summarize(item, latest, 'live-view-mode-summary');
  const title = summarized.sessions.find(session => session.id === latest.id).summary.text.split('\n')[0];
  await expect(page.locator('.session-open').first()).toHaveText(title);
  await expect(page.locator('.session-row').first()).toHaveAttribute('data-session-id', latest.id);
});

test('a late session search response cannot replace a newer search result', async ({ page }) => {
  await h.ingest([...sample('old-query', '이전 검색 대상'), ...sample('new-query', '새 검색 대상')]);
  await open(page); await page.getByLabel('목록 표시 단위').selectOption('sessions'); await expect(page.locator('.session-row')).toHaveCount(2);
  let release, arrived, returned;
  const hold = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }), completed = new Promise(resolve => { returned = resolve; });
  await page.route('**/api/sessions?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') !== '이전') return route.continue();
    const response = await route.fetch(); arrived(); await hold;
    await route.fulfill({ response }).catch(() => {}); returned();
  });
  try {
    await page.getByLabel('세션 검색').fill('이전'); await waiting;
    await page.getByLabel('세션 검색').fill('새'); await expect(page.locator('.session-open')).toHaveText(['새 검색 대상']);
    release(); await completed; await expect(page.locator('.session-open')).toHaveText(['새 검색 대상']);
  } finally { release(); }
});

test('switching to item mode discards an already requested but delayed session list', async ({ page }) => {
  await h.ingest([...sample('delayed-a', '첫 업무'), ...sample('delayed-b', '두 번째 업무')]);
  await open(page);
  let release, arrived, returned;
  const hold = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }), completed = new Promise(resolve => { returned = resolve; });
  await page.route('**/api/sessions?**', async route => {
    const response = await route.fetch(); arrived(); await hold;
    await route.fulfill({ response }).catch(() => {}); returned();
  });
  try {
    await page.getByLabel('목록 표시 단위').selectOption('sessions'); await waiting;
    await page.getByLabel('목록 표시 단위').selectOption('items'); await expect(page.locator('.item-row')).toHaveCount(2);
    release(); await completed; await expect(page.locator('.session-row')).toHaveCount(0);
    await expect(page.locator('.item-row')).toHaveCount(2); await expect(page.getByLabel('목록 표시 단위')).toHaveValue('items');
  } finally { release(); }
});
