import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managerStore } from '../../src/manager-store.mjs';
import { integrationStore } from '../../src/integration-store.mjs';
import { writingStore } from '../../src/writing-store.mjs';
import { writingCoordinator } from '../../src/writing-coordinator.mjs';
import { integrationCoordinator } from '../../src/integration-coordinator.mjs';
import { serve, body, stableId, digest, json, assert as check } from '../../src/shared.mjs';
import { pair, event, eventually } from '../helpers.mjs';

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-writing-policy-')), store = managerStore(dir), integrations = integrationStore(store);
  const writings = writingStore(store, integrations, { clock: () => Date.parse('2026-09-17T09:40:00Z'), ...options });
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, integrations, writings };
}
async function runtime(t, dir) {
  const submissions = [], cancellations = [], runs = new Map(); let cancelUnavailable = false;
  const { server } = await serve({ dir, role: 'runtime', handler: async (req, url) => {
    if (url.pathname === '/runs' && req.method === 'POST') {
      const input = await body(req), run = { ...input, id: stableId('run-', input.idempotency_key), status: 'running' };
      submissions.push(input); runs.set(run.id, run); return run;
    }
    const id = url.pathname.split('/')[2], run = runs.get(id); check(run, 'missing', 404);
    if (url.pathname.endsWith('/cancel')) {
      check(!cancelUnavailable, 'unavailable', 503); cancellations.push(id); run.status = 'cancelled';
    }
    return run;
  } });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { submissions, cancellations, runs, unavailable(value) { cancelUnavailable = value; } };
}
const writer = c => writingCoordinator({ ...c, notify() {}, automatic: false, automaticMetadata: false });
const enqueue = (c, item, operation) => c.writings.enqueue('work-item-metadata', item.id, { version: item.version, operation_id: operation });

test('GUI metadata inherits configured backend rather than forcing the source agent engine', async t => {
  const c = setup(t), mock = await runtime(t, c.dir);
  c.store.ingestMany(pair('codex-author', '09:00:00', '09:05:00'));
  enqueue(c, c.store.items()[0], 'configured-backend');
  await writer(c).tick();
  assert.equal(mock.submissions.length, 1);
  assert.equal(Object.hasOwn(mock.submissions[0], 'engine'), false);
  assert.equal(mock.submissions[0].input.sessions[0].engine, 'codex');
  assert.equal(mock.submissions[0].internal, true);
});

test('obsolete internal generation is cancelled durably after runtime recovery', async t => {
  const c = setup(t), mock = await runtime(t, c.dir), firstWriter = writer(c);
  c.store.ingestMany(pair('stale-author', '09:00:00', '09:05:00'));
  const item = c.store.items()[0]; enqueue(c, item, 'stale-generation'); await firstWriter.tick();
  c.store.edit(item.id, { version: item.version, title: '사용자가 수정한 제목', description: '사용자 설명' });
  mock.unavailable(true); await firstWriter.tick();
  assert.equal(c.writings.get('stale-generation').state, 'superseded');
  assert.equal(c.writings.cancellations().length, 1); assert.deepEqual(mock.cancellations, []);
  const restored = writingStore(c.store, c.integrations); mock.unavailable(false);
  await writer({ ...c, writings: restored }).tick();
  assert.deepEqual(mock.cancellations, [...mock.runs.keys()]); assert.deepEqual(restored.cancellations(), []);
  assert.equal(c.store.items()[0].title, '사용자가 수정한 제목');
});

test('manual metadata uses accepted closed summaries once, keeps open raw events, and summary regeneration still reads raw input', t => {
  const c = setup(t);
  c.store.ingestMany([...pair('snapshot-author', '09:00:00', '09:05:00', 'one', { text: '긴 원문 기록' }),
    ...pair('snapshot-author', '09:30:00', '09:35:00', 'two', { text: '현재 작업' })]);
  const closed = c.integrations.closedSessions()[0];
  c.integrations.ensureSummary(closed); c.integrations.finishSummary(closed, 'completed', { text: '검토 완료\n- 확인된 범위를 검토했습니다.' });
  const request = enqueue(c, c.store.items()[0], 'compact-manual-metadata');
  const summarized = request.snapshot.input.sessions.find(s => s.id === closed.id), open = request.snapshot.input.sessions.find(s => s.id !== closed.id);
  assert.equal(summarized.summary, '검토 완료\n- 확인된 범위를 검토했습니다.'); assert.deepEqual(summarized.events, []);
  assert.equal(open.summary, null); assert.equal(open.events.length, 2);
  const summary = c.writings.enqueue('session-summary', closed.id, { operation_id: 'fresh-summary-raw-input' });
  assert.equal(summary.snapshot.input.sessions[0].events.length, 2); assert.equal(summary.snapshot.input.sessions[0].summary, null);
});

