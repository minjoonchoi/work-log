import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async () => { h = new Harness(); await h.start('runtime'); await h.start('manager'); });
test.afterEach(async () => h.close());

for (const scale of [1, 2]) test(`bundled navigation icons render offline without icon fonts at ${scale}x display scale`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: scale });
  try {
    await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
    const page = await context.newPage(), external = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    const base = `http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`;
    await page.goto(base);
    await page.addStyleTag({ content: '* { font-family: monospace !important; }' });
    const menus = page.locator('.sidebar button');
    await expect(menus).toHaveCount(7);
    for (const menu of await menus.all()) {
      const icon = menu.locator('svg.menu-icon');
      await expect(icon).toBeVisible(); await expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(await icon.evaluate(node => ({ width: node.getBBox().width, height: node.getBBox().height }))).toEqual({ width: expect.any(Number), height: expect.any(Number) });
      expect(await icon.evaluate(node => node.getBBox().width > 0 && node.getBBox().height > 0)).toBe(true);
      expect(await menu.textContent()).not.toMatch(/[⚙▤▦▧◷⌕]/);
    }
    await page.getByRole('button', { name: '작업 실행 설정', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('button', { name: '캘린더', exact: true }).click();
    await expect(page.locator('#previous svg')).toBeVisible(); await expect(page.locator('#next svg')).toBeVisible();
    await page.screenshot({ path: info.outputPath('menu-icons.png') });
    await page.setViewportSize({ width: 380, height: 590 });
    await page.goto(`${base}/quick`);
    await expect(page.locator('.quick-footer button svg')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'WorkLog 전체 창 열기' }).locator('svg')).toBeVisible();
    for (const button of await page.locator('.quick-footer button').all()) {
      await expect(button.locator('svg')).toBeVisible();
      expect(await button.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath('quick-icons.png') });
    expect(external).toEqual([]);
  } finally { await context.close(); }
});

test('navigation icons remain visible before scripts run or service authentication completes', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
    for (const icon of await page.locator('.sidebar button svg').all()) await expect(icon).toBeVisible();
    await expect(page.locator('.sidebar button svg')).toHaveCount(7);
  } finally { await context.close(); }
});
