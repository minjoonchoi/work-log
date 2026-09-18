import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';
import { ROOT, alive, digest } from '../../src/shared.mjs';

async function setup(t, manager = false) {
  const h = await new Harness().start('runtime'); if (manager) await h.start('manager');
  t.after(() => h.close()); return h;
}
const checks = (h, profile = 'fixture.pass') => h.run({ task: 'checks.run', prompt: '등록된 검사를 실행해 주세요.', input: { profile } });
const report = (h, runIds) => h.run({ task: 'verification.report', prompt: '검사 근거 보고서를 작성해 주세요.', input: runIds ? { run_ids: runIds } : {} });

test('scenario planning uses the shared plan → verify → repair → review workflow and requirement IDs', async t => {
  const h = await setup(t);
  const run = await h.run({ task: undefined, prompt: '이 요구사항의 E2E 테스트 시나리오를 설계해 주세요.',
    input: { requirements: [{ id: 'SESSION-20', text: '정확히 20분이면 새 세션으로 분리' }, { id: 'RECOVERY', text: '재시작 후 원본 이력을 보존' }] },
    fixture: { scenario: 'scenario-missing-recovery-once' } });
  const result = await h.finish(run);
  assert.equal(result.task, 'test.scenarios.plan'); assert.equal(result.status, 'completed', result.message);
  assert.equal(result.round, 1); assert.deepEqual(result.attempts.map(a => a.stage), ['plan', 'repair', 'review']);
  const scenarios = JSON.parse(fs.readFileSync(result.artifact.file)).scenarios;
  assert.equal(scenarios.length, 4); assert.ok(scenarios.every(s => s.requirement_ids.includes('SESSION-20')));
  assert.match(fs.readFileSync(path.join(result.attempts[1].directory, 'prompt.txt'), 'utf8'), /SCENARIO-001/);
  const verification = JSON.parse(fs.readFileSync(result.artifact.verify_report));
  assert.ok(verification.checks.every(c => c.passed));
  const catalog = await h.runtime('/catalog'); assert.equal(catalog.workflows['plan-reviewed'].initial, 'plan');
  assert.equal(catalog.task_types.verify.executor, 'validator');
});

test('invented requirement references cannot pass scenario planning and never reach model review', async t => {
  const h = await setup(t);
  const result = await h.finish(await h.run({ task: 'test.scenarios.plan', fixture: { scenario: 'scenario-unknown-requirement' } }));
  assert.equal(result.status, 'blocked'); assert.equal(result.round, 2); assert.equal(result.artifact, null);
  assert.ok(result.attempts.every(a => a.stage !== 'review'));
  await assert.rejects(h.run({ task: 'test.scenarios.plan', input: { requirements: [{ id: 'R', text: 'a' }, { id: 'R', text: 'b' }] } }), /중복/);
});

test('real registered commands record failures and later checks; local report preserves evidence without model calls', async t => {
  const h = await setup(t, true);
  const result = await h.finish(await checks(h, 'fixture.mixed'));
  assert.equal(result.status, 'failed'); assert.equal(result.engine, 'local'); assert.equal(result.round, 0);
  assert.equal(result.attempts.length, 3); assert.ok(result.attempts.every(a => a.stage === 'verify' && a.pid));
  const evidence = await h.runtime(`/runs/${result.id}/evidence`);
  assert.deepEqual(evidence.data.checks.map(c => c.status), ['passed', 'failed', 'passed']);
  assert.equal(evidence.data.checks[1].observation.code, 7);
  assert.equal(evidence.data.before.digest, evidence.data.after.digest);
  assert.equal(digest(fs.readFileSync(evidence.file)), evidence.content_digest);
  const rendered = await h.finish(await report(h, [result.id]));
  assert.equal(rendered.status, 'completed'); assert.equal(rendered.engine, 'local');
  assert.deepEqual(rendered.attempts.map(a => [a.stage, a.pid]), [['render', null]]);
  const body = await h.manager(`/artifacts/${rendered.id}`);
  assert.match(body.text, /검사 판정: \*\*failed\*\*/); assert.match(body.text, /\| 7 \|/);
  assert.match(body.text, /검사 실행 근거가 아닙니다/); assert.match(body.text, /SHA-256/);
  await eventually(() => h.manager('/items'), items => items.length === 2);
  const items = await h.manager('/items');
  for (const item of items) assert.equal((await h.manager(`/items/${item.id}`)).agents.filter(a => a.role === 'worker').length, 0);
});

test('natural-language check/report routes select local tasks; arbitrary commands and active sources are refused', async t => {
  const h = await setup(t);
  await assert.rejects(report(h), /검사 실행이 없습니다/);
  await assert.rejects(h.run({ task: 'checks.run', input: { profile: 'fixture.pass', command: 'rm' } }), /input에는/);
  await assert.rejects(checks(h, 'missing.profile'), /등록되지 않은/);
  const run = await h.run({ task: undefined, prompt: 'E2E 검사를 실행해 주세요.', input: { profile: 'fixture.slow' } });
  assert.equal(run.task, 'checks.run'); assert.equal(run.engine, 'local');
  await assert.rejects(report(h, [run.id]), /종료되지 않은/);
  assert.equal((await h.finish(run)).status, 'completed');
  const rendered = await h.finish(await h.run({ task: undefined, prompt: '최신 검사 근거로 검증 보고서를 작성해 주세요.' }));
  assert.equal(rendered.task, 'verification.report'); assert.equal(rendered.status, 'completed');
  assert.match(fs.readFileSync(rendered.artifact.file, 'utf8'), new RegExp(run.id));
});

