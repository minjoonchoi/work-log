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

test('task settings group the complete catalog and preserve responsibility when instructions change', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.getByRole('button', { name: '작업 실행 설정' }).click();
  const dialog = page.getByRole('dialog');
  const settings = await h.runtime('/execution-settings');
  await expect(dialog.locator('#execution-task option')).toHaveCount(settings.tasks.length);
  expect(await dialog.locator('#execution-task optgroup').evaluateAll(groups => groups.map(group => group.label))).toEqual([
    '제품 · PO', '프로젝트 · PM', '공통 설계', '프런트엔드', '백엔드', '개발 공통', '조사·문서', '시스템 작업'
  ]);
  const boundary = dialog.getByRole('region', { name: '작업 책임 경계' });
  await dialog.getByLabel('작업 유형').selectOption('document.share.create');
  await expect(dialog.locator('#instruction-preview').getByRole('heading', { name: '업무 공유 문서 작성', exact: true })).toBeVisible();
  await expect(boundary).toContainText('sharing-document.md');
  await expect(dialog.locator('#instruction-preview')).toContainText('배경과 맥락');
  await expect(dialog.locator('#instruction-preview')).toContainText('요청과 다음 단계');
  await dialog.getByLabel('작업 유형').selectOption('code.review');
  await expect(boundary).toContainText('코드 자동 수정');
  await expect(boundary).toContainText('code-review.md');
  await boundary.getByText('필요 자료와 완료 기준').click();
  await expect(boundary).toContainText('검토 대상 버전을 고정한다');
  await dialog.getByRole('tab', { name: '원문 편집' }).click();
  await dialog.getByLabel('작업 지시문').fill('성급하게 합격시키지 않고 원문 요구와 변경 내용을 대조한다.');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('작업 실행 설정을 저장했습니다.');
  await expect(boundary).toContainText('코드 자동 수정');
  const saved = (await h.runtime('/execution-settings')).tasks.find(task => task.id === 'code.review');
  expect(saved.boundary).toEqual(settings.tasks.find(task => task.id === 'code.review').boundary);
  expect(saved.instruction).toContain('원문 요구');
  await dialog.getByLabel('작업 유형').selectOption('frontend.implement');
  await expect(boundary).toContainText('changes.json');
  await expect(boundary).toContainText('BE 코드·API 계약 변경');
  await dialog.getByLabel('작업 유형').selectOption('session.summarize');
  await expect(boundary).toContainText('제목 1줄과 최대 5개 bullet 항목');
  await expect(boundary).toContainText("'- '로 시작하는 1~5개 bullet 항목이며 항목마다 줄을 바꾼다.");
});
