import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, eventually } from '../helpers.mjs';
import { alive, digest } from '../../src/shared.mjs';

async function setup(t) {
  const h = await new Harness().start('runtime'); t.after(() => h.close()); return h;
}
const reviewedDocument = { task: 'document.create', review: { required: true, reason: '사용자가 별도의 독립 검토를 명시적으로 요청했습니다.' } };
const resume = (h, run) => h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} });
const settled = h => eventually(() => h.runtime('/health'), result => result.active === 0);

test('new workers receive a one-hour deadline and explicitly reviewed document generation uses only two invocations', async t => {
  const h = await setup(t), run = await h.finish(await h.run({ ...reviewedDocument }));
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.attempts.map(a => a.stage), ['produce', 'review']);
  for (const attempt of run.attempts) {
    const observed = JSON.parse(fs.readFileSync(path.join(attempt.directory, 'process.json')));
    assert.equal(observed.timeout_ms, 3600000);
  }
});

test('review timeout and service restart preserve the generated candidate; explicit resume retries only review', async t => {
  const h = await setup(t), run = await h.finish(await h.run({ ...reviewedDocument, fixture: { stallStage: 'review', timeoutMs: 800 } }));
  assert.equal(run.status, 'failed', run.message); assert.match(run.message, /timeout/);
  assert.deepEqual(run.attempts.map(a => a.stage), ['produce', 'review']);
  const file = path.join(run.attempts[0].directory, 'workspace/document-create.md'), before = digest(fs.readFileSync(file));
  await h.stop('runtime'); await h.start('runtime');
  assert.equal((await h.runtime(`/runs/${run.id}`)).attempts.length, 2, 'a restart must not retry a failed job automatically');
  await resume(h, run);
  const done = await h.finish(run);
  assert.equal(done.status, 'completed', done.message);
  assert.deepEqual(done.attempts.map(a => a.stage), ['produce', 'review', 'review']);
  assert.equal(done.artifact.content_digest, before);
  assert.equal(digest(fs.readFileSync(file)), before);
  assert.deepEqual(done.steps.filter(step => step.epoch === 1).map(step => step.task), ['review', 'render']);
});

test('repair timeout preserves the original finding and repair round when resumed', async t => {
  const h = await setup(t), run = await h.finish(await h.run({ ...reviewedDocument,
    fixture: { scenario: 'revise-once', stallStage: 'repair', timeoutMs: 800 } }));
  assert.equal(run.status, 'failed', run.message); assert.equal(run.round, 1);
  await settled(h); await resume(h, run);
  const done = await h.finish(run);
  assert.equal(done.status, 'completed', done.message); assert.equal(done.round, 1);
  assert.deepEqual(done.attempts.map(a => a.stage), ['produce', 'review', 'repair', 'repair', 'review']);
  assert.match(fs.readFileSync(path.join(done.attempts[3].directory, 'prompt.txt'), 'utf8'), /거절 상태의 수용 기준을 추가/);
});

for (const target of ['artifact', 'verification']) {
  test(`a changed ${target} rejects resume instead of silently regenerating or reviewing different content`, async t => {
    const h = await setup(t), run = await h.finish(await h.run({ ...reviewedDocument, fixture: { stallStage: 'review', timeoutMs: 800 } }));
    assert.equal(run.status, 'failed'); await settled(h);
    const file = path.join(run.attempts[0].directory, target === 'artifact' ? 'workspace/document-create.md' : 'verification.json');
    fs.appendFileSync(file, target === 'artifact' ? '\nunauthorized change\n' : '\n');
    await assert.rejects(resume(h, run), /변경되었습니다/);
    assert.equal((await h.runtime(`/runs/${run.id}`)).attempts.length, 2);
  });
}

test('service crash during review resumes review after the old worker exits, without regenerating', async t => {
  const h = await setup(t), run = await h.run({ ...reviewedDocument, fixture: { stallStage: 'review', stallMs: 1600 } });
  const active = await eventually(() => h.runtime(`/runs/${run.id}`), value => value.attempts[1]?.pid);
  const pid = active.attempts[1].pid;
  t.after(() => { if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch {} } });
  await h.stop('runtime', 'SIGKILL'); await h.start('runtime');
  await assert.rejects(resume(h, run), /worker가 살아/);
  await eventually(() => !alive(pid));
  await resume(h, run);
  const done = await h.finish(run);
  assert.equal(done.status, 'completed', done.message);
  assert.deepEqual(done.attempts.map(a => a.stage), ['produce', 'review', 'review']);
});

test('manual resume cannot reset an exhausted repair budget', async t => {
  const h = await setup(t), run = await h.finish(await h.run({ ...reviewedDocument, fixture: { scenario: 'always-revise' } }));
  assert.equal(run.status, 'blocked'); assert.equal(run.round, 2); assert.equal(run.attempts.length, 6);
  await settled(h); await assert.rejects(resume(h, run), /한도에 도달한 실행/);
  assert.equal((await h.runtime(`/runs/${run.id}`)).attempts.length, 6);
});

test('the frozen production timeout stays unchanged across resume', async t => {
  const h = await setup(t), run = await h.finish(await h.run({ fixture: { scenario: 'crash' } }));
  await settled(h); await resume(h, run); const done = await h.finish(run);
  const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'), { readOnly: true });
  try { assert.equal(JSON.parse(db.prepare('SELECT definition FROM runs WHERE id=?').get(run.id).definition).limits.timeoutMs, 3600000); }
  finally { db.close(); }
  assert.equal(done.attempts.length, 2);
});

