import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';

test('all harness packages can remain uninstalled while hooks, automatic titles and idle session summaries keep working', async t => {
  const h = new Harness(); t.after(() => h.close());
  fs.writeFileSync(path.join(h.dir, 'harness-packages.json'), JSON.stringify({ version: 1, revision: 0, installed: [] }));
  h.env = { HARNESS_TEST_AUTOMATIC_METADATA: '1', HARNESS_TEST_SESSION_SUMMARIES: '1' };
  await h.start('runtime'); await h.start('manager');
  const packages = await h.manager('/harness-packages');
  assert.ok(packages.packages.length >= 4 && packages.packages.every(row => !row.installed));
  const endpoint = readEndpoint(h.dir, 'manager');
  assert.equal((await fetch(`http://127.0.0.1:${endpoint.port}/api/harness-packages`)).status, 401);
  await assert.rejects(h.run(), /설치/);
  assert.equal((await h.runtime('/runs')).length, 0);

  for (let i = 1; i <= 5; i++) {
    h.hook('codex', { hook_event_name: 'UserPromptSubmit', session_id: 'tracking-only', event_id: `in-${i}`, turn_id: `turn-${i}`, prompt: `로컬 기록 ${i}` });
    h.hook('codex', { hook_event_name: 'Stop', session_id: 'tracking-only', event_id: `out-${i}`, turn_id: `turn-${i}`, last_assistant_message: `확인한 결과 ${i}` });
  }
  const item = (await eventually(() => h.manager('/items'), rows => rows.length === 1))[0];
  const metadata = await eventually(() => h.manager(`/items/${item.id}`), value => value.metadata_rewrite?.state === 'completed', 20000);
  assert.ok(metadata.item.title);
  assert.equal(metadata.sessions.length, 1);

  const at = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  await h.ingest(pair('idle-tracking-only', at(25), at(21), 'idle-turn', { source: 'system_hook' }));
  const idle = (await h.manager('/items')).find(row => row.id !== item.id);
  const detail = await eventually(() => h.manager(`/items/${idle.id}`), value => value.sessions[0]?.summary?.state === 'completed', 20000);
  assert.equal(detail.sessions[0].closed, false);
  assert.ok(detail.sessions[0].summary.current);
  const runs = await h.runtime('/runs');
  assert.ok(runs.length >= 2 && runs.every(run => run.internal && run.status === 'completed'));
  assert.equal((await h.manager('/items')).length, 2, 'app generation never creates a third work item');
  assert.ok((await h.manager('/harness-packages')).packages.every(row => !row.installed));
});

test('manager package controls preserve independent generation settings and reject stale or invalid updates', async t => {
  const h = new Harness(); t.after(() => h.close());
  await h.start('runtime'); await h.start('manager');
  const settings = await h.manager('/execution-settings');
  assert.equal(settings.tasks.filter(row => row.management_group === 'worklog').length, 5);
  assert.ok(settings.tasks.filter(row => row.management_group === 'worklog').every(row => row.installed && row.package_ids.length === 0));
  const before = await h.manager('/harness-packages');
  const after = await h.manager('/harness-packages/po', { method: 'PUT', body: { installed: false, revision: before.revision } });
  assert.equal(after.packages.find(row => row.id === 'po').installed, false);
  await assert.rejects(h.manager('/harness-packages/po', { method: 'PUT', body: { installed: true, revision: before.revision } }), /변경|revision/);
  await assert.rejects(h.manager('/harness-packages/missing', { method: 'PUT', body: { installed: true, revision: after.revision } }), /직무 묶음을 찾을 수 없습니다/);
  const next = await h.manager('/execution-settings');
  assert.deepEqual(next.tasks.filter(row => row.management_group === 'worklog'), settings.tasks.filter(row => row.management_group === 'worklog'));
  assert.equal(next.tasks.find(row => row.id === 'prd.create').installed, false);
});
