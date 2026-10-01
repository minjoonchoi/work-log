import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { Harness, pair } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(h.dir + '/token', 'utf8'));
});
test.afterEach(async () => h.close());
test('only history utilities remain in navigation, connections and writer settings', async ({ page }, info) => {
  const retired = [];
  page.on('request', r => { if (/harness-packages|task-queue/.test(r.url())) retired.push(r.url()); });
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await expect(page.getByRole('button', { name: '대기열', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await expect(page.getByRole('tab', { name: '에이전트 연결', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '직무 패키지', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-connection=codex-harness]')).toHaveCount(0);
  await expect(page.locator('[data-connection=codex-tracking]')).toBeVisible();
  await page.screenshot({ path: info.outputPath('connection-agents.png') });
  await page.getByRole('tab', { name: 'Atlassian 연결', exact: true }).click();
  await expect(page.getByLabel('Client ID', { exact: true })).toBeVisible();
  await expect(page.locator('#open-atlassian-settings')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('connection-atlassian.png') });
  await page.getByLabel('Client ID', { exact: true }).fill('unsaved-client');
  await page.getByRole('tab', { name: '에이전트 연결', exact: true }).click();
  await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await page.getByRole('tab', { name: 'Atlassian 연결', exact: true }).click();
  await expect(page.getByLabel('Client ID', { exact: true })).toHaveValue('unsaved-client');
  expect((await page.locator('#modal').boundingBox()).height).toBeGreaterThanOrEqual(640);
  await page.setViewportSize({ width: 900, height: 550 });
  expect((await page.locator('#modal').boundingBox()).height).toBeLessThanOrEqual(495);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '작업 실행 설정', exact: true }).click();
  await expect(page.getByRole('tab', { name: '하네스 작업', exact: true })).toHaveCount(0);
  await expect(page.locator('#execution-task option')).toHaveCount(4);
  expect(await page.locator('#execution-task option').evaluateAll(nodes => nodes.map(n => n.value).sort())).toEqual(['session.summarize', 'text.rewrite', 'work-item.result.summarize', 'work.report.create'].sort());
  await page.locator('#execution-task').selectOption('session.summarize');
  await page.getByRole('tab', { name: '원문 편집', exact: true }).click();
  await page.locator('#task-instruction').fill('제공된 세션 이력만 간결하게 요약합니다.');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('저장했습니다');
  expect(retired).toEqual([]);
});


test('item exposes a copyable exact resume command and a manual-copy fallback', async ({ page }, info) => {
  const id = '12345678-1234-1234-1234-123456789abc';
  await h.ingest(pair(id, '09:00:00', '09:01:00', 'first', { source: 'system_hook', cwd: "/tmp/user's project", text: '재개 기능 검증', work_item_id: 'resume-ui-item' }));
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.locator('.item-open').first().click();
  await expect(page.locator('.session-card .item-resume')).toHaveCount(0);
  await expect(page.locator('#copy-item-resume')).toHaveCount(1);
  const field = page.getByLabel('재개 명령');
  await expect(field).toBeHidden();
  await page.locator('.item-resume > summary').click();
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(/codex resume '12345678-1234-1234-1234-123456789abc'$/);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedResume = text; } } }));
  await page.getByRole('button', { name: '재개 명령 복사' }).click();
  expect(await page.evaluate(() => window.copiedResume)).toBe(await field.inputValue());
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('denied'); } } }));
  await page.getByRole('button', { name: '재개 명령 복사' }).click();
  await expect(field).toBeFocused();
  expect(await field.evaluate(node => node.selectionEnd - node.selectionStart)).toBe((await field.inputValue()).length);
  await page.screenshot({ path: info.outputPath('session-resume.png') });
});

test('item resume deduplicates time windows and selects among distinct conversations', async ({ page }) => {
  const first = '12345678-1234-1234-1234-123456789abc', second = '12345678-1234-1234-1234-123456789def';
  const source = { source: 'system_hook', cwd: '/tmp/project', work_item_id: 'resume-multiple' };
  await h.ingest([...pair(first, '09:00:00', '09:01:00', 'one', source),
    ...pair(first, '10:00:00', '10:01:00', 'two', source), ...pair(second, '11:00:00', '11:01:00', 'three', source)]);
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.locator('.item-open').first().click();
  await expect(page.locator('.session-card')).toHaveCount(3);
  await expect(page.locator('#item-resume-choice option')).toHaveCount(2);
  await expect(page.locator('#copy-item-resume')).toHaveCount(1);
  await expect(page.getByLabel('재개할 대화')).toBeHidden();
  await page.locator('.item-resume > summary').click();
  await page.getByLabel('재개할 대화').selectOption(`codex:${first}`);
  await expect(page.getByLabel('재개 명령')).toHaveValue(`cd -- '/tmp/project' && codex resume '${first}'`);
  await h.ingest(pair(second, '12:00:00', '12:01:00', 'four', source));
  await expect(page.locator('.session-card')).toHaveCount(4);
  await expect(page.getByLabel('재개 명령')).toBeVisible();
  await expect(page.getByLabel('재개할 대화')).toHaveValue(`codex:${first}`);
  await expect(page.getByLabel('재개 명령')).toHaveValue(`cd -- '/tmp/project' && codex resume '${first}'`);
});


test('item detail dismisses on Escape and outside click while dialogs and inside clicks keep it open', async ({ page }) => {
  await h.ingest(pair('dismiss-agent', '09:00:00', '09:01:00', 'one', { source: 'system_hook', work_item_id: 'dismiss-item' }));
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  const opener = page.locator('.item-open').first(), detail = page.locator('#detail');
  await opener.click(); await expect(detail).toBeVisible();
  await detail.locator('.detail-identity').click(); await expect(detail).toBeVisible();
  await page.keyboard.press('Escape'); await expect(detail).toBeHidden(); await expect(opener).toBeFocused();
  await opener.click(); await expect(detail).toBeVisible();
  await page.locator('#page-title').click(); await expect(detail).toBeHidden();
  await opener.click(); await expect(detail).toBeVisible();
  await page.locator('#edit-item').click();
  const modal = page.locator('#modal'); await expect(modal).toBeVisible();
  await page.locator('#edit-title').click(); await expect(detail).toBeVisible();
  await page.keyboard.press('Escape'); await expect(modal).toBeHidden(); await expect(detail).toBeVisible();
  await page.locator('#edit-item').click(); await expect(modal).toBeVisible();
  const bounds = await modal.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(2, 2); await page.mouse.up();
  await expect(modal).toBeVisible();
  await page.mouse.click(2, 2); await expect(modal).toBeHidden(); await expect(detail).toBeVisible();
  await page.keyboard.press('Escape'); await expect(detail).toBeHidden();
});
