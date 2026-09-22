import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { Harness, pair } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize } from '../fixtures/atlassian.mjs';

const description = 'h2. 배경\n* 고객의 *초대 실패*를 확인했습니다.\n\nh2. 목표\n* 재초대 흐름을 명확히 합니다.\n\nh2. 요구사항\n* 권한과 만료 정책\n* 오류 안내\n\nh2. 작업 범위\n* {{invite(user)}} 호출을 확인합니다.\n\nh2. 참고사항\n* [관련 명세|https://example.com/spec?q=1&v=2]\n* <img src=x onerror="window.__unsafe=true">\n* [위험|javascript:alert(1)]\n* {toc}';
const headings = ['배경', '목표', '요구사항', '작업 범위', '참고사항'];
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

test('Jira wiki descriptions render safely, round-trip editable source, and preview Jira creation without external writes', async ({ page }) => {
  await authorize(h); await open(page);
  const body = page.locator('.metadata-writing .work-item-description');
  await expect(page.locator('.item-main p')).not.toContainText('h2.');
  await expect(page.locator('.item-main p')).not.toContainText('*초대 실패*');
  await expect(body.locator('h3')).toHaveText(headings);
  await expect(body.locator('ul li')).toHaveCount(9);
  await expect(body.locator('strong')).toHaveText('초대 실패'); await expect(body.locator('img')).toHaveCount(0);
  await expect(body.locator('code')).toHaveText('invite(user)');
  await expect(body.locator('a')).toHaveCount(1); await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/spec?q=1&v=2');
  await expect(body).toContainText('[위험|javascript:alert(1)]'); await expect(body).toContainText('{toc}');
  expect(await page.evaluate(() => window.__unsafe)).toBeUndefined();
  await page.getByRole('button', { name: '제목·설명 편집', exact: true }).click();
  await expect(page.locator('#edit-description')).toHaveValue(description);
  await expect(page.locator('#edit-description-help')).toContainText('Jira 위키 형식');
  const edited = description.replace('오류 안내', '오류 안내와 복구 절차');
  await page.locator('#edit-description').fill(edited);
  await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
  await expect(body).toContainText('오류 안내와 복구 절차');
  await page.getByRole('button', { name: '제목·설명 편집', exact: true }).click();
  await expect(page.locator('#edit-description')).toHaveValue(edited);
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '＋ 새 이슈 만들기' }).click();
  await expect(page.locator('.jira-preview h3')).toHaveText(headings);
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
  expect(f.state.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
  expect((await h.manager(`/items/${item.id}`)).item.description).toBe(edited);
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
  await expect(dialog.locator('.work-item-description h3')).toHaveText(headings);
  await dialog.getByRole('button', { name: '취소', exact: true }).click(); expect(writes()).toHaveLength(0);
  await update.click(); await dialog.getByRole('button', { name: 'Jira에 반영', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.jira-issue-title')).toHaveText('초대 흐름 개선');
  await expect(page.locator('.jira-content-message')).toContainText('반영했습니다');
  expect(writes()).toHaveLength(1);
  expect(issue.fields.description.content.filter(node => node.type === 'heading').map(node => node.content[0].text)).toEqual(headings);
  expect(issue.fields.description.content.some(node => node.type === 'bulletList')).toBe(true);
  expect(issue.fields.description.content.filter(node => node.type === 'bulletList')).toHaveLength(5);
  expect((await h.manager(`/items/${item.id}`)).item.description).toBe(description);
  await page.reload(); await page.locator('.item-open').click();
  await expect(page.locator('.jira-issue-title')).toHaveText('초대 흐름 개선'); expect(writes()).toHaveLength(1);
});

test('legacy Markdown and plain descriptions keep their rendering and saved edit source', async ({ page }) => {
  const legacy = '## 기존 제목\n**강조**와 `코드`\n\n- 첫째\n- 둘째\n\n3. 세 번째';
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: item.title, description: legacy } });
  await open(page);
  const body = page.locator('.metadata-writing .work-item-description');
  await expect(body.locator('h3')).toHaveText('기존 제목'); await expect(body.locator('strong')).toHaveText('강조');
  await expect(body.locator('code')).toHaveText('코드'); await expect(body.locator('ul li')).toHaveCount(2);
  await expect(body.locator('ol')).toHaveAttribute('start', '3');
  await page.getByRole('button', { name: '제목·설명 편집', exact: true }).click();
  await expect(page.locator('#edit-description')).toHaveValue(legacy);
  const plain = '첫 줄 <script>window.__legacy=true</script>\n\n둘째 줄 & 원문';
  await page.locator('#edit-description').fill(plain);
  await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
  await expect(body.locator('h3')).toHaveCount(0); await expect(body.locator('p')).toHaveText(['첫 줄 <script>window.__legacy=true</script>', '둘째 줄 & 원문']);
  expect(await page.evaluate(() => window.__legacy)).toBeUndefined();
  expect((await h.manager(`/items/${item.id}`)).item.description).toBe(plain);
});
