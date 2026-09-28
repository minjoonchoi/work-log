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

async function openSettings(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.getByRole('button', { name: '작업 실행 설정', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: '하네스 작업', exact: true }).click();
  return dialog;
}

async function registerCustomTask() {
  const settings = await h.runtime('/execution-settings');
  const created = await h.runtime('/execution-settings/custom-tasks', { method: 'POST', body: {
    revision: settings.revision, template_id: 'document.create', label: '고객 온보딩 요약',
    description: '신규 고객의 적응 과정과 도입 결과를 설명합니다.', routing_terms: ['고객 온보딩 요약'],
    instruction: '# 고객 온보딩 요약\n\n제공된 도입 기록의 사실과 미확인 내용을 구분합니다.', backend: 'codex',
    backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } }
  } });
  return created.created_task_id;
}

const optionValues = dialog => dialog.locator('#execution-task option').evaluateAll(options => options.map(option => option.value));
const currentEditor = dialog => dialog.locator('.execution-selected-task');
const search = dialog => dialog.getByLabel('작업 유형 검색', { exact: true });
const selectTask = (dialog, id) => dialog.getByLabel('작업 유형', { exact: true }).selectOption(id);

test('installed tasks can be searched by name, identifier, category and purpose without switching the editor', async ({ page }, info) => {
  const customId = await registerCustomTask();
  const settings = await h.runtime('/execution-settings');
  const dialog = await openSettings(page);
  await expect(dialog.getByRole('combobox', { name: '작업 유형', exact: true })).toBeVisible();
  await selectTask(dialog, 'prd.create');

  await search(dialog).fill('엔티티 설계');
  expect(await optionValues(dialog)).toContain('entity.design');
  await expect(currentEditor(dialog)).toContainText('prd.create');

  await search(dialog).fill('  DOCUMENT.SHARE.CREATE  ');
  expect(await optionValues(dialog)).toEqual(['document.share.create']);
  await expect(currentEditor(dialog)).toContainText('prd.create');
  await selectTask(dialog, 'document.share.create');
  await expect(currentEditor(dialog)).toContainText('document.share.create');

  await search(dialog).fill('document');
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await dialog.screenshot({ path: info.outputPath('installed-task-search.png') });

  await search(dialog).fill('프런트엔드');
  const frontend = settings.tasks.filter(task => task.category === 'frontend' && task.installed);
  expect(frontend.length).toBeGreaterThan(0);
  for (const task of frontend) expect(await optionValues(dialog)).toContain(task.id);

  await search(dialog).fill('적응 과정');
  expect(await optionValues(dialog)).toEqual([customId]);
  await selectTask(dialog, customId);
  await expect(dialog.getByLabel('작업 목적', { exact: true })).toContainText('적응 과정');

  await search(dialog).press('Escape');
  await expect(search(dialog)).toHaveValue('');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#execution-task option')).toHaveCount(settings.tasks.filter(task => task.management_group === 'harness' && task.installed).length);
});

