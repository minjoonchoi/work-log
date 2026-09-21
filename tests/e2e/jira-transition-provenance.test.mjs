import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, eventually } from '../helpers.mjs';
import { atlFixture, authorize } from '../fixtures/atlassian.mjs';

const post = body => ({ method: 'POST', body });
const transition = (h, link, input) => h.manager(`/jira-links/${link}/transition`, post(input));
const writeCount = f => f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/transitions')).length;
async function setup(t) {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('manager'); await authorize(h);
  await h.ingest([...pair('provenance-a', '09:00:00', '09:05:00', 'first', { work_item_id: 'provenance-a' }),
    ...pair('provenance-b', '10:00:00', '10:05:00', 'first', { work_item_id: 'provenance-b' })]);
  const issue = f.addIssue();
  for (const id of ['provenance-a', 'provenance-b']) {
    const item = (await h.manager(`/items/${id}`)).item;
    await h.manager(`/items/${id}/jira/link`, post({ operation_id: `link-${id}`, version: item.version,
      cloud_id: 'cloud-test', issue_id: issue.id, key: issue.key }));
  }
  const current = await eventually(() => h.manager('/items/provenance-a'), detail => !!detail.jira_links[0].view?.data);
  const request = { operation_id: 'provenance-status-command', transition_id: '21',
    expected_status_id: current.jira_links[0].view.data.issue.status.id, expected_updated: current.jira_links[0].view.data.issue.updated };
  f.state.transitionFailure = 403;
  await assert.rejects(transition(h, 'link-provenance-a', request));
  return { h, f, request };
}

test('a shared Jira issue failure belongs to the invoking link; deleted owners never move the alert to another item', async t => {
  const { h, f, request } = await setup(t);
  const [incident] = await h.manager('/notifications');
  assert.equal(incident.kind, 'jira_transition'); assert.equal(incident.work_item_id, 'provenance-a');
  assert.equal(incident.link_operation_id, 'link-provenance-a');
  const items = await h.manager('/items');
  assert.equal(items.find(item => item.id === 'provenance-a').notification_count, 1);
  assert.equal(items.find(item => item.id === 'provenance-b').notification_count, 0);
  assert.equal((await transition(h, 'link-provenance-a', request)).repeated, true);
  await assert.rejects(transition(h, 'link-provenance-b', request), error => error.status === 409);
  assert.equal(writeCount(f), 1);
  await h.manager('/items/delete', post({ ids: ['provenance-a'], operation_id: 'hide-original-transition-owner' }));
  assert.deepEqual(await h.manager('/notifications'), []);
  assert.equal((await h.manager('/items/provenance-b')).item.notification_count, 0);
  await h.manager('/items/restore', post({ ids: ['provenance-a'], operation_id: 'restore-original-transition-owner' }));
  const [restored] = await h.manager('/notifications');
  assert.equal(restored.id, incident.id); assert.equal(restored.revision, incident.revision);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await transition(h, 'link-provenance-a', request)).repeated, true);
  assert.equal(writeCount(f), 1);
});

test('legacy transition journals replay without external writes; only legacy records may use an issue-scope notification link', async t => {
  const { h, f, request } = await setup(t);
  await h.stop('manager');
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  const row = db.prepare('SELECT request FROM jira_changes WHERE operation_id=?').get(request.operation_id);
  const recorded = JSON.parse(row.request); assert.equal(recorded.link_operation, 'link-provenance-a');
  delete recorded.link_operation;
  db.prepare('UPDATE jira_changes SET request=? WHERE operation_id=?').run(JSON.stringify(recorded), request.operation_id); db.close();
  await h.start('manager');
  assert.equal((await transition(h, 'link-provenance-a', request)).repeated, true);
  assert.equal((await transition(h, 'link-provenance-b', request)).repeated, true);
  assert.equal(writeCount(f), 1);
  const [legacy] = await h.manager('/notifications'); assert.equal(legacy.kind, 'jira_transition'); assert.ok(legacy.link_operation_id);
  // A recorded but unavailable link is different from a legacy journal with no link provenance.
  await h.stop('manager');
  const unavailable = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  unavailable.prepare('UPDATE jira_changes SET request=? WHERE operation_id=?').run(JSON.stringify({ ...recorded, link_operation: 'missing-original-link' }), request.operation_id); unavailable.close();
  await h.start('manager');
  assert.deepEqual(await h.manager('/notifications'), []); assert.equal(writeCount(f), 1);
});
