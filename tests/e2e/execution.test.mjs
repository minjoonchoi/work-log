import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Harness, eventually, event } from '../helpers.mjs';
import { ROOT, digest, alive } from '../../src/shared.mjs';

async function scenario(t, manager = true) { const h = await new Harness().start('runtime'); if (manager) await h.start('manager'); t.after(() => h.close()); return h; }
test('PRD real process workflow: produce → verify → independent review → repair → verify → review → publish', async t => {
  const h = await scenario(t);
  const run = await h.run({ fixture: { scenario: 'revise-once' } });
  const result = await h.finish(run);
  assert.equal(result.status, 'completed', result.message); assert.equal(result.round, 1);
  assert.deepEqual(result.attempts.map(a => a.stage), ['produce', 'review', 'repair', 'review']);
  assert.equal(new Set(result.attempts.map(a => a.pid)).size, 4);
  assert.match(fs.readFileSync(result.artifact.file, 'utf8'), /거절 상태/);
  assert.equal(digest(fs.readFileSync(result.artifact.file)), result.artifact.content_digest);
  const items = await eventually(() => h.manager('/items'), rows => rows[0]?.state === 'completed');
  const d = await h.manager(`/items/${items[0].id}`);
  assert.equal(d.sessions.length, 1); assert.equal(d.agents.filter(a => a.role === 'worker').length, 4);
  assert.equal(d.events.filter(e => e.role === 'worker').length, 8);
});
test('HTML workload is checked in a real browser, including requested button behavior and screenshot evidence', async t => {
  const h = await scenario(t, false);
  const run = await h.run({ task: 'mockup.html.create', input: { browser_checks: [{ click: '#save', visible: '#result', text: '저장되었습니다' }] } });
  const result = await h.finish(run, 20000);
  assert.equal(result.status, 'completed', result.message);
  const report = JSON.parse(fs.readFileSync(result.artifact.verify_report));
  assert.equal(report.checks.find(c => c.check === 'browser').interaction_count, 1);
  assert.ok(fs.statSync(path.join(path.dirname(result.artifact.verify_report), 'browser.png')).size > 1000);
});
test('non-working HTML interaction cannot pass and stops at repair budget', async t => {
  const h = await scenario(t, false);
  const run = await h.run({ task: 'mockup.html.create', fixture: { scenario: 'bad-html' }, input: { browser_checks: [{ click: '#save', visible: '#result' }] } });
  const result = await h.finish(run, 30000);
  assert.equal(result.status, 'blocked'); assert.equal(result.round, 2); assert.equal(result.artifact, null);
  assert.ok(result.attempts.every(a => a.stage !== 'review'), 'failed browser gate skips expensive review');
});
test('entity workload returns a validated immutable artifact', async t => {
  const h = await scenario(t, false); const result = await h.finish(await h.run({ task: 'entity.design' }));
  assert.equal(result.status, 'completed'); assert.match(fs.readFileSync(result.artifact.file, 'utf8'), /불변식/);
});
for (const [fixture, expected] of [['invalid', 'protocol_failure'], ['truncated', 'protocol_failure'], ['missing-evidence', '필수 검토'], ['tamper', '검토자가'], ['crash', '실행 실패'], ['flood', 'output_limit']]) {
  test(`failure scenario ${fixture}: no successful publication`, async t => {
    const h = await scenario(t, false); const r = await h.finish(await h.run({ fixture: { scenario: fixture } }));
    assert.equal(r.status, 'failed'); assert.match(r.message, new RegExp(expected)); assert.equal(r.artifact, null);
  });
}
test('missing mandatory checks and perpetual blocking issues stop within two repairs', async t => {
  const h = await scenario(t, false);
  for (const name of ['missing-section', 'always-revise']) {
    const result = await h.finish(await h.run({ fixture: { scenario: name } }));
    assert.equal(result.status, 'blocked'); assert.equal(result.round, 2); assert.equal(result.artifact, null);
    assert.ok(result.attempts.length <= 6);
  }
});
test('GUI/manager outage does not stop a run; durable outbox reconciles after restart', async t => {
  const h = await scenario(t);
  await h.stop('manager', 'SIGKILL');
  const result = await h.finish(await h.run()); assert.equal(result.status, 'completed');
  await h.start('manager');
  const items = await eventually(() => h.manager('/items'), rows => rows[0]?.state === 'completed');
  assert.equal(items.length, 1); assert.equal((await h.manager(`/items/${items[0].id}`)).runs[0].id, result.id);
  const count = (await h.manager('/health')).events;
  await h.stop('manager'); await h.start('manager');
  assert.equal((await h.manager('/health')).events, count);
});
test('cancel propagates through process tree; a late process result cannot resurrect run', async t => {
  const h = await scenario(t); const run = await h.run({ fixture: { scenario: 'child' } });
  const active = await eventually(() => h.runtime(`/runs/${run.id}`), r => r.attempts[0]?.pid && fs.existsSync(path.join(r.attempts[0].directory, 'workspace/child.pid')));
  const childPid = Number(fs.readFileSync(path.join(active.attempts[0].directory, 'workspace/child.pid')));
  await h.manager(`/runs/${run.id}/cancel`, { method: 'POST', body: {} });
  await eventually(() => alive(active.attempts[0].pid) || alive(childPid), value => !value);
  assert.equal((await h.runtime(`/runs/${run.id}`)).status, 'cancelled');
});
test('timeout is recorded as failure; safe resume uses a new isolated attempt', async t => {
  const h = await scenario(t, false); const result = await h.finish(await h.run({ fixture: { scenario: 'slow', timeoutMs: 100 } }));
  assert.equal(result.status, 'failed'); assert.match(result.message, /timeout/);
  await eventually(() => h.runtime(`/runs/${result.id}/resume`, { method: 'POST', body: {} }), r => r.status === 'running' || r.status === 'pending');
  const retried = await h.finish(result);
  assert.equal(retried.attempts.length, 2); assert.notEqual(retried.attempts[0].directory, retried.attempts[1].directory);
});
test('runtime crash marks interrupted and refuses resume while old write worker survives', async t => {
  const h = await scenario(t, false); const run = await h.run({ fixture: { scenario: 'slow', delayMs: 2000 } });
  const active = await eventually(() => h.runtime(`/runs/${run.id}`), r => r.attempts[0]?.pid);
  await h.stop('runtime', 'SIGKILL'); await h.start('runtime');
  assert.equal((await h.runtime(`/runs/${run.id}`)).status, 'interrupted');
  await assert.rejects(h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} }), /worker가 살아/);
  await eventually(() => alive(active.attempts[0].pid), value => !value, 7000);
  await h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} });
  const resumed = await h.finish(run); assert.equal(resumed.status, 'completed');
});
test('scheduler limits concurrent subprocesses; duplicate service start fails', async t => {
  const h = await scenario(t, false);
  const runs = await Promise.all(Array.from({ length: 5 }, () => h.run({ fixture: { delayMs: 250 } })));
  assert.ok((await h.runtime('/health')).active <= 3);
  const second = spawn(process.execPath, [path.join(ROOT, 'src/runtime.mjs')], { env: { ...process.env, HARNESS_DATA_DIR: h.dir }, stdio: 'ignore' });
  const exit = await new Promise(resolve => second.on('exit', resolve)); assert.notEqual(exit, 0);
  const results = await Promise.all(runs.map(r => h.finish(r))); assert.ok(results.every(r => r.status === 'completed'));
});
test('crash after final file publication recovers the verified artifact without repeating a model attempt', async t => {
  const h = await scenario(t, false);
  const exit = new Promise(resolve => h.processes.runtime.once('exit', resolve));
  const run = await h.run({ fixture: { crashAfterPublish: true } });
  assert.equal(await exit, 73); await h.start('runtime');
  const interrupted = await h.runtime(`/runs/${run.id}`); assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.attempts.length, 2);
  await h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} });
  const resumed = await h.runtime(`/runs/${run.id}`);
  assert.equal(resumed.status, 'completed', resumed.message); assert.equal(resumed.attempts.length, 2);
  assert.equal(resumed.steps.at(-1).reason, 'publication_reconciled');
  assert.equal(resumed.steps.at(-1).next_node, '$completed');
  assert.equal(digest(fs.readFileSync(resumed.artifact.file)), resumed.artifact.content_digest);
});
test('native prompt hook → harness delegation → worker → native Stop has exactly one real prompt/output pair', async t => {
  const h = await scenario(t);
  h.hook('codex', { session_id: 'native-entry', turn_id: 'native-turn', hook_event_name: 'UserPromptSubmit', prompt: '초대 PRD 작성' });
  await eventually(() => h.manager('/health'), health => health.events === 1);
  const run = await h.run({ origin: { engine: 'codex', agent_session_id: 'native-entry', turn_id: 'native-turn' } });
  assert.equal((await h.finish(run)).status, 'completed');
  await eventually(() => h.manager('/items'), items => items[0]?.session_count === 1);
  let [item] = await h.manager('/items');
  assert.notEqual(item.state, 'completed', 'a background result is not a fabricated native assistant response');
  h.hook('codex', { session_id: 'native-entry', turn_id: 'native-turn', hook_event_name: 'Stop', last_assistant_message: '검증한 PRD를 제공합니다.' });
  [item] = await eventually(() => h.manager('/items'), items => items[0]?.state === 'completed');
  const detail = await h.manager(`/items/${item.id}`);
  const io = detail.events.filter(e => e.role === 'user' && ['input', 'output'].includes(e.kind));
  assert.equal(io.length, 2); assert.equal(detail.sessions.length, 1); assert.equal(detail.sessions[0].pending, false);
  assert.ok(detail.events.filter(e => e.role === 'worker').every(e => e.session_id === detail.sessions[0].id));
});
