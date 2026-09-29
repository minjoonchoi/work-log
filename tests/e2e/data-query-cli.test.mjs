import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Harness, pair, eventually } from '../helpers.mjs';
import { ROOT, readEndpoint } from '../../src/shared.mjs';

async function cli(h, args, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), 'query', ...args], {
    env: { ...process.env, HARNESS_DATA_DIR: h.dir, CODEX_THREAD_ID: 'query-must-not-create-an-item', ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { exit, stdout, stderr, value: stdout.trim() ? JSON.parse(stdout) : null };
}
async function query(h, ...args) { const r = await cli(h, args); assert.equal(r.exit, 0, r.stderr); return r.value; }
async function setup(t) {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  for (const [n, title] of [[1, '인증 정책'], [2, '검색 개선'], [3, '배포 문서']]) {
    await h.ingest(pair(`agent-${n}`, `0${n}:00:00`, `0${n}:05:00`, `turn-${n}`, { work_item_id: `item-${n}`, text: `원본 ${title}` }));
    await h.manager(`/items/item-${n}`, { method: 'PATCH', body: { version: (await h.manager('/items')).find(row => row.id === `item-${n}`).version, title, description: `h2. 배경\n${title} 설명` } });
  }
  await h.manager('/items/item-1/tags', { method: 'PUT', body: { version: (await h.manager('/items')).find(row => row.id === 'item-1').version, tags: ['backend'] } });
  return h;
}

test('agents query local items, sessions, raw I/O and tags without starting runtime or creating any work', async t => {
  const h = await setup(t), before = await h.manager('/health');
  const items = await query(h, 'items');
  assert.deepEqual(items.records.map(row => row.id), ['item-3', 'item-2', 'item-1']);
  assert.equal(items.version, 1); assert.equal(items.next_cursor, null);
  const found = await query(h, 'items', '--search', '인증', '--tag', 'backend', '--jira', 'unlinked');
  assert.deepEqual(found.records.map(row => row.id), ['item-1']);
  const item = (await query(h, 'item', 'item-1')).record;
  assert.equal(item.item.title, '인증 정책'); assert.equal(item.events, undefined);
  const sessions = (await query(h, 'sessions', '--item', 'item-1', '--engine', 'codex')).records;
  assert.equal(sessions.length, 1); assert.equal(sessions[0].events, undefined);
  assert.equal((await query(h, 'session', sessions[0].id)).record.work_item_id, 'item-1');
  const history = await query(h, 'history', '--item', 'item-1', '--session', sessions[0].id, '--limit', '1');
  assert.equal(history.records[0].kind, 'output'); assert.equal(history.records[0].text, '원본 인증 정책');
  const older = await query(h, 'history', '--item', 'item-1', '--session', sessions[0].id, '--cursor', history.next_cursor);
  assert.equal(older.records[0].kind, 'input'); assert.equal(older.next_cursor, null);
  assert.deepEqual((await query(h, 'tags')).records, [{ name: 'backend', count: 1 }]);
  const worker = await cli(h, ['items'], { HARNESS_WORKER: '1' }); assert.equal(worker.exit, 0);
  const after = await h.manager('/health'); assert.equal(after.events, before.events);
  assert.equal((await h.manager('/items')).length, 3); assert.equal(readEndpoint(h.dir, 'runtime'), null);
});

test('list cursors detect changed scopes or data and time filters support explicit local timezone boundaries', async t => {
  const h = await setup(t);
  const first = await query(h, 'items', '--limit', '1');
  const second = await query(h, 'items', '--limit', '1', '--cursor', first.next_cursor);
  assert.equal(second.records[0].id, 'item-2');
  const changedScope = await cli(h, ['items', '--search', '인증', '--cursor', first.next_cursor]);
  assert.equal(changedScope.exit, 1); assert.equal(JSON.parse(changedScope.stderr.trim().split('\n').at(-1)).status, 409);
  await h.manager('/items/item-1', { method: 'PATCH', body: { version: (await h.manager('/items')).find(row => row.id === 'item-1').version, title: '인증 정책 수정', description: '수정' } });
  const stale = await cli(h, ['items', '--cursor', first.next_cursor]); assert.equal(stale.exit, 1);
  assert.match(stale.stderr, /첫 페이지/);
  const dates = await query(h, 'sessions', '--from', '2026-09-17T10:00:00+09:00', '--to', '2026-09-17T11:00:00+09:00');
  assert.deepEqual(dates.records.map(row => row.work_item_id), ['item-1']);
  const empty = await query(h, 'items', '--search', '없는업무'); assert.equal(empty.total, 0); assert.equal(empty.next_cursor, null);
});

test('merged aliases resolve to one owner, and deleted or unrelated session records cannot be queried', async t => {
  const h = await setup(t);
  const session = (await query(h, 'sessions', '--item', 'item-1')).records[0];
  assert.equal((await cli(h, ['history', '--item', 'item-2', '--session', session.id])).exit, 1);
  await h.manager('/merge', { method: 'POST', body: { ids: ['item-1', 'item-2'], target: 'item-2', operation_id: 'query-merge' } });
  assert.equal((await query(h, 'item', 'item-1')).record.item.id, 'item-2');
  assert.equal((await query(h, 'sessions', '--item', 'item-1')).records.length, 2);
  await h.manager('/items/delete', { method: 'POST', body: { ids: ['item-2'], operation_id: 'query-delete' } });
  for (const args of [['item', 'item-1'], ['session', session.id], ['history', '--item', 'item-1', '--session', session.id]])
    assert.equal((await cli(h, args)).exit, 1);
  assert.deepEqual((await query(h, 'items')).records.map(row => row.id), ['item-3']);
});

test('query rejects SQL, unexpected flags, ambiguous dates and missing IDs without network or filesystem mutations', async t => {
  const h = new Harness(); t.after(() => h.close());
  assert.equal((await query(h, '--help')).read_only, true);
  for (const args of [['constructor'], ['sql', 'select * from events'], ['items', '--limit', '0'], ['items', '--limit', '2', '--limit', '3'],
    ['items', '--from', '2026-02-30'], ['items', '--from', '2026-09-17T12:00:00'], ['item'],
    ['history', '--item', 'item-1'], ['items', '--to', '2026-09-17', '--from', '2026-09-18'], ['runs', '--internal', 'yes']]) {
    const result = await cli(h, args); assert.equal(result.exit, 1, JSON.stringify(args)); assert.equal(result.stdout, '');
  }
  const offline = await cli(h, ['items']); assert.equal(offline.exit, 1); assert.match(offline.stderr, /manager/);
  assert.equal(fs.existsSync(path.join(h.dir, 'memory.sqlite')), false);
  assert.equal(readEndpoint(h.dir, 'manager'), null);
});

test('query endpoint uses normal local authentication and only supports GET', async t => {
  const h = await setup(t), url = `http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}/api/query?resource=items`;
  assert.equal((await fetch(url)).status, 401);
  const token = fs.readFileSync(path.join(h.dir, 'token'), 'utf8').trim();
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 404);
  await assert.rejects(h.manager('/query?resource=items&limit=1&limit=2'), error => error.status === 400);
});

