import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

async function setup(t, firstCommand) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-check-lifecycle-'));
  for (const directory of ['src', 'harness', 'contracts']) fs.cpSync(path.join(ROOT, directory), path.join(root, directory), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const fixtures = path.join(root, 'tests/fixtures'); fs.mkdirSync(fixtures, { recursive: true });
  const marker = path.join(root, 'following-command-ran'), pidFile = path.join(root, 'escaped.pid');
  const profile = { label: 'isolated process lifecycle', validation_scope: 'local commands only; no live model',
    watch: ['package.json'], checks: [
      { id: 'first', label: 'first command', args: ['-e', firstCommand(pidFile)], timeoutMs: 5000 },
      { id: 'following', label: 'following command', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], timeoutMs: 5000 }
    ] };
  fs.writeFileSync(path.join(fixtures, 'check-profiles.json'), JSON.stringify({ 'fixture.lifecycle': profile }));
  const h = new Harness(); h.serviceRoot = root;
  t.after(async () => {
    await h.close();
    if (fs.existsSync(pidFile)) { try { process.kill(-Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await h.start('runtime'); return { h, marker, pidFile };
}
const runChecks = h => h.run({ task: 'checks.run', prompt: undefined, input: { profile: 'fixture.lifecycle' } });

test('a check with unconfirmed descendant termination stops following commands and refuses same-run resume', async t => {
  const { h, marker, pidFile } = await setup(t, file => `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
fs.writeFileSync(${JSON.stringify(file)},String(child.pid));child.unref();process.exit(0);`);
  const run = await h.finish(await runChecks(h));
  assert.equal(run.status, 'failed'); assert.equal(run.attempts.length, 1);
  assert.match(run.message, /프로세스 트리 종료.*후행 검사를 시작하지/);
  const evidence = await h.runtime(`/runs/${run.id}/evidence`);
  assert.deepEqual(evidence.data.checks.map(check => check.status), ['failed', 'not_run']);
  assert.equal(evidence.data.checks[0].observation.termination_confirmed, false);
  assert.equal(evidence.data.checks[1].started_at, null); assert.equal(evidence.data.checks[1].observation, null);
  assert.equal(evidence.data.message, run.message); assert.equal(fs.existsSync(marker), false);
  assert.ok(evidence.data.checks[0].observation.elapsed_ms < 2200);
  assert.doesNotThrow(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0));
  await eventually(() => h.runtime('/health'), value => value.active === 0);
  await assert.rejects(h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} }), error => error.status === 409 && /종료를 확인하지 못/.test(error.message));
  assert.equal((await h.runtime(`/runs/${run.id}`)).attempts.length, 1);
  const report = await h.finish(await h.run({ task: 'verification.report', prompt: undefined, input: { run_ids: [run.id] } }));
  assert.equal(report.status, 'completed'); assert.match(fs.readFileSync(report.artifact.file, 'utf8'), /후행 검사를 시작하지 않았/);
  assert.equal(fs.existsSync(marker), false);
});

test('ordinary nonzero exit still permits an independent following check and records both results', async t => {
  const { h, marker } = await setup(t, () => 'process.exit(7)');
  const run = await h.finish(await runChecks(h));
  assert.equal(run.status, 'failed'); assert.equal(run.attempts.length, 2);
  const evidence = await h.runtime(`/runs/${run.id}/evidence`);
  assert.deepEqual(evidence.data.checks.map(check => check.status), ['failed', 'passed']);
  assert.equal(evidence.data.checks[0].observation.code, 7);
  assert.equal(evidence.data.checks[0].observation.termination_confirmed, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
});
