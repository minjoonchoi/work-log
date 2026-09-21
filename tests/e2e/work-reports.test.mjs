import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, event, eventually } from '../helpers.mjs';

const post = body => ({ method: 'POST', body });
const put = body => ({ method: 'PUT', body });
async function setup(t, fixture = {}, runtime = true) {
  const h = new Harness(); h.env = { HARNESS_TEST_REPORT_FIXTURE: JSON.stringify(fixture) };
  t.after(() => h.close()); if (runtime) await h.start('runtime'); await h.start('manager'); return h;
}
const create = (h, operation_id, extra = {}) => h.manager('/reports', post({ operation_id, dates: ['2026-09-17'], timezone: 'Asia/Seoul', ...extra }));
const finished = (h, report, timeout = 20000) => eventually(() => h.manager(`/reports/${report.id}`), value => ['completed', 'failed'].includes(value.report.state), timeout);
const seed = (h, agent = 'report-source') => h.ingest(pair(agent, '2026-09-17T01:00:00Z', '2026-09-17T01:05:00Z', 'one', { work_item_id: agent, text: '변경 내용을 검토했습니다.' }));

test('local start date selects sessions once across midnight, merged sources stay traceable, and report lists omit snapshots', async t => {
  const h = await setup(t);
  await h.ingest([
    ...pair('selected-midnight', '2026-09-17T14:55:00Z', '2026-09-17T15:05:00Z', 'cross', { work_item_id: 'report-a', text: '자정을 넘긴 작업' }),
    ...pair('selected-peer', '2026-09-17T15:10:00Z', '2026-09-17T15:20:00Z', 'peer', { work_item_id: 'report-b', engine: 'claude', text: '동료와 검토' }),
    ...pair('starts-before-selection', '2026-09-16T14:55:00Z', '2026-09-17T02:00:00Z', 'old', { work_item_id: 'excluded-overlap' }),
    ...pair('hidden-report-source', '2026-09-17T04:00:00Z', '2026-09-17T04:10:00Z', 'hidden', { work_item_id: 'hidden-report-source' }),
    ...pair('worker-report-source', '2026-09-17T05:00:00Z', '2026-09-17T05:10:00Z', 'worker', { role: 'worker', work_item_id: 'report-a', text: '내부 작업은 요약에 넣지 않는다' })
  ]);
  const a = (await h.manager('/items/report-a')).item;
  await h.manager('/items/report-a/tags', put({ version: a.version, tags: ['backend'] }));
  await h.manager('/merge', post({ ids: ['report-a', 'report-b'], target: 'report-a', operation_id: 'merge-report-sources' }));
  await h.manager('/items/delete', post({ ids: ['hidden-report-source'], operation_id: 'delete-before-report' }));
  const beforeItems = (await h.manager('/items')).map(item => item.id);
  const report = await create(h, 'create-multiple-date-report', { dates: ['2026-09-18', '2026-09-17'] });
  assert.equal(report.session_count, 2); assert.deepEqual(report.dates, ['2026-09-17', '2026-09-18']);
  assert.equal((await create(h, 'create-multiple-date-report', { dates: ['2026-09-17', '2026-09-18'] })).id, report.id);
  const result = await finished(h, report); assert.equal(result.report.state, 'completed', result.report.message);
  const summaryView = await h.manager(`/reports/${report.id}?view=summary`);
  assert.equal(Object.hasOwn(summaryView, 'sessions'), false);
  assert.deepEqual(summaryView.report, result.report); assert.deepEqual(summaryView.parts, result.parts);
  assert.ok(summaryView.parts.every(part => !Object.hasOwn(part, 'input') && !Object.hasOwn(part, 'body')));
  await assert.rejects(h.manager(`/reports/${report.id}?view=invalid`), error => error.status === 400);
  assert.equal(result.sessions.length, 2); assert.equal(new Set(result.sessions.map(session => session.id)).size, 2);
  assert.deepEqual(new Set(result.sessions.map(session => session.original_work_item_id)), new Set(['report-a', 'report-b']));
  assert.ok(result.sessions.every(session => session.work_item_id === 'report-a' && session.tags.includes('backend')));
  assert.doesNotMatch(result.report.body, /\[(?:session|part):|근거 세션/);
  const storedPart = await h.manager(`/reports/${report.id}/parts/${result.parts[0].id}`);
  assert.deepEqual(new Set(storedPart.part.source_refs), new Set(result.sessions.map(session => `session:${session.id}`)));
  assert.equal(storedPart.part.body, result.report.body);
  assert.equal(Object.hasOwn(result.report, 'source_refs'), false);
  assert.deepEqual((await h.manager('/items')).map(item => item.id), beforeItems);
  const [row] = await h.manager('/reports'); assert.equal(row.id, report.id);
  assert.equal(row.body, undefined); assert.equal(row.sessions, undefined); assert.equal(row.snapshot, undefined);
  const run = await h.runtime(`/runs/${result.report.run_id}`);
  assert.equal(run.task, 'work.report.create'); assert.equal(run.internal, true);
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']); assert.equal(run.artifact.validation_scope, 'format');
  assert.equal((await h.manager('/sessions')).filter(session => session.work_item_id === 'report-a').length, 2);
  await h.stop('manager');
  const legacy = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  legacy.exec('ALTER TABLE work_reports DROP COLUMN session_count'); legacy.close();
  await h.start('manager');
  const migrated = await h.manager(`/reports/${report.id}?view=summary`);
  assert.deepEqual(migrated.report, result.report); assert.equal((await h.runtime('/runs')).length, 1);
});

test('accepted summaries reduce report input while queued snapshots survive later metadata, tags and dialogue changes', async t => {
  const h = await setup(t, { delayMs: 700 }); await seed(h);
  const source = await h.manager('/items/report-source'), sid = source.sessions[0].id;
  await h.manager(`/sessions/${sid}/summary/regenerate`, post({ operation_id: 'summary-for-report' }));
  await eventually(() => h.manager('/writing/summary-for-report'), row => row.state === 'completed');
  const captured = await create(h, 'frozen-summary-report');
  const snapshot = await h.manager(`/reports/${captured.id}`); assert.ok(snapshot.sessions[0].summary); assert.deepEqual(snapshot.sessions[0].events, []);
  const item = (await h.manager('/items/report-source')).item;
  await h.manager('/items/report-source/tags', put({ version: item.version, tags: ['later-tag'] }));
  await h.ingest(pair('report-source', '2026-09-17T01:10:00Z', '2026-09-17T01:15:00Z', 'later', { work_item_id: item.id, text: '요약 접수 후 추가된 이력' }));
  const result = await finished(h, captured); assert.equal(result.report.state, 'completed', result.report.message);
  assert.deepEqual(result.sessions, snapshot.sessions); assert.equal(result.report.source_digest, captured.source_digest);
  assert.ok(!JSON.stringify(result.sessions).includes('later-tag')); assert.ok(!JSON.stringify(result.sessions).includes('접수 후'));
});

test('report admission validates dates, IANA timezone, request identity and empty scopes without calling the model', async t => {
  const h = await setup(t); await seed(h);
  for (const extra of [{ dates: [] }, { dates: ['2026-02-30'] }, { dates: ['2026-09-17', '2026-09-17'] },
    { dates: Array.from({ length: 367 }, (_, index) => new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10)) },
    { timezone: 'Mars/Unknown' }, { timezone: '+09:00' }, { report_type: 'performance' }, { report_type: 'invented' }, { extra: true }]) {
    await assert.rejects(create(h, 'invalid-report-input', extra), error => error.status === 400);
  }
  await assert.rejects(create(h, 'empty-report-selection', { dates: ['2025-01-01'] }), error => error.status === 409);
  assert.deepEqual(await h.manager('/reports'), []); assert.deepEqual(await h.runtime('/runs'), []);
  const report = await create(h, 'stable-report-request');
  await assert.rejects(create(h, 'stable-report-request', { timezone: 'UTC' }), error => error.status === 409);
  await assert.rejects(h.manager('/reports/unknown'), error => error.status === 404);
  assert.equal((await finished(h, report)).report.state, 'completed');
});

