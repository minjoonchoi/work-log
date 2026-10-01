import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

test('commentary appears live in prompt history before Stop and survives manager restart', async ({ page, context }) => {
  const h = new Harness();
  try {
    await h.start('manager');
    await context.addInitScript(token => { window.__HARNESS_TOKEN__ = token; }, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
    const file = path.join(h.dir, 'rollout.jsonl');
    const append = row => fs.appendFileSync(file, JSON.stringify(row) + '\n');
    append({ type: 'session_meta', payload: { id: 'live-progress', cli_version: '0.120.0', source: 'cli' } });
    append({ type: 'turn_context', payload: { turn_id: 'live-turn' } });
    await h.ingest([{ id: 'live-prompt', engine: 'codex', agent_session_id: 'live-progress', role: 'user', kind: 'input',
      event_at: '2026-10-02T00:00:00Z', turn_id: 'live-turn', source_turn_id: 'live-turn', turn_source: 'native', hook_schema: 2,
      source: 'system_hook', transcript_path: file, text: '진행 메시지 수집 확인' }]);
    await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
    await page.locator('.item-open').click();
    await page.locator('.session-card > summary').click();
    await page.locator('.raw-history > summary').click();
    append({ type: 'response_item', timestamp: '2026-10-02T00:01:00Z', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '중간 진행 내용을 확인하고 있습니다.' }] } });
    const progress = page.locator('.event[data-kind="progress"]');
    await expect(progress).toHaveCount(1);
    await expect(progress.locator('summary')).toContainText('진행 메시지');
    await progress.locator('summary').click();
    await expect(progress.locator('pre')).toHaveText('중간 진행 내용을 확인하고 있습니다.');
    await expect(page.locator('.event[data-kind="output"]')).toHaveCount(0);
    await h.stop('manager'); await h.start('manager');
    const item = (await h.manager('/items'))[0], detail = await h.manager(`/items/${item.id}`);
    const history = await h.manager(`/items/${item.id}/history?session_id=${detail.sessions[0].id}`);
    expect(history.records.filter(e => e.kind === 'progress')).toHaveLength(1);
    expect(detail.sessions[0].pending).toBe(true);
  } finally { await h.close(); }
});
