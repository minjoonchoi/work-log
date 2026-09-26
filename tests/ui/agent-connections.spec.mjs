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

const disconnected = () => ({ state: 'disconnected', message: 'WorkLog에 연결되지 않았습니다.', paths: [] });
const baseline = () => ({ available: true, connections: ['codex', 'claude'].map(engine => ({ engine, ...disconnected(), tracking: disconnected(), harness: disconnected() })) });
async function fixture(page, snapshot = baseline()) {
  const state = { snapshot, writes: [], reads: 0, failRead: false, writeError: null, beforeWrite: null,
    packages: { revision: 0, packages: [['pm', 'PM'], ['po', 'PO'], ['frontend', '프런트엔드'], ['backend', '백엔드'], ['common', '공통']].map(([id, label]) => ({ id, label, description: `${label} 작업 유형`, installed: false, task_count: 3, task_ids: [] })) },
    packageWrites: [], packageError: null, beforePackageWrite: null };
  await page.route('**/api/agent-connections**', async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      state.reads++;
      if (state.failRead) { state.failRead = false; return route.abort('failed'); }
      return route.fulfill({ json: state.snapshot });
    }
    const [engine, kind] = new URL(request.url()).pathname.split('/').slice(-2);
    state.writes.push({ engine, kind, method: request.method(), body: request.postDataJSON() });
    await state.beforeWrite?.();
    if (state.writeError) return route.fulfill({ status: 409, json: { error: state.writeError } });
    const connection = state.snapshot.connections.find(row => row.engine === engine);
    connection[kind].state = request.method() === 'DELETE' ? 'disconnected' : 'connected';
    connection[kind].message = connection[kind].state === 'connected' ? '선택한 기능이 연결되었습니다.' : '선택한 기능의 연결을 해제했습니다.';
    connection.state = connection.tracking.state;
    return route.fulfill({ json: state.snapshot });
  });
  await page.route('**/api/harness-packages**', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: state.packages });
    const id = new URL(request.url()).pathname.split('/').at(-1), input = request.postDataJSON();
    state.packageWrites.push({ id, ...input }); await state.beforePackageWrite?.();
    if (state.packageError) return route.fulfill({ status: 409, json: { error: state.packageError } });
    state.packages.packages.find(value => value.id === id).installed = input.installed; state.packages.revision++;
    return route.fulfill({ json: state.packages });
  });
  return state;
}
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  return page.getByRole('dialog');
}

test('tracking and harness links are independent per engine, do not duplicate pending writes and persist on reopening', async ({ page }, info) => {
  const state = await fixture(page);
  const dialog = await open(page), codex = dialog.getByRole('region', { name: 'Codex 이력 수집', exact: true }), claude = dialog.getByRole('region', { name: 'Claude 이력 수집', exact: true });
  const codexHarness = dialog.getByRole('region', { name: 'Codex 하네스 위임', exact: true });
  await expect(dialog).toContainText('자동으로 연결되지 않습니다');
  await expect(codex).toContainText('연결 안 됨'); await expect(claude).toContainText('연결 안 됨');
  expect(state.writes).toEqual([]);
  let release;
  state.beforeWrite = () => new Promise(resolve => { release = resolve; });
  await codex.getByRole('button', { name: '이력 수집 연결', exact: true }).click();
  await expect(codex.getByRole('button', { name: '이력 수집 연결 중', exact: true })).toBeDisabled();
  await page.locator('#connect-codex-tracking').dispatchEvent('click');
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(dialog.getByRole('button', { name: '상태 새로고침', exact: true })).toBeDisabled();
  release(); state.beforeWrite = null;
  await expect(codex).toContainText('연결됨'); await expect(claude).toContainText('연결 안 됨');
  await expect(codexHarness).toContainText('연결 안 됨');
  await codexHarness.getByRole('button', { name: '하네스 위임 연결', exact: true }).click();
  await expect(codexHarness).toContainText('연결됨');
  await claude.getByRole('button', { name: '이력 수집 연결', exact: true }).click();
  await expect(claude).toContainText('연결됨');
  await codex.getByRole('button', { name: '이력 수집 해제', exact: true }).click();
  await expect(codex).toContainText('연결 안 됨'); await expect(claude).toContainText('연결됨');
  await expect(codexHarness).toContainText('연결됨');
  expect(state.writes).toEqual([{ engine: 'codex', kind: 'tracking', method: 'POST', body: {} }, { engine: 'codex', kind: 'harness', method: 'POST', body: {} }, { engine: 'claude', kind: 'tracking', method: 'POST', body: {} }, { engine: 'codex', kind: 'tracking', method: 'DELETE', body: {} }]);
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await dialog.screenshot({ path: info.outputPath('agent-connections.png') });
  fs.mkdirSync('output/screenshots', { recursive: true });
  await dialog.screenshot({ path: 'output/screenshots/worklog-connection-scopes-20260926.png' });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await expect(claude).toContainText('연결됨');
});