test('an idle summary completing does not supersede metadata from unchanged raw history, while a used closed summary stays protected', t => {
  const c = setup(t);
  c.store.ingestMany([...pair('concurrent-summary', '09:00:00', '09:05:00', 'closed'),
    ...pair('concurrent-summary', '09:30:00', '09:35:00', 'open')]);
  const closed = c.integrations.closedSessions()[0];
  c.integrations.ensureSummary(closed); c.integrations.finishSummary(closed, 'completed', { text: '기존 검토\n- 요구사항을 검토했습니다.' });
  const request = enqueue(c, c.store.items()[0], 'metadata-during-idle-summary');
  const open = c.integrations.sessionSnapshots(c.store.sessionList().filter(session => session.id !== closed.id))[0];
  c.integrations.ensureSummary(open); c.integrations.finishSummary(open, 'completed', { text: '최근 작업\n- 현재까지의 작업을 정리했습니다.' });
  assert.equal(c.writings.isCurrent(request), true);
  assert.equal(request.snapshot.input.sessions.find(session => session.id === open.id).summary, null);
  assert.equal(c.integrations.summary(open.id).text, '최근 작업\n- 현재까지의 작업을 정리했습니다.');
  c.integrations.finishSummary(closed, 'completed', { text: '수정된 검토\n- 검토 내용을 보완했습니다.' });
  assert.equal(c.writings.isCurrent(request), false, 'a summary actually used in the metadata remains version-sensitive');
});

test('a manual metadata snapshot accepted before the source policy change still uses its original summary evidence', t => {
  const c = setup(t);
  c.store.ingestMany(pair('legacy-open-summary', '09:30:00', '09:35:00'));
  const session = c.integrations.sessionSnapshots()[0];
  c.integrations.ensureSummary(session); c.integrations.finishSummary(session, 'completed', { text: '기존 요약\n- 이전 요청에 포함된 요약입니다.' });
  const request = enqueue(c, c.store.items()[0], 'legacy-open-metadata-source');
  const legacy = structuredClone(request.snapshot);
  delete legacy.metadata_source_policy;
  legacy.input.sessions[0].summary = c.integrations.summary(session.id).text;
  legacy.source_digest = digest(json(legacy.input));
  c.store.db.prepare('UPDATE writing_requests SET snapshot=? WHERE operation_id=?').run(json(legacy), request.operation_id);
  assert.equal(c.writings.isCurrent(c.writings.get(request.operation_id)), true);
  c.integrations.finishSummary(session, 'completed', { text: '변경한 요약\n- 이후에 요약이 변경되었습니다.' });
  assert.equal(c.writings.isCurrent(c.writings.get(request.operation_id)), false);
});

test('slow Jira synchronization does not block new local writing submissions', async t => {
  const c = setup(t), mock = await runtime(t, c.dir);
  c.store.ingestMany([...pair('jira-author', '09:00:00', '09:05:00'), ...pair('jira-author', '09:30:00', '09:35:00', 'two')]);
  const item = c.store.items()[0], session = c.integrations.closedSessions()[0];
  c.integrations.ensureSummary(session); c.integrations.finishSummary(session, 'completed', { text: '동기화 대기\n- 요청 작업을 확인했습니다.' });
  c.integrations.beginIssue(item.id, { version: item.version, operation_id: 'fixture-jira-link', cloud_id: 'test', project: 'TEST', issue_type: '1' });
  c.integrations.finishIssue('fixture-jira-link', 'linked', { id: '1', key: 'TEST-1', cloud_id: 'test' });
  let entered = false, release;
  const wait = new Promise(resolve => { release = resolve; });
  const coordinator = integrationCoordinator({ integrations: c.integrations, writings: writer(c), notify() {}, client: {
    status: async () => ({ connected: true }), writeWorklog: async () => { entered = true; await wait; return { id: 'log-1' }; }
  } });
  const inFlight = coordinator.tick();
  try {
    await eventually(() => entered);
    enqueue(c, item, 'during-jira-network-wait');
    await coordinator.tick();
    assert.equal(mock.submissions.length, 1); assert.equal(c.writings.get('during-jira-network-wait').state, 'running');
  } finally { release(); await inFlight; }
  assert.equal(c.integrations.worklog(session.id).state, 'synced');
});


