import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, event, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

let h;
test.beforeEach(async ({ context }) => {
  h = await new Harness().start('manager');
  await context.addInitScript(token => {
    window.__HARNESS_TOKEN__ = token; window.nativeRoutes = [];
    window.webkit = { messageHandlers: { openWorkLog: { postMessage: route => window.nativeRoutes.push(route) } } };
  }, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => h.close());
const url = route => `http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}${route}`;
const ask = (kind = 'tool.started', at = '09:01:00', text = '승인자는 팀장인가요?') => event('ask', kind, at, 't1', {
  engine: 'claude', source: 'system_hook', call_id: 'ask-one', text: JSON.stringify({ name: 'AskUserQuestion', input: { questions: [{ question: text }] } })
});
async function seed() {
  await h.ingest([
    event('ask', 'input', '09:00:00', 't1', { engine: 'claude', work_item_id: 'ask-item', text: '승인 흐름을 설계해 주세요.' }), ask(),
    event('agent', 'input', '09:00:00', 't1', { work_item_id: 'agent-item', text: 'PRD 초안을 작성해 주세요.' }),
    ...pair('queued', '09:00:00', '09:01:00', 't1', { work_item_id: 'queued-item', text: 'HTML 목업 생성' }),
    event('queued', 'run.updated', '09:02:00', 't1', { run: { id: 'queue-run', status: 'pending' } }),
    ...pair('running', '09:00:00', '09:01:00', 't1', { work_item_id: 'running-item', text: '엔티티 검토' }),
    event('running', 'run.updated', '09:02:00', 't1', { run: { id: 'active-run', status: 'running' } }),
    ...pair('blocked', '09:00:00', '09:01:00', 't1', { work_item_id: 'blocked-item', text: '검증 재확인' }),
    event('blocked', 'run.updated', '09:02:00', 't1', { run: { id: 'blocked-run', status: 'blocked', message: '검증 환경에 접근할 수 없습니다.' } })
  ]);
}

test('quick panel distinguishes user reply, agent response, queue and execution, and routes the user-reply filter', async ({ page }) => {
  await h.start('runtime'); await eventually(() => h.manager('/health'), health => health.runtime_connected);
  await seed(); await page.setViewportSize({ width: 380, height: 600 }); await page.goto(url('/quick'));
  await expect(page.locator('#waiting-count')).toHaveText('1'); await expect(page.locator('#current-count')).toHaveText('3');
  await expect(page.locator('[data-item=ask-item]')).toContainText('사용자 답변 필요');
  await expect(page.locator('[data-item=agent-item]')).toContainText('에이전트 응답 대기');
  await expect(page.locator('[data-item=queued-item]')).toContainText('실행 대기');
  await expect(page.locator('[data-item=running-item]')).toContainText('작업 실행 중');
  await expect(page.locator('[data-group=attention]')).toContainText('검증 재확인');
  await expect(page.locator('[data-group=waiting]')).not.toContainText('검증 재확인');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-view=waiting-user]').click();
  expect(await page.evaluate(() => window.nativeRoutes)).toEqual([{ view: 'waiting-user' }]);
  fs.mkdirSync('output/screenshots', { recursive: true });
  await page.screenshot({ path: 'output/screenshots/waiting-state-panel.png' });
  await h.ingest([ask('tool.finished', '09:03:00')]);
  await expect(page.locator('#waiting-count')).toHaveText('0');
  await expect(page.locator('[data-item=ask-item]')).toContainText('에이전트 응답 대기');
  await expect(page.locator('[data-group=waiting]')).toHaveCount(0);
});

test('question detail is separate from raw I/O and updates on reply; native filter excludes failures and running work', async ({ page }) => {
  await seed(); await page.goto(url('/'));
  await expect(page.locator('.item-open')).toHaveCount(5);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('harness:navigate', { detail: { view: 'waiting-user' } })));
  await expect(page.locator('.item-open')).toHaveText(['승인 흐름을 설계해 주세요.']);
  await page.locator('.item-open').click();
  await expect(page.locator('.user-questions')).toContainText('승인자는 팀장인가요?');
  await expect(page.locator('.user-questions')).toContainText('해당 Claude 에이전트 세션에서 답변');
  await expect(page.locator('.session-card > summary')).toContainText('사용자 답변 필요');
  await expect(page.locator('.session-card > summary')).not.toContainText('에이전트 응답 대기');
  await page.locator('.session-card > summary').click();
  await expect(page.locator('.event')).toHaveCount(1);
  await expect(page.locator('.event')).not.toContainText('승인자는 팀장인가요?');
  await h.ingest([ask('tool.finished', '09:03:00')]);
  await expect(page.locator('.user-questions')).toHaveCount(0);
  await expect(page.locator('.session-card > summary')).toContainText('에이전트 응답 대기');
  await expect(page.locator('.item-open')).toHaveCount(0);
  await expect(page.locator('#item-list')).toContainText('답변이 필요한 업무가 없습니다');
  await expect(page.locator('#item-list')).not.toContainText('아직 기록된 업무가 없습니다');
  await h.ingest([event('ask', 'output', '09:04:00', 't1', { engine: 'claude', text: '팀장 승인 흐름입니다.' })]);
  await expect(page.locator('.session-card > summary')).not.toContainText('응답 대기');
  await expect(page.locator('.event')).toHaveCount(2);
});

test('question text is escaped; a simultaneous background run stays visible on merged work', async ({ page }) => {
  await seed();
  await h.manager('/merge', { method: 'POST', body: { ids: ['ask-item', 'running-item'], target: 'ask-item', operation_id: 'merge-ui-states' } });
  await h.ingest([ask('tool.started', '09:02:00', '<img src=x onerror=alert(1)> 어떤 승인자를 사용할까요?')]);
  await page.setViewportSize({ width: 380, height: 600 }); await page.goto(url('/quick'));
  await expect(page.locator('[data-item=ask-item]')).toContainText('사용자 답변 필요');
  await expect(page.locator('[data-item=ask-item] .quick-secondary')).toContainText('실행 상태 미확인');
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(url('/'));
  await page.getByRole('button', { name: '승인 흐름을 설계해 주세요.', exact: true }).click();
  await expect(page.locator('.question-text')).toContainText('<img src=x'); await expect(page.locator('.user-questions img')).toHaveCount(0);
  await expect(page.locator('#detail')).toContainText('함께 기록된 상태: 작업 실행 중');
});
