import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); h.env = { HARNESS_TEST_TASK_DRAFT_DELAY_MS: '120' };
  await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => h.close());

const request = '팀 리더를 위한 주간 회의 기록을 작성합니다. 회의 메모를 받아 결정, 담당자와 기한을 Markdown으로 정리하고 실제 메시지 발송은 하지 않습니다.';
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.getByRole('button', { name: '작업 실행 설정', exact: true }).click();
  await page.getByRole('tab', { name: '하네스 작업', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '사용자 작업 등록', exact: true }).click();
  return dialog;
}
async function generate(page, dialog, value = request) {
  await dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true }).fill(value);
  const response = page.waitForResponse(response => response.url().endsWith('/api/execution-settings/custom-task-drafts') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).click();
  const accepted = await (await response).json();
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toBeVisible();
  return accepted;
}

test('guided task generation prefills an editable registration without registering and retains Codex profile defaults', async ({ page }, info) => {
  const initial = await h.runtime('/execution-settings');
  const template = initial.tasks.find(task => task.id === 'document.share.create');
  await h.runtime('/execution-settings/document.share.create', { method: 'PUT', body: {
    revision: initial.revision, instruction: template.instruction, backend: 'claude',
    backends: { codex: { model: 'gpt-5.5', effort: 'low' }, claude: { model: 'opus', effort: 'max' } }
  } });
  const dialog = await open(page), submissions = [];
  page.on('request', request => { if (request.url().endsWith('/api/execution-settings/custom-task-drafts') && request.method() === 'POST') submissions.push(request.postDataJSON()); });
  await expect(dialog.getByRole('region', { name: '작업 설명 안내' })).toContainText('목적과 대상');
  await expect(dialog.getByRole('region', { name: '작업 설명 안내' })).toContainText('품질 기준과 제약');
  await expect(dialog.getByRole('button', { name: '등록', exact: true })).toHaveCount(0);
  await dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true }).fill(request);
  await dialog.screenshot({ path: info.outputPath('draft-request.png') });
  await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).dispatchEvent('click');
  await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).dispatchEvent('click');
  await expect(dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0].request).toBe(request);
  expect(submissions[0].idempotency_key).toMatch(/^[a-f0-9-]{36}$/);
  const runs = await h.runtime('/runs');
  const generated = runs.find(run => run.task === 'task.type.draft');
  const result = await h.runtime(`/execution-settings/custom-task-drafts/${generated.id}`);
  expect(result.status).toBe('completed');
  await expect(dialog.getByLabel('기반 작업 유형', { exact: true })).toHaveValue(result.draft.template_id);
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue(result.draft.label);
  await expect(dialog.getByLabel('작업 목적', { exact: true })).toHaveValue(result.draft.description);
  await expect(dialog.getByLabel('선택 키워드', { exact: true })).toHaveValue(result.draft.routing_terms.join(', '));
  await expect(dialog.locator('#task-instruction')).toHaveValue(result.draft.instruction);
  await expect(dialog.getByLabel('기본 backend', { exact: true })).toHaveValue('codex');
  await expect(dialog.locator('#codex-model')).toHaveValue('');
  await expect(dialog.locator('#codex-effort')).toHaveValue('');
  await expect(dialog.locator('#codex-effort option:checked')).toHaveText('유형 기본값 사용 · high');
  expect((await h.runtime('/execution-settings')).tasks.filter(task => task.source === 'user')).toEqual([]);
  const register = dialog.getByRole('button', { name: '등록', exact: true });
  await expect(register).toHaveCount(1);
  await expect(register).toBeInViewport({ ratio: 1 });
  await dialog.screenshot({ path: info.outputPath('generated-registration.png') });
  await page.setViewportSize({ width: 1280, height: 650 });
  await expect(register).toBeInViewport({ ratio: 1 });
  const body = dialog.locator('.custom-task-registration-body');
  await body.evaluate(element => element.scrollTop = element.scrollHeight);
  const bodyBounds = await body.boundingBox(), footerBounds = await dialog.locator('.custom-task-registration-actions').boundingBox();
  expect(bodyBounds.y + bodyBounds.height).toBeLessThanOrEqual(footerBounds.y + 1);
  await expect(dialog.locator('#claude-effort')).toBeInViewport({ ratio: 1 });
  await expect(register).toBeInViewport({ ratio: 1 });
  await dialog.screenshot({ path: info.outputPath('generated-registration-scrolled.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await body.evaluate(element => element.scrollTop = 0);
  await register.click();
  await expect(page.locator('#toast')).toHaveText('사용자 작업을 등록했습니다.');
  const saved = (await h.runtime('/execution-settings')).tasks.find(task => task.source === 'user');
  expect(saved).toMatchObject({ ...result.draft, backend: 'codex' });
  expect(saved.backends.codex).toMatchObject({ model: null, effort: null });
});

test('request editing preserves existing form changes until explicit regeneration replaces the draft', async ({ page }) => {
  const dialog = await open(page);
  await generate(page, dialog);
  await dialog.getByLabel('작업 이름', { exact: true }).fill('직접 수정한 회의 기록');
  await dialog.getByRole('tab', { name: '원문 편집', exact: true }).click();
  await dialog.getByLabel('작업 지시문', { exact: true }).fill('# 직접 수정\n\n수동 편집 내용을 보존한다.');
  await dialog.getByLabel('기본 backend', { exact: true }).selectOption('claude');
  await dialog.locator('#claude-model').selectOption('haiku');
  await dialog.getByRole('button', { name: '요청 수정·다시 작성', exact: true }).click();
  await expect(dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true })).toHaveValue(request);
  const next = '고객 지원 담당자에게 전달할 장애 대응 기록입니다. 로그를 읽어 원인 가설과 후속 확인 사항을 정리하고 서비스 변경은 하지 않습니다.';
  await dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true }).fill(next);
  await dialog.getByRole('button', { name: '초안으로 돌아가기', exact: true }).click();
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue('직접 수정한 회의 기록');
  await expect(dialog.locator('#task-instruction')).toHaveValue('# 직접 수정\n\n수동 편집 내용을 보존한다.');
  await expect(dialog.locator('#task-backend')).toHaveValue('claude');
  await expect(dialog.locator('#claude-model')).toHaveValue('haiku');
  await dialog.getByRole('button', { name: '요청 수정·다시 작성', exact: true }).click();
  await expect(dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true })).toHaveValue(next);
  await expect(dialog.locator('#custom-draft-help')).toContainText('현재 등록 초안이 새 내용으로 바뀝니다');
  await generate(page, dialog, next);
  await expect(dialog.getByLabel('작업 이름', { exact: true })).not.toHaveValue('직접 수정한 회의 기록');
  await expect(dialog.getByLabel('작업 목적', { exact: true })).toHaveValue(next);
  await expect(dialog.locator('#task-backend')).toHaveValue('codex');
  await expect(dialog.locator('#claude-model')).toHaveValue('');
  expect((await h.runtime('/execution-settings')).tasks.filter(task => task.source === 'user')).toEqual([]);
});

