import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

test('held title requests stay out of the list and can be reviewed and restored from connection settings', async ({ page, context }) => {
  const h = new Harness();
  try {
    await h.start('manager');
    await h.ingest(pair('unknown-title','09:00:00','09:01:00','t',{
      source:'system_hook',role:'user',text:'Generate a concise, single-line task title at most 36 characters and return only the title. <script>window.injected=true</script>'
    }));
    await context.addInitScript(token => { window.__HARNESS_TOKEN__=token; },fs.readFileSync(path.join(h.dir,'token'),'utf8'));
    await page.goto('http://127.0.0.1:'+readEndpoint(h.dir,'manager').port+'/');
    await expect(page.locator('.item-row')).toHaveCount(0);
    await page.getByRole('button',{name:'연결 설정',exact:true}).click();
    await page.getByRole('button',{name:'분류 보류 기록',exact:true}).click();
    await expect(page.getByRole('heading',{name:'분류 보류 기록'})).toBeVisible();
    await page.getByText('원본 기록 확인',{exact:true}).click();
    await expect(page.locator('.held-preview details')).toHaveCount(2);
    await page.locator('.held-preview summary').first().click();
    await expect(page.locator('.held-preview pre').first()).toContainText('Generate a concise');
    expect(await page.evaluate(()=>window.injected)).toBeUndefined();
    await page.getByRole('button',{name:'업무로 등록',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'업무로 등록했습니다'})).toBeVisible();
    expect((await h.manager('/items')).length).toBe(1);
    await page.getByRole('button',{name:'연결 설정으로 돌아가기',exact:true}).click();
    await expect(page.getByRole('heading',{name:'연결 설정',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'분류 보류 기록',exact:true}).click();
    await expect(page.getByText('분류 보류 기록이 없습니다.',{exact:true})).toBeVisible();
  } finally { await h.close(); }
});
