import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize, adfText } from '../fixtures/atlassian.mjs';

let h, f;
test.beforeEach(async ({ context }) => {
  h = new Harness(); f = await atlFixture(h); await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => { await h.close(); await f.close(); });
async function open(page) { await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`); }

test('connection settings save only op references and retain edits during live activity', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: '연결 설정' }).click();
  await page.getByLabel('1Password vault 이름').fill('Team Vault');
  await page.getByLabel('1Password item 이름').fill('Atlassian App');
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('연결 설정을 저장했습니다.');
  expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'integrations/atlassian.json')))).toEqual({ vault: 'Team Vault', item: 'Atlassian App' });
  await page.getByLabel('1Password item 이름').fill('편집 중인 값');
  await h.ingest(pair('live-settings', '09:00:00', '09:05:00'));
  await expect(page.locator('.item-row')).toHaveCount(1);
  await expect(page.getByLabel('1Password item 이름')).toHaveValue('편집 중인 값');
  await page.screenshot({ path: 'output/playwright/atlassian-settings.png', fullPage: true });
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await authorize(h);
  await page.getByRole('button', { name: '연결 설정' }).click();
  await expect(page.locator('#atlassian-status')).toContainText('Atlassian 연결됨');
  await expect(page.getByLabel('1Password item 이름')).toHaveValue('Atlassian App');
  await page.getByRole('button', { name: '연결 해제', exact: true }).click();
  await expect(page.locator('#atlassian-status')).toContainText('연결 안 됨');
});

test('manual ticket creation → live session summary and Jira worklog status with original I/O', async ({ page }) => {
  await authorize(h);
  await h.ingest(pair('jira-ui', '09:00:00', '09:05:00', 'one', { text: '승인 정책과 권한 요구사항을 정리합니다.' }));
  const item = (await h.manager('/items'))[0];
  await open(page); await page.locator('.item-open').click();
  expect(f.state.issues).toHaveLength(0);
  await page.getByRole('button', { name: '＋ 새 이슈 만들기', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('티켓 유형')).toHaveValue('10001');
  await expect(dialog.locator('.jira-preview')).toContainText(item.description);
  await dialog.getByRole('button', { name: 'Jira 티켓 만들기', exact: true }).click();
  await expect(page.getByRole('link', { name: 'TEAM-1 Jira에서 열기', exact: true })).toBeVisible();
  await expect(page.locator('.jira-status')).toHaveText('해야 할 일');
  expect(f.state.issues[0].fields.summary).toBe(item.title);
  expect(adfText(f.state.issues[0].fields.description)).toBe(item.description);
  await h.ingest(pair('jira-ui', '09:25:00', '09:27:00', 'two', { text: '정리한 요구사항으로 화면을 설계합니다.' }));
  await expect(page.locator('.session-card')).toHaveCount(2);
  const oldSession = page.locator('.session-card').last(); await oldSession.locator('summary').click();
  await expect(oldSession.locator('.summary-text')).toBeVisible({ timeout: 20000 });
  await expect(oldSession.locator('.sync-status')).toContainText('Jira 동기화됨', { timeout: 15000 });
  await expect(page.getByRole('heading', { name: '연결 미확인 출력', exact: true })).toHaveCount(0);
  await expect(oldSession.locator('.event').first()).toHaveAttribute('data-kind', 'output');
  await expect(oldSession).toContainText('5분 0초');
  await page.screenshot({ path: 'output/playwright/jira-session-worklog.png', fullPage: true });
  expect(f.state.worklogs).toHaveLength(1);
  expect(adfText(f.state.worklogs[0].comment)).toBe(await oldSession.locator('.summary-text').innerText());
  await h.stop('manager'); await h.start('manager');
  await open(page); await page.locator('.item-open').click();
  await expect(page.getByRole('link', { name: 'TEAM-1 Jira에서 열기', exact: true })).toBeVisible();
  expect(f.state.issues).toHaveLength(1);
});
