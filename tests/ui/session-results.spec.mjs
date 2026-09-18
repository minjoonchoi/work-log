import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = new Harness(); await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => h.close());
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`); await page.locator('.item-open').click();
}

test('session contains original I/O and results; worker details open on demand and metadata jobs stay in their own controls', async ({ page }) => {
  await h.ingest(pair('session-result-ui', '09:00:00', '09:05:00', 'first', { text: '권한 관리 기능의 요구사항과 수용 조건을 정리합니다.' }));
  const item = (await h.manager('/items'))[0];
  const run = await h.finish(await h.run({ work_item_id: item.id, origin: { engine: 'codex', agent_session_id: 'session-result-ui', turn_id: 'first' } }));
  await eventually(() => h.manager(`/items/${item.id}`), d => d.runs[0]?.status === 'completed' && d.runs[0]?.session_id);
  await open(page); const session = page.locator('.session-card'); await session.locator(':scope > summary').click();
  await expect(page.getByRole('heading', { name: '작업 실행', exact: true })).toHaveCount(0);
  await expect(page.locator('#worker-history')).toHaveCount(0);
  await expect(session.locator('.session-result')).toHaveCount(1);
  await expect(session.locator('.session-result')).toContainText('PRD 작성');
  await expect(session.locator('.session-result')).toBeHidden();
  await session.locator('.session-results > summary').click();
  await expect(session.locator('.event')).toHaveCount(2); await expect(session.locator('.event').first()).toHaveAttribute('data-kind', 'output');
  await expect(page.locator('#detail')).not.toContainText(run.id);
  await session.getByRole('button', { name: '실행 상세', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toContainText(run.id);
  await expect(dialog.locator('.execution-event')).not.toHaveCount(0);
  await dialog.locator('.execution-event summary').first().click(); await expect(dialog.locator('.execution-event pre').first()).toBeVisible();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await session.getByRole('button', { name: '산출물 보기', exact: true }).click(); await expect(dialog).toContainText('prd.md');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '제목·설명 다시 작성', exact: true }).click();
  await expect(page.locator('.metadata-writing .writing-status')).toContainText('작성 완료', { timeout: 15000 });
  await expect(session.locator('.session-result')).toHaveCount(1);
  await page.locator('.metadata-writing').getByRole('button', { name: '실행 상세', exact: true }).click();
  await expect(dialog).toContainText('text.rewrite'); await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.locator('#toast')).toBeHidden(); await page.locator('#detail').evaluate(el => { el.scrollTop = 0; });
  fs.mkdirSync('output/screenshots', { recursive: true });
  await page.screenshot({ path: 'output/screenshots/session-work-results-overview.png' });
  await session.evaluate(el => { const panel = document.querySelector('#detail'); panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 28; });
  await page.screenshot({ path: 'output/screenshots/session-work-results.png' });
  await page.setViewportSize({ width: 900, height: 800 });
  expect(await page.locator('#detail').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'output/screenshots/session-work-results-compact.png' });
});

test('unlinked result is visible until its original hook input arrives, then moves into exactly one session', async ({ page }) => {
  const run = await h.finish(await h.run({ work_item_id: 'waiting-ui', origin: { engine: 'codex', agent_session_id: 'late-ui', turn_id: 'one' } }));
  await eventually(() => h.manager('/items/waiting-ui'), d => d.runs[0]?.status === 'completed');
  await open(page); await expect(page.locator('.unlinked-results .session-result')).toHaveCount(1);
  await expect(page.locator('.session-card')).toHaveCount(0);
  await h.ingest(pair('late-ui', '09:00:00', '09:05:00', 'one', { work_item_id: 'waiting-ui', text: '늦게 수집한 요청' }));
  await expect(page.locator('.unlinked-results')).toHaveCount(0);
  await expect(page.locator('.session-card')).toHaveCount(1); await page.locator('.session-card > summary').click();
  await page.locator('.session-results > summary').click();
  await expect(page.locator(`.session-card [data-run-id="${run.id}"]`)).toBeVisible();
  await expect(page.locator('.session-result')).toHaveCount(1); await expect(page.locator('.event')).toHaveCount(2);
});
