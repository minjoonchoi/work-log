import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, event, pair } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => h.close());
async function open(page, title) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  if (title) await page.getByRole('button', { name: title, exact: true }).click(); else await page.locator('.item-open').click();
}
const records = (agent, count) => Array.from({ length: count }, (_, n) => pair(agent, '09:00:00', '09:01:00', `t${n}`,
  { text: `기록 ${n} — 시스템 훅으로 수집한 원문입니다.\n각 입력과 출력은 별도 레코드로 보존합니다.`, source: 'system_hook' })).flat();

test('scroll loads older I/O pages; multi-page live catch-up preserves the reading position and every stored record', async ({ page }) => {
  await h.ingest(records('infinite', 61));
  const requests = []; page.on('request', req => { if (req.url().includes('/history?')) requests.push(req.url()); });
  await open(page); await expect(page.locator('.event')).toHaveCount(0);
  expect(requests).toHaveLength(0);
  const session = page.locator('.session-card'); await session.locator(':scope > summary').click();
  await expect(session.locator('.event')).toHaveCount(0); expect(requests).toHaveLength(0);
  await session.locator('.raw-history > summary').click();
  await expect(session.locator('.event')).toHaveCount(40);
  await expect(session.locator('.event').first()).toContainText('기록 60');
  await expect(session.locator('.event').first()).toContainText('Stop');
  expect(requests).toHaveLength(1);
  await expect(session.locator('.event pre:visible')).toHaveCount(0);
  const anchor = session.locator('.event').nth(10), anchorId = await anchor.getAttribute('data-event-id');
  await anchor.locator(':scope > summary').click();
  await expect(anchor.locator('pre')).toBeVisible();
  await anchor.evaluate(el => { window.__expandedRecord = el; el.scrollIntoView({ block: 'start' }); });
  const before = await anchor.evaluate(el => el.getBoundingClientRect().top);
  const additions = Array.from({ length: 21 }, (_, n) => pair('infinite', '09:02:00', '09:03:00', `new${n}`,
    { text: `새 기록 ${n}`, source: 'system_hook' })).flat();
  await h.ingest([...additions, event('infinite', 'output', '09:00:00', 't0', { text: '늦게 수집된 응답', source: 'system_hook' })]);
  await expect(session.locator('.event')).toHaveCount(82);
  await expect(session.locator('.event')).not.toContainText(['늦게 수집된 응답']);
  const preserved = page.locator(`[data-event-id="${anchorId}"]`);
  await expect(preserved).toHaveAttribute('open', '');
  expect(await preserved.evaluate(el => el === window.__expandedRecord)).toBe(true);
  await expect(session.locator('.event[open]')).toHaveCount(1);
  expect(Math.abs(await preserved.evaluate(el => el.getBoundingClientRect().top) - before)).toBeLessThan(3);
  await expect(session.locator('.event').first()).toContainText('새 기록 20');
  for (const count of [123, 163, 165]) {
    await session.locator('.history-more').scrollIntoViewIfNeeded();
    await expect(session.locator('.event')).toHaveCount(count);
  }
  await expect(session).toContainText('모든 기록을 불러왔습니다.');
  const ids = await session.locator('.event').evaluateAll(nodes => nodes.map(n => n.dataset.eventId));
  expect(new Set(ids).size).toBe(165);
  const times = await session.locator('.event time').evaluateAll(nodes => nodes.map(n => n.dateTime));
  expect(times).toEqual([...times].sort().reverse());
  await expect(session.locator('.event pre').filter({ hasText: '늦게 수집된 응답' })).toHaveCount(1);
  await preserved.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: 'output/screenshots/session-single-record-expanded.png' });
  await session.locator('.raw-history > summary').evaluate(el => el.scrollIntoView({ block: 'start' }));
  fs.mkdirSync('output/screenshots', { recursive: true });
  await page.screenshot({ path: 'output/screenshots/session-infinite-history.png' });
});

