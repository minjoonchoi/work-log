import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Harness, pair, eventually } from '../helpers.mjs';
const summary = { task: 'session.summarize', internal: true, input: { title: '작업 요약', events: [
  { kind: 'input', event_at: '2026-09-17T09:00:00Z', text: '작업을 정리해 주세요.' }
] } };

test('response-only publication resumes after a crash without a verification report or another model call', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const exited = new Promise(resolve => h.processes.runtime.once('exit', resolve));
  const run = await h.run({ ...summary, fixture: { crashAfterPublish: true, scenario: 'summary-too-long' } });
  assert.equal(await exited, 73);
  await h.start('runtime');
  await h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} });
  const result = await h.finish(run);
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(result.steps.map(step => step.task), ['produce', 'render']);
  assert.equal(result.artifact.verify_report, undefined);
  assert.equal(result.artifact.validation_scope, 'response');
  assert.ok(fs.readFileSync(result.artifact.file, 'utf8').split('\n').length > 6);
});

test('six-line summary is committed to SQLite unchanged, while an unreadable response preserves it without retry', async t => {
  const h = new Harness(); t.after(() => h.close());
  h.env = { HARNESS_TEST_WRITING_FIXTURE: JSON.stringify({ scenario: 'rewrite-six-lines' }) };
  await h.start('runtime'); await h.start('manager');
  await h.ingest(pair('stored-response', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0], detail = await h.manager(`/items/${item.id}`);
  const sid = detail.sessions[0].id;
  const generate = operation_id => h.manager(`/sessions/${sid}/summary/regenerate`, { method: 'POST', body: { operation_id } });
  const finish = id => eventually(() => h.manager(`/writing/${id}`), row => !['pending', 'running'].includes(row.state));
  await generate('six-lines');
  const saved = await finish('six-lines');
  assert.equal(saved.state, 'completed', saved.message);
  const stored = (await h.manager(`/items/${item.id}`)).sessions[0].summary.text;
  assert.equal(stored.split('\n').length, 7);
  const run = await h.runtime(`/runs/${saved.run_id}`);
  assert.equal(run.attempts.length, 1);
  assert.deepEqual(run.steps.map(step => step.task), ['produce', 'render']);
  await h.stop('manager');
  h.env.HARNESS_TEST_WRITING_FIXTURE = JSON.stringify({ scenario: 'invalid' });
  await h.start('manager');
  await generate('bad-response');
  const failed = await finish('bad-response');
  assert.equal(failed.state, 'failed');
  assert.equal((await h.runtime(`/runs/${failed.run_id}`)).attempts.length, 1);
  const after = await h.manager(`/items/${item.id}`);
  assert.equal(after.sessions[0].summary.text, stored);
  assert.equal((await h.manager('/items')).length, 1);
});