test('queued and submitted report parts recover manager restarts without duplicate runs; creation order stays descending', async t => {
  const h = await setup(t, { delayMs: 1000 }, false); await seed(h);
  const first = await create(h, 'report-runtime-unavailable'); await h.stop('manager');
  await h.start('runtime'); await h.start('manager');
  const running = await eventually(() => h.manager(`/reports/${first.id}`), value => value.report.state === 'running');
  await h.stop('manager'); await h.start('manager');
  const completed = await finished(h, first); assert.equal(completed.report.state, 'completed');
  assert.equal(completed.report.run_id, running.report.run_id); assert.equal((await h.runtime('/runs')).length, 1);
  const second = await create(h, 'newer-report-created'); await finished(h, second);
  assert.deepEqual((await h.manager('/reports')).map(report => report.id), [second.id, first.id]);
  assert.equal((await create(h, 'report-runtime-unavailable')).id, first.id); assert.equal((await h.runtime('/runs')).length, 2);
});

test('format and provenance failures stay failed without model retries, while a new operation can generate a new report', async t => {
  const h = await setup(t); await seed(h);
  const scenarios = ['report-invalid', 'report-missing-source', 'report-unknown-source', 'report-duplicate-source',
    'report-body-source-leak', 'report-body-evidence-section'];
  for (const scenario of scenarios) {
    await h.stop('manager'); h.env.HARNESS_TEST_REPORT_FIXTURE = JSON.stringify({ scenario }); await h.start('manager');
    const report = await create(h, `failure-${scenario}`), result = await finished(h, report);
    assert.equal(result.report.state, 'failed'); assert.equal(result.report.body, null);
    const run = await h.runtime(`/runs/${result.report.run_id}`); assert.equal(run.status, 'failed');
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']); assert.equal(run.artifact, null);
  }
  await h.stop('manager'); h.env.HARNESS_TEST_REPORT_FIXTURE = '{}'; await h.start('manager');
  const retried = await create(h, 'new-operation-after-report-failure'); assert.equal((await finished(h, retried)).report.state, 'completed');
  assert.equal((await h.runtime('/runs')).length, scenarios.length + 1);
});

