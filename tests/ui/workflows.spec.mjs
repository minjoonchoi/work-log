import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, event, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = await new Harness().start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => { await h.close(); });
async function open(page) { await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`); await expect(page.getByRole('heading', { name: '업무 목록', exact: true })).toBeVisible(); }
async function calendar(page, mode = 'sessions', view = 'month') {
  await page.getByRole('button', { name: '캘린더', exact: true }).click();
  await page.getByLabel('캘린더 날짜').fill('2026-09-17'); await page.getByLabel('캘린더 날짜').blur();
  await page.getByLabel('캘린더 표시 단위').selectOption(mode);
  await page.locator(`[data-view=${view}]`).click();
}
function sample(agent, name, start = '09:00:00', end = '09:30:00', turn = 't1') {
  return pair(agent, `2026-09-17T${start}+09:00`, `2026-09-17T${end}+09:00`, turn, { text: name });
}
test('failed local checks expose observed outcomes and a report remains distinct from test success', async ({ page }) => {
  const checked = await h.finish(await h.run({ task: 'checks.run', prompt: 'E2E 검사 실행', input: { profile: 'fixture.mixed' } }));
  expect(checked.status).toBe('failed');
  const items = await eventually(() => h.manager('/items'), rows => rows[0]?.notification_count === 1);
  await open(page); await page.locator('.item-open').click();
  await page.locator('.session-card > summary').click();
  await page.locator('.session-results > summary').click();
  await page.getByRole('button', { name: '검사 결과 보기', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.run')).toHaveCount(3);
  await expect(dialog.locator('.run').nth(1)).toContainText('실패');
  await expect(dialog.locator('.run').nth(1)).toContainText('종료 코드: 7');
  await page.screenshot({ path: 'output/playwright/check-evidence.png', fullPage: true });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  const rendered = await h.finish(await h.run({ task: 'verification.report', prompt: '검사 근거 보고서', work_item_id: items[0].id, input: { run_ids: [checked.id] } }));
  expect(rendered.status).toBe('completed');
  await eventually(() => h.manager(`/items/${items[0].id}`), detail => detail.runs.length === 2);
  await page.reload(); await page.locator('.item-open').click();
  await page.locator('.session-card').filter({ has: page.locator('[data-artifact]') }).locator(':scope > summary').click();
  await page.locator('.session-results').filter({ has: page.locator('[data-artifact]') }).locator(':scope > summary').click();
  await page.getByRole('button', { name: '산출물 보기', exact: true }).click();
  await expect(dialog).toContainText('실행 근거 보고서 · 검사별 판정을 확인하세요');
  await expect(dialog).toContainText('검사 판정: **failed**');
});
test('GUI list → multi-select → choose representative → merge → session history → search alias', async ({ page }) => {
  await h.ingest([...sample('design', '권한 관리 PRD'), ...sample('backend', '권한 관리 엔티티')]);
  const items = await h.manager('/items'), before = (await Promise.all(items.map(i => h.manager(`/items/${i.id}`)))).flatMap(d => d.sessions.map(s => s.id)).sort();
  await open(page);
  await page.getByRole('checkbox', { name: '권한 관리 PRD 선택' }).check();
  await page.getByRole('checkbox', { name: '권한 관리 엔티티 선택' }).check();
  await page.getByRole('button', { name: '선택한 업무 병합' }).click();
  await expect(page.getByRole('dialog')).toContainText('세션 2개');
  await page.getByLabel('대표 업무').selectOption({ label: '권한 관리 PRD' });
  await page.getByRole('button', { name: '하나로 병합', exact: true }).click();
  await expect(page.locator('.item-row')).toHaveCount(1); await expect(page.locator('.session-card')).toHaveCount(2);
  const after = await h.manager('/items'); expect((await h.manager(`/items/${after[0].id}`)).sessions.map(s => s.id).sort()).toEqual(before);
  await page.getByRole('button', { name: '상세 닫기' }).click();
  await page.getByLabel('업무 검색').fill('엔티티'); await expect(page.locator('.item-row')).toHaveCount(1);
  await page.screenshot({ path: 'output/playwright/merged-items.png', fullPage: true });
});
test('20-minute boundary is visible in detail with real prompt/output timestamps', async ({ page }) => {
  await h.ingest([...sample('a', '세션 경계 확인', '09:00:00', '09:05:00'), ...sample('a', '두 번째 요청', '09:25:00', '09:27:00', 't2')]);
  await open(page); await page.getByRole('button', { name: '세션 경계 확인', exact: true }).click();
  await expect(page.locator('.session-card')).toHaveCount(2);
  await page.locator('.session-card').first().locator('summary').click();
  await expect(page.locator('.session-card').first()).toContainText('프롬프트 입력');
  await expect(page.locator('.session-card').first()).toContainText('09:27');
  await expect(page.locator('.session-card').first().locator('.event').first()).toHaveAttribute('data-kind', 'output');
  await page.screenshot({ path: 'output/playwright/session-history.png', fullPage: true });
});
test('month/day/week overflow opens all hidden entries; count follows selected display unit', async ({ page }) => {
  for (let i = 0; i < 5; i++) await h.ingest(sample(`a${i}`, `캘린더 업무 ${i}`));
  await open(page); await calendar(page);
  const monthDay = page.locator('.month-day[data-date="2026-09-17"]');
  await expect(monthDay.locator('.calendar-event')).toHaveCount(2);
  await monthDay.getByRole('button', { name: '+3개 더보기', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.dialog-entry')).toHaveCount(5);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/calendar-month.png', fullPage: true });
  for (const view of ['day', 'week']) {
    await page.locator(`[data-view=${view}]`).click();
    const day = page.locator('.time-day[data-date="2026-09-17"]');
    await day.getByRole('button', { name: '+3개 더보기', exact: true }).click();
    await expect(page.getByRole('dialog').locator('.dialog-entry')).toHaveCount(5);
    await page.getByRole('button', { name: '닫기', exact: true }).click();
  }
  await page.screenshot({ path: 'output/playwright/calendar-week.png', fullPage: true });
  const items = await h.manager('/items'); await h.manager('/merge', { method: 'POST', body: { ids: items.map(i => i.id), target: items[0].id, operation_id: 'ui-merge' } });
  await page.locator('[data-view=month]').click(); await page.getByLabel('캘린더 표시 단위').selectOption('items');
  await expect(monthDay.locator('.calendar-event')).toHaveCount(1); await expect(monthDay.locator('.more')).toHaveCount(0);
  await page.getByLabel('캘린더 표시 단위').selectOption('sessions'); await expect(monthDay.locator('.more')).toHaveText('+3개 더보기');
});
test('timed overflow lists the entire date including sessions outside the overlapping cluster', async ({ page }) => {
  for (let i = 0; i < 3; i++) await h.ingest(sample(`overlap-${i}`, `오전 업무 ${i}`));
  await h.ingest(sample('afternoon', '오후 별도 작업', '14:00:00', '14:30:00'));
  await h.ingest(pair('other-day', '2026-09-18T09:00:00+09:00', '2026-09-18T09:30:00+09:00', 't1', { text: '다음 날 작업' }));
  await open(page); await calendar(page, 'sessions', 'day');
  for (const view of ['day', 'week']) {
    await page.locator(`[data-view=${view}]`).click();
    await page.locator('.time-header').getByRole('button', { name: '세션 4개 더보기', exact: true }).click();
    await expect(page.getByRole('dialog').locator('.dialog-entry')).toHaveCount(4);
    await expect(page.getByRole('dialog')).toContainText('오후 별도 작업');
    await expect(page.getByRole('dialog')).not.toContainText('다음 날 작업');
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.locator('.time-day[data-date="2026-09-17"] .time-more').click();
    await expect(page.getByRole('dialog').locator('.dialog-entry')).toHaveCount(4);
    await page.getByRole('button', { name: '닫기', exact: true }).click();
  }
  await page.locator('.time-header').getByRole('button', { name: '세션 4개 더보기', exact: true }).click();
  await page.screenshot({ path: 'output/screenshots/calendar-day-sessions-modal.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: /오후 별도 작업/ }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.work-item-title')).toHaveText('오후 별도 작업');
  await expect(page.locator('.session-card')).toHaveAttribute('open', '');
});
test('cross-midnight clips one session into both calendar days, without creating a second session', async ({ page }) => {
  await h.ingest(pair('night', '2026-09-17T23:50:00+09:00', '2026-09-18T00:10:00+09:00', 'night', { text: '야간 작업' }));
  await open(page); await calendar(page);
  const first = page.locator('.month-day[data-date="2026-09-17"] .calendar-event');
  const next = page.locator('.month-day[data-date="2026-09-18"] .calendar-event');
  await expect(first).toHaveCount(1); await expect(next).toHaveCount(1);
  expect(await first.getAttribute('data-event')).toBe(await next.getAttribute('data-event'));
  await next.click(); await expect(page.locator('.session-card')).toHaveCount(1);
});
test('titles are rendered as text; manual edit persists after new input and service restart', async ({ page }) => {
  await h.ingest(sample('a', '<img src=x onerror=alert(1)> 기획'));
  await open(page); await expect(page.locator('.item-row img')).toHaveCount(0);
  await page.locator('.item-open').click(); await page.getByRole('button', { name: '제목·설명 편집' }).click();
  await page.getByLabel('제목', { exact: true }).fill('사용자가 정한 제목'); await page.getByLabel('설명', { exact: true }).fill('직접 편집한 설명');
  await page.getByRole('button', { name: '저장', exact: true }).click(); await expect(page.getByRole('heading', { name: '사용자가 정한 제목' })).toBeVisible();
  await h.ingest(sample('a', '새 요청', '10:00:00', '10:10:00', 't2'));
  await h.stop('manager'); await h.start('manager');
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await expect(page.getByRole('button', { name: '사용자가 정한 제목', exact: true })).toBeVisible();
});
test('GUI cancel reaches execution layer; closing GUI page does not interrupt another workload', async ({ page, context }) => {
  const run = await h.run({ fixture: { scenario: 'slow' } });
  await eventually(() => h.manager('/items'), rows => rows[0]?.state === 'running');
  await open(page); await page.locator('.item-open').click();
  await page.locator('.session-card > summary').click();
  await page.locator('.session-results > summary').click();
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page.locator('.run')).toContainText('취소됨');
  expect((await h.runtime(`/runs/${run.id}`)).status).toBe('cancelled');
  await page.close(); const other = await h.run(); const complete = await h.finish(other); expect(complete.status).toBe('completed');
  const reopened = await context.newPage(); await reopened.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await expect(reopened.locator('.item-row')).toHaveCount(2);
});
test('verified artifact is opened through work item; changed file is rejected', async ({ page }) => {
  const run = await h.finish(await h.run()); await eventually(() => h.manager('/items'), rows => rows[0]?.state === 'completed');
  await open(page); await page.locator('.item-open').click(); await page.locator('.session-card > summary').click();
  await page.locator('.session-results > summary').click(); await page.getByRole('button', { name: '산출물 보기', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('prd.md'); await expect(page.locator('.artifact-text')).toContainText('수용 기준');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  fs.appendFileSync(run.artifact.file, '\n외부 변경'); await page.getByRole('button', { name: '산출물 보기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('검증 후 산출물이 변경');
});
test('keyboard navigation reaches hidden calendar entries and selects an item', async ({ page }) => {
  for (let i = 0; i < 4; i++) await h.ingest(sample(`keyboard${i}`, `키보드 작업 ${i}`));
  await open(page); await calendar(page);
  const more = page.locator('.month-day[data-date="2026-09-17"] .more'); await more.focus();
  // A concurrent snapshot of the same calendar must preserve keyboard focus.
  await page.locator('#calendar-date').evaluate(el => el.onchange({ target: el }));
  await expect(more).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').locator('.dialog-entry').last().focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#detail')).toBeVisible();
});
for (const engine of ['codex', 'claude']) test(`${engine} system hooks stream new prompt/output into the open session, newest first without duplicates`, async ({ page }) => {
  await open(page);
  const raw = { session_id: `live-${engine}`, turn_id: 'turn-1' };
  h.hook(engine, { ...raw, event_id: 'input-1', hook_event_name: 'UserPromptSubmit', prompt: '실시간 세션 확인' });
  await expect(page.getByRole('button', { name: '실시간 세션 확인', exact: true })).toBeVisible({ timeout: 3000 });
  await page.getByRole('button', { name: '실시간 세션 확인', exact: true }).click();
  const session = page.locator('.session-card');
  await session.locator('summary').click();
  await expect(page.locator('#history-live')).toHaveText('실시간 갱신 중');
  await expect(session).toContainText('응답 대기');
  h.hook(engine, { ...raw, event_id: 'output-1', hook_event_name: 'Stop', last_assistant_message: '첫 번째 응답 원문' });
  await expect(session.locator('.event pre')).toHaveText(['첫 번째 응답 원문', '실시간 세션 확인'], { timeout: 3000 });
  await expect(session).not.toContainText('응답 대기');
  h.hook(engine, { ...raw, turn_id: 'turn-2', event_id: 'input-2', hook_event_name: 'UserPromptSubmit', prompt: '두 번째 프롬프트 원문' });
  const output = { ...raw, turn_id: 'turn-2', event_id: 'output-2', hook_event_name: 'Stop', last_assistant_message: '두 번째 응답 원문' };
  h.hook(engine, output);
  await expect(session.locator('.event pre')).toHaveText(['두 번째 응답 원문', '두 번째 프롬프트 원문', '첫 번째 응답 원문', '실시간 세션 확인'], { timeout: 3000 });
  await expect(session).toHaveAttribute('open', '');
  const times = await session.locator('time').evaluateAll(nodes => nodes.map(n => n.dateTime));
  expect(times).toEqual([...times].sort().reverse());
  h.hook(engine, output);
  await eventually(() => fs.readdirSync(path.join(h.dir, 'spool')).length, count => count === 0);
  await expect(session.locator('.event')).toHaveCount(4);
  await page.screenshot({ path: `output/playwright/live-session-${engine}.png`, fullPage: true });
});
test('late hook delivery is placed by observed time, not ingestion time; open edit fields survive live refresh', async ({ page }) => {
  await h.ingest([
    event('late', 'input', '2026-09-17T09:00:00+09:00', 'first', { text: '지연 도착 확인' }),
    event('late', 'output', '2026-09-17T09:10:00+09:00', 'first', { text: '09:10 응답' })
  ]);
  await open(page); await page.locator('.item-open').click();
  await page.locator('.session-card summary').click();
  await page.getByRole('button', { name: '제목·설명 편집' }).click();
  await page.getByLabel('제목', { exact: true }).fill('작성 중인 제목');
  await h.ingest([
    event('late', 'input', '2026-09-17T09:05:00+09:00', 'second', { text: '09:05 입력' }),
    event('late', 'output', '2026-09-17T09:07:00+09:00', 'second', { text: '09:07 응답' })
  ]);
  await expect(page.locator('.session-card .event pre')).toHaveText(['09:10 응답', '09:07 응답', '09:05 입력', '지연 도착 확인'], { timeout: 3000 });
  await expect(page.getByLabel('제목', { exact: true })).toHaveValue('작성 중인 제목');
  await expect(page.getByLabel('제목', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.locator('.session-card')).toHaveAttribute('open', '');
});
test('open session reconnects after manager restart and catches up on spooled hooks without a page reload', async ({ page }) => {
  await h.ingest(pair('recover', new Date(Date.now() - 60000).toISOString(), new Date(Date.now() - 30000).toISOString(), 'before', { text: '연결 복구 확인' }));
  await open(page); await page.locator('.item-open').click();
  await page.locator('.session-card summary').click();
  await expect(page.locator('.event')).toHaveCount(2);
  await expect(page.locator('#history-live')).toHaveText('실시간 갱신 중');
  const originalSession = await page.locator('.session-card').getAttribute('data-session-id');
  const port = readEndpoint(h.dir, 'manager').port;
  await page.evaluate(() => window.__reloadSentinel = 'same-page');
  await h.stop('manager');
  await expect(page.locator('#history-live')).toContainText('재연결');
  h.hook('codex', { session_id: 'recover', turn_id: 'continued', event_id: 'resume-input', hook_event_name: 'UserPromptSubmit', prompt: '연결 중단 중 입력' });
  h.hook('codex', { session_id: 'recover', turn_id: 'continued', event_id: 'resume-output', hook_event_name: 'Stop', last_assistant_message: '연결 중단 중 응답' });
  h.env = { HARNESS_MANAGER_PORT: String(port) }; await h.start('manager');
  await expect(page.locator('#history-live')).toHaveText('실시간 갱신 중');
  await expect(page.locator('.session-card .event')).toHaveCount(4);
  const prior = page.locator(`[data-session-id="${originalSession}"]`);
  await expect(prior).toHaveAttribute('open', '');
  await expect(page.locator('.session-card').first()).toContainText('연결 중단 중 응답');
  expect(await page.evaluate(() => window.__reloadSentinel)).toBe('same-page');
});
test.describe('DST display', () => {
  test.use({ timezoneId: 'America/New_York' });
  test('repeated local hour retains two UTC windows and exposes distinct offsets', async ({ page }) => {
    await h.ingest([...pair('dst', '2026-11-01T05:10:00Z', '2026-11-01T05:20:00Z', 't1', { text: 'DST 작업' }),
      ...pair('dst', '2026-11-01T06:10:00Z', '2026-11-01T06:20:00Z', 't2', { text: 'DST 작업 계속' })]);
    await open(page); await page.getByRole('button', { name: '캘린더', exact: true }).click();
    await page.getByLabel('캘린더 날짜').fill('2026-11-01'); await page.getByLabel('캘린더 날짜').blur();
    const entries = page.locator('.month-day[data-date="2026-11-01"] .calendar-event');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toHaveAttribute('title', /GMT-4/); await expect(entries.nth(1)).toHaveAttribute('title', /GMT-5/);
    const [item] = await h.manager('/items'); expect((await h.manager(`/items/${item.id}`)).sessions).toHaveLength(2);
  });
});
