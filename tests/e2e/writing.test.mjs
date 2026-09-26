import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, event, eventually } from '../helpers.mjs';
import { atlFixture, authorize, createIssue, adfText } from '../fixtures/atlassian.mjs';

async function setup(t, fixture = {}) {
  const h = new Harness(); h.env = { HARNESS_TEST_WRITING_FIXTURE: JSON.stringify(fixture) };
  t.after(() => h.close()); await h.start('runtime'); await h.start('manager'); return h;
}
const rewriteItem = (h, item, op) => h.manager(`/items/${item.id}/metadata/regenerate`, { method: 'POST', body: { operation_id: op, version: item.version } });
const rewriteSession = (h, sid, op) => h.manager(`/sessions/${sid}/summary/regenerate`, { method: 'POST', body: { operation_id: op } });
const finished = (h, op) => eventually(() => h.manager(`/writing/${op}`), r => !['pending', 'running'].includes(r.state), 20000);
const running = (h, op) => eventually(() => h.manager(`/writing/${op}`), r => r.state === 'running', 10000);
async function fixture(h, value) {
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = JSON.stringify(value); await h.start('manager');
}

test('GUI command API snapshots merged histories without duplicating an open session summary into the metadata input', async t => {
  const h = await setup(t);
  await h.ingest([...pair('author', '09:00:00', '09:05:00', 'one', { text: '요구사항 정리' }),
    ...pair('reviewer', '2026-09-18T09:00:00Z', '2026-09-18T09:10:00Z', 'two', { engine: 'claude', text: '설계 검토' })]);
  const items = await h.manager('/items');
  await h.manager('/merge', { method: 'POST', body: { ids: items.map(i => i.id), target: items[0].id, operation_id: 'merge-writing' } });
  let detail = await h.manager(`/items/${items[0].id}`);
  await rewriteSession(h, detail.sessions[0].id, 'summary-before-item');
  assert.equal((await finished(h, 'summary-before-item')).state, 'completed');
  detail = await h.manager(`/items/${items[0].id}`);
  const originalEvents = detail.events.filter(e => e.role === 'user');
  const accepted = detail.sessions[0].summary.text, version = detail.item.version;
  await h.manager(`/items/${detail.item.id}`, { method: 'PATCH', body: { version, title: '직접 쓴 이전 제목', description: '이전 설명' } });
  const item = (await h.manager(`/items/${detail.item.id}`)).item;
  const queued = await rewriteItem(h, item, 'rewrite-merged-metadata');
  assert.equal((await rewriteItem(h, item, 'rewrite-merged-metadata')).operation_id, queued.operation_id);
  await assert.rejects(rewriteItem(h, item, 'rewrite-duplicate-pending'), /이미 작성 중/);
  const done = await finished(h, queued.operation_id); assert.equal(done.state, 'completed');
  const run = await h.runtime(`/runs/${done.run_id}`);
  assert.equal(run.task, 'text.rewrite'); assert.equal(run.internal, true);
  assert.equal(run.request.input.format, 'work-item-metadata');
  assert.equal(run.request.input.sessions.length, 2);
  assert.equal(run.request.input.sessions[0].summary, null);
  assert.deepEqual(run.request.input.sessions.map(s => s.engine), ['codex', 'claude']);
  assert.deepEqual(run.request.input.sessions.flatMap(s => s.events).map(e => e.text), originalEvents.map(e => e.text));
  detail = await h.manager(`/items/${item.id}`);
  assert.equal(detail.sessions[0].summary.text, accepted, 'the accepted session summary remains stored');
  assert.equal(detail.item.version, item.version + 1); assert.match(detail.item.description, /2개 세션/);
  assert.deepEqual([...detail.item.description.matchAll(/^h2\. (.+)$/gm)].map(match => match[1]), ['배경', '목표', '요구사항', '작업 범위', '참고사항']);
  assert.equal(detail.item.manual, 1); assert.equal((await h.manager('/items')).length, 1);
  assert.deepEqual(detail.events.filter(e => e.role === 'user'), originalEvents);
  assert.equal((await rewriteItem(h, item, queued.operation_id)).run_id, done.run_id);
  await assert.rejects(rewriteItem(h, item, 'rewrite-stale-version'), /변경/);
});

