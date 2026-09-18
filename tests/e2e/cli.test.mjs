import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { Harness } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

test('prompt entry CLI waits for the complete workflow and returns one final JSON without GUI or manager', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), 'run', '초대 기능의 PRD 작성', '--engine', 'fixture', '--wait'],
    { env: { ...process.env, HARNESS_DATA_DIR: h.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  const exit = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(exit, 0, stderr); const final = JSON.parse(stdout);
  assert.equal(final.status, 'completed'); assert.ok(final.artifact.file.endsWith('/prd.md'));
  assert.equal(stdout.trim().split('\n').length, 1); assert.match(stderr, /"status"/);
});
test('CLI selects local checks and report jobs, exposes their catalog and evidence, and preserves failure exit code', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), ...args],
    { env: { ...process.env, HARNESS_DATA_DIR: h.dir }, encoding: 'utf8', timeout: 15000 });
  const catalog = cli('catalog'); assert.equal(catalog.status, 0);
  assert.ok(JSON.parse(catalog.stdout).jobs.some(j => j.id === 'test.scenarios.plan'));
  const file = path.join(h.dir, 'request.json');
  fs.writeFileSync(file, JSON.stringify({ prompt: 'E2E 검사를 실행해 주세요.', input: { profile: 'fixture.mixed' } }));
  const checked = cli('run', '--input', file, '--wait'); assert.equal(checked.status, 1, checked.stderr);
  const run = JSON.parse(checked.stdout); assert.equal(run.engine, 'local'); assert.ok(run.evidence);
  assert.equal(JSON.parse(cli('evidence', run.id).stdout).data.overall, 'failed');
  const rendered = cli('run', '최신 검증 보고서를 작성해 주세요.', '--wait'); assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(fs.readFileSync(JSON.parse(rendered.stdout).artifact.file, 'utf8'), /검사 판정: \*\*failed\*\*/);
});
