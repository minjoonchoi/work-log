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

const secretPath = '/api/integrations/atlassian/client-secret';
const clientSettings = { client_id: 'fixture-client', client_secret: 'fixture-secret' };
const showSettings = async page => {
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await page.getByRole('button', { name: 'Atlassian 설정', exact: true }).click();
};
const clientField = page => page.getByLabel('Client ID', { exact: true });
const secretField = page => page.getByLabel('Client Secret', { exact: true });
const reveal = page => page.getByRole('button', { name: 'Client Secret 보기', exact: true });
const conceal = page => page.getByRole('button', { name: 'Client Secret 숨기기', exact: true });
const saveSettings = h => h.manager('/integrations/atlassian', { method: 'PUT', body: clientSettings });

test('direct client credentials stay masked, reveal only on demand, and preserve saved secrets on empty save', async ({ page }) => {
  const reveals = [], saves = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === secretPath) reveals.push(request.postDataJSON());
    if (new URL(request.url()).pathname === '/api/integrations/atlassian' && request.method() === 'PUT') saves.push(request.postDataJSON());
  });
  await open(page); await showSettings(page);
  await expect(page.getByText('1Password', { exact: false })).toHaveCount(0);
  await clientField(page).fill(clientSettings.client_id); await secretField(page).fill(clientSettings.client_secret);
  await expect(secretField(page)).toHaveAttribute('type', 'password');
  await expect(reveal(page)).toHaveAttribute('aria-controls', 'atlassian-client-secret');
  await reveal(page).click(); await expect(secretField(page)).toHaveAttribute('type', 'text');
  await expect(conceal(page)).toHaveAttribute('aria-pressed', 'true'); expect(reveals).toHaveLength(0);
  await conceal(page).click(); await expect(secretField(page)).toHaveAttribute('type', 'password');
  await expect(secretField(page)).toHaveValue(clientSettings.client_secret);
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('연결 설정을 저장했습니다.');
  await expect(secretField(page)).toHaveValue(''); await expect(secretField(page)).toHaveAttribute('type', 'password');
  await expect(secretField(page)).toHaveAttribute('placeholder', /저장됨/);
  const status = await h.manager('/integrations/atlassian');
  expect(status.config).toEqual({ client_id: clientSettings.client_id }); expect(status.has_client_secret).toBe(true);
  expect(JSON.stringify(status)).not.toContain(clientSettings.client_secret);
  expect(fs.readFileSync(path.join(h.dir, 'integrations/atlassian.json'), 'utf8')).not.toContain(clientSettings.client_secret);
  await page.getByRole('button', { name: '닫기', exact: true }).click(); await showSettings(page);
  await expect(secretField(page)).toHaveValue(''); await expect(reveal(page)).toHaveAttribute('aria-pressed', 'false');
  expect(reveals).toHaveLength(0);
  await reveal(page).click(); await expect(secretField(page)).toHaveValue(clientSettings.client_secret);
  expect(reveals).toEqual([{ client_id: clientSettings.client_id }]);
  await conceal(page).click(); await expect(secretField(page)).toHaveValue('');
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  await expect(page.locator('#save-atlassian')).toBeEnabled();
  expect(saves.at(-1)).toEqual({ client_id: clientSettings.client_id });
  await reveal(page).click(); await expect(secretField(page)).toHaveValue(clientSettings.client_secret);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(secretField(page)).toHaveValue(''); await expect(secretField(page)).toHaveAttribute('type', 'password');
  await showSettings(page); await expect(secretField(page)).toHaveValue('');
  expect(reveals).toHaveLength(2);
});

test('live status polling preserves unsaved credentials and disconnect retains the saved app configuration', async ({ page }) => {
  await authorize(h); let polls = 0;
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/integrations/atlassian' && response.request().method() === 'GET') polls++; });
  await open(page); await showSettings(page);
  await expect(page.locator('#atlassian-status')).toContainText('Atlassian 연결됨');
  await clientField(page).fill('unsaved-client'); await secretField(page).fill('unsaved-secret');
  const initialPolls = polls; await h.ingest(pair('live-settings', '09:00:00', '09:05:00'));
  await expect(page.locator('.item-row')).toHaveCount(1);
  await expect.poll(() => polls).toBeGreaterThan(initialPolls);
  await expect(clientField(page)).toHaveValue('unsaved-client'); await expect(secretField(page)).toHaveValue('unsaved-secret');
  await expect(secretField(page)).toHaveAttribute('type', 'password');
  await page.screenshot({ path: 'output/playwright/atlassian-settings.png', fullPage: true });
  await page.getByRole('button', { name: '닫기', exact: true }).click(); await showSettings(page);
  await expect(clientField(page)).toHaveValue(clientSettings.client_id); await expect(secretField(page)).toHaveValue('');
  await page.getByRole('button', { name: '연결 해제', exact: true }).click();
  await expect(page.locator('#atlassian-status')).toContainText('연결 안 됨');
  expect((await h.manager('/integrations/atlassian')).has_client_secret).toBe(true);
});