test('active session can be summarized and rewritten repeatedly without new items or user I/O', async t => {
  const h = await setup(t);
  await h.ingest([event('active-writing', 'input', '09:00:00', 'first', { text: '작업 계획을 정리해 주세요' })]);
  const item = (await h.manager('/items'))[0], before = await h.manager(`/items/${item.id}`), sid = before.sessions[0].id;
  await rewriteSession(h, sid, 'active-summary-one');
  const first = await finished(h, 'active-summary-one'); assert.equal(first.state, 'completed');
  let detail = await h.manager(`/items/${item.id}`);
  assert.equal(detail.sessions[0].closed, false); assert.equal(detail.sessions[0].pending, true);
  assert.equal(detail.sessions[0].worklog, null);
  const text = detail.sessions[0].summary.text;
  await rewriteSession(h, sid, 'active-summary-two');
  detail = await h.manager(`/items/${item.id}`); assert.equal(detail.sessions[0].summary.text, text);
  const second = await finished(h, 'active-summary-two'); assert.equal(second.state, 'completed');
  assert.notEqual(first.run_id, second.run_id);
  assert.deepEqual((await h.runtime(`/runs/${first.run_id}`)).request.input, (await h.runtime(`/runs/${second.run_id}`)).request.input);
  detail = await h.manager(`/items/${item.id}`);
  assert.equal(detail.sessions.length, 1); assert.equal(detail.events.filter(e => e.role === 'user').length, 1);
  assert.equal((await h.manager('/items')).length, 1);
});

test('invalid output preserves accepted summary and metadata; deliberate retry starts a new validated run', async t => {
  const h = await setup(t);
  await h.ingest(pair('failed-writing', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0], sid = (await h.manager(`/items/${item.id}`)).sessions[0].id;
  await rewriteSession(h, sid, 'accepted-summary'); await finished(h, 'accepted-summary');
  const accepted = (await h.manager(`/items/${item.id}`)).sessions[0].summary.text;
  await fixture(h, { scenario: 'rewrite-blank' });
  await rewriteItem(h, item, 'invalid-metadata'); await rewriteSession(h, sid, 'invalid-session');
  assert.equal((await finished(h, 'invalid-metadata')).state, 'failed');
  assert.equal((await finished(h, 'invalid-session')).state, 'failed');
  let detail = await h.manager(`/items/${item.id}`);
  assert.equal(detail.item.title, item.title); assert.equal(detail.item.description, item.description);
  assert.equal(detail.sessions[0].summary.text, accepted); assert.equal(detail.sessions[0].summary.current, true);
  assert.equal(detail.item.activity, 'recent'); assert.equal((await h.manager('/quick')).counts.notifications, 2);
  await fixture(h, { rewriteVariant: true });
  await rewriteSession(h, sid, 'retry-valid-summary');
  assert.equal((await finished(h, 'retry-valid-summary')).state, 'completed');
  detail = await h.manager(`/items/${item.id}`); assert.match(detail.sessions[0].summary.text, /작업 기록/);
  assert.equal(detail.item.activity, 'recent', 'the independently failed metadata still needs attention');
  await rewriteItem(h, detail.item, 'retry-valid-metadata');
  assert.equal((await finished(h, 'retry-valid-metadata')).state, 'completed');
  assert.equal((await h.manager('/quick')).counts.notifications, 0);
  assert.equal((await h.manager('/writing/invalid-session')).state, 'failed', 'historical failures stay recorded without keeping attention open');
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager('/quick')).counts.notifications, 0);
});

