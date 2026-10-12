import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managerStore } from '../../src/manager-store.mjs';
import { integrationStore } from '../../src/integration-store.mjs';
import { integrationCoordinator } from '../../src/integration-coordinator.mjs';
import { pair } from '../helpers.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-preservation-'));
  const store = managerStore(dir), integrations = integrationStore(store);
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.ingestMany(pair('preserve-agent', '09:00:00', '09:05:00'));
  const item = store.items()[0];
  integrations.linkExisting(item.id, { version: item.version, operation_id: 'preserve-link', cloud_id: 'cloud-test', key: 'TEAM-1', issue_id: '1' },
    { id: '1', key: 'TEAM-1', cloud_id: 'cloud-test' });
  const session = integrations.worklogSessions()[0], link = integrations.links(item.id)[0];
  integrations.ensureSummary(session); integrations.finishSummary(session, 'completed', { text: '원래 요약' });
  integrations.beginWorklog(session, link, '원래 요약');
  return { store, integrations, session, link };
}
for (const state of ['synced', 'pending', 'failed']) test(`published log is preserved when legacy state is ${state}`, t => {
  const { integrations, session, link } = setup(t);
  integrations.finishWorklog(session.id, state, '123');
  const old = integrations.worklog(session.id);
  const row = integrations.beginWorklog({ ...session, seconds: 900 }, link, '새 요약');
  assert.equal(row.state, 'synced'); assert.equal(row.worklog_id, '123');
  assert.equal(row.payload, old.payload); assert.equal(row.source_digest, old.source_digest);
});
test('unknown old update finds its published log without overwriting or appending', async t => {
  const { integrations, session } = setup(t);
  integrations.finishWorklog(session.id, 'unknown');
  let reads = 0;
  const coordinator = integrationCoordinator({ integrations, notify() {}, writings: { async tick() {} }, client: {
    async findWorklog() { reads++; return { id: '456', properties: [{ key: 'work-log', value: { source_digest: 'previous-revision' } }] }; },
    async status() { return { connected: true }; },
    async writeWorklog() { assert.fail('published worklog must not be written again'); }
  } });
  await coordinator.tick(); await coordinator.tick();
  assert.equal(reads, 1); assert.equal(integrations.worklog(session.id).state, 'synced');
  assert.equal(integrations.worklog(session.id).worklog_id, '456');
});
