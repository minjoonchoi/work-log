import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize } from '../fixtures/atlassian.mjs';

const description = '## 작업 배경\n고객의 **초대 실패**를 확인했습니다.\n\n## 목적\n재초대 흐름을 명확히 합니다.\n\n## 범위\n- 권한과 만료 정책\n- 오류 안내\n\n## 결과\n1. 검증 전 초안입니다.\n2. <img src=x onerror="window.__unsafe=true">';
let h, f, item;
test.beforeEach(async ({ context }) => {
  h = new Harness(); f = await atlFixture(h); await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(`${h.dir}/token`, 'utf8'));
  await h.ingest(pair('structured-description', '09:00:00', '09:05:00', 'first'));
  item = (await h.manager('/items'))[0];
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: '초대 흐름 개선', description } });
  item = (await h.manager(`/items/${item.id}`)).item;
});
test.afterEach(async () => { await h.close(); await f.close(); });
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`); await page.locator('.item-open').click();
}
const writes = () => f.state.calls.filter(c => c.method === 'PUT' && /\/issue\/[^/]+$/.test(c.path));

test('structured description renders headings and lists, keeps Markdown edit source, and previews Jira creation without external writes', async ({ page }) => {
  await authorize(h); await open(page);
  const body = page.locator('.metadata-writing .work-item-description');
  await expect(page.locator('.item-main p')).not.toContainText('##');
  await expect(page.locator('.item-main p')).not.toContainText('**');
  await expect(body.locator('h3')).toHaveText(['작업 배경', '목적', '범위', '결과']);
  await expect(body.locator('ul li')).toHaveCount(2); await expect(body.locator('ol li')).toHaveCount(2);
  await expect(body.locator('strong')).toHaveText('초대 실패'); await expect(body.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__unsafe)).toBeUndefined();
  await page.getByRole('button', { name: '제목·설명 편집', exact: true }).click();
  await expect(page.locator('#edit-description')).toHaveValue(description);
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '＋ 새 이슈 만들기' }).click();
  await expect(page.locator('.jira-preview h3')).toHaveText(['작업 배경', '목적', '범위', '결과']);
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
  expect(f.state.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
  expect((await h.manager(`/items/${item.id}`)).item.description).toBe(description);
  fs.mkdirSync('output/screenshots', { recursive: true });
  await page.screenshot({ path: 'output/screenshots/structured-work-item-description.png', fullPage: true });
});

test('linked Jira content changes only after explicit preview confirmation and uses structured ADF', async ({ page }) => {
  await authorize(h); const issue = f.addIssue({ summary: '기존 Jira 제목' }, 'TEAM-42');
  await h.manager(`/items/${item.id}/jira/link`, { method: 'POST', body: {
    version: item.version, operation_id: 'structured-jira-link', cloud_id: 'cloud-test', key: issue.key, issue_id: issue.id
  } });
  await open(page);
  const update = page.getByRole('button', { name: 'TEAM-42 제목·설명 반영' });
  await expect(update).toBeEnabled(); expect(writes()).toHaveLength(0);
  await update.click(); const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.work-item-description h3')).toHaveCount(4);
  await dialog.getByRole('button', { name: '취소', exact: true }).click(); expect(writes()).toHaveLength(0);
  await update.click(); await dialog.getByRole('button', { name: 'Jira에 반영', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.jira-issue-title')).toHaveText('초대 흐름 개선');
  await expect(page.locator('.jira-content-message')).toContainText('반영했습니다');
  expect(writes()).toHaveLength(1);
  expect(issue.fields.description.content.filter(node => node.type === 'heading')).toHaveLength(4);
  expect(issue.fields.description.content.some(node => node.type === 'bulletList')).toBe(true);
  expect(issue.fields.description.content.some(node => node.type === 'orderedList')).toBe(true);
  expect((await h.manager(`/items/${item.id}`)).item.description).toBe(description);
  await page.reload(); await page.locator('.item-open').click();
  await expect(page.locator('.jira-issue-title')).toHaveText('초대 흐름 개선'); expect(writes()).toHaveLength(1);
});