test('failed generation preserves the request and offers manual entry without applying invalid output', async ({ page }) => {
  await h.stop('runtime'); h.env.HARNESS_TEST_TASK_DRAFT_SCENARIO = 'draft-unknown-template'; await h.start('runtime');
  const dialog = await open(page);
  await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('고려할 사항을 입력');
  expect(await h.runtime('/runs')).toEqual([]);
  await dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true }).fill(request);
  await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '등록 내용 작성', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true })).toHaveValue(request);
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveCount(0);
  expect((await h.runtime('/execution-settings')).tasks.filter(task => task.source === 'user')).toEqual([]);
  await dialog.getByRole('button', { name: '직접 입력', exact: true }).click();
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toBeEditable();
});

test('cancelled, replaced and closed draft requests cannot overwrite a manual or newer form', async ({ page }) => {
  const polls = new Map(), cancelled = [], records = [];
  let sequence = 0;
  await page.route('**/api/execution-settings/custom-task-drafts**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/cancel')) { cancelled.push(pathname.split('/').at(-2)); return route.fulfill({ json: { status: 'cancelled', draft: null } }); }
    if (route.request().method() === 'POST') {
      const id = `draft-${++sequence}`; records.push(id);
      return route.fulfill({ json: { id, status: 'pending', message: null, draft: null } });
    }
    const id = pathname.split('/').at(-1);
    await new Promise(resolve => polls.set(id, resolve));
    return route.fulfill({ json: { id, status: 'completed', message: null, draft: {
      template_id: 'document.create', label: `생성 내용 ${id}`, description: `${id} 목적`, routing_terms: [id], instruction: `# ${id}\n\n등록 초안`
    } } });
  });
  const dialog = await open(page);
  const start = async value => {
    const expected = records.length + 1;
    await dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true }).fill(value);
    await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).click();
    await expect.poll(() => records.length).toBe(expected);
    const id = records[expected - 1]; await expect.poll(() => polls.has(id)).toBe(true); return id;
  };
  const release = async id => {
    const response = page.waitForResponse(response => response.url().endsWith(`/${id}`) && response.request().method() === 'GET');
    polls.get(id)(); await response;
  };
  const first = await start('처음 설명');
  await dialog.getByRole('button', { name: '직접 입력', exact: true }).click();
  await dialog.getByLabel('작업 이름', { exact: true }).fill('수동으로 작성 중');
  await release(first);
  await expect.poll(() => cancelled.includes(first)).toBe(true);
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue('수동으로 작성 중');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await dialog.getByRole('button', { name: '사용자 작업 등록', exact: true }).click();
  const second = await start('중단할 설명');
  await dialog.getByRole('button', { name: '작성 중단', exact: true }).click();
  const third = await start('새로운 설명');
  await release(third);
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue(`생성 내용 ${third}`);
  await release(second);
  await expect.poll(() => cancelled.includes(second)).toBe(true);
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveValue(`생성 내용 ${third}`);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await dialog.getByRole('button', { name: '사용자 작업 등록', exact: true }).click();
  const fourth = await start('닫을 설명');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '작업 실행 설정', exact: true }).click();
  await page.getByRole('tab', { name: '하네스 작업', exact: true }).click();
  await release(fourth);
  await expect.poll(() => cancelled.includes(fourth)).toBe(true);
  await expect(dialog.getByRole('heading', { name: '작업 실행 설정', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toHaveCount(0);
});

test('retrying a lost submission response reuses its idempotency key', async ({ page }) => {
  const submissions = [];
  await page.route('**/api/execution-settings/custom-task-drafts', async route => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) return route.abort('failed');
    return route.fulfill({ json: { id: 'retry-draft', status: 'blocked', message: '요청을 더 구체적으로 작성해 주세요.', draft: null } });
  });
  const dialog = await open(page);
  await dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true }).fill(request);
  await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.locator('#custom-draft-status')).toContainText('같은 요청으로 다시 시도하면 기존 작성 상태를 확인');
  await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('더 구체적으로');
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
});

