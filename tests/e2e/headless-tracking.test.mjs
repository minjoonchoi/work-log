import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shared.mjs';
import { Harness, event, pair } from '../helpers.mjs';

test('both headless backends skip hooks before stdin parsing or data initialization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-guard-'));
  try {
    for (const engine of ['codex', 'claude']) for (const input of ['invalid-json', ...['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'SessionEnd'].map(hook_event_name =>
      JSON.stringify({ hook_event_name, session_id: 'headless', prompt: '내부 요약', last_assistant_message: '완료' }))]) {
      const dir = path.join(root, engine);
      const child = spawnSync(process.execPath, [path.join(ROOT, 'src/hook.mjs'), engine], {
        env: { ...process.env, WORKLOG_TRACKING_DISABLED: '1', HARNESS_WORKER: '', HARNESS_DATA_DIR: dir },
        cwd: root, input, encoding: 'utf8', timeout: 3000
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, '');
      assert.equal(fs.existsSync(dir), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only user prompts create items; owned and ownerless headless events never enter history', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  await h.ingest([event('user', 'session.started', '09:00:00', 't1', { source: 'system_hook' })]);
  assert.equal((await h.manager('/items')).length, 0);
  await h.ingest(pair('user', '09:01:00', '09:02:00', 't1', { source: 'system_hook' }));
  const item = (await h.manager('/items'))[0];
  const before = await h.manager('/items/' + item.id);
  for (const work_item_id of [undefined, item.id]) {
    for (const extra of [
      { role: 'worker' }, { role: 'metadata' }, { internal: true },
      { tracking_disabled: true }, { source: 'runtime' }
    ]) await h.ingest(pair('headless-' + JSON.stringify(extra), '09:03:00', '09:04:00', 'worker', {
      source: 'system_hook', work_item_id, ...extra
    }));
  }
  assert.equal((await h.manager('/items')).length, 1);
  const after = await h.manager('/items/' + item.id);
  assert.deepEqual(after.agents, before.agents);
  assert.deepEqual(after.events, before.events);
  assert.equal(after.sessions.length, 1);
});