test('annual work reports with more than 500 sessions reduce validated parts with complete transitive source coverage', async t => {
  const h = await setup(t); const total = 501;
  const events = Array.from({ length: total }, (_, index) => pair(`annual-${index}`, '2026-09-17T01:00:00Z', '2026-09-17T01:01:00Z', 'one',
    { work_item_id: 'annual-work-item', text: `관측된 수행 기록 ${index}; 확인된 결과 지표는 없음` })).flat();
  for (let index = 0; index < events.length; index += 500) await h.ingest(events.slice(index, index + 500));
  const dates = Array.from({ length: 365 }, (_, index) => new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10));
  const report = await create(h, 'annual-work-report', { dates });
  assert.equal(report.session_count, total); assert.ok(report.progress.total > 1);
  await eventually(() => h.manager(`/reports/${report.id}`), value => value.parts.some(part => part.state === 'completed'), 20000);
  await h.stop('manager'); await h.start('manager');
  const result = await finished(h, report, 60000); assert.equal(result.report.state, 'completed', result.report.message);
  const summaryView = await h.manager(`/reports/${report.id}?view=summary`);
  assert.equal(Object.hasOwn(summaryView, 'sessions'), false);
  assert.deepEqual(summaryView.report, result.report); assert.deepEqual(summaryView.parts, result.parts);
  assert.ok(Buffer.byteLength(JSON.stringify(summaryView)) < Buffer.byteLength(JSON.stringify(result)) / 2);
  assert.equal(result.report.report_type, 'work');
  assert.deepEqual([...result.report.body.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['업무 개요', '수행 내용', '미완료·확인 사항']);
  assert.doesNotMatch(result.report.body, /\[(?:session|part):|근거 세션/);
  const leaves = result.parts.filter(part => part.level === 0);
  assert.equal(new Set(leaves.flatMap(part => part.source_ids)).size, total);
  assert.deepEqual(new Set(leaves.flatMap(part => part.source_ids)), new Set(result.sessions.map(session => session.id)));
  const root = result.parts.find(part => part.run_id === result.report.run_id && part.level === Math.max(...result.parts.map(part => part.level)));
  assert.equal(root.source_ids.length, total); assert.ok(root.dependencies.length >= 2);
  const storedRoot = await h.manager(`/reports/${report.id}/parts/${root.id}`);
  assert.deepEqual(new Set(storedRoot.part.source_refs), new Set(root.dependencies.map(dependency => `part:${dependency}`)));
  const intermediate = await h.manager(`/reports/${report.id}/parts/${root.dependencies[0]}`);
  assert.equal(intermediate.part.state, 'completed'); assert.ok(intermediate.part.body); assert.ok(intermediate.part.source_ids.length);
  await assert.rejects(h.manager(`/reports/${report.id}/parts/unknown`), error => error.status === 404);
  const runs = await h.runtime('/runs'); assert.equal(new Set(result.parts.map(part => part.run_id)).size, runs.length);
  assert.ok(runs.every(run => run.internal && run.task === 'work.report.create' && run.status === 'completed'));
  for (const run of runs) {
    const full = await h.runtime(`/runs/${run.id}`);
    assert.ok(Buffer.byteLength(JSON.stringify(full.request.input)) <= 120 * 1024);
    assert.deepEqual(full.attempts.map(attempt => attempt.stage), ['produce']);
    const part = result.parts.find(part => part.run_id === run.id);
    const stored = (await h.manager(`/reports/${report.id}/parts/${part.id}`)).part;
    const input = full.request.input, type = input.stage === 'consolidate' ? 'part' : 'session';
    assert.deepEqual(new Set(stored.source_refs), new Set((input.parts || input.sessions).map(source => `${type}:${source.id}`)));
    assert.ok(stored.source_refs.length <= 100); assert.equal(new Set(stored.source_refs).size, stored.source_refs.length);
    assert.doesNotMatch(stored.body, /\[(?:session|part):|근거 세션/);
  }
  assert.equal((await h.manager('/items')).length, 1); assert.equal((await h.manager('/sessions')).length, total);
});

test('oversized source admission leaves no partial report and a failed hierarchy stops only its own queued parts', async t => {
  const h = await setup(t, { scenario: 'report-unknown-source' });
  await h.ingest(pair('oversized-report-input', '2026-09-18T01:00:00Z', '2026-09-18T01:01:00Z', 'one',
    { work_item_id: 'oversized-report-input', text: 'a'.repeat(70000) }));
  await assert.rejects(create(h, 'reject-oversized-report', { dates: ['2026-09-18'] }), error => error.status === 400 && /120KiB/.test(error.message));
  assert.deepEqual(await h.manager('/reports'), []);
  const events = Array.from({ length: 401 }, (_, index) => pair(`failure-part-${index}`, '2026-09-17T01:00:00Z', '2026-09-17T01:01:00Z', 'one',
    { work_item_id: 'failing-hierarchy', text: '부분 작성 실패를 검증할 원문' })).flat();
  for (let index = 0; index < events.length; index += 500) await h.ingest(events.slice(index, index + 500));
  const userRun = await h.run({ fixture: { delayMs: 1000 } });
  const report = await create(h, 'failing-hierarchical-report');
  const result = await eventually(() => h.manager(`/reports/${report.id}`), value => value.report.state === 'failed'
    && value.parts.every(part => !['pending', 'running'].includes(part.state)), 30000);
  assert.equal(result.report.body, null); assert.ok(result.parts.some(part => part.state === 'failed'));
  assert.ok(result.parts.some(part => part.state === 'cancelled' && !part.run_id));
  assert.equal((await h.finish(userRun)).status, 'completed', 'report failure must not cancel an unrelated user run');
  const reportRuns = (await h.runtime('/runs')).filter(run => run.task === 'work.report.create');
  assert.ok(reportRuns.length <= 3); assert.ok(reportRuns.every(run => !['pending', 'running'].includes(run.status)));
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager(`/reports/${report.id}`)).report.state, 'failed');
  assert.equal((await h.runtime('/runs')).filter(run => run.task === 'work.report.create').length, reportRuns.length);
});

