import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, event, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { managerStore } from '../../src/manager-store.mjs';
import { integrationStore } from '../../src/integration-store.mjs';
import { atlFixture, authorize, createIssue, adfText } from '../fixtures/atlassian.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); h.env = { HARNESS_TEST_WRITING_FIXTURE: JSON.stringify({ delayMs: 350 }) };
  await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => { await h.close(); });
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.locator('.item-open').click();
}

test('GUI rewrites an active session, then item metadata, and can repeat both while keeping original I/O', async ({ page }) => {
  await h.ingest(pair('writing-ui', '09:00:00', '09:05:00', 'first', { text: '권한 관리의 요구사항과 수용 조건을 정리했습니다.' }));
  const item = (await h.manager('/items'))[0];
  await open(page); const session = page.locator('.session-card');
  await expect(session).not.toHaveAttribute('open', '');
  const summaryButton = session.locator('[data-rewrite-summary]');
  await expect(summaryButton).toHaveText('요약하기');
  await summaryButton.focus(); await summaryButton.press('Enter'); await expect(summaryButton).toBeDisabled();
  await expect(summaryButton).toHaveAttribute('aria-busy', 'true');
  await expect(session.locator('.session-summary-title')).toContainText('수용 조건', { timeout: 15000 });
  await expect(session).not.toHaveAttribute('open', '');
  await expect(summaryButton).toHaveText('재요약');
  await expect(summaryButton).toBeEnabled();
  await page.screenshot({ path: 'output/screenshots/session-collapsed-summary.png', fullPage: true });
  await session.locator('summary').click();
  await expect(session.locator('.summary-text')).toContainText('수용 조건');
  await expect(session.locator('.summary-text ul li')).toHaveCount(2);
  expect((await session.locator('.summary-text li').allTextContents()).every(text => !text.startsWith('- '))).toBe(true);
  await expect(session.locator('.writing-status')).toContainText('작성 완료');
  await expect(session).toHaveAttribute('open', '');
  await expect(session.locator('.event')).toHaveCount(2);
  await expect(session.locator('.event').first()).toHaveAttribute('data-kind', 'output');
  const first = (await h.manager(`/items/${item.id}`)).sessions[0].rewrite;
  await summaryButton.click(); await expect(summaryButton).toBeDisabled();
  await expect(session.locator('.summary-text')).toBeVisible();
  await expect(summaryButton).toBeEnabled({ timeout: 15000 });
  const second = (await h.manager(`/items/${item.id}`)).sessions[0].rewrite;
  expect(first.run_id).not.toBe(second.run_id);
  const metadata = page.getByRole('group', { name: '제목·설명 작업', exact: true }).getByRole('button', { name: '제목·설명 다시 작성', exact: true });
  await metadata.click(); await expect(metadata).toBeDisabled();
  await expect(page.locator('.metadata-writing .writing-status')).toContainText('작성 완료', { timeout: 15000 });
  await expect(page.locator('#detail')).toContainText('1개 세션 이력');
  await metadata.click(); await expect(metadata).toBeDisabled();
  await expect(metadata).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('.item-row')).toHaveCount(1); await expect(page.locator('.session-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '연결 미확인 출력', exact: true })).toHaveCount(0);
  const detail = await h.manager(`/items/${item.id}`);
  expect(detail.runs.every(r => r.internal && r.task === 'text.rewrite')).toBe(true);
  await expect(page.locator('#toast')).toBeHidden();
  await page.locator('#detail').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: 'output/screenshots/on-demand-writing.png', fullPage: true });
  await page.screenshot({ path: 'output/screenshots/writing-controls-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 900, height: 900 });
  expect(await page.locator('#detail').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const selector of ['.metadata-writing', '.session-summary']) {
    expect(await page.locator(selector).evaluate(el => {
      const bounds = el.getBoundingClientRect();
      return [...el.querySelectorAll('button')].every(button => {
        const rect = button.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right;
      });
    })).toBe(true);
  }
  await page.screenshot({ path: 'output/screenshots/writing-controls-compact.png', fullPage: true });
});

test('legacy paragraph summaries become at most five readable bullets without altering source text or Jira worklogs', async ({ page }) => {
  await h.stop('manager');
  const f = await atlFixture(h);
  await h.start('manager');
  try {
    await authorize(h);
    await h.ingest(pair('legacy-summary-ui', '09:00:00', '09:05:00', 'first', { text: '기존 단락 요약 확인' }));
    const item = (await h.manager('/items'))[0]; await createIssue(h, item);
    // Simulate an already accepted summary from the previous release; new generation requires bullets.
    await h.stop('manager');
    const store = managerStore(h.dir), integrations = integrationStore(store);
    const [snapshot] = integrations.sessionSnapshots();
    integrations.ensureSummary(snapshot);
    integrations.finishSummary(snapshot, 'completed', { text: '기존 단락 요약 확인\n버전 1.2.3과 비율 3.14를 확인했습니다. 자료는 https://example.test/docs/v1.2?rate=3.14 입니다. Dr. Smith reviewed the API. 요구사항을 정리했습니다. 화면 흐름을 확인했습니다. <img src=x onerror=alert(1)>를 기록했습니다. 다음 검토가 남아 있습니다.' });
    store.db.close(); await h.start('manager');
    await h.ingest(pair('legacy-summary-ui', '09:25:00', '09:26:00', 'next'));
    const before = await eventually(() => h.manager(`/items/${item.id}`), data => data.sessions[0]?.worklog?.state === 'synced', 15000);
    const original = before.sessions[0].summary.text, originalLog = adfText(f.state.worklogs[0].comment);
    const writes = f.state.calls.filter(call => ['POST', 'PUT'].includes(call.method)).length;
    await open(page);
    const session = page.locator('.session-card').filter({ has: page.locator(`[data-rewrite-summary="${before.sessions[0].id}"]`) });
    await session.locator('summary').click();
    const bullets = session.locator('.summary-text ul li');
    await expect(bullets).toHaveCount(5);
    await expect(bullets.nth(0)).toHaveText('버전 1.2.3과 비율 3.14를 확인했습니다.');
    await expect(bullets.nth(1)).toHaveText('자료는 https://example.test/docs/v1.2?rate=3.14 입니다.');
    await expect(bullets.nth(2)).toHaveText('Dr. Smith reviewed the API.');
    await expect(bullets.nth(4)).toContainText('화면 흐름을 확인했습니다.');
    await expect(bullets.nth(4)).toContainText('다음 검토가 남아 있습니다.');
    await expect(session.locator('.summary-text img')).toHaveCount(0);
    expect((await bullets.allTextContents()).join(' ')).toBe(original.split('\n').slice(1).join(' '));
    expect((await h.manager(`/items/${item.id}`)).sessions[0].summary.text).toBe(original);
    expect(adfText(f.state.worklogs[0].comment)).toBe(originalLog);
    expect(f.state.calls.filter(call => ['POST', 'PUT'].includes(call.method)).length).toBe(writes);
    await session.locator('.session-summary').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/screenshots/session-summary-list.png', fullPage: true });
  } finally { await f.close(); }
});

test('editing metadata during regeneration preserves saved edits and reports stale result live', async ({ page }) => {
  await h.ingest(pair('editing-ui', '09:00:00', '09:05:00'));
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = JSON.stringify({ delayMs: 1400 }); await h.start('manager');
  const item = (await h.manager('/items'))[0]; await open(page);
  await page.getByRole('button', { name: '제목·설명 다시 작성', exact: true }).click();
  await eventually(() => h.manager(`/items/${item.id}`), d => d.metadata_rewrite?.state === 'running');
  const edit = page.getByRole('group', { name: '제목·설명 작업', exact: true }).getByRole('button', { name: '제목·설명 편집', exact: true });
  await edit.focus(); await edit.press('Enter');
  await page.getByLabel('제목', { exact: true }).fill('사용자가 확정한 업무명');
  await page.getByLabel('설명', { exact: true }).fill('생성 중에 직접 수정한 설명');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#detail h2')).toHaveText('사용자가 확정한 업무명');
  await expect(page.locator('.metadata-writing .writing-status')).toContainText('결과를 반영하지 않았습니다', { timeout: 15000 });
  await expect(page.locator('#detail')).toContainText('생성 중에 직접 수정한 설명');
  await expect(page.getByRole('button', { name: '제목·설명 다시 작성', exact: true })).toBeEnabled();
});

test('failed session rewrite keeps the last accepted summary and offers a fresh retry', async ({ page }) => {
  await h.ingest(pair('retry-ui', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0], sessionId = (await h.manager(`/items/${item.id}`)).sessions[0].id;
  await open(page); const session = page.locator(`.session-card[data-session-id="${sessionId}"]`); await session.locator('summary').click();
  const button = session.locator('[data-rewrite-summary]');
  await button.click(); await expect(session.locator('.summary-text')).toBeVisible({ timeout: 15000 });
  const accepted = await session.locator('.summary-text').innerText();
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = JSON.stringify({ scenario: 'rewrite-six-lines' }); await h.start('manager');
  await open(page); await session.locator('summary').click(); await button.click();
  await expect(session.locator('.writing-status')).toContainText('작성 실패', { timeout: 15000 });
  await expect(session.locator('.summary-text')).toHaveText(accepted, { useInnerText: true });
  await expect(button).toBeEnabled();
  await h.ingest([event('concurrent-ui', 'input', '09:10:00', 'next', { work_item_id: item.id, text: '다른 에이전트에서 동일 업무를 계속합니다.' })]);
  await page.getByRole('button', { name: '알림', exact: true }).click();
  await expect(page.locator('.notification-row')).toHaveCount(1);
  await expect(page.locator('.notification-row')).toContainText('요약');
  const quick = await page.context().newPage();
  await quick.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}/quick`);
  await expect(quick.locator('#notification-count')).toHaveText('1');
  await expect(quick.locator('#current-count')).toHaveText('1');
  await expect(quick.locator('[data-group=notifications] .quick-notification')).toHaveCount(1);
  await quick.close();
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = JSON.stringify({ rewriteVariant: true }); await h.start('manager');
  await open(page); await session.locator('summary').click(); await button.click();
  await expect(session.locator('.summary-text')).toContainText('작업 기록', { timeout: 15000 });
  await expect(session.locator('.writing-status')).toContainText('작성 완료');
  await page.getByRole('button', { name: '알림', exact: true }).click();
  await expect(page.locator('.notification-row')).toHaveCount(0);
});