test('publication crash recovery rejects changed checkpoint evidence before declaring completion', async t => {
  const h = await setup(t), exit = new Promise(resolve => h.processes.runtime.once('exit', resolve));
  const run = await h.run({ ...reviewedDocument, fixture: { crashAfterPublish: true } });
  assert.equal(await exit, 73);
  const intent = JSON.parse(fs.readFileSync(path.join(h.dir, 'runs', run.id, 'publication-intent.json')));
  const publishedDigest = digest(fs.readFileSync(intent.file));
  // The report still parses and says passed; its accepted bytes have changed.
  fs.appendFileSync(intent.verify_report, '\n');
  await h.start('runtime');
  const before = await h.runtime(`/runs/${run.id}`);
  assert.equal(before.status, 'interrupted'); assert.equal(before.attempts.length, 2);
  await assert.rejects(resume(h, run), error => error.status === 409 && /검사 근거가 변경되었습니다/.test(error.message));
  const after = await h.runtime(`/runs/${run.id}`);
  assert.equal(after.status, 'interrupted'); assert.equal(after.epoch, before.epoch);
  assert.equal(after.attempts.length, before.attempts.length);
  assert.equal(after.steps.some(step => step.reason === 'publication_reconciled'), false);
  assert.equal(digest(fs.readFileSync(intent.file)), publishedDigest);
});

test('an unconfirmed process tree blocks standalone resume across restarts while legacy observations retain existing behavior', async t => {
  const h = await setup(t), run = await h.finish(await h.run({ task: 'document.create', fixture: { scenario: 'crash' } }));
  assert.equal(run.status, 'failed'); await settled(h); await h.stop('runtime');
  const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'));
  const row = db.prepare('SELECT id,result FROM attempts WHERE run_id=?').get(run.id), original = JSON.parse(row.result);
  db.prepare('UPDATE attempts SET result=? WHERE id=?').run(JSON.stringify({ ...original,
    observation: { ...original.observation, termination_confirmed: false, parent_exit_observed: true, stdio_closed: false, termination_grace_ms: 1000 } }), row.id);
  db.close(); await h.start('runtime');
  const before = await h.runtime(`/runs/${run.id}`);
  await assert.rejects(resume(h, run), error => error.status === 409 && /프로세스 트리 종료를 확인하지 못/.test(error.message));
  const after = await h.runtime(`/runs/${run.id}`);
  assert.equal(after.epoch, before.epoch); assert.deepEqual(after.attempts, before.attempts);

  await h.stop('runtime');
  const legacy = structuredClone(original); delete legacy.observation.termination_confirmed;
  const restored = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'));
  restored.prepare('UPDATE attempts SET result=? WHERE id=?').run(JSON.stringify(legacy), row.id); restored.close();
  await h.start('runtime'); await resume(h, run);
  assert.equal((await h.finish(run)).attempts.length, 2);
});

test('plan and child resume preflight all siblings before resuming an unconfirmed process tree', async t => {
  const h = await setup(t);
  const step = id => ({ id, task: 'document.create', output_key: id, request_excerpt: id,
    input: { requirements: `${id} 문서를 작성한다.` }, depends_on: [] });
  const plan = await h.runtime('/plans', { method: 'POST', body: { prompt: 'first second', engine: 'fixture',
    fixture: { scenario: 'crash' }, steps: [step('first'), step('second')] } });
  const failed = await eventually(() => h.runtime(`/plans/${plan.id}`), value => value.status === 'failed');
  await settled(h); await h.stop('runtime');
  const runIds = failed.steps.map(step => step.run_id), db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'));
  const row = db.prepare('SELECT id,result FROM attempts WHERE run_id=?').get(runIds[1]);
  const result = JSON.parse(row.result); result.observation.termination_confirmed = false;
  db.prepare('UPDATE attempts SET result=? WHERE id=?').run(JSON.stringify(result), row.id); db.close();
  await h.start('runtime');
  const before = await Promise.all(runIds.map(id => h.runtime(`/runs/${id}`)));
  for (const route of [`/plans/${plan.id}/resume`, `/runs/${runIds[0]}/resume`, `/runs/${runIds[1]}/resume`])
    await assert.rejects(h.runtime(route, { method: 'POST', body: {} }), error => error.status === 409 && /프로세스 트리 종료를 확인하지 못/.test(error.message));
  const after = await Promise.all(runIds.map(id => h.runtime(`/runs/${id}`)));
  assert.deepEqual(after.map(run => ({ epoch: run.epoch, attempts: run.attempts })), before.map(run => ({ epoch: run.epoch, attempts: run.attempts })));
  assert.equal((await h.runtime(`/plans/${plan.id}`)).status, 'failed');
});

test('a persisted unconfirmed process observation blocks recovery even if service exit preceded its attempt result commit', async t => {
  const h = await setup(t), run = await h.finish(await h.run({ task: 'document.create', fixture: { scenario: 'crash' } }));
  await settled(h); await h.stop('runtime');
  const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'));
  const row = db.prepare('SELECT id,pid,directory FROM attempts WHERE run_id=?').get(run.id);
  const file = path.join(row.directory, 'process.json'), original = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...original, termination_confirmed: false, parent_exit_observed: true, stdio_closed: false }));
  db.prepare("UPDATE attempts SET result=NULL,status='running',ended_at=NULL WHERE id=?").run(row.id);
  db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id); db.close();
  await h.start('runtime');
  const before = await h.runtime(`/runs/${run.id}`); assert.equal(before.status, 'interrupted');
  await assert.rejects(resume(h, run), error => error.status === 409 && /프로세스 트리 종료를 확인하지 못/.test(error.message));
  assert.deepEqual((await h.runtime(`/runs/${run.id}`)).attempts, before.attempts);
});
