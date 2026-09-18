import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize } from '../fixtures/atlassian.mjs';

let h, f, item;
test.beforeEach(async ({ context }) => {
  h = new Harness(); f = await atlFixture(h); await h.start('runtime'); await h.start('manager'); await authorize(h);
  await h.ingest(pair('search-work', '09:00:00', '09:05:00', 'first', { text: '권한 관리 기능 설계' })); item = (await h.manager('/items'))[0];
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => { await h.close(); await f.close(); });
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`); await page.locator('.item-open').click();
  await page.getByRole('button', { name: '기존 이슈 연결', exact: true }).click();
}

test('title search → compare key/title/status → more results → choose one existing issue', async ({ page }) => {
  f.state.searchPageSize = 2;
  const titles = ['권한 관리 요구사항 정리', '권한 관리 화면 설계', '권한 관리 API 설계', '권한 관리 예외 처리', '권한 관리 <img src=x onerror=alert(1)>'];
  const issues = titles.map(summary => f.addIssue({ summary })); f.setStatus(issues[1], 'progress'); f.setStatus(issues[2], 'done');
  await open(page); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('이슈 키 또는 제목').fill('권한 관리'); await dialog.getByRole('button', { name: '검색', exact: true }).click();
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: '이슈 연결', exact: true })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'TEAM-1 권한 관리 요구사항 정리', exact: true }).check();
  await dialog.getByRole('button', { name: '더 보기', exact: true }).click();
  await expect(dialog.getByRole('radio')).toHaveCount(4);
  await expect(dialog.getByRole('radio').first()).toBeChecked();
  await dialog.getByRole('button', { name: '더 보기', exact: true }).click();
  await expect(dialog.getByRole('radio')).toHaveCount(5); await expect(dialog.locator('img')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '더 보기', exact: true })).toBeHidden();
  await dialog.getByRole('radio', { name: 'TEAM-4 권한 관리 예외 처리', exact: true }).check();
  await expect(dialog.locator('#jira-selection')).toHaveText('TEAM-4 · 권한 관리 예외 처리');
  fs.mkdirSync('output/screenshots', { recursive: true });
  await page.screenshot({ path: 'output/screenshots/jira-issue-search.png' });
  await dialog.getByRole('button', { name: '이슈 연결', exact: true }).click();
  await expect(page.getByRole('link', { name: 'TEAM-4 Jira에서 열기' })).toBeVisible();
  expect((await h.manager(`/items/${item.id}`)).item.title).toBe(item.title);
  expect(f.state.issues).toHaveLength(5); expect(f.state.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
});

test('new query invalidates selection and ignores delayed old responses; empty and failed results remain unlinked', async ({ page }) => {
  f.addIssue({ summary: '권한 설계' }); f.addIssue({ summary: '일정 계획' });
  await open(page); const dialog = page.getByRole('dialog'), input = dialog.getByLabel('이슈 키 또는 제목');
  f.state.searchDelay = 300; await input.fill('권한'); await input.press('Enter');
  await eventually(() => f.state.calls.some(c => c.path.endsWith('/search/jql') && c.query.jql.includes('권한')));
  f.state.searchDelay = 0; await input.fill('일정'); await input.press('Enter');
  await expect(dialog.getByRole('radio')).toHaveCount(1);
  await expect(dialog.getByRole('radio')).toHaveAccessibleName('TEAM-2 일정 계획');
  await eventually(() => f.state.searchCompleted?.some(jql => jql.includes('권한')));
  await expect(dialog.getByRole('radio')).toHaveAccessibleName('TEAM-2 일정 계획');
  await dialog.getByRole('radio').check(); await input.fill('없는제목');
  await expect(dialog.getByRole('button', { name: '이슈 연결', exact: true })).toBeDisabled();
  await input.press('Enter'); await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(dialog.locator('#jira-search-status')).toContainText('검색 결과가 없습니다');
  f.state.searchFailure = 429; await input.fill('권한'); await input.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('호출 한도');
  expect((await h.manager(`/items/${item.id}`)).jira_links).toHaveLength(0);
});