test('failed older-page load retains records and supports an explicit retry without duplicate rows', async ({ page }) => {
  await h.ingest(records('retry-pages', 45));
  let fail = true;
  await page.route('**/api/items/*/history?**', async route => {
    if (new URL(route.request().url()).searchParams.has('cursor') && fail) { fail = false; await route.fulfill({ status: 503, json: { error: '일시적인 조회 실패' } }); }
    else await route.continue();
  });
  await open(page); await page.locator('.session-card > summary').click(); await page.locator('.raw-history > summary').click();
  await expect(page.locator('.event')).toHaveCount(40);
  await page.locator('.history-more').scrollIntoViewIfNeeded();
  await expect(page.locator('.history-page-status')).toContainText('일시적인 조회 실패');
  await expect(page.locator('.event')).toHaveCount(40);
  await page.getByRole('button', { name: '이력 다시 불러오기', exact: true }).click();
  await expect(page.locator('.event')).toHaveCount(80);
  await page.locator('.history-more').scrollIntoViewIfNeeded(); await expect(page.locator('.event')).toHaveCount(90);
  expect(new Set(await page.locator('.event').evaluateAll(nodes => nodes.map(n => n.dataset.eventId))).size).toBe(90);
});

test('raw hook I/O stays independent of a new task type, tool events and internal worker output', async ({ page }) => {
  await h.ingest(pair('generic-results', '09:00:00', '09:05:00', 'one', { text: '작업 원문 <script>bad()</script>', source: 'system_hook' }));
  const item = (await h.manager('/items'))[0];
  const run = { id: 'generic-task-result', task: 'research.future-format', status: 'completed', engine: 'future-engine',
    created_at: '2026-09-17T09:00:00.000Z', updated_at: '2026-09-17T09:05:00.000Z',
    origin: { engine: 'codex', agent_session_id: 'generic-results', turn_id: 'one' } };
  await h.ingest([event('generic-results', 'tool.finished', '09:01:00', 'one', { text: '도구 반환값' }),
    event('generic-results', 'run.updated', '09:05:00', 'one', { run, work_item_id: item.id }),
    event('worker-result', 'output', '09:05:00', 'one', { role: 'worker', text: '{"arbitrary":"result data"}',
      parent: { ...run.origin, run_id: run.id, work_item_id: item.id } })]);
  const diagnostics = []; page.on('request', req => { if (req.url().endsWith(`/runs/${run.id}/events`)) diagnostics.push(req.url()); });
  await open(page); await page.locator('.session-card > summary').click(); await page.locator('.raw-history > summary').click();
  await expect(page.locator('.event')).toHaveCount(2); await expect(page.locator('.event script')).toHaveCount(0);
  await expect(page.locator('.conversation-history')).not.toContainText('도구 반환값');
  await expect(page.locator('.conversation-history')).not.toContainText('result data');
  await expect(page.locator('.session-result')).toBeHidden(); expect(diagnostics).toHaveLength(0);
  await page.locator('.session-card').evaluate(el => { const panel = document.querySelector('#detail'); panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 28; });
  fs.mkdirSync('output/screenshots', { recursive: true });
  await page.screenshot({ path: 'output/screenshots/session-record-history.png' });
  await page.setViewportSize({ width: 900, height: 800 });
  expect(await page.locator('#detail').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'output/screenshots/session-record-history-compact.png' });
  await page.locator('.session-results > summary').click();
  await expect(page.locator('.session-result')).toContainText('research.future-format');
  await expect(page.locator('.session-result')).toContainText('작업이 완료되었습니다.');
  await expect(page.getByRole('button', { name: '산출물 보기' })).toHaveCount(0);
  await page.getByRole('button', { name: '실행 상세', exact: true }).click();
  expect(diagnostics).toHaveLength(1);
  await page.locator('.execution-event > summary').click();
  await expect(page.getByRole('dialog')).toContainText('{"arbitrary":"result data"}');
});