test('retrying a lost poll response reuses the accepted declaration and closing its paused request cancels the worker', async ({ page }) => {
  await h.stop('runtime'); h.env.HARNESS_TEST_TASK_DRAFT_DELAY_MS = '1800'; await h.start('runtime');
  const submissions = [], responses = [];
  let abortNextPoll = true;
  page.on('request', request => { if (request.url().endsWith('/api/execution-settings/custom-task-drafts') && request.method() === 'POST') submissions.push(request.postDataJSON()); });
  page.on('response', async response => { if (response.url().endsWith('/api/execution-settings/custom-task-drafts') && response.request().method() === 'POST') responses.push(await response.json()); });
  await page.route(/\/api\/execution-settings\/custom-task-drafts\/[^/]+$/, route => {
    if (route.request().method() === 'GET' && abortNextPoll) { abortNextPoll = false; return route.abort('failed'); }
    return route.continue();
  });
  const dialog = await open(page);
  await dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true }).fill(request);
  await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.locator('#custom-draft-status')).toContainText('같은 요청으로 다시 시도하면 기존 작성 상태를 확인');
  await expect(dialog.getByRole('button', { name: '작성 중단', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).click();
  await expect(dialog.getByLabel('작업 이름', { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(2); expect(submissions[1]).toEqual(submissions[0]);
  expect(responses).toHaveLength(2); expect(responses[1].id).toBe(responses[0].id);
  expect((await h.runtime('/runs')).filter(run => run.task === 'task.type.draft')).toHaveLength(1);
  await dialog.getByRole('button', { name: '요청 수정·다시 작성', exact: true }).click();
  abortNextPoll = true;
  await dialog.getByLabel('어떤 작업을 등록할까요?', { exact: true }).fill('새로운 요청으로 또 다른 초안을 준비합니다.');
  await dialog.getByRole('button', { name: '등록 내용 작성', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect.poll(() => responses.length).toBe(3);
  const pending = responses[2].id;
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await h.runtime(`/execution-settings/custom-task-drafts/${pending}`)).status).toBe('cancelled');
  expect((await h.runtime('/runs')).filter(run => run.task === 'task.type.draft')).toHaveLength(2);
});
