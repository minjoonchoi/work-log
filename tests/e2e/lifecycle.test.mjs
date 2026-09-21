import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Harness, eventually } from '../helpers.mjs';
import { alive, readEndpoint } from '../../src/shared.mjs';

const post = body => ({ method: 'POST', body });
const summary = { task: 'session.summarize', input: { title: '요청 작업 정리', events: [
  { kind: 'input', event_at: '2026-09-19T01:00:00Z', text: '요청한 작업을 정리하세요.' }
] } };
const planRequest = { prompt: '요구사항 설계', engine: 'fixture', fixture: { delayMs: 500 }, steps: [
  { id: 'requirements', task: 'prd.create', output_key: 'prd', request_excerpt: '요구사항', input: { requirements: '요구사항' }, depends_on: [] },
  { id: 'design', task: 'entity.design', output_key: 'entity', request_excerpt: '설계', input: { requirements: '설계' }, depends_on: ['requirements'] }
] };
async function setup(t, role = 'runtime') {
  const h = new Harness(); t.after(() => h.close()); await h.start(role); return h;
}
async function activeChild(h, run) {
  const value = await eventually(() => h.runtime(`/runs/${run.id}`), run => run.attempts[0]?.pid
    && fs.existsSync(path.join(run.attempts[0].directory, 'workspace/child.pid')));
  return [value.attempts[0].pid, Number(fs.readFileSync(path.join(value.attempts[0].directory, 'workspace/child.pid')))];
}
function sentinel(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { if (alive(child.pid)) child.kill('SIGKILL'); }); return child;
}
function durableRuns(h) {
  const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT id,status,request FROM runs').all(); } finally { db.close(); }
}

test('app quit cancels internal metadata only and drains user jobs plus queued dependency steps before exiting', async t => {
  const h = await setup(t), native = sentinel(t);
  const internal = await h.run({ ...summary, internal: true, fixture: { scenario: 'child' } });
  const internalPids = await activeChild(h, internal);
  const user = await h.run({ fixture: { scenario: 'slow', delayMs: 1000 } });
  const activeUser = await eventually(() => h.runtime(`/runs/${user.id}`), run => run.attempts[0]?.pid);
  const userPids = [activeUser.attempts[0].pid];
  // The task name alone does not make this explicitly requested summary an internal job.
  const explicitSummary = await h.run({ ...summary, fixture: { scenario: 'slow', delayMs: 1000 } });
  const plan = await h.runtime('/plans', post(planRequest));
  const runtime = h.processes.runtime;
  const result = await h.runtime('/lifecycle/quit', post({}));
  assert.deepEqual(result, { status: 'draining', remaining_user_runs: 4 });
  await eventually(() => internalPids.some(alive), value => !value);
  assert.ok(userPids.every(alive), 'already delegated user workers survive GUI quit');
  const drainingPlan = await h.runtime(`/plans/${plan.id}`);
  await assert.rejects(h.runtime(`/plans/${plan.id}/resume`, post({})), /기존 업무를 마무리/);
  await assert.rejects(h.runtime(`/runs/${drainingPlan.steps[0].run_id}/resume`, post({})), /기존 업무를 마무리/);
  await eventually(() => runtime.exitCode, code => code === 0, 15000);
  assert.ok(alive(native.pid), 'an unrelated native agent session is not owned by WorkLog');
  assert.ok(userPids.every(pid => !alive(pid)));
  const rows = durableRuns(h);
  assert.equal(rows.find(row => row.id === internal.id).status, 'cancelled');
  for (const run of [user, explicitSummary]) assert.equal(rows.find(row => row.id === run.id).status, 'completed');
  const children = rows.filter(row => JSON.parse(row.request).plan_id === plan.id);
  assert.equal(children.length, 2); assert.ok(children.every(row => row.status === 'completed'));
  const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT status FROM plans WHERE id=?').get(plan.id).status, 'completed'); db.close();
});

