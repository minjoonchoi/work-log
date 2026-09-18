import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => h.close());

test('GUI edits and resets task instruction, backend and backend-specific model effort', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.getByRole('button', { name: '작업 실행 설정' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '작업 실행 설정' })).toBeVisible();
  await dialog.getByLabel('작업 유형').selectOption('entity.design');
  await dialog.getByLabel('작업 지시문').fill('관계 수와 삭제 정책을 명확히 설명한다.');
  await dialog.getByLabel('기본 backend').selectOption('claude');
  await dialog.getByLabel('Model override', { exact: true }).nth(0).fill('gpt-5.5');
  await dialog.getByLabel('Effort override', { exact: true }).nth(0).selectOption('low');
  await dialog.getByLabel('Model override', { exact: true }).nth(1).fill('opus');
  await dialog.getByLabel('Effort override', { exact: true }).nth(1).selectOption('xhigh');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('작업 실행 설정을 저장했습니다.');
  const saved = await h.runtime('/execution-settings'), entity = saved.tasks.find(task => task.id === 'entity.design');
  expect(entity.backend).toBe('claude'); expect(entity.instruction).toContain('삭제 정책');
  expect(entity.backends.codex).toMatchObject({ model: 'gpt-5.5', effort: 'low' });
  expect(entity.backends.claude).toMatchObject({ model: 'opus', effort: 'xhigh' });
  fs.mkdirSync('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/execution-settings.png', fullPage: true });
  await dialog.getByRole('button', { name: '기본값 복원' }).click();
  await expect(page.locator('#toast')).toHaveText('유형 기본값으로 복원했습니다.');
  const reset = (await h.runtime('/execution-settings')).tasks.find(task => task.id === 'entity.design');
  expect(reset.backend).toBe('codex'); expect(reset.overridden).toBe(false);
});