test('completed work reports and cached run artifacts remain queryable after the execution service stops', async t => {
  const h = await setup(t); await h.start('runtime');
  const created = await h.manager('/reports', { method: 'POST', body: { operation_id: 'query-report', dates: ['2026-09-17'], timezone: 'UTC' } });
  const complete = await eventually(() => h.manager(`/reports/${created.id}?view=summary`), row => row.report.state === 'completed', 20000);
  const run = await h.finish(await h.run({ work_item_id: 'item-1', task: 'session.summarize', internal: true, input: { title: '기록 요약', events: [{ kind: 'input', event_at: '2026-09-17T00:00:00Z', text: '기록을 정리해 주세요.' }] } })); assert.equal(run.status, 'completed');
  await eventually(() => query(h, 'runs', '--item', 'item-1', '--internal', 'include'), value => value.records.some(row => row.id === run.id && row.status === 'completed'));
  await h.stop('runtime');
  const listed = await query(h, 'reports'); assert.equal(listed.records[0].id, created.id); assert.equal(listed.records[0].body, undefined);
  const report = (await query(h, 'report', created.id)).record; assert.equal(report.report.body, complete.report.body); assert.equal(report.sessions, undefined);
  const stored = (await query(h, 'run', run.id)).record; assert.equal(stored.status, 'completed'); assert.ok(stored.artifact);
  assert.equal((await query(h, 'runs', '--item', 'item-1')).records.some(row => row.internal), false);
});