test('a late Stop that splits a session removes moved records from an already open history', async ({ page }) => {
  await h.ingest([event('resplit-ui', 'input', '09:00:00', 'first', { text: '세션 경계 갱신' }),
    ...pair('resplit-ui', '09:30:00', '09:31:00', 'second', { text: '다음 세션의 대화' })]);
  await open(page); const firstId = await page.locator('.session-card').getAttribute('data-session-id');
  await page.locator('.session-card > summary').click(); await page.locator('.raw-history > summary').click(); await expect(page.locator('.event')).toHaveCount(3);
  await h.ingest([event('resplit-ui', 'output', '09:05:00', 'first', { text: '늦게 도착한 첫 응답' })]);
  await expect(page.locator('.session-card')).toHaveCount(2);
  const original = page.locator(`[data-session-id="${firstId}"]`);
  await expect(original.locator('.event pre')).toHaveText(['늦게 도착한 첫 응답', '세션 경계 갱신']);
  await expect(original).toHaveAttribute('open', '');
  await page.locator('.session-card').first().locator(':scope > summary').click(); await page.locator('.session-card').first().locator('.raw-history > summary').click();
  await expect(page.locator('.session-card').first().locator('.event')).toHaveCount(2);
});

test('switching work items while a history request is delayed ignores the old response', async ({ page }) => {
  await h.ingest([...pair('switch-a', '09:00:00', '09:01:00', 'one', { text: '이전 업무' }),
    ...pair('switch-b', '09:00:00', '09:01:00', 'one', { text: '다른 업무' })]);
  const item = (await h.manager('/items')).find(i => i.title === '이전 업무');
  let release, arrived;
  const hold = new Promise(resolve => release = resolve), waiting = new Promise(resolve => arrived = resolve);
  await page.route(`**/api/items/${item.id}/history?**`, async route => {
    const response = await route.fetch(); arrived(); await hold;
    await route.fulfill({ response }).catch(() => {});
  });
  await open(page, '이전 업무'); await page.locator('.session-card > summary').click(); await page.locator('.raw-history > summary').click(); await waiting;
  await page.getByRole('button', { name: '다른 업무', exact: true }).click(); await page.locator('.session-card > summary').click(); await page.locator('.raw-history > summary').click();
  await expect(page.locator('.event pre')).toHaveText(['다른 업무', '다른 업무']);
  release(); await expect(page.locator('.event')).toHaveCount(2);
  await expect(page.locator('.conversation-history')).not.toContainText('이전 업무');
});

test('unresolved output is fetched only after opening its raw group and each record remains collapsed until selected', async ({ page }) => {
  await h.ingest([event('orphan-ui', 'output', '09:05:00', 'late', { text: '<img src=x onerror=alert(1)> 연결 전 원문' })]);
  const requests = []; page.on('request', req => { if (req.url().includes('/history?')) requests.push(req.url()); });
  await open(page);
  const group = page.locator('[data-raw-history-key="unlinked"]');
  await expect(page.getByRole('heading', { name: '연결 미확인 출력 1건' })).toBeVisible();
  await expect(group).not.toHaveAttribute('open', '');
  await expect(group.locator('.event')).toHaveCount(0); expect(requests).toHaveLength(0);
  await group.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  await expect(group.locator('.event')).toHaveCount(1);
  const record = group.locator('.event');
  await expect(record.locator('pre')).toBeHidden();
  await expect(record.locator('summary')).toContainText('응답 출력 · 연결 미확인');
  await expect(record.locator('summary')).not.toContainText('연결 전 원문');
  await record.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(record.locator('pre')).toBeVisible();
  await expect(record.locator('pre')).toHaveText('<img src=x onerror=alert(1)> 연결 전 원문');
  await expect(group.locator('img')).toHaveCount(0);
  const recordId = await record.getAttribute('data-event-id');
  await group.locator(':scope > summary').click();
  const before = requests.length;
  await h.ingest([event('orphan-ui', 'output', '09:06:00', 'other', { text: '나중에 도착한 연결 미확인 출력' })]);
  await expect(group.locator(':scope > summary')).toHaveText('원문 이력 2개');
  await expect(group).not.toHaveAttribute('open', ''); expect(requests).toHaveLength(before);
  await group.locator(':scope > summary').click();
  await expect(group.locator('.event')).toHaveCount(2);
  await expect(group.locator(`[data-event-id="${recordId}"]`)).toHaveAttribute('open', '');
  await expect(group.locator('.event').first()).not.toHaveAttribute('open', '');
});