test('changing Client ID clears a revealed secret and connect saves only dirty credentials', async ({ page }) => {
  await saveSettings(h); const saves = [];
  await page.addInitScript(() => { window.open = url => { window.__lastExternalURL = url; return null; }; });
  await page.route('**/api/integrations/atlassian/authorize', route => route.fulfill({ json: { authorization_url: 'https://auth.atlassian.com/authorize?fixture=1' } }));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/integrations/atlassian' && request.method() === 'PUT') saves.push(request.postDataJSON()); });
  await open(page); await showSettings(page); await reveal(page).click();
  await expect(secretField(page)).toHaveValue(clientSettings.client_secret);
  await page.getByRole('button', { name: 'Atlassian 연결', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__lastExternalURL)).toContain('auth.atlassian.com');
  expect(saves).toHaveLength(0); await expect(secretField(page)).toHaveValue('');
  await reveal(page).click(); await expect(secretField(page)).toHaveValue(clientSettings.client_secret);
  await clientField(page).fill('different-client');
  await expect(secretField(page)).toHaveValue(''); await expect(secretField(page)).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  await expect(page.locator('#dialog-error')).toContainText('Client Secret을 입력'); expect(saves).toHaveLength(0);
  await clientField(page).fill(clientSettings.client_id); await reveal(page).click();
  await expect(secretField(page)).toHaveValue(clientSettings.client_secret);
  await secretField(page).fill('edited-secret');
  await page.getByRole('button', { name: 'Atlassian 연결', exact: true }).click();
  await expect(page.locator('#connect-atlassian')).toBeEnabled();
  expect(saves).toEqual([{ client_id: clientSettings.client_id, client_secret: 'edited-secret' }]);
  await expect(secretField(page)).toHaveValue(''); await expect(secretField(page)).toHaveAttribute('type', 'password');
});

test('late reveal responses cannot overwrite typed values, a changed Client ID, or a reopened dialog', async ({ page }) => {
  await saveSettings(h); const queued = [];
  await page.route('**/api/integrations/atlassian/client-secret', async route => {
    await new Promise(resolve => queued.push(resolve));
    await route.fulfill({ json: { client_secret: clientSettings.client_secret } });
  });
  const release = async index => {
    const response = page.waitForResponse(value => new URL(value.url()).pathname === secretPath);
    queued[index](); await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await open(page); await showSettings(page); await reveal(page).click();
  await expect.poll(() => queued.length).toBe(1);
  await secretField(page).fill('typed-while-loading'); await release(0);
  await expect(page.locator('#toggle-client-secret')).toBeEnabled();
  await expect(secretField(page)).toHaveValue('typed-while-loading'); await expect(secretField(page)).toHaveAttribute('type', 'password');
  await reveal(page).click(); await expect(secretField(page)).toHaveAttribute('type', 'text'); expect(queued).toHaveLength(1);
  await clientField(page).fill('changed-client'); await clientField(page).fill(clientSettings.client_id);
  await reveal(page).click(); await expect.poll(() => queued.length).toBe(2);
  await clientField(page).fill('another-client'); await release(1);
  await expect(secretField(page)).toHaveValue(''); await expect(secretField(page)).toHaveAttribute('type', 'password');
  await clientField(page).fill(clientSettings.client_id); await reveal(page).click(); await expect.poll(() => queued.length).toBe(3);
  await page.getByRole('button', { name: '닫기', exact: true }).click(); await showSettings(page); await release(2);
  await expect(secretField(page)).toHaveValue(''); await expect(secretField(page)).toHaveAttribute('type', 'password');
  await expect(reveal(page)).toHaveAttribute('aria-pressed', 'false');
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
  const oldSession = page.locator('.session-card').last(); await oldSession.locator(':scope > summary').click();
  await expect(oldSession.locator('.summary-text')).toBeVisible({ timeout: 20000 });
  await expect(oldSession.locator('.sync-status')).toContainText('Jira 동기화됨', { timeout: 15000 });
  await expect(page.getByRole('heading', { name: '연결 미확인 출력', exact: true })).toHaveCount(0);
  await oldSession.locator('.raw-history > summary').click();
  await expect(oldSession.locator('.event').first()).toHaveAttribute('data-kind', 'output');
  await expect(oldSession).toContainText('5분 0초');
  await page.screenshot({ path: 'output/playwright/jira-session-worklog.png', fullPage: true });
  expect(f.state.worklogs).toHaveLength(1);
  const original = (await h.manager(`/items/${item.id}`)).sessions[0].summary.text;
  expect(adfText(f.state.worklogs[0].comment)).toBe(original);
  await expect(oldSession.locator('.summary-text strong')).toHaveText(original.split('\n')[0]);
  expect(await oldSession.locator('.summary-text li').allTextContents()).toEqual(original.split('\n').slice(1).map(line => line.replace(/^[-*•]\s+/, '')));
  await h.stop('manager'); await h.start('manager');
  await open(page); await page.locator('.item-open').click();
  await expect(page.getByRole('link', { name: 'TEAM-1 Jira에서 열기', exact: true })).toBeVisible();
  expect(f.state.issues).toHaveLength(1);
});
