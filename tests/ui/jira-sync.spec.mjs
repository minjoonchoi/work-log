import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize, adfText } from '../fixtures/atlassian.mjs';

test('Sync publishes each summarized session with exact time and summary, retries failure and never duplicates', async ({ page, context }) => {
  const h = new Harness(), f = await atlFixture(h);
  try {
    await h.start('runtime'); await h.start('manager'); await authorize(h);
    await context.addInitScript(token => { window.__HARNESS_TOKEN__ = token; }, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
    await h.ingest(pair('sync-current', '09:00:00', '09:05:00', 'one', { text: '동기화 검증 작업' }));
    const item = (await h.manager('/items'))[0], issue = f.addIssue({ summary: '티켓 제목은 표시하지 않음' }, 'TEAM-42');
    await h.ingest(pair('sync-second', '09:10:00', '09:17:00', 'two', { text: '두 번째 요약 작업', work_item_id: item.id }));
    let detail = await h.manager(`/items/${item.id}`);
    for (const session of detail.sessions) await h.manager(`/sessions/${session.id}/summary/regenerate`, { method: 'POST', body: { operation_id: `sync-summary-${session.id}` } });
    detail = await eventually(() => h.manager(`/items/${item.id}`), d => d.sessions.every(s => s.summary?.state === 'completed'));
    await h.manager(`/items/${item.id}/jira/link`, { method: 'POST', body: { version: detail.item.version, operation_id: 'sync-existing-link', cloud_id: 'cloud-test', key: issue.key, issue_id: issue.id } });
    await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`); await page.locator('.item-open').click();
    const card = page.locator('.jira-card'), sync = card.getByRole('button', { name: 'TEAM-42 업무 로그 Sync' });
    await expect(sync).toBeVisible(); await expect(card.locator('button')).toHaveCount(1);
    await expect(card.locator('select,.jira-issue-title')).toHaveCount(0);
    expect(f.state.worklogs).toHaveLength(0);
    f.state.worklogFailure = 400;
    await sync.click();
    await expect(page.locator('.session-sync').first()).toContainText('확인 필요');
    f.state.worklogFailure = null;
    await sync.click();
    await expect.poll(() => f.state.worklogs.length).toBe(2);
    const log = f.state.worklogs.find(w => w.timeSpentSeconds === 300);
    const second = f.state.worklogs.find(w => w.timeSpentSeconds === 420);
    expect(second.started).toBe('2026-09-17T09:10:00.000+0000');
    expect(adfText(second.comment)).toBe(detail.sessions[1].summary.text);
    expect(log.issueId).toBe(issue.id);
    expect(log.started).toBe('2026-09-17T09:00:00.000+0000');
    expect(log.timeSpentSeconds).toBe(300);
    expect(adfText(log.comment)).toBe(detail.sessions[0].summary.text);
    await expect(page.locator('.session-sync').first()).toContainText('Jira 동기화됨');
    await sync.click(); await h.stop('manager'); await h.start('manager');
    await h.manager('/jira-links/sync-existing-link/worklogs/sync', { method: 'POST', body: {} });
    expect(f.state.worklogs).toHaveLength(2);
    expect(f.state.calls.filter(c => ['PUT','POST'].includes(c.method) && /\/issue\/[^/]+$|\/transitions$/.test(c.path))).toHaveLength(0);
  } finally { await h.close(); await f.close(); }
});
