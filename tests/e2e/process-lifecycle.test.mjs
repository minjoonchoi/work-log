import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../../src/process-runner.mjs';
import { eventually } from '../helpers.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-process-life-'));
  const pidFile = path.join(dir, 'descendant.pid');
  t.after(() => {
    if (fs.existsSync(pidFile)) {
      const { pid, detached } = JSON.parse(fs.readFileSync(pidFile));
      try { process.kill(detached ? -pid : pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const start = (script, overrides = {}) => runProcess({ command: process.execPath, args: ['-e', script], cwd: dir,
    env: { PATH: process.env.PATH }, attemptDir: dir, limits: { timeoutMs: 3000, maxOutputBytes: 4096 }, ...overrides });
  return { dir, pidFile, start };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

test('normal completion preserves split UTF-8, both logs, exit status and confirmed lifecycle evidence', async t => {
  const { dir, start } = setup(t);
  const run = start(`const b=Buffer.from('한글 결과');process.stdout.write(b.subarray(0,1));process.stderr.write('진단 로그');setTimeout(()=>process.stdout.write(b.subarray(1)),30);`);
  const result = await run.promise;
  assert.equal(result.ok, true); assert.equal(result.stdout, '한글 결과'); assert.equal(result.stderr, '진단 로그');
  assert.equal(result.observation.code, 0); assert.equal(result.observation.reason, null);
  assert.equal(result.observation.parent_exit_observed, true); assert.equal(result.observation.stdio_closed, true);
  assert.equal(result.observation.termination_confirmed, true);
  assert.equal(fs.readFileSync(path.join(dir, 'stdout.log'), 'utf8'), result.stdout);
  assert.equal(fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8'), result.stderr);
  const bytes = fs.readFileSync(path.join(dir, 'process.json'));
  run.cancel(); run.cancel(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'process.json')), bytes, 'late cancellation cannot rewrite a completed observation');
});

test('spawn failure returns once without waiting for a nonexistent process or leaking its deadline', async t => {
  const { dir, start } = setup(t);
  const run = start('', { command: path.join(dir, 'missing-command') });
  const result = await run.promise; run.cancel();
  assert.equal(result.ok, false); assert.equal(result.observation.pid, null); assert.equal(result.observation.code, null);
  assert.match(result.observation.error, /ENOENT/); assert.equal(result.observation.termination_confirmed, true);
  assert.ok(result.observation.elapsed_ms < 1000);
});

test('timeout escalates TERM-ignoring owned parent and child to KILL within the bounded grace', async t => {
  const { pidFile, start } = setup(t);
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid,detached:false}));setInterval(()=>{},1000);`;
  const result = await start(script, { limits: { timeoutMs: 250, maxOutputBytes: 4096 } }).promise;
  assert.equal(result.ok, false); assert.equal(result.observation.reason, 'timeout');
  assert.equal(result.observation.signal, 'SIGKILL'); assert.equal(result.observation.termination_confirmed, true);
  assert.ok(result.observation.elapsed_ms >= 700); assert.ok(result.observation.elapsed_ms < 2000);
  await eventually(() => !alive(JSON.parse(fs.readFileSync(pidFile)).pid));
  assert.equal(alive(result.observation.pid), false);
});

test('cancellation propagates TERM to the owned group and reports a confirmed stop without waiting for the grace deadline', async t => {
  const { pidFile, start } = setup(t);
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid,detached:false}));setInterval(()=>{},1000);`;
  const run = start(script); await eventually(() => fs.existsSync(pidFile)); run.cancel();
  const result = await run.promise;
  assert.equal(result.ok, false); assert.equal(result.observation.reason, 'cancelled');
  assert.equal(result.observation.signal, 'SIGTERM'); assert.equal(result.observation.termination_confirmed, true);
  assert.equal(result.observation.parent_exit_observed, true); assert.equal(result.observation.stdio_closed, true);
  assert.ok(result.observation.elapsed_ms < 1000);
  await eventually(() => !alive(JSON.parse(fs.readFileSync(pidFile)).pid));
});

test('parent exit starts bounded cleanup even when the worker deadline is one hour away', async t => {
  const { pidFile, start } = setup(t);
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid,detached:true}));child.unref();process.stdout.write('parent done',()=>process.exit(0));`;
  const result = await start(script, { limits: { timeoutMs: 3600000, maxOutputBytes: 4096 } }).promise;
  assert.equal(result.ok, false); assert.equal(result.observation.code, 0); assert.equal(result.stdout, 'parent done');
  assert.equal(result.observation.reason, 'termination_unconfirmed'); assert.equal(result.observation.termination_confirmed, false);
  assert.equal(result.observation.parent_exit_observed, true); assert.equal(result.observation.stdio_closed, false);
  assert.equal(result.observation.timeout_ms, 3600000); assert.ok(result.observation.elapsed_ms < 2200);
  assert.equal(alive(JSON.parse(fs.readFileSync(pidFile)).pid), true);
});

for (const cause of ['timeout', 'cancelled', 'output_limit', 'worker_tool_limit', 'worker_observer_failed']) {
  test(`${cause}: a detached pipe holder cannot prevent bounded failure or be reported as terminated`, async t => {
    const { dir, pidFile, start } = setup(t);
    const payload = cause === 'output_limit' ? 'x'.repeat(8192) : 'ready';
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid,detached:true}));child.unref();
process.stdout.write(${JSON.stringify(payload)},()=>${cause === 'timeout' ? 'setInterval(()=>{},1000)' : 'process.exit(0)'});`;
    const observer = cause === 'worker_tool_limit' ? () => 'worker_tool_limit'
      : cause === 'worker_observer_failed' ? () => { throw new Error('fixture observer failure'); } : undefined;
    const run = start(script, { limits: { timeoutMs: cause === 'timeout' ? 150 : 3000, maxOutputBytes: 4096 }, onStdout: observer });
    if (cause === 'cancelled') {
      await eventually(() => fs.existsSync(pidFile));
      // The owned parent has exited while the independent child retains pipes.
      await new Promise(resolve => setTimeout(resolve, 80)); run.cancel(); run.cancel();
    }
    const result = await run.promise;
    assert.equal(result.ok, false); assert.equal(result.observation.reason, cause);
    assert.equal(result.observation.parent_exit_observed, true); assert.equal(result.observation.stdio_closed, false);
    assert.equal(result.observation.termination_confirmed, false); assert.match(result.observation.error, /종료를 확인하지 못/);
    assert.equal(result.observation.termination_grace_ms, 1000);
    assert.ok(result.observation.elapsed_ms >= 950); assert.ok(result.observation.elapsed_ms < 2200);
    const descendant = JSON.parse(fs.readFileSync(pidFile)).pid;
    assert.equal(alive(descendant), true, 'runner may signal only its own process group');
    assert.ok(Buffer.byteLength(result.stdout) <= 4096);
    const bytes = fs.readFileSync(path.join(dir, 'process.json'));
    process.kill(-descendant, 'SIGKILL'); await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(fs.readFileSync(path.join(dir, 'process.json')), bytes, 'late close must not settle or record the attempt twice');
  });
}