test('legacy pending source-engine snapshots recover accepted runs without changing their submission', async t => {
  const c = setup(t), mock = await runtime(t, c.dir), coordinator = writer(c);
  c.store.ingestMany(pair('legacy-receipt', '09:00:00', '09:05:00'));
  const queued = enqueue(c, c.store.items()[0], 'legacy-receipt-recovery'); await coordinator.tick();
  const accepted = c.writings.get(queued.operation_id).run_id;
  const oldSnapshot = { ...queued.snapshot, engine: 'codex' };
  c.store.db.prepare("UPDATE writing_requests SET state='pending',run_id=NULL,snapshot=? WHERE operation_id=?")
    .run(JSON.stringify(oldSnapshot), queued.operation_id);
  await writer(c).tick();
  assert.equal(mock.submissions.length, 1); assert.equal(c.writings.get(queued.operation_id).run_id, accepted);
});

test('obsolete writing cancellation never stops a run owned by the user', async t => {
  const c = setup(t), mock = await runtime(t, c.dir), coordinator = writer(c);
  c.store.ingestMany(pair('ownership', '09:00:00', '09:05:00'));
  const item = c.store.items()[0]; enqueue(c, item, 'ownership-guard'); await coordinator.tick();
  const run = [...mock.runs.values()][0]; run.internal = false;
  c.store.edit(item.id, { version: item.version, title: '새 제목', description: '수정 내용' });
  await coordinator.tick();
  assert.deepEqual(mock.cancellations, []); assert.equal(run.status, 'running');
});

test('periodic admission replaces a stale pending summary atomically and preserves lost-receipt cancellation across restart', async t => {
  const c = setup(t), mock = await runtime(t, c.dir);
  c.store.ingestMany([...pair('late-summary', '09:00:00', '09:01:00', 'first'),
    ...pair('late-summary', '09:30:00', '09:31:00', 'second')]);
  const session = c.integrations.closedSessions()[0];
  const original = c.writings.enqueue('session-summary', session.id, { operation_id: 'stale-pending-summary' });
  await writer(c).tick();
  const originalRun = c.writings.get(original.operation_id).run_id;
  // The runtime accepted the job before its acknowledgement was persisted.
  c.store.db.prepare("UPDATE writing_requests SET state='pending',run_id=NULL WHERE operation_id=?").run(original.operation_id);
  const trigger = event('summary-trigger', 'input', '10:00:00', 'new-prompt', { source: 'system_hook' });
  c.store.ingestMany([...pair('late-summary', '09:05:00', '09:06:00', 'late-history'), trigger]);
  assert.equal(c.writings.isCurrent(original), false);

  assert.equal(c.writings.scheduleAutomatic({ summaries: true, metadata: false }), true);
  assert.equal(c.writings.get(original.operation_id).state, 'superseded');
  assert.deepEqual(c.writings.cancellations().map(row => row.run_id), [originalRun]);
  const replacement = c.writings.pending()[0];
  assert.equal(c.writings.pending().length, 1); assert.equal(replacement.source, 'automatic');
  assert.equal(replacement.target_id, session.id); assert.notEqual(replacement.run_key, original.run_key);
  assert.equal(replacement.snapshot.input.sessions[0].events.length, 4);
  assert.equal(c.integrations.summary(session.id).source_digest, replacement.snapshot.source_digest);
  assert.equal(replacement.snapshot.summary_trigger.kind, 'periodic');

  const restored = writingStore(c.store, c.integrations, { clock: () => Date.parse('2026-09-17T09:40:00Z') });
  c.store.ingestMany([trigger]);
  assert.equal(restored.scheduleAutomatic({ summaries: true, metadata: false }), false);
  assert.equal(restored.pending().length, 1);
  assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM writing_requests').get().n, 2);
  mock.unavailable(true); await writer({ ...c, writings: restored }).tick();
  assert.deepEqual(restored.cancellations().map(row => row.run_id), [originalRun]);
  assert.deepEqual(mock.cancellations, []); assert.equal(mock.submissions.length, 2);

  mock.unavailable(false); await writer({ ...c, writings: writingStore(c.store, c.integrations) }).tick();
  assert.deepEqual(mock.cancellations, [originalRun]); assert.deepEqual(restored.cancellations(), []);
  assert.equal(restored.get(replacement.operation_id).state, 'running');
  assert.equal(mock.runs.get(originalRun).status, 'cancelled');
  assert.equal(mock.submissions.length, 2);
});