test('test-only command profiles are absent from a normal service', async t => {
  const h = new Harness(); h.testMode = false; await h.start('runtime'); t.after(() => h.close());
  assert.ok((await h.runtime('/catalog')).check_profiles.every(p => !p.id.startsWith('fixture.')));
  await assert.rejects(checks(h), /등록되지 않은/);
});
test('asking how to run tests does not execute them; malformed catalog inputs are rejected', async t => {
  const h = await setup(t);
  const answer = await h.finish(await h.run({ task: undefined, prompt: 'E2E 테스트는 실행하지 말고 실행 방법만 설명해 주세요.' }));
  assert.equal(answer.task, 'text.generate'); assert.equal(answer.evidence, null);
  await assert.rejects(h.run({ task: '__proto__' }), /지원하지 않는 업무/);
  await assert.rejects(checks(h, '__proto__'), /등록되지 않은/);
  await assert.rejects(h.run({ task: 'test.scenarios.plan', input: { categories: null } }), /분류/);
});

test('cancellation kills command descendants, leaves queued checks not_run, and allows an honest report', async t => {
  const h = await setup(t);
  const run = await checks(h, 'fixture.slow');
  const active = await eventually(() => h.runtime(`/runs/${run.id}`), r => r.attempts[0]?.pid && fs.existsSync(path.join(r.attempts[0].directory, 'child.pid')));
  const childPid = Number(fs.readFileSync(path.join(active.attempts[0].directory, 'child.pid')));
  const queued = await checks(h); assert.equal((await h.runtime(`/runs/${queued.id}`)).status, 'pending');
  await h.runtime(`/runs/${queued.id}/cancel`, { method: 'POST', body: {} });
  await h.runtime(`/runs/${run.id}/cancel`, { method: 'POST', body: {} });
  await eventually(() => alive(childPid) || alive(active.attempts[0].pid), value => !value);
  await eventually(() => h.runtime(`/runs/${run.id}/evidence`), e => e.data.checks[0].status === 'interrupted');
  const rendered = await h.finish(await report(h, [run.id, queued.id]));
  const text = fs.readFileSync(rendered.artifact.file, 'utf8');
  assert.match(text, /interrupted/); assert.match(text, /not_run/); assert.match(text, /cancelled/);
});

test('crashed check execution remains unknown, refuses overlapping resume, and records a separate new epoch', async t => {
  const h = await setup(t); const run = await checks(h, 'fixture.slow');
  const active = await eventually(() => h.runtime(`/runs/${run.id}`), r => r.attempts[0]?.pid);
  await h.stop('runtime', 'SIGKILL'); await h.start('runtime');
  assert.equal((await h.runtime(`/runs/${run.id}`)).status, 'interrupted');
  const oldEvidence = await h.runtime(`/runs/${run.id}/evidence`);
  assert.equal(oldEvidence.data.checks[0].status, 'unknown'); assert.equal(oldEvidence.data.checks[0].ended_at, null);
  await assert.rejects(h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} }), /worker가 살아/);
  const rendered = await h.finish(await report(h, [run.id])); assert.match(fs.readFileSync(rendered.artifact.file, 'utf8'), /unknown/);
  await eventually(() => alive(active.attempts[0].pid), value => !value, 7000);
  await h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} });
  const result = await h.finish(run); assert.equal(result.status, 'completed'); assert.equal(result.evidence.epoch, 1);
  assert.equal(JSON.parse(fs.readFileSync(oldEvidence.file)).checks[0].status, 'unknown');
});

test('timeout, output overflow and unavailable checks cannot be reported as passed', async t => {
  const h = await setup(t);
  for (const [name, status, expected] of [['timeout', 'failed', 'timeout'], ['flood', 'failed', 'output_limit'], ['missing', 'blocked', null]]) {
    const result = await h.finish(await checks(h, `fixture.${name}`)); assert.equal(result.status, status, result.message);
    const e = await h.runtime(`/runs/${result.id}/evidence`); assert.notEqual(e.data.overall, 'passed');
    if (expected) assert.equal(e.data.checks[0].observation.reason, expected);
    else { assert.equal(e.data.checks[0].status, 'not_run'); assert.equal(result.attempts.length, 0); }
  }
});

test('source changes during a check invalidate its passing exit code; later changes remain visible in reports', async t => {
  const h = await setup(t), file = path.join(ROOT, 'tests/fixtures/check-source.txt'), original = fs.readFileSync(file);
  t.after(() => fs.writeFileSync(file, original));
  try {
    const changed = await h.finish(await checks(h, 'fixture.change')); assert.equal(changed.status, 'blocked');
    const evidence = (await h.runtime(`/runs/${changed.id}/evidence`)).data;
    assert.equal(evidence.checks[0].status, 'passed'); assert.equal(evidence.overall, 'source_changed');
    const passed = await h.finish(await checks(h)); assert.equal(passed.status, 'completed');
    fs.writeFileSync(file, original);
    const rendered = await h.finish(await report(h, [changed.id, passed.id]));
    assert.match(fs.readFileSync(rendered.artifact.file, 'utf8'), /no \/ unknown/);
  } finally { fs.writeFileSync(file, original); }
});

test('altered evidence documents and altered command logs are rejected before rendering', async t => {
  const h = await setup(t);
  const first = await h.finish(await checks(h)); fs.appendFileSync(first.evidence.file, ' ');
  await assert.rejects(report(h, [first.id]), /근거 해시/);
  const second = await h.finish(await checks(h));
  const evidence = (await h.runtime(`/runs/${second.id}/evidence`)).data;
  fs.appendFileSync(evidence.checks[0].logs['stdout.log'].file, 'fabricated');
  await assert.rejects(report(h, [second.id]), /로그 해시/);
});
