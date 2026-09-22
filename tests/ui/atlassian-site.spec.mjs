import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize } from '../fixtures/atlassian.mjs';

let h, f;
test.beforeEach(async ({ context }) => {
  h = new Harness(); f = await atlFixture(h); await h.start('manager'); await authorize(h);
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => { await h.close(); await f.close(); });
const open = page => page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
const siteField = page => page.getByLabel('Atlassian 사이트 주소', { exact: true });
async function settings(page) {
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await page.getByRole('button', { name: 'Atlassian 설정', exact: true }).click();
}
const saveSite = site_url => h.manager('/integrations/atlassian', { method: 'PUT', body: { client_id: 'fixture-client', site_url } });
function multipleSites() {
  f.state.resources = [
    { id: 'cloud-other', name: '다른 회사', url: 'https://other.atlassian.net', scopes: [...f.state.scopes] },
    { id: 'cloud-test', name: 'Fixture 팀', url: 'https://fixture.atlassian.net', scopes: [...f.state.scopes] }
  ];
}
async function report(page) {
  const value = { id: 'site-report', title: '회사 업무 요약', state: 'completed', dates: ['2026-09-21'], created_at: '2026-09-21T03:00:00Z', timezone: 'Asia/Seoul', session_count: 0, body: '## 업무\n\n사이트 선택을 확인했습니다.' };
  await page.route('**/api/reports', route => route.fulfill({ json: [value] }));
  await page.route('**/api/reports/site-report*', route => route.fulfill({ json: { report: value, sessions: [], parts: [], publications: [] } }));
  await page.getByRole('button', { name: '업무 요약', exact: true }).click();
  await page.getByRole('button', { name: value.title, exact: true }).click();
}

test('company site saves canonically, survives reopening and polling, and clearing it preserves credentials and tokens', async ({ page }) => {
  const saved = [], tokenCalls = f.state.tokenCalls.length; let polls = 0, release;
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/integrations/atlassian' && response.request().method() === 'GET') polls++; });
  await page.route('**/api/integrations/atlassian', async route => {
    if (route.request().method() === 'PUT') {
      saved.push(route.request().postDataJSON());
      if (saved.length === 1) await new Promise(resolve => { release = resolve; });
    }
    await route.continue();
  });
  await open(page); await settings(page);
  await expect(siteField(page)).toHaveValue('');
  await expect(siteField(page)).toHaveAttribute('placeholder', 'https://company.atlassian.net');
  await siteField(page).fill('fixture.atlassian.net/');
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  await expect(siteField(page)).toBeDisabled(); await expect.poll(() => saved.length).toBe(1);
  release(); await expect(siteField(page)).toHaveValue('https://fixture.atlassian.net');
  expect(saved[0]).toEqual({ client_id: 'fixture-client', site_url: 'fixture.atlassian.net/' });
  await expect(siteField(page)).toBeEnabled();
  await expect(page.getByLabel('Client Secret', { exact: true })).toHaveAttribute('type', 'password');
  await page.screenshot({ path: 'output/screenshots/atlassian-site-settings.png' });
  await page.getByRole('button', { name: '닫기', exact: true }).click(); await settings(page);
  await expect(siteField(page)).toHaveValue('https://fixture.atlassian.net');
  await siteField(page).fill('unsaved.atlassian.net'); const before = polls;
  await expect.poll(() => polls).toBeGreaterThan(before);
  await expect(siteField(page)).toHaveValue('unsaved.atlassian.net');
  await page.getByRole('button', { name: 'Client Secret 보기', exact: true }).click();
  await expect(page.getByLabel('Client Secret', { exact: true })).toHaveValue('fixture-secret');
  await siteField(page).fill(''); await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  await expect(page.locator('#save-atlassian')).toBeEnabled();
  expect(saved.at(-1)).toEqual({ client_id: 'fixture-client', site_url: '' });
  const status = await h.manager('/integrations/atlassian');
  expect(status.config).toEqual({ client_id: 'fixture-client' }); expect(status.connected).toBe(true); expect(status.has_client_secret).toBe(true);
  expect(f.state.tokenCalls).toHaveLength(tokenCalls);
  await expect(page.getByLabel('Client Secret', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '닫기', exact: true }).click(); await settings(page); await expect(siteField(page)).toHaveValue('');
});

test('connecting with only the company site edited saves the change without resending a revealed secret', async ({ page }) => {
  const writes = [];
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/integrations/atlassian') writes.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.open = url => { window.__authorization = url; }; });
  await page.route('**/api/integrations/atlassian/authorize', route => route.fulfill({ json: { authorization_url: 'https://auth.atlassian.com/authorize?fixture=1' } }));
  await open(page); await settings(page);
  await page.getByRole('button', { name: 'Client Secret 보기', exact: true }).click();
  await expect(page.getByLabel('Client Secret', { exact: true })).toHaveValue('fixture-secret');
  await siteField(page).fill('fixture.atlassian.net'); await page.getByRole('button', { name: 'Atlassian 연결', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__authorization)).toBe('https://auth.atlassian.com/authorize?fixture=1');
  expect(writes).toEqual([{ client_id: 'fixture-client', site_url: 'fixture.atlassian.net' }]);
  await expect(siteField(page)).toHaveValue('https://fixture.atlassian.net');
  await expect(page.getByLabel('Client Secret', { exact: true })).toHaveValue('');
});

test('Jira create, existing-issue search and Confluence explicitly select the preferred company and show its address', async ({ page }) => {
  multipleSites(); await saveSite('fixture.atlassian.net');
  await h.ingest(pair('site-choice', '09:00:00', '09:05:00', 'first', { text: '회사 사이트 선택' }));
  const products = [];
  // Keep the preferred row last to verify selection does not depend on response order.
  await page.route('**/api/integrations/atlassian/sites?product=*', async route => {
    products.push(new URL(route.request().url()).searchParams.get('product'));
    const response = await route.fetch(), rows = await response.json();
    await route.fulfill({ response, json: rows.sort((a, b) => Number(!!a.preferred) - Number(!!b.preferred)) });
  });
  await open(page); await page.locator('.item-open').click();
  await page.locator('#create-jira').click();
  await expect(page.locator('#jira-site')).toHaveValue('cloud-test');
  await expect(page.locator('#jira-site option:checked')).toHaveText('Fixture 팀 · https://fixture.atlassian.net');
  await expect(page.locator('#jira-type')).toHaveValue('10001');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  f.addIssue({ summary: '회사 검색 결과' }); await page.locator('#link-jira').click();
  await expect(page.locator('#existing-site')).toHaveValue('cloud-test');
  await page.locator('#existing-key').fill('회사'); await page.locator('#lookup-jira').click();
  await expect(page.getByRole('radio')).toHaveCount(1);
  expect(f.state.calls.find(call => call.path.endsWith('/search/jql')).path).toContain('/cloud-test/');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await report(page); await page.locator('#publish-report').click();
  await expect(page.locator('#report-confluence-site')).toHaveValue('cloud-test');
  await expect(page.locator('#report-confluence-site option:checked')).toHaveText('Fixture 팀 · https://fixture.atlassian.net');
  await expect(page.locator('#report-confluence-space')).toHaveValue('10');
  expect(products).toEqual(['jira', 'jira', 'confluence']);
  expect(f.state.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  await page.screenshot({ path: 'output/screenshots/company-atlassian-site-selection.png' });
});

test('an unavailable company or missing Jira write permission never silently selects another site', async ({ page }) => {
  multipleSites(); await saveSite('missing.atlassian.net');
  await h.ingest(pair('site-unavailable', '09:00:00', '09:05:00', 'first', { text: '회사 접근 권한 확인' }));
  await open(page); await page.locator('.item-open').click();
  await page.locator('#create-jira').click(); await expect(page.locator('#toast')).toContainText('사이트');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.locator('#link-jira').click(); await expect(page.locator('#toast')).toContainText('사이트');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(f.state.calls.filter(call => call.path.endsWith('/project/search'))).toHaveLength(0);
  await saveSite('fixture.atlassian.net'); f.state.resources[1].scopes = ['read:jira-work'];
  await page.locator('#create-jira').click(); await expect(page.locator('#toast')).toContainText('Jira 쓰기 권한');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(f.state.calls.filter(call => call.path.endsWith('/project/search'))).toHaveLength(0);
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click(); await report(page);
  await page.locator('#publish-report').click(); await expect(page.locator('#toast')).toContainText('Confluence');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(f.state.calls.filter(call => call.path.endsWith('/wiki/api/v2/spaces'))).toHaveLength(0);
});