test('report task appears in editable execution settings and fixed scope rejects review overrides', async t => {
  const h = await setup(t); await seed(h);
  const settings = await h.runtime('/execution-settings'), configured = settings.tasks.find(task => task.id === 'work.report.create');
  assert.ok(configured); assert.deepEqual(Object.keys(configured.backends.codex.defaults), ['produce']);
  assert.match(configured.instruction, /status\.report/); assert.match(configured.instruction, /성과|기여/);
  await h.runtime('/execution-settings/work.report.create', put({ revision: settings.revision, instruction: configured.instruction + '\n\n간결한 한국어로 작성하세요.',
    backend: 'claude', backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } } }));
  const report = await create(h, 'configured-report-task'), result = await finished(h, report);
  const run = await h.runtime(`/runs/${result.report.run_id}`);
  assert.match(fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8'), /간결한 한국어/);
  await assert.rejects(h.runtime('/runs', post({ task: 'work.report.create', input: run.request.input, engine: 'fixture', internal: true,
    review: { required: false, reason: '선택 변경' } })), /고정된 검증/);
  await assert.rejects(h.runtime('/runs', post({ task: 'work.report.create', input: { ...run.request.input, report_type: 'performance' }, engine: 'fixture', internal: true })), error => error.status === 400);
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_reports').get().n, 1); db.close();
});

