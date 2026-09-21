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

async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.getByRole('button', { name: '작업 실행 설정', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('작업 유형', { exact: true }).selectOption('prd.create');
  return dialog;
}
const options = locator => locator.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
function seed(backends) {
  const file = path.join(h.dir, 'execution-settings.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 4, tasks: {
    'prd.create': { instruction: '기존 저장 지시문', backend: 'codex', backends }
  } }));
  return { file, bytes: fs.readFileSync(file) };
}
async function save(page, dialog) {
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('작업 실행 설정을 저장했습니다.');
}

test('backend-specific model dropdowns filter efforts, clear incompatible choices and preserve both backend selections', async ({ page }, info) => {
  const catalog = await h.runtime('/execution-settings');
  const dialog = await open(page);
  await expect(dialog.locator('input[id$="-model"]')).toHaveCount(0);
  await expect(dialog.locator('#codex-model')).toHaveValue('');
  await expect(dialog.locator('#codex-model option').first()).toContainText('gpt-5.6-luna');
  await expect(dialog.locator('.backend-settings section').first()).toContainText('produce: gpt-5.6-luna / high');
  expect(await options(dialog.locator('#codex-effort'))).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  for (const engine of ['codex', 'claude']) {
    expect(await options(dialog.locator(`#${engine}-model`))).toEqual(['', ...catalog.models[engine].map(model => model.id)]);
    for (const model of catalog.models[engine]) {
      await dialog.locator(`#${engine}-model`).selectOption(model.id);
      expect(await options(dialog.locator(`#${engine}-effort`))).toEqual(['', ...model.efforts]);
      if (model.efforts.length) await expect(dialog.locator(`#${engine}-effort`)).toBeEnabled();
      else await expect(dialog.locator(`#${engine}-effort`)).toBeDisabled();
    }
  }
  await dialog.locator('#codex-model').selectOption('gpt-5.6-terra');
  await dialog.locator('#codex-effort').selectOption('ultra');
  await dialog.locator('#codex-model').selectOption('gpt-5.6-luna');
  await expect(dialog.locator('#codex-effort')).toHaveValue('');
  await expect(dialog.locator('#codex-effort option:checked')).toHaveText('자동 선택 · high');
  await expect(dialog.locator('#codex-effort option[value="ultra"]')).toHaveCount(0);
  await expect(dialog.locator('#codex-selection-notice')).toContainText('기본값으로 바꿨습니다');
  await dialog.locator('#codex-effort').selectOption('high');
  await dialog.locator('#claude-model').selectOption('opus');
  await dialog.locator('#claude-effort').selectOption('max');
  await dialog.locator('#task-backend').selectOption('claude');
  await expect(dialog.locator('#codex-model')).toHaveValue('gpt-5.6-luna');
  await expect(dialog.locator('#codex-effort')).toHaveValue('high');
  await dialog.locator('#claude-model').selectOption('haiku');
  await expect(dialog.locator('#claude-effort')).toHaveValue('');
  await expect(dialog.locator('#claude-effort')).toBeDisabled();
  await expect(dialog.locator('#claude-selection-notice')).toContainText('effort를 지원하지 않아 설정을 해제');
  await dialog.locator('#task-backend').selectOption('codex');
  await expect(dialog.locator('#claude-model')).toHaveValue('haiku');
  await save(page, dialog);
  const saved = (await h.runtime('/execution-settings')).tasks.find(task => task.id === 'prd.create');
  expect(saved.backends.codex).toMatchObject({ model: 'gpt-5.6-luna', effort: 'high' });
  expect(saved.backends.claude).toMatchObject({ model: 'haiku', effort: null });
  await page.reload();
  await page.getByRole('button', { name: '작업 실행 설정', exact: true }).click();
  await dialog.getByLabel('작업 유형', { exact: true }).selectOption('prd.create');
  await expect(dialog.locator('#codex-effort')).toHaveValue('high');
  await expect(dialog.locator('#claude-model')).toHaveValue('haiku');
  await expect(dialog.locator('#claude-effort')).toBeDisabled();
  await dialog.locator('.backend-settings').screenshot({ path: info.outputPath('model-effort-selectors.png') });
});

