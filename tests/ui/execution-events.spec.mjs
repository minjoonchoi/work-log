import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, event, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => h.close());
async function workload(options) {
  await h.ingest(pair('diagnostics', '09:00:00', '09:05:00', 'request', { text: '요청한 산출물을 작성하고 검토합니다.', source: 'system_hook' }));
  const item = (await h.manager('/items'))[0];
  const run = await h.finish(await h.run({ ...options, work_item_id: item.id,
    origin: { engine: 'codex', agent_session_id: 'diagnostics', turn_id: 'request' } }));
  expect(run.status).toBe('completed');
  await eventually(() => h.manager(`/items/${item.id}`), value => value.runs[0]?.status === 'completed');
  return { run, item };
}
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await page.locator('.item-open').click(); await page.locator('.session-card > summary').click();
  await page.locator('.session-results > summary').click();
  await page.getByRole('button', { name: '실행 상세', exact: true }).click();
  return page.getByRole('dialog');
}

test('execution diagnostics distinguish generation, review and repair I/O and show measured attempt duration', async ({ page }) => {
  const { run, item } = await workload({ fixture: { scenario: 'revise-once', delayMs: 50 } });
  const recorded = await h.manager(`/items/${item.id}/runs/${run.id}/events`);
  expect(recorded.records.every(value => ['produce', 'review', 'repair'].includes(value.stage))).toBe(true);
  expect(recorded.attempts).toHaveLength(4);
  expect(recorded.attempts.every(value => Object.keys(value).sort().join(',') === 'ended_at,id,stage,started_at')).toBe(true);
  const dialog = await open(page);
  await expect(dialog.locator('.execution-event')).toHaveCount(8);
  await expect(dialog.locator('[data-stage="produce"][data-kind="input"] summary')).toContainText('생성 · 입력');
  await expect(dialog.locator('[data-stage="review"][data-kind="input"] summary')).toHaveCount(2);
  await expect(dialog.locator('[data-stage="review"][data-kind="input"] summary').first()).toContainText('검토 · 입력');
  await expect(dialog.locator('[data-stage="repair"][data-kind="input"] summary')).toContainText('수정 · 입력');
  for (const result of await dialog.locator('[data-kind="output"] summary').allTextContents()) expect(result).toMatch(/소요 \d[\d,.]*초/);
  await dialog.locator('[data-stage="review"][data-kind="input"] summary').first().click();
  await expect(dialog.locator('[data-stage="review"][data-kind="input"] pre').first()).toBeVisible();
  fs.mkdirSync('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/execution-stage-details.png' });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.locator('.conversation-history .event-label-title')).toHaveText(['응답 출력', '프롬프트 입력']);
});

test('legacy diagnostics infer planning only from exact attempt IDs and retain generic labels when evidence is unavailable', async ({ page }) => {
  const { run, item } = await workload({ task: 'test.scenarios.plan', input: {
    requirements: [{ id: 'REQ-1', text: '각 생성과 검토 단계를 구분해 표시한다.' }]
  } });
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  db.prepare("UPDATE events SET payload=json_remove(payload,'$.stage') WHERE json_extract(payload,'$.parent.run_id')=?").run(run.id);
  db.close();
  await h.ingest([event('unknown-worker', 'output', '09:06:00', 'unmatched', { role: 'worker',
    stage: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script>',
    parent: { run_id: run.id, work_item_id: item.id, engine: 'codex', agent_session_id: 'diagnostics', turn_id: 'request' } })]);
  const dialog = await open(page);
  await expect(dialog.locator('[data-stage="plan"][data-kind="input"] summary')).toContainText('계획 · 입력');
  await expect(dialog.locator('[data-stage="review"][data-kind="output"] summary')).toContainText('검토 · 결과');
  await expect(dialog.locator('[data-stage=""] summary')).toContainText('작업자 결과');
  await expect(dialog.locator('img, script')).toHaveCount(0);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await h.stop('runtime');
  await page.getByRole('button', { name: '실행 상세', exact: true }).click();
  await expect(dialog.locator('.execution-event')).toHaveCount(5);
  expect(await dialog.locator('.execution-event').evaluateAll(nodes => nodes.every(node => node.dataset.stage === ''))).toBe(true);
  await expect(dialog).not.toContainText('소요');
});
