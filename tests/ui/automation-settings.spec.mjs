import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); h.env = { HARNESS_TEST_AUTOMATIC_METADATA: '1' };
  await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => h.close());
const open = async page => {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.getByRole('button', { name: '자동 작성 설정', exact: false }).click();
  await expect(page.getByRole('heading', { name: '자동 작성 설정', exact: true })).toBeVisible();
};

test('GUI persists automatic writing thresholds and the collected second response creates visible structured metadata', async ({ page }) => {
  await open(page);
  await expect(page.getByLabel('에이전트 응답 수')).toHaveValue('5');
  await expect(page.getByLabel('요약된 종료 세션 수')).toHaveValue('5');
  await page.getByLabel('에이전트 응답 수').fill('2');
  await page.getByLabel('요약된 종료 세션 수').fill('3');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('자동 작성 기준을 저장했습니다.');
  expect(await h.manager('/automation/settings')).toEqual({ initial_output_count: 2, summary_interval: 3 });
  await h.stop('manager'); await h.start('manager'); await open(page);
  await expect(page.getByLabel('에이전트 응답 수')).toHaveValue('2');
  await expect(page.getByLabel('요약된 종료 세션 수')).toHaveValue('3');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await h.ingest(pair('automatic-ui', '09:00:00', '09:01:00', 'first', { source: 'system_hook', text: '권한 관리 범위를 정리했습니다.' }));
  const item = (await h.manager('/items'))[0];
  expect((await h.manager(`/items/${item.id}`)).metadata_rewrite).toBeNull();
  await page.locator('.item-open').click();
  await h.ingest(pair('automatic-ui', '09:02:00', '09:03:00', 'second', { source: 'system_hook', text: '권한별 수용 조건을 확인했습니다.' }));
  const result = await eventually(() => h.manager(`/items/${item.id}`), detail => detail.metadata_rewrite?.state === 'completed', 20000);
  await expect(page.locator('.metadata-writing .writing-status')).toContainText('작성 완료');
  await expect(page.locator('.work-item-title')).toHaveText(result.item.title);
  await expect(page.locator('.work-item-description h3')).toHaveText(['작업 배경', '목적', '범위', '결과']);
  expect(result.runs.filter(run => run.internal && run.task === 'text.rewrite')).toHaveLength(1);
  await page.screenshot({ path: 'output/playwright/automatic-metadata-result.png', fullPage: true });
});

test('automatic writing settings reject invalid counts and restore defaults only after save', async ({ page }) => {
  await open(page);
  const input = page.getByLabel('에이전트 응답 수');
  for (const value of ['0', '1.5', '1001', '']) {
    await input.fill(value); await page.getByRole('button', { name: '저장', exact: true }).click();
    expect(await input.evaluate(node => node.validity.valid)).toBe(false);
    expect(await h.manager('/automation/settings')).toEqual({ initial_output_count: 5, summary_interval: 5 });
  }
  await input.fill('8'); await page.getByLabel('요약된 종료 세션 수').fill('12');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => h.manager('/automation/settings')).toEqual({ initial_output_count: 8, summary_interval: 12 });
  await page.getByRole('button', { name: '기본값 입력', exact: true }).click();
  await expect(input).toHaveValue('5'); await expect(page.getByLabel('요약된 종료 세션 수')).toHaveValue('5');
  expect(await h.manager('/automation/settings')).toEqual({ initial_output_count: 8, summary_interval: 12 });
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => h.manager('/automation/settings')).toEqual({ initial_output_count: 5, summary_interval: 5 });
  await page.screenshot({ path: 'output/playwright/automation-settings.png', fullPage: true });
});