test('legacy model and unsupported effort stay visible and unchanged until supported replacements are selected', async ({ page }) => {
  const backends = { codex: { model: 'gpt-5.5', effort: 'ultra' }, claude: { model: 'private-claude-legacy', effort: 'high' } };
  const original = seed(backends);
  const dialog = await open(page);
  await expect(dialog.locator('#codex-effort')).toHaveValue('ultra');
  await expect(dialog.locator('#codex-effort option:checked')).toContainText('기존 저장값');
  await expect(dialog.locator('#codex-selection-notice')).toContainText('현재 모델에서 지원하지 않습니다');
  await expect(dialog.locator('#claude-model')).toHaveValue('private-claude-legacy');
  await expect(dialog.locator('#claude-model option:checked')).toContainText('기존 저장값');
  await expect(dialog.locator('#claude-selection-notice')).toContainText('지원 목록에 없는 저장된 모델');
  await expect(dialog.locator('#claude-effort')).toHaveValue('high');
  expect(fs.readFileSync(original.file)).toEqual(original.bytes);
  await dialog.getByRole('tab', { name: '원문 편집' }).click();
  await dialog.getByLabel('작업 지시문', { exact: true }).fill('모델 선택은 유지하고 작업 지시문만 수정한다.');
  await save(page, dialog);
  let saved = (await h.runtime('/execution-settings')).tasks.find(task => task.id === 'prd.create');
  for (const engine of ['codex', 'claude']) expect(saved.backends[engine]).toMatchObject(backends[engine]);
  await dialog.locator('#codex-model').selectOption('gpt-5.6-luna');
  await expect(dialog.locator('#codex-effort')).toHaveValue('');
  await expect(dialog.locator('#codex-effort option[data-legacy]')).toHaveCount(0);
  await dialog.locator('#claude-model').selectOption('haiku');
  await expect(dialog.locator('#claude-model option[data-legacy]')).toHaveCount(0);
  await expect(dialog.locator('#claude-effort')).toHaveValue('');
  await expect(dialog.locator('#claude-effort')).toBeDisabled();
  await save(page, dialog);
  saved = (await h.runtime('/execution-settings')).tasks.find(task => task.id === 'prd.create');
  expect(saved.backends.codex).toMatchObject({ model: 'gpt-5.6-luna', effort: null });
  expect(saved.backends.claude).toMatchObject({ model: 'haiku', effort: null });
});

test('an existing no-effort model retains its legacy effort until cleared and cannot become the active backend while invalid', async ({ page }) => {
  seed({ codex: { model: null, effort: null }, claude: { model: 'haiku', effort: 'high' } });
  const dialog = await open(page);
  await expect(dialog.locator('#claude-effort')).toHaveValue('high');
  await expect(dialog.locator('#claude-effort')).toBeEnabled();
  await expect(dialog.locator('#claude-selection-notice')).toContainText('현재 모델에서 지원하지 않습니다');
  await save(page, dialog);
  const unchanged = await h.runtime('/execution-settings');
  expect(unchanged.tasks.find(task => task.id === 'prd.create').backends.claude).toMatchObject({ model: 'haiku', effort: 'high' });
  await dialog.locator('#task-backend').selectOption('claude');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect((await h.runtime('/execution-settings')).revision).toBe(unchanged.revision);
  await dialog.locator('#claude-effort').selectOption('');
  await expect(dialog.locator('#claude-effort')).toBeDisabled();
  await expect(dialog.locator('#claude-effort option[data-legacy]')).toHaveCount(0);
  await save(page, dialog);
  const saved = (await h.runtime('/execution-settings')).tasks.find(task => task.id === 'prd.create');
  expect(saved.backend).toBe('claude');
  expect(saved.backends.claude).toMatchObject({ model: 'haiku', effort: null });
});