test('search and an empty result keep unsaved instructions and backend choices attached to the original task', async ({ page }) => {
  const before = await h.runtime('/execution-settings');
  const originalReview = before.tasks.find(task => task.id === 'code.review');
  const dialog = await openSettings(page);
  await selectTask(dialog, 'document.create');
  await dialog.getByRole('tab', { name: '원문 편집', exact: true }).click();
  const instruction = '# 검색 중인 문서 초안\n\n확인한 근거만 사용하고 누락된 정보는 미정으로 표시합니다.';
  await dialog.getByLabel('작업 지시문', { exact: true }).fill(instruction);
  await dialog.locator('#task-backend').selectOption('claude');
  await dialog.locator('#codex-model').selectOption('gpt-5.6-luna');
  await dialog.locator('#codex-effort').selectOption('high');
  await dialog.locator('#claude-model').selectOption('opus');
  await dialog.locator('#claude-effort').selectOption('max');

  await search(dialog).fill('code.review');
  expect(await optionValues(dialog)).toEqual(['code.review']);
  await expect(currentEditor(dialog)).toContainText('document.create');
  await search(dialog).fill('검색되는작업없음-unique');
  await expect(dialog.locator('#execution-task-empty')).toContainText('검색 결과가 없습니다');
  await expect(dialog.locator('#execution-task option')).toHaveCount(0);
  await expect(dialog.getByLabel('작업 지시문', { exact: true })).toHaveValue(instruction);
  await expect(dialog.getByRole('tab', { name: '원문 편집', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('#task-backend')).toHaveValue('claude');
  await expect(dialog.locator('#codex-model')).toHaveValue('gpt-5.6-luna');
  await expect(dialog.locator('#codex-effort')).toHaveValue('high');
  await expect(dialog.locator('#claude-model')).toHaveValue('opus');
  await expect(dialog.locator('#claude-effort')).toHaveValue('max');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('작업 실행 설정을 저장했습니다.');
  const after = await h.runtime('/execution-settings'), saved = after.tasks.find(task => task.id === 'document.create');
  expect(saved.instruction).toBe(instruction); expect(saved.backend).toBe('claude');
  expect(saved.backends.codex).toMatchObject({ model: 'gpt-5.6-luna', effort: 'high' });
  expect(saved.backends.claude).toMatchObject({ model: 'opus', effort: 'max' });
  expect(after.tasks.find(task => task.id === 'code.review')).toEqual(originalReview);
  await dialog.getByRole('button', { name: '검색 지우기', exact: true }).click();
  await expect(dialog.getByLabel('작업 유형', { exact: true })).toHaveValue('document.create');
});

test('package navigation restores search, selected custom task and unsaved form after an unrelated package change', async ({ page }, info) => {
  const customId = await registerCustomTask(), before = await h.runtime('/execution-settings');
  const original = before.tasks.find(task => task.id === customId);
  const packageSnapshot = await h.runtime('/harness-packages');
  const frontend = packageSnapshot.packages.find(value => value.id === 'frontend');
  const dialog = await openSettings(page);
  await search(dialog).fill('온보딩');
  await selectTask(dialog, customId);
  await dialog.getByLabel('작업 이름', { exact: true }).fill('도입 진행 결과 정리');
  await dialog.getByLabel('작업 목적', { exact: true }).fill('공유받은 도입 기록으로 진행 상황을 설명합니다.');
  await dialog.getByLabel('선택 키워드', { exact: true }).fill('도입 진행 정리, 고객 도입 기록');
  await dialog.getByRole('tab', { name: '원문 편집', exact: true }).click();
  const instruction = '# 아직 저장하지 않은 지시문\n\n도입 배경과 확인된 결과를 작성합니다.';
  await dialog.getByLabel('작업 지시문', { exact: true }).fill(instruction);
  await dialog.locator('#task-backend').selectOption('claude');
  await dialog.locator('#codex-model').selectOption('gpt-5.6-luna');
  await dialog.locator('#codex-effort').selectOption('xhigh');
  await dialog.locator('#claude-model').selectOption('opus');
  await dialog.locator('#claude-effort').selectOption('max');
  await dialog.getByRole('region', { name: '작업 책임 경계' }).getByText('필요 자료와 완료 기준').click();
  await dialog.getByRole('button', { name: '직무 패키지 관리', exact: true }).click();
  const frontendCard = dialog.getByRole('region', { name: `${frontend.label} 패키지`, exact: true });
  const back = dialog.getByRole('button', { name: '작업 실행 설정으로 돌아가기', exact: true });
  await expect(dialog.getByRole('heading', { name: '직무별 하네스 작업', exact: true })).toBeFocused();
  await expect(back).toBeInViewport();
  const [dialogBox, backBox] = await Promise.all([dialog.boundingBox(), back.boundingBox()]);
  expect(backBox.y).toBeGreaterThanOrEqual(dialogBox.y);
  expect(backBox.y + backBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height);
  await dialog.screenshot({ path: info.outputPath('package-management-return.png') });
  await frontendCard.getByRole('button', { name: '제거', exact: true }).click();
  await expect(frontendCard).toContainText('미설치');
  await dialog.getByRole('button', { name: '작업 실행 설정으로 돌아가기', exact: true }).click();

  await expect(dialog.getByRole('tab', { name: '하네스 작업', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(search(dialog)).toHaveValue('온보딩');
  await expect(dialog.getByLabel('작업 유형', { exact: true })).toHaveValue(customId);
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue('도입 진행 결과 정리');
  await expect(dialog.getByLabel('작업 목적', { exact: true })).toHaveValue('공유받은 도입 기록으로 진행 상황을 설명합니다.');
  await expect(dialog.getByLabel('선택 키워드', { exact: true })).toHaveValue('도입 진행 정리, 고객 도입 기록');
  await expect(dialog.getByLabel('작업 지시문', { exact: true })).toHaveValue(instruction);
  await expect(dialog.getByRole('tab', { name: '원문 편집', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('#task-backend')).toHaveValue('claude');
  await expect(dialog.locator('#codex-model')).toHaveValue('gpt-5.6-luna');
  await expect(dialog.locator('#codex-effort')).toHaveValue('xhigh');
  await expect(dialog.locator('#claude-model')).toHaveValue('opus');
  await expect(dialog.locator('#claude-effort')).toHaveValue('max');
  await expect(dialog.locator('#task-boundary details')).toHaveAttribute('open', '');
  expect((await h.runtime('/execution-settings')).tasks.find(task => task.id === customId)).toEqual(original);

  await dialog.getByRole('button', { name: '검색 지우기', exact: true }).click();
  for (const taskId of frontend.task_ids) await expect(dialog.locator(`#execution-task option[value="${taskId}"]`)).toHaveCount(0);
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('작업 실행 설정을 저장했습니다.');
  const saved = (await h.runtime('/execution-settings')).tasks.find(task => task.id === customId);
  expect(saved).toMatchObject({ label: '도입 진행 결과 정리', description: '공유받은 도입 기록으로 진행 상황을 설명합니다.', instruction, backend: 'claude' });
  expect(saved.routing_terms).toEqual(['도입 진행 정리', '고객 도입 기록']);
  expect(saved.backends.codex).toMatchObject({ model: 'gpt-5.6-luna', effort: 'xhigh' });
  expect(saved.backends.claude).toMatchObject({ model: 'opus', effort: 'max' });
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await dialog.screenshot({ path: info.outputPath('task-search-and-package-return.png') });
});

test('removing the selected package cannot transfer an unsaved draft to the visible fallback task', async ({ page }) => {
  const before = await h.runtime('/execution-settings'), packages = await h.runtime('/harness-packages');
  const common = packages.packages.find(value => value.id === 'common');
  const dialog = await openSettings(page);
  await search(dialog).fill('document.create');
  await selectTask(dialog, 'document.create');
  await dialog.getByRole('tab', { name: '원문 편집', exact: true }).click();
  const unsaved = '# 제거되는 작업의 저장 전 수정\n\n다른 작업에 적용하면 안 됩니다.';
  await dialog.getByLabel('작업 지시문', { exact: true }).fill(unsaved);
  await dialog.getByRole('button', { name: '직무 패키지 관리', exact: true }).click();
  const card = dialog.getByRole('region', { name: `${common.label} 패키지`, exact: true });
  await card.getByRole('button', { name: '제거', exact: true }).click();
  await expect(card).toContainText('미설치');
  await dialog.getByRole('button', { name: '작업 실행 설정으로 돌아가기', exact: true }).click();
  await expect(currentEditor(dialog)).not.toContainText('document.create');
  await expect(dialog.locator('#execution-task option[value="document.create"]')).toHaveCount(0);
  await expect(dialog.getByLabel('작업 지시문', { exact: true })).not.toHaveValue(unsaved);
  await search(dialog).fill('');
  const fallback = await dialog.getByLabel('작업 유형', { exact: true }).inputValue();
  expect(fallback).toBeTruthy(); expect(common.task_ids).not.toContain(fallback);
  await expect(dialog.getByLabel('작업 지시문', { exact: true })).toHaveValue(before.tasks.find(task => task.id === fallback).instruction);
  const after = await h.runtime('/execution-settings');
  expect(after.tasks.find(task => task.id === 'document.create').instruction).toBe(before.tasks.find(task => task.id === 'document.create').instruction);
  expect(after.tasks.find(task => task.id === fallback).instruction).toBe(before.tasks.find(task => task.id === fallback).instruction);
});

test('no installed packages leaves an empty harness list while WorkLog generation remains usable and package install repopulates it', async ({ page }) => {
  let packages = await h.runtime('/harness-packages');
  for (const entry of packages.packages.filter(value => value.installed)) {
    packages = await h.manager(`/harness-packages/${entry.id}`, { method: 'PUT', body: { installed: false, revision: packages.revision } });
  }
  const dialog = await openSettings(page);
  await expect(dialog.locator('#execution-task option')).toHaveCount(0);
  await expect(dialog.locator('#execution-task-empty')).toContainText('설치된 작업 유형이 없습니다');
  await expect(dialog.getByRole('button', { name: '사용자 작업 등록', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '저장', exact: true })).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'WorkLog 자동 생성', exact: true }).click();
  await expect(dialog.locator('#execution-task option')).toHaveCount(5);
  await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
  await dialog.getByRole('tab', { name: '하네스 작업', exact: true }).click();
  await dialog.getByRole('button', { name: '직무 패키지 관리', exact: true }).click();
  const po = packages.packages.find(entry => entry.id === 'po');
  const card = dialog.getByRole('region', { name: `${po.label} 패키지`, exact: true });
  await card.getByRole('button', { name: '설치', exact: true }).click();
  await expect(card).toContainText('설치됨');
  await dialog.getByRole('button', { name: '작업 실행 설정으로 돌아가기', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: '하네스 작업', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect((await optionValues(dialog)).sort()).toEqual([...po.task_ids].sort());
  await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
});
