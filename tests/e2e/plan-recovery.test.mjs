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
function request(fixture, third = false) {
  return {
    prompt: 'PRD를 작성하고 엔티티를 설계하고 필요하면 테스트 시나리오를 계획해 주세요.', engine: 'fixture', fixture,
    steps: [{ id: 'prd', task: 'prd.create', output_key: 'product-requirements', request_excerpt: 'PRD를 작성',
      input: { requirements: '초대 수락과 거절을 포함하는 제품 요구사항 및 수용 기준을 작성하세요.' }, depends_on: [] },
    { id: 'entities', task: 'entity.design', output_key: 'domain-entities', request_excerpt: '엔티티를 설계',
      input: { requirements: '선행 PRD를 바탕으로 초대 엔티티와 관계 및 불변식을 설계하세요.' }, depends_on: ['prd'] },
    ...(third ? [{ id: 'scenarios', task: 'test.scenarios.plan', output_key: 'acceptance-scenarios', request_excerpt: '테스트 시나리오를 계획해 주세요.',
      input: { requirements: [{ id: 'REQ-INVITE', text: '초대 수락과 거절 상태의 불변식을 검증한다.' }] }, depends_on: ['entities'] }] : [])]
  };
}
const plan = (h, input) => h.runtime('/plans', { method: 'POST', body: input });
const read = (h, id) => h.runtime(`/plans/${id}`);
const control = (h, id, action) => h.runtime(`/plans/${id}/${action}`, { method: 'POST', body: {} });
const finish = (h, id) => eventually(() => read(h, id), value => ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(value.status), 15000);
async function runningAttempt(h, runId) {
  return eventually(() => h.runtime(`/runs/${runId}`), run => run.attempts.some(a => a.status === 'running' && a.pid));
}
function database(h, t) {
  const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'), { readOnly: true }); t.after(() => db.close()); return db;
}

test('cancelling a plan stops an active worker and keeps its waiting descendant unstarted', async t => {
  const h = await setup(t), accepted = await plan(h, request({ scenario: 'slow', delayMs: 4000 }));
  const started = await eventually(() => read(h, accepted.id), p => p.steps[0].status === 'running');
  const active = await runningAttempt(h, started.steps[0].run_id), pid = active.attempts.find(a => a.status === 'running').pid;
  const cancelled = await control(h, accepted.id, 'cancel');
  assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(cancelled.steps.map(s => s.status), ['cancelled', 'cancelled']);
  assert.equal(cancelled.steps[1].run_id, null); assert.deepEqual(cancelled.artifacts, []);
  await eventually(() => h.runtime('/health'), health => health.active === 0);
  assert.equal(alive(pid), false);
  const stable = await read(h, accepted.id); assert.equal(stable.steps[1].run_id, null);
  const db = database(h, t); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 1);
});

test('runtime crash leaves the old worker interrupted and never starts its dependent until explicit safe resume', async t => {
  const h = await setup(t), accepted = await plan(h, request({ scenario: 'slow', delayMs: 1400 }));
  const started = await eventually(() => read(h, accepted.id), p => p.steps[0].status === 'running');
  const first = await runningAttempt(h, started.steps[0].run_id), pid = first.attempts.find(a => a.status === 'running').pid;
  t.after(() => { if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch {} } });
  await h.stop('runtime', 'SIGKILL'); await h.start('runtime');
  const interrupted = await finish(h, accepted.id);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.steps[0].status, 'interrupted');
  assert.equal(interrupted.steps[1].run_id, null); assert.ok(['pending', 'blocked'].includes(interrupted.steps[1].status));
  assert.equal(alive(pid), true);
  await assert.rejects(control(h, accepted.id, 'resume'), /worker가 살아|worker 종료/);
  const denied = await read(h, accepted.id); assert.equal(denied.status, 'interrupted'); assert.equal(denied.steps[1].run_id, null);
  await eventually(() => !alive(pid), Boolean, 5000);
  const beforeResume = await read(h, accepted.id); assert.equal(beforeResume.steps[1].run_id, null);
  await control(h, accepted.id, 'resume');
  const done = await finish(h, accepted.id); assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(done.artifacts.length, 2);
  const db = database(h, t);
  const oldAttempts = db.prepare('SELECT epoch FROM attempts WHERE run_id=? ORDER BY started_at').all(first.id);
  assert.deepEqual(oldAttempts.map(a => a.epoch), [0, 1, 1]);
  const secondRow = db.prepare('SELECT created_at FROM runs WHERE id=?').get(done.steps[1].run_id);
  const firstRow = db.prepare('SELECT updated_at FROM runs WHERE id=?').get(first.id);
  assert.ok(secondRow.created_at >= firstRow.updated_at, 'dependent begins only after resumed predecessor completes');
});

test('resuming a partially completed plan reuses the completed branch and releases the remaining DAG in dependency order', async t => {
  const h = await setup(t), accepted = await plan(h, request({ delayMs: 300 }, true));
  const partial = await eventually(() => read(h, accepted.id), p => p.steps[0].status === 'completed' && p.steps[1].status === 'running');
  const first = await h.runtime(`/runs/${partial.steps[0].run_id}`);
  await runningAttempt(h, partial.steps[1].run_id);
  assert.equal(partial.steps[2].run_id, null);
  const originalContents = fs.readFileSync(first.artifact.file), originalDigest = first.artifact.content_digest;
  await control(h, accepted.id, 'cancel');
  await eventually(() => h.runtime('/health'), health => health.active === 0);
  const cancelled = await read(h, accepted.id); assert.equal(cancelled.progress.completed, 1); assert.equal(cancelled.progress.cancelled, 2);
  await control(h, accepted.id, 'resume');
  const done = await finish(h, accepted.id); assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(done.progress.completed, 3); assert.equal(done.steps[0].run_id, first.id);
  const reused = await h.runtime(`/runs/${first.id}`);
  assert.equal(reused.attempts.length, first.attempts.length);
  assert.equal(reused.artifact.content_digest, originalDigest); assert.deepEqual(fs.readFileSync(first.artifact.file), originalContents);
  assert.equal(digest(originalContents), originalDigest);
  const db = database(h, t);
  const second = db.prepare('SELECT * FROM runs WHERE id=?').get(done.steps[1].run_id);
  const third = db.prepare('SELECT * FROM runs WHERE id=?').get(done.steps[2].run_id);
  assert.equal(second.epoch, 1); assert.equal(third.epoch, 0); assert.ok(third.created_at >= second.updated_at);
  const definition = JSON.parse(third.definition);
  assert.equal(definition.upstream.find(source => source.step_id === 'prd').content_digest, originalDigest);
  assert.equal(definition.upstream.find(source => source.step_id === 'entities').content_digest, done.steps[1].artifact.content_digest);
});