test('refresh recovers a read failure and a rejected repair displays the current state without rendering server text as HTML', async ({ page }) => {
  const state = await fixture(page); state.failRead = true;
  const dialog = await open(page);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(page.locator('#connect-codex-tracking')).toBeDisabled();
  await dialog.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await expect(page.locator('#connect-codex-tracking')).toBeEnabled();
  const untrusted = '<img src=x onerror="window.connectionInjected=1">';
  state.snapshot.connections[0].tracking = { state: 'needs_attention', message: untrusted, paths: [`/temporary/${untrusted}`] };
  await dialog.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  const codex = dialog.getByRole('region', { name: 'Codex 이력 수집', exact: true });
  await expect(codex).toContainText('확인 필요'); await expect(codex).toContainText(untrusted);
  await codex.locator('summary').click(); await expect(codex.locator('li')).toContainText(untrusted);
  state.writeError = '다른 사용자 설정과 충돌합니다. 기존 설정을 확인하세요.';
  const reads = state.reads;
  await codex.getByRole('button', { name: '이력 수집 다시 연결', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(state.writeError);
  await expect.poll(() => state.reads).toBe(reads + 1);
  await expect(codex.getByRole('button', { name: '이력 수집 다시 연결', exact: true })).toBeEnabled();
  await expect(codex).toContainText('확인 필요');
  expect(await page.evaluate(() => window.connectionInjected)).toBeUndefined(); await expect(dialog.locator('img')).toHaveCount(0);
  state.writeError = null;
  await codex.getByRole('button', { name: '이력 수집 다시 연결', exact: true }).click();
  await expect(codex).toContainText('연결됨'); await expect(dialog.getByRole('alert')).toBeHidden();
});

test('an uninstalled environment disables agent mutations while Atlassian settings remain accessible', async ({ page }) => {
  const snapshot = baseline(); snapshot.available = false;
  const state = await fixture(page, snapshot), dialog = await open(page);
  await expect(dialog).toContainText('설치된 WorkLog 환경에서 연결');
  await expect(page.locator('#connect-codex-tracking')).toBeDisabled(); await expect(page.locator('#connect-claude-tracking')).toBeDisabled();
  await page.locator('#connect-codex-tracking').dispatchEvent('click'); expect(state.writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Atlassian 설정', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Atlassian 연결 설정', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Client ID', { exact: true })).toBeEditable();
});

test('connected configuration waits for actual hooks and then shows delivery without restarting the settings dialog', async ({ page }) => {
  const snapshot = baseline();
  snapshot.connections[0] = { ...snapshot.connections[0], state: 'connected', tracking: { state: 'connected', message: '훅 설정이 연결되었습니다.', paths: [] },
    collection: { state: 'awaiting_hook', last_event_at: null } };
  const state = await fixture(page, snapshot), dialog = await open(page);
  const codex = dialog.getByRole('region', { name: 'Codex 이력 수집', exact: true });
  await expect(codex).toContainText('훅 수신 대기');
  await codex.getByText('기존 세션에서 수집 시작하기').click();
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
  await page.locator('#connect-codex-tracking').click(); await expect.poll(() => gates.length).toBe(1);
  await dialog.getByRole('button', { name: 'Atlassian 설정', exact: true }).click();
  await dialog.getByLabel('Client ID', { exact: true }).fill('preserve-unsaved-client');
  let response = page.waitForResponse(value => value.url().endsWith('/api/agent-connections/codex/tracking'));
  gates[0](); await response;
  await expect(dialog.getByLabel('Client ID', { exact: true })).toHaveValue('preserve-unsaved-client');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await page.locator('#connect-claude-tracking').click(); await expect.poll(() => gates.length).toBe(2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await expect(page.locator('#connect-claude-tracking')).toBeEnabled();
  response = page.waitForResponse(value => value.url().endsWith('/api/agent-connections/claude/tracking'));
  gates[1](); await response;
  await expect(dialog.getByRole('region', { name: 'Claude 이력 수집', exact: true })).toContainText('연결 안 됨');
  await dialog.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Claude 이력 수집', exact: true })).toContainText('연결됨');
});

test('role packages install and remove independently of links, preserve revisions and expose conflicts for retry', async ({ page }) => {
  const state = await fixture(page), dialog = await open(page);
  const pm = dialog.getByRole('region', { name: 'PM 패키지', exact: true });
  const po = dialog.getByRole('region', { name: 'PO 패키지', exact: true });
  let release; state.beforePackageWrite = () => new Promise(resolve => { release = resolve; });
  await pm.getByRole('button', { name: '설치', exact: true }).click();
  await expect(pm.getByRole('button', { name: '설치', exact: true })).toBeDisabled();
  await pm.locator('button').dispatchEvent('click');
  await expect.poll(() => state.packageWrites.length).toBe(1);
  release(); state.beforePackageWrite = null;
  await expect(pm).toContainText('설치됨'); await expect(po).toContainText('미설치');
  expect(state.writes).toEqual([]);
  state.packageError = '패키지 설정이 변경되었습니다. 최신 상태를 확인하세요.';
  await po.getByRole('button', { name: '설치', exact: true }).click();
  await expect(dialog.locator('#harness-packages-error')).toHaveText(state.packageError);
  await expect(pm).toContainText('설치됨'); await expect(po).toContainText('미설치');
  state.packageError = null;
  await pm.getByRole('button', { name: '제거', exact: true }).click();
  await expect(pm).toContainText('미설치');
  expect(state.packageWrites).toEqual([{ id: 'pm', installed: true, revision: 0 }, { id: 'po', installed: true, revision: 1 }, { id: 'pm', installed: false, revision: 1 }]);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await expect(pm).toContainText('미설치');
  expect(state.writes).toEqual([]);
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
