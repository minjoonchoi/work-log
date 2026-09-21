import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, eventually } from '../helpers.mjs';

const patch = body => ({ method: 'PATCH', body });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const detail = (h, id) => h.manager(`/items/${id}`);

test('oversized automatic metadata is admitted as one visible failure without a model call or restart loop', async t => {
  const h = new Harness(); h.env = { HARNESS_TEST_AUTOMATIC_METADATA: '0' }; t.after(() => h.close());
  await h.start('runtime'); await h.start('manager');
  await h.manager('/automation/settings', patch({ initial_output_count: 1 }));
  const base = Date.parse('2026-09-17T09:00:00Z');
  const events = Array.from({ length: 1001 }, (_, index) => pair('oversized-metadata',
    new Date(base + index * 1000).toISOString(), new Date(base + index * 1000 + 500).toISOString(), `turn-${index}`,
    { source: 'system_hook', work_item_id: 'oversized-metadata-item', text: `기록 ${index}` })).flat();
  for (let offset = 0; offset < events.length; offset += 500) await h.ingest(events.slice(offset, offset + 500));
  await h.stop('manager'); h.env.HARNESS_TEST_AUTOMATIC_METADATA = '1'; await h.start('manager');
  const failed = await eventually(() => detail(h, 'oversized-metadata-item'), value => value.metadata_rewrite?.state === 'failed', 15000);
  assert.equal(failed.metadata_rewrite.source, 'automatic'); assert.equal(failed.metadata_rewrite.run_id, null);
  assert.match(failed.metadata_rewrite.message, /2000|2,000/);
  const alerts = await h.manager('/notifications');
  assert.equal(alerts.length, 1); assert.equal(alerts[0].kind, 'metadata');
  assert.equal(alerts[0].work_item_id, failed.item.id);
  const operation = failed.metadata_rewrite.operation_id;
  await h.stop('manager'); await h.start('manager'); await pause(1250);
  const current = await detail(h, failed.item.id);
  assert.equal(current.metadata_rewrite.operation_id, operation);
  assert.equal(current.metadata_rewrite.state, 'failed');
  assert.equal(current.item.title, failed.item.title); assert.equal(current.item.description, failed.item.description);
  assert.equal((await h.runtime('/runs')).length, 0);
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM writing_requests WHERE format='work-item-metadata'").get().count, 1); db.close();
});
