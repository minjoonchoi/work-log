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
  await page.getByRole('button', { name: '작업 실행 설정' }).click();
  await page.getByRole('tab', { name: '하네스 작업', exact: true }).click();
  return page.getByRole('dialog');
}
async function draft(dialog, { label = '주간 회의 기록', description = '회의 결정과 다음 행동을 정리한다.', terms = '주간 회의 기록, 주간결정정리' } = {}) {
  await dialog.getByRole('button', { name: '사용자 작업 등록', exact: true }).click();
  await dialog.getByRole('button', { name: '직접 입력', exact: true }).click();
  await expect(dialog.getByLabel('기반 작업 유형', { exact: true })).toHaveValue('document.create');
  await dialog.getByLabel('작업 이름', { exact: true }).fill(label);
  await dialog.getByLabel('작업 목적', { exact: true }).fill(description);
  await dialog.getByLabel('선택 키워드', { exact: true }).fill(terms);
}
async function register(page, dialog) {
  await dialog.getByRole('button', { name: '등록', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('사용자 작업을 등록했습니다.');
  return dialog.getByLabel('작업 유형', { exact: true }).inputValue();
}

test('custom task registration, metadata and execution edits survive runtime restart and page reload', async ({ page }, testInfo) => {
  const baseline = await h.runtime('/execution-settings');
  const template = baseline.tasks.find(task => task.id === 'document.create');
  const dialog = await open(page);
  await draft(dialog);
  await expect(dialog.locator('#custom-task-template option')).toHaveCount(baseline.templates.length);
  expect(await dialog.locator('#custom-task-template option').evaluateAll(options => options.map(option => option.value))).not.toContain('session.summarize');
  await dialog.getByLabel('기반 작업 유형', { exact: true }).selectOption('code.review');
  await expect(dialog.getByRole('region', { name: '작업 책임 경계' })).toContainText('code-review.md');
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue('주간 회의 기록');
  await dialog.getByLabel('기반 작업 유형', { exact: true }).selectOption('document.create');
  await dialog.getByRole('tab', { name: '원문 편집' }).click();
  await dialog.getByLabel('작업 지시문', { exact: true }).fill('# 주간 회의 기록\n\n- 결정과 담당자를 정리한다.\n- 후속 행동의 기한을 기록한다.');
  await dialog.getByLabel('기본 backend', { exact: true }).selectOption('claude');
  await dialog.locator('#codex-model').selectOption('gpt-5.5');
  await dialog.locator('#codex-effort').selectOption('high');
  await dialog.locator('#claude-model').selectOption('opus');
  await dialog.locator('#claude-effort').selectOption('xhigh');
  const id = await register(page, dialog);
  expect(id).toMatch(/^user\./);
  await expect(dialog.locator('#execution-task optgroup[label="사용자 작업"] option')).toHaveCount(1);
  await expect(dialog.locator('.execution-task-source')).toContainText('사용자 작업');
  await expect(dialog.locator('.custom-task-template')).toContainText('document.create');
  await expect(dialog.locator('#custom-task-template')).toHaveCount(0);
  await dialog.getByLabel('작업 이름', { exact: true }).fill('주간 결정 문서');
  await dialog.getByLabel('작업 목적', { exact: true }).fill('매주 결정의 근거, 담당자와 마감일을 공유한다.');
  await dialog.getByLabel('선택 키워드', { exact: true }).fill('주간결정문서\n 회의결정공유');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('작업 실행 설정을 저장했습니다.');
  await h.stop('runtime'); await h.start('runtime');
  await page.reload();
  await page.getByRole('button', { name: '작업 실행 설정' }).click();
  await page.getByRole('tab', { name: '하네스 작업', exact: true }).click();
  await dialog.getByLabel('작업 유형', { exact: true }).selectOption(id);
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue('주간 결정 문서');
  await expect(dialog.getByLabel('작업 목적', { exact: true })).toHaveValue('매주 결정의 근거, 담당자와 마감일을 공유한다.');
  await expect(dialog.getByLabel('선택 키워드', { exact: true })).toHaveValue('주간결정문서, 회의결정공유');
  await expect(dialog.locator('#instruction-preview')).toContainText('후속 행동의 기한');
  await expect(dialog.locator('#task-backend')).toHaveValue('claude');
  await expect(dialog.locator('#codex-model')).toHaveValue('gpt-5.5');
  await expect(dialog.locator('#claude-effort')).toHaveValue('xhigh');
  const saved = await h.runtime('/execution-settings');
  const custom = saved.tasks.find(task => task.id === id);
  expect(custom).toMatchObject({ source: 'user', template_id: 'document.create' });
  expect(custom.boundary).toMatchObject(Object.fromEntries(Object.entries(template.boundary).filter(([key]) => key !== 'owns')));
  expect(custom.boundary.owns).toContain(template.boundary.owns);
  expect(saved.tasks.filter(task => task.source !== 'user')).toEqual(baseline.tasks);
  await dialog.screenshot({ path: testInfo.outputPath('custom-task-settings.png') });
});

test('invalid keywords and concurrent registration show errors without discarding the draft', async ({ page, context }) => {
  const baseline = await h.runtime('/execution-settings');
  const dialog = await open(page);
  await draft(dialog, { label: '대기 중인 기록', terms: '' });
  await dialog.getByRole('button', { name: '등록', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue('대기 중인 기록');
  expect((await h.runtime('/execution-settings')).revision).toBe(baseline.revision);
  await dialog.getByLabel('선택 키워드', { exact: true }).fill(Array.from({ length: 21 }, (_, index) => `키워드${index}`).join(', '));
  await dialog.getByRole('button', { name: '등록', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect((await h.runtime('/execution-settings')).tasks).toHaveLength(baseline.tasks.length);
  await dialog.getByLabel('선택 키워드', { exact: true }).fill('대기기록정리');

  const secondPage = await context.newPage();
  const secondDialog = await open(secondPage);
  await draft(secondDialog, { label: '다른 창의 기록', terms: '다른창기록정리' });
  const firstId = await register(secondPage, secondDialog);
  await dialog.getByRole('button', { name: '등록', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('다른 창');
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue('대기 중인 기록');
  await expect(dialog.getByLabel('선택 키워드', { exact: true })).toHaveValue('대기기록정리');
  await expect(dialog.getByRole('button', { name: '등록', exact: true })).toBeEnabled();
  const conflicted = await h.runtime('/execution-settings');
  expect(conflicted.tasks.filter(task => task.source === 'user').map(task => task.id)).toEqual([firstId]);

  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '작업 실행 설정' }).click();
  await page.getByRole('tab', { name: '하네스 작업', exact: true }).click();
  await draft(dialog, { label: '대기 중인 기록', terms: '대기기록정리' });
  const secondId = await register(page, dialog);
  expect(secondId).not.toBe(firstId);
  await expect(dialog.locator('#execution-task optgroup[label="사용자 작업"] option')).toHaveCount(2);
  const beforeDuplicate = await h.runtime('/execution-settings');
  await draft(dialog, { label: '다른 창의 기록', terms: '중복이름확인' });
  await dialog.getByRole('button', { name: '등록', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('같은 이름');
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue('다른 창의 기록');
  expect(await h.runtime('/execution-settings')).toEqual(beforeDuplicate);
});

test('custom metadata and Markdown stay text, reset retains registration, and confirmed deletion preserves built-ins', async ({ page }) => {
  const baseline = await h.runtime('/execution-settings');
  const dialog = await open(page);
  await expect(dialog.getByRole('button', { name: '작업 등록 삭제', exact: true })).toHaveCount(0);
  const label = '<img src=x onerror="window.customExecuted=true">';
  const description = '</textarea><script>window.customExecuted=true</script>';
  await draft(dialog, { label, description, terms: '검증기록정리' });
  await dialog.getByRole('tab', { name: '원문 편집' }).click();
  await dialog.getByLabel('작업 지시문', { exact: true }).fill('# 안전한 기록\n\n**결정**을 기록한다.\n\n<script>window.customExecuted=true</script>\n<img src=x onerror="window.customExecuted=true">');
  await dialog.getByRole('tab', { name: '미리보기' }).click();
  await expect(dialog.locator('#instruction-preview strong')).toHaveText('결정');
  await expect(dialog.locator('#instruction-preview script, #instruction-preview img')).toHaveCount(0);
  const id = await register(page, dialog);
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue(label);
  await expect(dialog.getByLabel('작업 목적', { exact: true })).toHaveValue(description);
  expect(await page.evaluate(() => window.customExecuted)).toBeUndefined();
  await dialog.getByRole('button', { name: '기본값 복원', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('유형 기본값으로 복원했습니다.');
  await expect(dialog.getByLabel('작업 유형', { exact: true })).toHaveValue(id);
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue(label);
  await expect(dialog.locator('#instruction-preview')).not.toContainText('안전한 기록');
  expect((await h.runtime('/execution-settings')).tasks.find(task => task.id === id)).toMatchObject({ label, description, routing_terms: ['검증기록정리'], overridden: false });
  await dialog.getByRole('button', { name: '작업 등록 삭제', exact: true }).click();
  const confirmation = dialog.getByRole('region', { name: '작업 등록 삭제 확인' });
  await expect(confirmation).toContainText(label);
  await expect(confirmation).toContainText('기존 실행 기록은 유지됩니다');
  await expect(confirmation.locator('img, script')).toHaveCount(0);
  await confirmation.getByRole('button', { name: '취소', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(dialog.getByLabel('작업 유형', { exact: true })).toHaveValue(id);
  await dialog.getByRole('button', { name: '작업 등록 삭제', exact: true }).click();
  await confirmation.getByRole('button', { name: '등록 삭제', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('사용자 작업 등록을 삭제했습니다.');
  await expect(dialog.locator('#execution-task optgroup[label="사용자 작업"]')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '작업 등록 삭제', exact: true })).toHaveCount(0);
  expect((await h.runtime('/execution-settings')).tasks).toEqual(baseline.tasks);
  expect(await page.evaluate(() => window.customExecuted)).toBeUndefined();
});
