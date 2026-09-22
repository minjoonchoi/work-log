import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => h.close());

const baseline = () => ({ available: true, connections: ['codex', 'claude'].map(engine => ({ engine, state: 'disconnected', message: 'WorkLog에 연결되지 않았습니다.', paths: [] })) });
async function fixture(page, snapshot = baseline()) {
  const state = { snapshot, writes: [], reads: 0, failRead: false, writeError: null, beforeWrite: null };
  await page.route('**/api/agent-connections**', async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      state.reads++;
      if (state.failRead) { state.failRead = false; return route.abort('failed'); }
      return route.fulfill({ json: state.snapshot });
    }
    const engine = new URL(request.url()).pathname.split('/').at(-1);
    state.writes.push({ engine, method: request.method(), body: request.postDataJSON() });
    await state.beforeWrite?.();
    if (state.writeError) return route.fulfill({ status: 409, json: { error: state.writeError } });
    const connection = state.snapshot.connections.find(row => row.engine === engine);
    connection.state = request.method() === 'DELETE' ? 'disconnected' : 'connected';
    connection.message = connection.state === 'connected' ? 'work 스킬과 대화 기록 수집이 연결되었습니다.' : 'WorkLog 연결을 해제했습니다. 기존 사용자 설정은 유지됩니다.';
    return route.fulfill({ json: state.snapshot });
  });
  return state;
}
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  return page.getByRole('dialog');
}

test('Codex and Claude connect independently, pending actions do not duplicate, and disconnect leaves the other connection intact', async ({ page }, info) => {
  const state = await fixture(page);
  const dialog = await open(page), codex = dialog.getByRole('region', { name: 'Codex', exact: true }), claude = dialog.getByRole('region', { name: 'Claude', exact: true });
  await expect(dialog).toContainText('자동으로 연결되지 않습니다');
  await expect(codex).toContainText('연결 안 됨'); await expect(claude).toContainText('연결 안 됨');
  expect(state.writes).toEqual([]);
  let release;
  state.beforeWrite = () => new Promise(resolve => { release = resolve; });
  await codex.getByRole('button', { name: '연결', exact: true }).click();
  await expect(codex.getByRole('button', { name: '연결 중', exact: true })).toBeDisabled();
  await page.locator('#connect-codex').dispatchEvent('click');
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(dialog.getByRole('button', { name: '상태 새로고침', exact: true })).toBeDisabled();
  release(); state.beforeWrite = null;
  await expect(codex).toContainText('연결됨'); await expect(claude).toContainText('연결 안 됨');
  await claude.getByRole('button', { name: '연결', exact: true }).click();
  await expect(claude).toContainText('연결됨');
  await codex.getByRole('button', { name: '연결 해제', exact: true }).click();
  await expect(codex).toContainText('연결 안 됨'); await expect(claude).toContainText('연결됨');
  expect(state.writes).toEqual([{ engine: 'codex', method: 'POST', body: {} }, { engine: 'claude', method: 'POST', body: {} }, { engine: 'codex', method: 'DELETE', body: {} }]);
  await dialog.screenshot({ path: info.outputPath('agent-connections.png') });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await expect(claude).toContainText('연결됨');
});