test('five stale automatic summaries hold admission slots until cancellation is reconciled, then a timer refills the batch', async t => {
  const c = setup(t), mock = await runtime(t, c.dir);
  const agents = Array.from({ length: 5 }, (_, index) => `capacity-author-${index}`);
  c.store.ingestMany(agents.flatMap(agent => [...pair(agent, '09:00:00', '09:01:00', 'first'),
    ...pair(agent, '09:30:00', '09:31:00', 'second')]));
  c.store.ingestMany([event('capacity-trigger', 'input', '10:00:00', 'first-prompt', { source: 'system_hook' })]);
  assert.equal(c.writings.scheduleAutomatic({ summaries: true, metadata: false }), true);
  const originals = c.writings.pending();
  assert.equal(originals.length, 5); assert.ok(originals.every(row => row.source === 'automatic' && row.state === 'pending'));

  c.store.ingestMany(agents.flatMap(agent => pair(agent, '09:05:00', '09:06:00', 'late-history')));
  assert.ok(originals.every(row => !c.writings.isCurrent(row)));
  assert.equal(c.writings.scheduleAutomatic({ summaries: true, metadata: false }), true);
  assert.ok(originals.every(row => c.writings.get(row.operation_id).state === 'superseded'));
  assert.equal(c.writings.pending().length, 0);
  assert.equal(c.writings.cancellingSummaryCount(), 5);
  assert.deepEqual(c.writings.cancellations().map(row => row.run_id).sort(), originals.map(row => stableId('run-', row.run_key)).sort());
  const restored = writingStore(c.store, c.integrations, { clock: () => Date.parse('2026-09-17T09:40:00Z') });
  assert.equal(restored.scheduleAutomatic({ summaries: true, metadata: false }), false);
  await writer({ ...c, writings: restored }).tick();
  assert.deepEqual(restored.cancellations(), []);
  assert.equal(restored.scheduleAutomatic({ summaries: true, metadata: false }), true);
  const replacements = restored.pending();
  assert.equal(replacements.length, 5);
  assert.deepEqual(new Set(replacements.map(row => row.target_id)), new Set(originals.map(row => row.target_id)));
  assert.ok(replacements.every(row => row.snapshot.input.sessions[0].events.length === 4));
  await writer({ ...c, writings: restored }).tick();
  assert.equal(mock.submissions.length, 5); assert.deepEqual(restored.cancellations(), []);
  assert.ok(restored.pending().every(row => row.state === 'running'));
  assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM writing_requests').get().n, 10);
});

test('idle eligibility starts at exactly twenty minutes and an unchanged timer reuses source evidence', t => {
  let time = Date.parse('2026-09-17T09:24:59.999Z');
  const c = setup(t, { clock: () => time });
  c.store.ingestMany(pair('idle-boundary', '09:00:00', '09:05:00'));
  let reads = 0;
  const read = c.store.sessionMessages;
  c.store.sessionMessages = (...args) => { reads++; return read(...args); };
  assert.equal(c.writings.scheduleAutomatic({ summaries: true }), false);
  time += 1;
  assert.equal(c.writings.scheduleAutomatic({ summaries: true }), true);
  const request = c.writings.pending()[0], afterFirst = reads;
  assert.equal(request.snapshot.summary_trigger.reason, 'idle');
  assert.equal(c.writings.scheduleAutomatic({ summaries: true }), false);
  assert.equal(reads, afterFirst, 'unchanged timer polling must not reload conversation bodies');
  c.store.ingestMany([event('idle-boundary', 'input', '09:06:00', 'late-turn')]);
  assert.equal(c.writings.isCurrent(request), false);
  assert.ok(reads > afterFirst, 'late input must invalidate cached source evidence');
});