test('editing metadata retires its latest failed rewrite without hiding unrelated session failures', async t => {
  const h = await setup(t, { scenario: 'rewrite-blank' });
  await h.ingest(pair('manual-attention', '09:00:00', '09:05:00'));
  let item = (await h.manager('/items'))[0];
  await rewriteItem(h, item, 'failed-before-edit'); assert.equal((await finished(h, 'failed-before-edit')).state, 'failed');
  assert.equal((await h.manager('/quick')).counts.notifications, 1);
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: '직접 확정한 제목', description: '직접 확정한 설명' } });
  assert.equal((await h.manager('/quick')).counts.notifications, 0);
  const detail = await h.manager(`/items/${item.id}`); item = detail.item;
  await rewriteSession(h, detail.sessions[0].id, 'failed-session-edit'); assert.equal((await finished(h, 'failed-session-edit')).state, 'failed');
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: '다시 편집한 제목', description: item.description } });
  assert.equal((await h.manager('/quick')).counts.notifications, 1, 'editing item metadata does not resolve its session summary failure');
});

test('failed summaries follow merged work and stay visible alongside agent activity until a fresh retry', async t => {
  const h = await setup(t, { scenario: 'rewrite-blank' });
  await h.ingest([...pair('summary-source', '09:00:00', '09:05:00', 'first', { work_item_id: 'summary-source' }),
    ...pair('summary-target', '09:00:00', '09:05:00', 'first', { work_item_id: 'summary-target' })]);
  const sid = (await h.manager('/items/summary-source')).sessions[0].id;
  await rewriteSession(h, sid, 'failed-before-merge'); assert.equal((await finished(h, 'failed-before-merge')).state, 'failed');
  await h.manager('/merge', { method: 'POST', body: { ids: ['summary-source', 'summary-target'], target: 'summary-target', operation_id: 'merge-failed-summary' } });
  await h.ingest([event('summary-target', 'input', '09:10:00', 'next', { work_item_id: 'summary-target' })]);
  let overview = await h.manager('/quick');
  assert.equal(overview.counts.total, 1); assert.equal(overview.counts.current, 1); assert.equal(overview.counts.notifications, 1);
  assert.equal(overview.notifications[0].work_item_id, 'summary-target');
  assert.deepEqual(overview.current[0].activities, ['agent_response_pending']);
  await fixture(h, { delayMs: 900 });
  await rewriteSession(h, sid, 'retry-after-merge'); await running(h, 'retry-after-merge');
  overview = await h.manager('/quick');
  assert.equal(overview.counts.notifications, 0, 'a fresh request replaces the old failure');
  assert.equal(overview.current[0].activity, 'agent_response_pending', 'internal rewrite progress does not replace native activity');
  assert.equal((await finished(h, 'retry-after-merge')).state, 'completed');
  await h.ingest([event('summary-target', 'output', '09:12:00', 'next', { work_item_id: 'summary-target' })]);
  overview = await h.manager('/quick'); assert.equal(overview.counts.current, 0); assert.equal(overview.counts.notifications, 0);
  assert.equal(overview.counts.recent, 1);
});

test('a manual edit during headless generation wins; the obsolete generated title is not applied', async t => {
  const h = await setup(t, { delayMs: 1300 });
  await h.ingest(pair('edit-writing', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0];
  await rewriteItem(h, item, 'edit-in-flight');
  const job = await running(h, 'edit-in-flight');
  await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: '사용자가 방금 확정한 제목', description: '편집한 설명' } });
  assert.equal((await finished(h, 'edit-in-flight')).state, 'superseded');
  await h.finish({ id: job.run_id });
  const detail = await h.manager(`/items/${item.id}`);
  assert.equal(detail.item.title, '사용자가 방금 확정한 제목'); assert.equal(detail.item.description, '편집한 설명');
});

