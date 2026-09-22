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
async function linked(page) {
  await authorize(h); const issue = f.addIssue({ summary: '승인 정책 및 권한 API 설계' }, 'TEAM-42');
  await h.manager(`/items/${item.id}/jira/link`, { method: 'POST', body: { version: item.version, operation_id: 'ui-existing-link', cloud_id: 'cloud-test', key: issue.key, issue_id: issue.id } });
  await open(page); await expect(page.locator('#detail .jira-status')).toHaveText('해야 할 일'); return issue;
}
const select = page => page.getByRole('combobox', { name: 'TEAM-42 변경할 상태' });
const change = page => page.getByRole('button', { name: 'TEAM-42 상태 변경', exact: true });
const reload = page => page.getByRole('button', { name: 'TEAM-42 상태 새로고침' });

test('key/URL lookup preview, explicit connection, real link and inline status changes survive live I/O refresh', async ({ page }) => {
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
  await expect(change(page)).toBeDisabled();
  await expect(select(page).locator('option[value="41"]')).toBeDisabled();
  await page.locator('.session-card > summary').click();
  await page.locator('.session-card .raw-history > summary').click();
  await expect(page.locator('.session-card .event')).toHaveCount(2);
  await select(page).selectOption('21');
  await h.ingest(pair('jira-ui-issues', '09:10:00', '09:12:00', 'next', { text: '권한 예외 처리 요구사항을 보완합니다.' }));
  await expect(page.locator('.session-card .event')).toHaveCount(4);
  await expect(select(page)).toHaveValue('21'); // The selected target survives the SSE snapshot.
  f.state.transitionDelay = 350;
  await change(page).click(); await expect(change(page)).toBeDisabled();
  await expect(page.locator('#detail .jira-status')).toHaveText('진행 중');
  await expect(select(page)).toHaveValue('');
  expect(f.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/transitions'))).toHaveLength(1);
  expect(f.state.issues).toHaveLength(1); expect(issue.fields.summary).toBe('승인 정책 및 권한 API 설계');
  await page.screenshot({ path: 'output/screenshots/jira-issue-management.png' });
  await page.setViewportSize({ width: 900, height: 760 });
  const bounds = await page.locator('.jira-card').evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }));
  expect(bounds.content).toBeLessThanOrEqual(bounds.width);
  await page.screenshot({ path: 'output/screenshots/jira-issue-management-compact.png' });
});