test('completed historical reports remain unchanged while retired pending and running requests stop only their own internal parts', async t => {
  const h = await setup(t); await seed(h, 'legacy-report-history');
  const completed = await create(h, 'completed-historical-report');
  const accepted = await finished(h, completed); assert.equal(accepted.report.state, 'completed');
  await h.stop('manager'); h.env.HARNESS_TEST_REPORT_FIXTURE = JSON.stringify({ delayMs: 3000 }); await h.start('manager');
  const userRun = await h.run({ fixture: { delayMs: 1000 } });
  const running = await create(h, 'retired-running-report'), normal = await create(h, 'preserved-normal-report');
  const [runningDetail] = await eventually(async () => Promise.all([running, normal].map(report => h.manager(`/reports/${report.id}`))),
    rows => rows.every(value => value.report.state === 'running'), 15000);
  const queued = await create(h, 'retired-queued-report');
  await h.stop('manager');
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  const historicalBody = '## 목표와 역할\n이전 기록\n\n## 수행과 협업\n이전 기록\n\n## 성과와 근거\n미확인 결과\n\n## 한계와 성장\n이전 기록\n\n## 근거 세션\n이전 근거';
  for (const report of [completed, running, queued]) {
    db.prepare("UPDATE work_reports SET request=json_set(request,'$.report_type','performance'),snapshot=json_set(snapshot,'$.report_type','performance') WHERE id=?").run(report.id);
    db.prepare("UPDATE work_report_parts SET input=json_set(input,'$.report_type','performance') WHERE report_id=?").run(report.id);
  }
  db.prepare('UPDATE work_reports SET title=?,body=? WHERE id=?').run('이전 버전에서 작성된 기록', historicalBody, completed.id);
  const before = db.prepare('SELECT * FROM work_reports WHERE id=?').get(completed.id);
  const queuedRunId = db.prepare('SELECT run_id FROM work_report_parts WHERE report_id=?').get(queued.id).run_id;
  assert.equal(queuedRunId, null, 'fixture must capture the unsubmitted legacy case');
  db.close();
  await h.start('manager');
  const retired = await eventually(() => h.manager(`/reports/${running.id}`), value => value.report.state === 'failed'
    && value.parts.every(part => !['pending', 'running'].includes(part.state)), 15000);
  assert.match(retired.report.message, /일반 업무 요약으로 새로 작성/);
  assert.equal((await h.runtime(`/runs/${runningDetail.report.run_id}`)).status, 'cancelled');
  const retiredQueued = await h.manager(`/reports/${queued.id}`);
  assert.equal(retiredQueued.report.state, 'failed'); assert.ok(retiredQueued.parts.every(part => part.run_id === null && part.state === 'cancelled'));
  assert.equal((await finished(h, normal)).report.state, 'completed');
  assert.equal((await h.finish(userRun)).status, 'completed');
  const historical = await h.manager(`/reports/${completed.id}`);
  assert.equal(historical.report.state, 'completed'); assert.equal(historical.report.title, before.title); assert.equal(historical.report.body, historicalBody);
  assert.equal(historical.report.report_type, 'performance');
  const after = new DatabaseSync(path.join(h.dir, 'memory.sqlite'), { readOnly: true });
  assert.deepEqual(after.prepare('SELECT * FROM work_reports WHERE id=?').get(completed.id), before); after.close();
  assert.equal((await h.runtime('/runs')).length, 4, 'retired queued report must not start a new model run');
});