test('refresh recovers a read failure and a rejected repair displays the current state without rendering server text as HTML', async ({ page }) => {
  const state = await fixture(page); state.failRead = true;
  const dialog = await open(page);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(page.locator('#connect-codex')).toBeDisabled();
  await dialog.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await expect(page.locator('#connect-codex')).toBeEnabled();
  const untrusted = '<img src=x onerror="window.connectionInjected=1">';
  state.snapshot.connections[0] = { engine: 'codex', state: 'needs_attention', message: untrusted, paths: [`/temporary/${untrusted}`] };
  await dialog.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  const codex = dialog.getByRole('region', { name: 'Codex', exact: true });
  await expect(codex).toContainText('확인 필요'); await expect(codex).toContainText(untrusted);
  await codex.locator('summary').click(); await expect(codex.locator('li')).toContainText(untrusted);
  state.writeError = '다른 사용자 설정과 충돌합니다. 기존 설정을 확인하세요.';
  const reads = state.reads;
  await codex.getByRole('button', { name: '다시 연결', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(state.writeError);
  await expect.poll(() => state.reads).toBe(reads + 1);
  await expect(codex.getByRole('button', { name: '다시 연결', exact: true })).toBeEnabled();
  await expect(codex).toContainText('확인 필요');
  expect(await page.evaluate(() => window.connectionInjected)).toBeUndefined(); await expect(dialog.locator('img')).toHaveCount(0);
  state.writeError = null;
  await codex.getByRole('button', { name: '다시 연결', exact: true }).click();
  await expect(codex).toContainText('연결됨'); await expect(dialog.getByRole('alert')).toBeHidden();
});

test('an uninstalled environment disables agent mutations while Atlassian settings remain accessible', async ({ page }) => {
  const snapshot = baseline(); snapshot.available = false;
  const state = await fixture(page, snapshot), dialog = await open(page);
  await expect(dialog).toContainText('설치된 WorkLog 환경에서 연결');
  await expect(page.locator('#connect-codex')).toBeDisabled(); await expect(page.locator('#connect-claude')).toBeDisabled();
  await page.locator('#connect-codex').dispatchEvent('click'); expect(state.writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Atlassian 설정', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Atlassian 연결 설정', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Client ID', { exact: true })).toBeEditable();
});

test('connected configuration waits for actual hooks and then shows delivery without restarting the settings dialog', async ({ page }) => {
  const snapshot = baseline();
  snapshot.connections[0] = { engine: 'codex', state: 'connected', message: '훅 설정이 연결되었습니다.', paths: [],
    collection: { state: 'awaiting_hook', last_event_at: null } };
  const state = await fixture(page, snapshot), dialog = await open(page);
  const codex = dialog.getByRole('region', { name: 'Codex', exact: true });
  await expect(codex).toContainText('훅 수신 대기');
  await expect(codex).toContainText('첫 입력 훅이 도착하면 업무를 자동 등록');
  await expect(codex).toContainText('/hooks');
  state.snapshot.connections[0].collection = { state: 'observed', last_event_at: '2026-09-21T14:00:00.000Z', last_event_kind: 'input' };
  await expect(codex).toContainText('훅 수신 확인', { timeout: 8000 });
  expect(state.writes).toEqual([]);
});

test('late connection responses cannot replace Atlassian settings or a reopened connections dialog', async ({ page }) => {
  const state = await fixture(page), dialog = await open(page);
  const gates = [];
  state.beforeWrite = () => new Promise(resolve => gates.push(resolve));
  await page.locator('#connect-codex').click(); await expect.poll(() => gates.length).toBe(1);
  await dialog.getByRole('button', { name: 'Atlassian 설정', exact: true }).click();
  await dialog.getByLabel('Client ID', { exact: true }).fill('preserve-unsaved-client');
  let response = page.waitForResponse(value => value.url().endsWith('/api/agent-connections/codex'));
  gates[0](); await response;
  await expect(dialog.getByLabel('Client ID', { exact: true })).toHaveValue('preserve-unsaved-client');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await page.locator('#connect-claude').click(); await expect.poll(() => gates.length).toBe(2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await expect(page.locator('#connect-claude')).toBeEnabled();
  response = page.waitForResponse(value => value.url().endsWith('/api/agent-connections/claude'));
  gates[1](); await response;
  await expect(dialog.getByRole('region', { name: 'Claude', exact: true })).toContainText('연결 안 됨');
  await dialog.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Claude', exact: true })).toContainText('연결됨');
});

test('Confluence publishing opens Atlassian setup directly without the agent connections hub', async ({ page }) => {
  const state = await fixture(page);
  const report = { id: 'local-report', title: '로컬 업무 요약', state: 'completed', dates: ['2026-09-21'], created_at: '2026-09-21T03:00:00Z', timezone: 'Asia/Seoul', session_count: 0, body: '## 업무\n\n구현 결과를 확인했습니다.' };
  await page.route('**/api/reports', route => route.fulfill({ json: [report] }));
  await page.route('**/api/reports/local-report', route => route.fulfill({ json: { report, sessions: [], parts: [], publications: [] } }));
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.getByRole('button', { name: '업무 요약', exact: true }).click();
  await page.getByRole('button', { name: report.title, exact: true }).click();
  await page.getByRole('button', { name: 'Confluence 게시', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Atlassian 연결 설정', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Client ID', { exact: true })).toBeEditable();
  expect(state.reads).toBe(0); expect(state.writes).toEqual([]);
});