test('new prompt/output invalidate only captured inputs; old summary remains visible with stale indicator', async t => {
  const h = await setup(t);
  await h.ingest(pair('live-writing', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0], sid = (await h.manager(`/items/${item.id}`)).sessions[0].id;
  await rewriteSession(h, sid, 'live-original'); await finished(h, 'live-original');
  const old = (await h.manager(`/items/${item.id}`)).sessions[0].summary.text;
  await fixture(h, { delayMs: 1300 });
  await rewriteItem(h, item, 'live-item-rewrite'); await rewriteSession(h, sid, 'live-session-rewrite');
  const run = await running(h, 'live-session-rewrite');
  await h.ingest(pair('live-writing', '09:10:00', '09:12:00', 'next', { text: '새로운 요구사항' }));
  assert.equal((await finished(h, 'live-item-rewrite')).state, 'superseded');
  assert.equal((await finished(h, 'live-session-rewrite')).state, 'superseded');
  assert.equal((await h.runtime(`/runs/${run.run_id}`)).request.input.sessions[0].events.length, 2);
  const detail = await h.manager(`/items/${item.id}`);
  assert.equal(detail.sessions[0].summary.text, old); assert.equal(detail.sessions[0].summary.current, false);
  assert.equal(detail.events.filter(e => e.role === 'user').length, 4);
});

test('merging during metadata generation protects representative metadata and does not resegment sessions', async t => {
  const h = await setup(t, { delayMs: 1000 });
  await h.ingest([...pair('merge-write-a', '09:00:00', '09:05:00'), ...pair('merge-write-b', '10:00:00', '10:05:00')]);
  const [a, b] = await h.manager('/items');
  await rewriteItem(h, a, 'merging-metadata'); await running(h, 'merging-metadata');
  await h.manager('/merge', { method: 'POST', body: { ids: [a.id, b.id], target: b.id, operation_id: 'merge-during-writing' } });
  assert.equal((await finished(h, 'merging-metadata')).state, 'superseded');
  const detail = await h.manager(`/items/${b.id}`);
  assert.equal(detail.item.title, b.title); assert.equal(detail.item.description, b.description); assert.equal(detail.sessions.length, 2);
});

test('queued requests survive runtime absence and manager restart; lost submit receipt reuses the same run', async t => {
  const h = await setup(t, { delayMs: 600 }); await h.stop('runtime');
  await h.ingest(pair('restart-writing', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0];
  await rewriteItem(h, item, 'durable-rewrite');
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager('/writing/durable-rewrite')).state, 'pending');
  await h.start('runtime');
  const first = await running(h, 'durable-rewrite'); await h.stop('manager');
  // Crash after runtime accepted POST, before the local receipt was committed.
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  db.prepare("UPDATE writing_requests SET state='pending',run_id=NULL WHERE operation_id='durable-rewrite'").run(); db.close();
  await h.start('manager');
  assert.equal((await rewriteItem(h, item, 'durable-rewrite')).operation_id, 'durable-rewrite');
  const done = await finished(h, 'durable-rewrite'); assert.equal(done.state, 'completed'); assert.equal(done.run_id, first.run_id);
  const detail = await eventually(() => h.manager(`/items/${item.id}`), d => d.runs.length === 1);
  assert.equal(detail.item.version, item.version + 1);
});

