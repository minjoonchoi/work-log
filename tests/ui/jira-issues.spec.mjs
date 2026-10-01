import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize, adfText } from '../fixtures/atlassian.mjs';

let h, f, item;
test.beforeEach(async ({ context }) => {
  h = new Harness(); f = await atlFixture(h); await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => {
    window.__HARNESS_TOKEN__ = token;
    window.__EXTERNAL_URLS__ = [];
    window.webkit = { messageHandlers: { openExternal: { postMessage: url => window.__EXTERNAL_URLS__.push(url) } } };
  }, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
  await h.ingest(pair('jira-ui-issues', '09:00:00', '09:05:00', 'first', { text: '권한 관리 기능 기획과 API 설계' }));
  item = (await h.manager('/items'))[0];
});
test.afterEach(async () => { await h.close(); await f.close(); });
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.locator('.item-open').click();
}
test('key/URL lookup preview, explicit connection, real link and compact Sync card', async ({ page }) => {
  await authorize(h); const issue = f.addIssue({ summary: '승인 정책 및 권한 API 설계' }, 'TEAM-42');
  await open(page);
  await expect(page.getByRole('button', { name: '＋ 새 이슈 만들기' })).toBeVisible();
  await page.getByRole('button', { name: '기존 이슈 연결', exact: true }).click();
  const dialog = page.getByRole('dialog'), input = dialog.getByLabel('이슈 키 또는 제목');
  await input.fill('https://wrong.atlassian.net/browse/TEAM-42');
  await dialog.getByRole('button', { name: '검색', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('선택한 Jira 사이트');
  await input.fill('https://fixture.atlassian.net/browse/TEAM-42');
  await input.press('Enter');
  await expect(dialog.getByRole('radiogroup')).toContainText('승인 정책 및 권한 API 설계');
  await dialog.getByRole('radio', { name: 'TEAM-42 승인 정책 및 권한 API 설계' }).check();
  expect((await h.manager(`/items/${item.id}`)).jira_links).toHaveLength(0);
  fs.mkdirSync('output/screenshots', { recursive: true });
  await page.screenshot({ path: 'output/screenshots/jira-existing-issue-dialog.png' });
  // Editing the lookup invalidates the old preview; Enter performs a fresh read.
  await input.fill('team-42'); await expect(dialog.getByRole('button', { name: '이슈 연결', exact: true })).toBeDisabled();
  await input.press('Enter'); await dialog.getByRole('radio', { name: 'TEAM-42 승인 정책 및 권한 API 설계' }).check(); await dialog.getByRole('button', { name: '이슈 연결', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const link = page.getByRole('link', { name: 'TEAM-42 Jira에서 열기' });
  await expect(link).toHaveAttribute('href', 'https://fixture.atlassian.net/browse/TEAM-42');
  await link.focus(); await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__EXTERNAL_URLS__)).toEqual(['https://fixture.atlassian.net/browse/TEAM-42']);
  await expect(page.locator('#detail .jira-status')).toHaveText('해야 할 일');
  const card = page.locator('.jira-card');
  await expect(card.getByRole('button', { name: 'TEAM-42 업무 로그 Sync' })).toBeVisible();
  await expect(card.locator('button')).toHaveCount(1);
  await expect(card.locator('.jira-issue-title,select')).toHaveCount(0);
  expect(f.state.issues).toHaveLength(1); expect(issue.fields.summary).toBe('승인 정책 및 권한 API 설계');
  await page.setViewportSize({ width: 900, height: 760 });
  const bounds = await card.evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }));
  expect(bounds.content).toBeLessThanOrEqual(bounds.width);
});