test('stale selection refreshes status; failed reads retain marked history and recover without losing controls', async ({ page }) => {
  const issue = await linked(page); await select(page).selectOption('21');
  f.setStatus(issue, 'progress');
  await change(page).click();
  await expect(page.locator('.jira-status')).toHaveText('진행 중');
  await expect(page.locator('.jira-message')).toContainText('최신 상태');
  expect(f.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/transitions'))).toHaveLength(0);
  f.state.issueReadFailure = 403; await reload(page).click();
  await expect(page.locator('.jira-observed')).toContainText('최신 상태 미확인');
  await expect(select(page)).toBeDisabled(); await expect(reload(page)).toBeEnabled();
  f.state.issueReadFailure = null; await reload(page).click(); await expect(select(page)).toBeEnabled();
  await select(page).selectOption('31'); await change(page).click();
  await expect(page.locator('.jira-status')).toHaveText('완료');
  await expect(page.locator('.jira-message')).toHaveCount(0);
});

test('read-only access and unavailable transitions explain disabled controls while retaining the issue link', async ({ page }) => {
  await linked(page); f.state.scopes = ['read:jira-work']; await reload(page).click();
  await expect(select(page)).toBeDisabled(); await expect(page.locator('.jira-message')).toContainText('쓰기 권한');
  await expect(page.getByRole('button', { name: 'TEAM-42 제목·설명 반영', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'TEAM-42 제목·설명 반영', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'TEAM-42 Jira에서 열기' })).toBeVisible();
  f.state.scopes.push('write:jira-work'); f.state.noTransitions = true; await reload(page).click();
  await expect(select(page)).toBeDisabled(); await expect(page.locator('.jira-card')).toContainText('변경 가능한 상태가 없습니다.');
});

test('Done status selection explains automatic posting and produces one normal paragraph comment from the sessions', async ({ page }, info) => {
  await h.stop('manager'); h.env.HARNESS_RESULT_FIXTURE = JSON.stringify({ scenario: 'slow', delayMs: 1200 }); await h.start('manager');
  await linked(page);
  const notice = page.locator('.jira-done-notice'), result = page.getByRole('region', { name: 'TEAM-42 완료 결과 댓글', exact: true });
  await expect(notice).toBeHidden();
  await select(page).selectOption('31'); await expect(notice).toContainText('한 문단의 결과 댓글을 Jira에 자동 게시');
  await select(page).selectOption('21'); await expect(notice).toBeHidden();
  await select(page).selectOption('31');
  await change(page).click();
  await expect(page.locator('.jira-status')).toHaveText('완료');
  await expect(result.locator('.jira-result-comment-state')).toHaveText(/작성 대기|작성 중|게시 대기|게시 중/);
  await expect(result).toContainText('화면을 이동해도 계속 진행됩니다');
  await expect(result.locator('.jira-result-comment-state')).toHaveText('게시됨', { timeout: 20000 });
  expect(f.state.comments).toHaveLength(1);
  const comment = f.state.comments[0], content = adfText(comment.body);
  expect(comment.body.content).toHaveLength(1); expect(comment.body.content[0].type).toBe('paragraph');
  expect(content).toContain('권한 관리'); expect(content).not.toMatch(/[\r\n]/);
  await expect(result.locator('.jira-result-comment-text')).toHaveText(content);
  await expect(page.getByRole('button', { name: 'TEAM-42 제목·설명 반영', exact: true })).toBeEnabled();
  expect(f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/transitions'))).toHaveLength(1);
  expect(f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/comment'))).toHaveLength(1);
  await page.locator('.jira-card').screenshot({ path: info.outputPath('jira-done-result-comment.png') });
  await page.reload(); await page.locator('.item-open').click();
  await expect(result.locator('.jira-result-comment-state')).toHaveText('게시됨');
  await reload(page).click(); expect(f.state.comments).toHaveLength(1);
});

test('a known comment rejection allows an explicit retry and preserves its request ID when the retry response is lost', async ({ page }) => {
  await linked(page); f.state.commentFailure = 403;
  await select(page).selectOption('31'); await change(page).click();
  const result = page.getByRole('region', { name: 'TEAM-42 완료 결과 댓글', exact: true }), retry = result.getByRole('button', { name: '결과 댓글 다시 시도', exact: true });
  await expect(result.locator('.jira-result-comment-state')).toHaveText('실패', { timeout: 20000 });
  await expect(retry).toBeEnabled(); expect(f.state.comments).toHaveLength(0);
  const requests = [];
  await page.route('**/api/jira-links/*/result-comment/retry', route => {
    requests.push(route.request().postDataJSON());
    return requests.length === 1 ? route.abort('failed') : route.continue();
  });
  f.state.commentFailure = null;
  await retry.click(); await expect(retry).toBeEnabled();
  await retry.click();
  await expect(result.locator('.jira-result-comment-state')).toHaveText('게시됨', { timeout: 20000 });
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(requests[0].operation_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.state.comments).toHaveLength(1);
  expect(f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/transitions'))).toHaveLength(1);
});

test('a lost comment response offers reconciliation without retrying or duplicating the posted comment', async ({ page }) => {
  await linked(page); f.state.loseComment = true;
  await select(page).selectOption('31'); await change(page).click();
  const result = page.getByRole('region', { name: 'TEAM-42 완료 결과 댓글', exact: true });
  await expect(result.locator('.jira-result-comment-state')).toHaveText('게시 결과 확인 필요', { timeout: 20000 });
  await expect(result.getByRole('button', { name: '결과 댓글 다시 시도', exact: true })).toHaveCount(0);
  await expect(result).toContainText('댓글을 다시 전송하지 않습니다'); expect(f.state.comments).toHaveLength(1);
  const requests = [];
  page.on('request', request => { if (request.url().endsWith('/result-comment/reconcile')) requests.push(request.postDataJSON()); });
  await result.getByRole('button', { name: '게시 결과 확인', exact: true }).click();
  await expect(result.locator('.jira-result-comment-state')).toHaveText('게시됨', { timeout: 20000 });
  expect(requests).toEqual([{}]); expect(f.state.comments).toHaveLength(1);
  expect(f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/comment'))).toHaveLength(1);
});

test('lost transition response shows durable uncertainty and refresh observes the target without resending', async ({ page }) => {
  await linked(page); f.state.loseTransition = true;
  await select(page).selectOption('21'); await change(page).click();
  await eventually(() => h.manager(`/items/${item.id}`), d => d.jira_links[0].change?.state === 'unknown');
  await expect(select(page)).toBeDisabled();
  await reload(page).click();
  await expect(page.locator('.jira-status')).toHaveText('진행 중');
  await expect(page.locator('.jira-message')).toContainText('이전 전송 응답은 확인하지 못했습니다.');
  expect(f.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/transitions'))).toHaveLength(1);
});