test('a stale generation with a lost submission receipt is cancelled after manager restart', async t => {
  const h = await setup(t, { delayMs: 15000 });
  await h.ingest(pair('lost-receipt-stale', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0]; await rewriteItem(h, item, 'stale-lost-receipt');
  const accepted = await running(h, 'stale-lost-receipt'); await h.stop('manager');
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  db.prepare("UPDATE writing_requests SET state='pending',run_id=NULL WHERE operation_id='stale-lost-receipt'").run();
  db.prepare('UPDATE work_items SET version=version+1 WHERE id=?').run(item.id); db.close();
  await h.start('manager');
  assert.equal((await finished(h, 'stale-lost-receipt')).state, 'superseded');
  const cancelled = await eventually(() => h.runtime(`/runs/${accepted.run_id}`), run => run.status === 'cancelled');
  assert.equal(cancelled.internal, true); assert.equal(cancelled.artifact, null);
});

test('tampered final artifact cannot overwrite metadata even when runtime reports completed', async t => {
  const h = await setup(t, { delayMs: 400 });
  await h.ingest(pair('tampered-writing', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0]; await rewriteItem(h, item, 'tampered-rewrite');
  const started = await running(h, 'tampered-rewrite'); await h.stop('manager');
  const run = await h.finish({ id: started.run_id }); assert.equal(run.status, 'completed');
  fs.appendFileSync(run.artifact.file, ' ');
  await h.start('manager');
  const done = await finished(h, 'tampered-rewrite'); assert.equal(done.state, 'failed'); assert.match(done.message, /변경/);
  assert.equal((await h.manager(`/items/${item.id}`)).item.version, item.version);
});

test('on-demand summaries wait for closure; later rewrites PUT the same Jira worklog with unchanged time', async t => {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('runtime'); await h.start('manager'); await authorize(h);
  await h.ingest(pair('jira-rewrite', '09:00:00', '09:05:00', 'first', { text: '권한 정의를 정리했습니다.' }));
  const item = (await h.manager('/items'))[0]; await createIssue(h, item);
  const sid = (await h.manager(`/items/${item.id}`)).sessions[0].id;
  await rewriteSession(h, sid, 'jira-open-summary'); await finished(h, 'jira-open-summary');
  assert.equal(f.state.worklogs.length, 0);
  await h.ingest(pair('jira-rewrite', '09:25:00', '09:30:00', 'next'));
  await eventually(() => h.manager(`/items/${item.id}`), d => d.sessions[0].worklog?.state === 'synced');
  const log = structuredClone(f.state.worklogs[0]); await fixture(h, { rewriteVariant: true });
  await rewriteSession(h, sid, 'jira-closed-rewrite');
  assert.equal((await finished(h, 'jira-closed-rewrite')).state, 'completed');
  const detail = await eventually(() => h.manager(`/items/${item.id}`), d => d.sessions[0].worklog?.state === 'synced' && d.sessions[0].summary.text.includes('작업 기록'));
  assert.equal(f.state.worklogs.length, 1); assert.equal(f.state.worklogs[0].id, log.id);
  assert.equal(f.state.worklogs[0].started, log.started); assert.equal(f.state.worklogs[0].timeSpentSeconds, log.timeSpentSeconds);
  assert.equal(adfText(f.state.worklogs[0].comment), detail.sessions[0].summary.text);
  assert.equal(f.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/worklog')).length, 1);
  assert.ok(f.state.calls.some(c => c.method === 'PUT' && c.path.includes('/worklog/')));
  await rewriteItem(h, detail.item, 'jira-local-metadata'); await finished(h, 'jira-local-metadata');
  assert.equal(f.state.issues[0].fields.summary, item.title); // Creating a ticket is the only authorized metadata write.
});

test('text.rewrite rejects unknown formats/fields and enforces the session five-line description gate', async t => {
  const h = await setup(t);
  const input = { format: 'session-summary', sessions: [{ id: 'session-1', engine: 'codex', start_at: '2026-09-17T09:00:00Z', end_at: '2026-09-17T09:05:00Z', summary: null,
    events: [{ kind: 'input', event_at: '2026-09-17T09:00:00Z', text: '요구 정리 요청' }] }] };
  for (const invalid of [{ ...input, format: 'anything' }, { ...input, engine: 'codex' }, { ...input, sessions: [...input.sessions, ...input.sessions] }]) {
    await assert.rejects(h.run({ task: 'text.rewrite', input: invalid }), /위반/);
  }
  const run = await h.run({ task: 'text.rewrite', input, internal: true, fixture: { scenario: 'rewrite-six-lines' } });
  const failed = await h.finish(run); assert.notEqual(failed.status, 'completed'); assert.ok(failed.round <= 2);
  const good = await h.finish(await h.run({ task: 'text.rewrite', input, internal: true })); assert.equal(good.status, 'completed');
  const description = JSON.parse(fs.readFileSync(good.artifact.file)).description.split('\n');
  assert.ok(description.length <= 5 && description.every(line => line.startsWith('- ')));
  for (const attempt of good.attempts) assert.match(fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8'), /최대 5개 bullet 항목/);
  const emptyBullet = await h.finish(await h.run({ task: 'text.rewrite', input, internal: true, fixture: { scenario: 'rewrite-empty-bullet' } }));
  assert.notEqual(emptyBullet.status, 'completed');
  // New runs reject plain paragraphs; stored legacy summaries are covered by the UI scenario.
  const legacy = await h.finish(await h.run({ task: 'text.rewrite', input, internal: true, fixture: { scenario: 'rewrite-legacy-paragraph' } }));
  assert.equal(legacy.status, 'failed'); assert.equal(legacy.artifact, null);
});

test('metadata default requests five Jira wiki sections and keeps missing results explicitly unconfirmed', async t => {
  const h = await setup(t);
  await h.ingest([event('metadata-unconfirmed', 'input', '09:00:00', 'first', { text: '권한 관리 화면을 검토해 주세요.' })]);
  const item = (await h.manager('/items'))[0];
  await rewriteItem(h, item, 'metadata-no-result');
  assert.equal((await finished(h, 'metadata-no-result')).state, 'completed');
  const detail = await h.manager(`/items/${item.id}`);
  assert.deepEqual([...detail.item.description.matchAll(/^h2\. (.+)$/gm)].map(match => match[1]), ['배경', '목표', '요구사항', '작업 범위', '참고사항']);
  assert.match(detail.item.description, /h2\. 참고사항\n\* 미완료:.*미확인/);
  const run = await h.runtime(`/runs/${detail.metadata_rewrite.run_id}`);
  assert.equal(run.attempts.length, 1, 'metadata generation uses one model call');
  const prompt = fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8');
  for (const heading of ['배경', '목표', '요구사항', '작업 범위', '참고사항']) assert.ok(prompt.includes(`h2. ${heading}`));
  assert.match(prompt, /결과가 없거나 확인되지 않았으면 미완료·미확인/);
});

test('oversized automatic summary is reported without blocking unrelated manual work or retrying forever', async t => {
  const h = await setup(t);
  const events = Array.from({ length: 1001 }, (_, i) => pair('large-writing', '09:00:00', '09:05:00', `t${i}`)).flat();
  for (let i = 0; i < events.length; i += 500) await h.ingest(events.slice(i, i + 500));
  await h.ingest([...pair('large-writing', '09:25:00', '09:30:00', 'next', { source: 'system_hook' }), ...pair('normal-writing', '10:00:00', '10:05:00', 'normal')]);
  // Seed the full oversized source before enabling periodic admission. Its
  // final, small idle window is independently eligible for a valid summary.
  await h.stop('manager'); h.env.HARNESS_TEST_SESSION_SUMMARIES = '1'; await h.start('manager');
  const items = await h.manager('/items'), large = items.find(i => i.session_count === 2), normal = items.find(i => i.session_count === 1);
  const failed = await eventually(() => h.manager(`/items/${large.id}`), d => d.sessions[0].summary?.state === 'failed');
  assert.match(failed.sessions[0].summary.message, /2000/); assert.equal(failed.sessions[0].rewrite, null);
  assert.equal(failed.sessions[0].summary.run_id, null);
  assert.equal(failed.item.activity, 'recent'); assert.equal((await h.manager('/quick')).counts.notifications, 1);
  await rewriteItem(h, normal, 'unrelated-normal-writing'); assert.equal((await finished(h, 'unrelated-normal-writing')).state, 'completed');
  const again = await h.manager(`/items/${large.id}`);
  assert.equal(again.sessions[0].summary.updated_at, failed.sessions[0].summary.updated_at);
});