test('reopening during drain preserves existing work and permits new requests again', async t => {
  const h = await setup(t);
  const user = await h.run({ fixture: { scenario: 'slow', delayMs: 600 } });
  assert.equal((await h.runtime('/lifecycle/quit', post({}))).remaining_user_runs, 1);
  await assert.rejects(h.run(), /기존 업무를 마무리/);
  await assert.rejects(h.runtime('/plans', post(planRequest)), /기존 업무를 마무리/);
  await assert.rejects(h.runtime(`/runs/${user.id}/resume`, post({})), /기존 업무를 마무리/);
  assert.deepEqual(await h.runtime('/lifecycle/start', post({})), { status: 'running' });
  const newInternal = await h.run({ ...summary, internal: true });
  assert.equal((await h.finish(newInternal)).status, 'completed');
  assert.equal((await h.finish(user)).status, 'completed');
  assert.equal((await h.runtime('/health')).lifecycle, 'running');
});

test('quit with only internal work waits for its owned process group and exits normally', async t => {
  const h = await setup(t);
  const internal = await h.run({ ...summary, internal: true, fixture: { scenario: 'child' } });
  const pids = await activeChild(h, internal), runtime = h.processes.runtime;
  assert.deepEqual(await h.runtime('/lifecycle/quit', post({})), { status: 'draining', remaining_user_runs: 0 });
  await eventually(() => runtime.exitCode, code => code === 0);
  assert.ok(pids.every(pid => !alive(pid)));
  assert.equal(durableRuns(h)[0].status, 'cancelled');
});

test('a plan body arriving after quit cannot bypass draining admission', async t => {
  const h = await setup(t);
  await h.run({ fixture: { scenario: 'slow', delayMs: 500 } });
  const bytes = JSON.stringify(planRequest), endpoint = readEndpoint(h.dir, 'runtime');
  let pending;
  const response = new Promise((resolve, reject) => {
    pending = http.request({ host: '127.0.0.1', port: endpoint.port, method: 'POST', path: '/plans', headers: {
      Authorization: `Bearer ${fs.readFileSync(path.join(h.dir, 'token'), 'utf8').trim()}`,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes)
    } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    pending.on('error', reject);
  });
  t.after(() => pending.destroy());
  await new Promise(resolve => pending.write(bytes.slice(0, 10), resolve));
  await h.runtime('/health');
  assert.equal((await h.runtime('/lifecycle/quit', post({}))).remaining_user_runs, 1);
  pending.end(bytes.slice(10));
  const result = await response;
  assert.equal(result.status, 503); assert.match(result.body.error, /기존 업무를 마무리/);
  assert.deepEqual(await h.runtime('/plans'), []);
});

test('manager shutdown reaps its active Keychain helper and queued credential saves without touching native sessions', async t => {
  const h = new Harness(), native = sentinel(t), file = path.join(h.dir, 'keychain-helper.mjs');
  const pidsFile = path.join(h.dir, 'credential-pids.json'), invocations = path.join(h.dir, 'credential-calls.txt');
  fs.writeFileSync(file, `#!${process.execPath}
import fs from 'node:fs'; import { spawn } from 'node:child_process';
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
fs.appendFileSync(${JSON.stringify(invocations)},'called\\n');
fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);
`, { mode: 0o755 });
  h.env = { HARNESS_KEYCHAIN_BIN: file };
  t.after(async () => {
    await h.close(false);
    if (fs.existsSync(pidsFile)) for (const pid of JSON.parse(fs.readFileSync(pidsFile))) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(h.dir, { recursive: true, force: true });
  });
  await h.start('manager');
  const endpoint = '/integrations/atlassian';
  const options = { method: 'PUT', body: { client_id: 'fixture-client', client_secret: 'fixture-secret' } };
  const first = h.manager(endpoint, options).catch(error => error);
  const pids = await eventually(() => JSON.parse(fs.readFileSync(pidsFile)));
  // A queued mutation may resume after the current helper rejects during shutdown.
  const second = h.manager(endpoint, options).catch(error => error);
  const manager = h.processes.manager; await h.stop('manager');
  await Promise.allSettled([first, second]);
  assert.equal(manager.exitCode, 0);
  await eventually(() => pids.some(alive), value => !value);
  assert.equal(fs.readFileSync(invocations, 'utf8'), 'called\n');
  assert.ok(alive(native.pid));
  assert.doesNotMatch(h.logs.manager, /fixture-client|fixture-secret/);
});
