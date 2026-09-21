import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, event, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize, createIssue } from '../fixtures/atlassian.mjs';

let h, f;
test.beforeEach(async ({ context }) => {
  h = new Harness(); f = null; await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => {
    window.__HARNESS_TOKEN__ = token; window.nativeRoutes = [];
    window.webkit = { messageHandlers: { openWorkLog: { postMessage: route => window.nativeRoutes.push(route) } } };
  }, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => { await h.close(); await f?.close(); });
const post = body => ({ method: 'POST', body });
const url = route => `http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}${route}`;
const noticeRow = (page, notice) => page.locator(`.notification-row[data-notification-id="${notice.id}"]`);
const notices = () => h.manager('/notifications');
async function openNotifications(page) {
  await page.goto(url('/')); await page.getByRole('button', { name: '알림', exact: true }).click();
  await expect(page.locator('#notifications-view')).toBeVisible();
}
async function failedRun() {
  await h.ingest(pair('notification-run', '09:00:00', '09:05:00', 'request', { text: '실패 원인을 확인할 PRD 작업', source: 'system_hook' }));
  const item = (await h.manager('/items'))[0];
  const run = await h.finish(await h.run({ work_item_id: item.id, fixture: { scenario: 'crash' },
    origin: { engine: 'codex', agent_session_id: 'notification-run', turn_id: 'request' } }));
  expect(run.status).toBe('failed');
  const list = await eventually(notices, rows => rows.some(row => row.run_id === run.id));
  return { item, run, notice: list.find(row => row.run_id === run.id) };
}

test('failed workload notification opens its exact execution; dismissal persists without erasing failure/history and a new failure resurfaces', async ({ page }) => {
  const { item, run, notice } = await failedRun(), before = await h.manager(`/items/${item.id}`);
  const originalIO = before.events.filter(event => event.role === 'user' && ['input', 'output'].includes(event.kind));
  await openNotifications(page); const row = noticeRow(page, notice);
  await expect(row).toContainText(item.title); await expect(row).toContainText(notice.title); await expect(row).toContainText(notice.message);
  await expect(row.locator('time')).toHaveAttribute('datetime', notice.occurred_at);
  await row.locator('[data-open-notification]').click();
  const targetRun = page.locator(`.run[data-run-id="${run.id}"]`);
  await expect(targetRun).toBeVisible(); await expect(targetRun.getByRole('button', { name: '다시 실행', exact: true })).toBeVisible();
  await targetRun.getByRole('button', { name: '실행 상세', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading', { name: '실행 상세', exact: true })).toBeVisible();
  await expect(dialog).toContainText(run.id); await expect(dialog).toContainText(run.message);
  await expect(page.locator('.work-item-title')).toHaveText(item.title);
  await expect(page.locator('.session-card[open]')).toHaveAttribute('data-session-id', before.runs.find(record => record.id === run.id).session_id);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '상세 닫기' }).click();
  await row.getByRole('button', { name: '알림 지우기', exact: true }).click(); await expect(page.locator('.notification-row')).toHaveCount(0);
  expect((await h.runtime(`/runs/${run.id}`)).status).toBe('failed');
  expect((await h.manager(`/items/${item.id}`)).events.filter(event => event.role === 'user' && ['input', 'output'].includes(event.kind))).toEqual(originalIO);
  await h.stop('manager'); await h.start('manager'); await openNotifications(page);
  await expect(page.locator('.notification-row')).toHaveCount(0); expect(await notices()).toEqual([]);
  await h.runtime(`/runs/${run.id}/resume`, post({})); await h.finish(run);
  const again = (await eventually(notices, rows => rows.some(row => row.run_id === run.id && row.revision !== notice.revision))).find(row => row.run_id === run.id);
  await expect(noticeRow(page, again)).toBeVisible();
  expect((await h.runtime(`/runs/${run.id}`)).status).toBe('failed');
});

test('native question tools stay raw hook evidence and never create notification or GUI answer controls', async ({ page }) => {
  for (const [engine, name] of [['claude', 'AskUserQuestion'], ['codex', 'request_user_input'], ['codex', 'request_user_input_async']]) {
    const base = { session_id: `native-${name}`, turn_id: 'native-turn' };
    h.hook(engine, { ...base, hook_event_name: 'UserPromptSubmit', prompt: `원본 ${name} 대화` });
    h.hook(engine, { ...base, hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: `call-${name}`,
      tool_input: { questions: [{ id: 'choice', question: '원본 에이전트에서 답변할 질문', header: '선택' }] } });
  }
  const items = await eventually(() => h.manager('/items'), rows => rows.length === 3);
  expect(items.every(item => item.activity === 'agent_response_pending')).toBe(true); expect(await notices()).toEqual([]);
  await openNotifications(page); await expect(page.locator('.notification-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '사용자 답변 필요', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '확인이 필요한 작업', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '업무 목록', exact: true }).click(); await page.locator('.item-open').first().click();
  await expect(page.locator('.user-questions, .question-text')).toHaveCount(0);
  await page.locator('.session-card > summary').click(); await expect(page.locator('.event')).toHaveCount(1);
  await expect(page.locator('.session-card > summary')).toContainText('에이전트 응답 대기');
  const all = await Promise.all(items.map(item => h.manager(`/items/${item.id}`)));
  expect(all.flatMap(item => item.events).filter(event => event.kind === 'tool.started')).toHaveLength(3);
  expect(all.flatMap(item => item.events).filter(event => event.kind === 'output')).toHaveLength(0);
  await page.setViewportSize({ width: 380, height: 600 }); await page.goto(url('/quick'));
  await expect(page.locator('#notification-count')).toHaveText('0'); await expect(page.locator('#current-count')).toHaveText('3');
  await expect(page.locator('[data-group=waiting], [data-group=attention]')).toHaveCount(0);
});

test('menu-bar notifications show the actual failure and route to the same notification in the full window', async ({ page }) => {
  const { item, notice } = await failedRun(); await page.setViewportSize({ width: 380, height: 600 }); await page.goto(url('/quick'));
  await expect(page.locator('#notification-count')).toHaveText('1');
  const row = page.locator(`.quick-notification[data-notification="${notice.id}"]`);
  await expect(row).toContainText(item.title); await expect(row).toContainText(notice.message);
  await expect(row.locator('.quick-notification-action')).toHaveText(notice.action_label);
  await row.click(); await page.locator('[data-view=notifications]').first().click();
  expect(await page.evaluate(() => window.nativeRoutes)).toEqual([{ view: 'notifications', notification_id: notice.id }, { view: 'notifications' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(url('/'));
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent('harness:navigate', { detail })), { view: 'notifications', notification_id: notice.id });
  await expect(page.locator(`.run[data-run-id="${notice.run_id}"]`)).toBeVisible();
});

test('Jira worklog failure and unknown delivery each open the exact session; resolved synchronization clears their notifications', async ({ page }) => {
  await h.stop('manager'); f = await atlFixture(h); await h.start('manager'); await authorize(h);
  await h.ingest(pair('notification-worklog', '09:00:00', '09:05:00', 'first', { text: 'Jira 업무 로그를 동기화합니다.' }));
  const item = (await h.manager('/items'))[0]; await createIssue(h, item); f.state.worklogFailure = 403;
  await h.ingest(pair('notification-worklog', '09:25:00', '09:26:00', 'second'));
  const first = (await eventually(notices, rows => rows.some(row => row.kind === 'jira_worklog'), 20000)).find(row => row.kind === 'jira_worklog');
  await openNotifications(page); await expect(noticeRow(page, first)).toContainText(first.message);
  await noticeRow(page, first).locator('[data-open-notification]').click();
  const session = page.locator(`.session-card[data-session-id="${first.session_id}"]`);
  await expect(session).toHaveAttribute('open', ''); await expect(session).toContainText('동기화 다시 시도');
  f.state.worklogFailure = null; await session.getByRole('button', { name: '동기화 다시 시도', exact: true }).click();
  await eventually(() => h.manager(`/items/${item.id}`), data => data.sessions.find(record => record.id === first.session_id)?.worklog?.state === 'synced', 15000);
  await eventually(notices, rows => !rows.some(row => row.id === first.id), 15000);
  await expect(page.locator('.notification-row')).toHaveCount(0); expect(f.state.worklogs).toHaveLength(1);
  await page.getByRole('button', { name: '상세 닫기' }).click();
  f.state.worklogFailure = 503; await h.ingest(pair('notification-worklog', '09:46:00', '09:47:00', 'third'));
  const current = await eventually(() => h.manager(`/items/${item.id}`), data => data.sessions.some(session => session.worklog?.state === 'unknown' && session.worklog.message.includes('불명확')), 20000);
  const unknownSession = current.sessions.find(session => session.worklog?.state === 'unknown');
  const unknown = (await notices()).find(row => row.kind === 'jira_worklog' && row.session_id === unknownSession.id);
  expect(unknown).toBeTruthy(); await expect(noticeRow(page, unknown)).toContainText(unknown.message);
  await noticeRow(page, unknown).locator('[data-open-notification]').click();
  const unknownCard = page.locator(`.session-card[data-session-id="${unknownSession.id}"]`);
  await expect(unknownCard).toHaveAttribute('open', '');
  const sent = f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/worklog'));
  const matching = sent.find(call => call.body.properties[0].value.session_id === unknownSession.id);
  expect(matching).toBeTruthy();
  // Simulate Jira later confirming the unacknowledged operation, then reconcile through the real REST fixture.
  f.state.worklogs.push({ ...matching.body, id: '901', issueId: f.state.issues[0].id }); f.state.worklogFailure = null;
  await unknownCard.getByRole('button', { name: '전송 결과 다시 확인', exact: true }).click();
  await eventually(() => h.manager(`/items/${item.id}`), data => data.sessions.find(record => record.id === unknownSession.id)?.worklog?.state === 'synced', 15000);
  await eventually(notices, rows => !rows.some(row => row.id === unknown.id), 15000);
  await expect(page.locator('.notification-row')).toHaveCount(0);
  expect(f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/worklog'))).toHaveLength(sent.length);
});

test('a retired session worklog notification opens its original Jira card and preserves the published worklog evidence', async ({ page }) => {
  await h.stop('manager'); f = await atlFixture(h); await h.start('manager'); await authorize(h);
  await h.ingest(pair('retired-worklog', '09:00:00', '09:05:00', 'first', { text: '권한 관리 기능의 Jira 업무 로그를 정리합니다.' }));
  const item = (await h.manager('/items'))[0]; await createIssue(h, item, 'retired-session-jira');
  await h.ingest(pair('retired-worklog', '09:25:00', '09:26:00', 'second'));
  await eventually(() => h.manager(`/items/${item.id}`), data => data.sessions.some(session => session.worklog?.state === 'synced'), 15000);
  await h.ingest(pair('retired-worklog', '09:46:00', '09:47:00', 'third'));
  const before = await eventually(() => h.manager(`/items/${item.id}`), data => data.sessions.filter(session => session.worklog?.state === 'synced').length === 2, 15000);
  const retired = before.sessions.find(session => session.start_at === '2026-09-17T09:25:00.000Z');
  expect(retired?.worklog?.state).toBe('synced');
  const published = structuredClone(f.state.worklogs);

  // A second linked issue makes the navigation assertion distinguish the original card from a generic Jira fallback.
  await h.ingest(pair('other-jira-card', '10:00:00', '10:05:00', 'other', { text: '별도 화면 설계 이슈' }));
  const other = (await h.manager('/items')).find(row => row.id !== item.id);
  await createIssue(h, other, 'unrelated-session-jira');
  await h.manager('/merge', post({ ids: [item.id, other.id], target: item.id, operation_id: 'merge-notification-card-fixture' }));
  await h.ingest([event('retired-worklog', 'output', '09:10:00', 'first', { text: '경계를 바꾸는 늦은 출력' })]);
  const notice = (await eventually(notices, rows => rows.some(row => row.kind === 'jira_worklog' && row.session_id === retired.id), 15000))
    .find(row => row.kind === 'jira_worklog' && row.session_id === retired.id);
  expect(notice.link_operation_id).toBe('retired-session-jira');
  expect((await h.manager(`/items/${item.id}`)).sessions.some(session => session.id === retired.id)).toBe(false);

  await openNotifications(page); await expect(noticeRow(page, notice)).toContainText('늦게 수집된 이력으로 세션 경계가 변경되었습니다.');
  await expect(page.locator('.notification-row')).toHaveCount(2);
  fs.mkdirSync(path.resolve('output/playwright'), { recursive: true });
  await page.screenshot({ path: path.resolve('output/playwright/notifications-main.png'), fullPage: true });
  await noticeRow(page, notice).locator('[data-open-notification]').click();
  await expect(page.locator('.jira-card')).toHaveCount(2);
  await expect(page.locator('[data-jira-card="retired-session-jira"]')).toBeFocused();
  await expect(page.locator(`.session-card[data-session-id="${retired.id}"]`)).toHaveCount(0);
  await expect(page.locator('.jira-section .sync-message').filter({ hasText: retired.id })).toContainText('기존 Jira 업무 로그를 확인하세요.');
  expect(f.state.worklogs).toEqual(published);
  expect(f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/worklog'))).toHaveLength(2);
});
