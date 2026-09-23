import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { Harness } from '../helpers.mjs';
import { ROOT, digest } from '../../src/shared.mjs';

test('prompt entry CLI waits for the complete workflow and returns one final JSON without GUI or manager', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), 'run', '초대 기능의 PRD 작성', '--engine', 'fixture', '--wait'],
    { cwd: h.dir, env: { ...process.env, CODEX_THREAD_ID: '', HARNESS_DATA_DIR: h.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  const exit = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(exit, 0, stderr); const final = JSON.parse(stdout);
  assert.equal(final.status, 'completed'); assert.ok(final.artifact.file.endsWith('/prd.md'));
  assert.equal(final.artifact.output_file, path.join(fs.realpathSync(h.dir), 'output', 'worklog', final.id, 'prd.md'));
  assert.notEqual(final.artifact.output_file, final.artifact.file);
  assert.equal(digest(fs.readFileSync(final.artifact.output_file)), final.artifact.content_digest);
  assert.deepEqual(fs.readFileSync(final.artifact.output_file), fs.readFileSync(final.artifact.file));
  assert.equal(stdout.trim().split('\n').length, 1); assert.match(stderr, /\[work\] 시작/); assert.match(stderr, /\[work\] 완료/);
});
test('CLI selects local checks and report jobs, exposes their catalog and evidence, and preserves failure exit code', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), ...args],
    { cwd: h.dir, env: { ...process.env, CODEX_THREAD_ID: '', HARNESS_DATA_DIR: h.dir }, encoding: 'utf8', timeout: 15000 });
  const catalog = cli('catalog'); assert.equal(catalog.status, 0);
  assert.ok(JSON.parse(catalog.stdout).jobs.some(j => j.id === 'test.scenarios.plan'));
  const file = path.join(h.dir, 'request.json');
  fs.writeFileSync(file, JSON.stringify({ prompt: 'E2E 검사를 실행해 주세요.', input: { profile: 'fixture.mixed' } }));
  const checked = cli('run', '--input', file, '--wait'); assert.equal(checked.status, 1, checked.stderr);
  const run = JSON.parse(checked.stdout); assert.equal(run.engine, 'local'); assert.ok(run.evidence);
  assert.equal(JSON.parse(cli('evidence', run.id).stdout).data.overall, 'failed');
  const rendered = cli('run', '최신 검증 보고서를 작성해 주세요.', '--wait'); assert.equal(rendered.status, 0, rendered.stderr);
  const report = JSON.parse(rendered.stdout);
  assert.match(fs.readFileSync(report.artifact.file, 'utf8'), /검사 판정: \*\*failed\*\*/);
  assert.equal(report.artifact.output_file, path.join(fs.realpathSync(h.dir), 'output', 'worklog', report.id, path.basename(report.artifact.file)));
  assert.equal(digest(fs.readFileSync(report.artifact.output_file)), report.artifact.content_digest);
});

test('catalog CLI discovers bounded tasks without every schema, then loads only a selected full contract', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), ...args],
    { cwd: h.dir, env: { ...process.env, CODEX_THREAD_ID: '', HARNESS_DATA_DIR: h.dir }, encoding: 'utf8', timeout: 15000 });
  const full = JSON.parse(cli('catalog').stdout);
  const summarized = cli('catalog', '--summary'); assert.equal(summarized.status, 0, summarized.stderr);
  const summary = JSON.parse(summarized.stdout); assert.equal(summary.version, full.version);
  assert.deepEqual(summary.jobs.map(j => j.id), full.jobs.map(j => j.id));
  assert.ok(summary.jobs.every(j => !Object.hasOwn(j, 'input_schema')));
  assert.equal(summary.workflows, undefined); assert.ok(summarized.stdout.length < JSON.stringify(full).length);
  const id = 'api.design', summarizedJob = summary.jobs.find(j => j.id === id), fullJob = full.jobs.find(j => j.id === id);
  assert.deepEqual(summarizedJob.boundary, { owns: fullJob.boundary.owns, excludes: fullJob.boundary.excludes, deliverable: fullJob.boundary.deliverable });
  assert.deepEqual(summarizedJob.routing, fullJob.routing);
  const selected = cli('catalog', '--task', id); assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(selected.stdout), fullJob); assert.ok(fullJob.input_schema.required.length > 0);
  const unknown = cli('catalog', '--task', 'unsupported.example'); assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, ''); assert.match(unknown.stderr, /지원하지 않는 업무/);
  const ambiguous = cli('catalog', '--summary', '--task', id); assert.equal(ambiguous.status, 1); assert.equal(ambiguous.stdout, '');
});

test('independent CLI requests reuse a prior published file through an explicit frozen input reference', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), ...args],
    { cwd: h.dir, env: { ...process.env, CODEX_THREAD_ID: '', HARNESS_DATA_DIR: h.dir }, encoding: 'utf8', timeout: 15000 });
  const first = cli('run', '초대 기능의 PRD 작성', '--engine', 'fixture', '--wait');
  assert.equal(first.status, 0, first.stderr);
  const prior = JSON.parse(first.stdout), source = prior.artifact.output_file;
  assert.equal(digest(fs.readFileSync(source)), prior.artifact.content_digest);
  const sourceContents = fs.readFileSync(source, 'utf8');
  const input = { task: 'entity.design', engine: 'fixture',
    input: { requirements: '제공된 초대 기능 PRD의 요구사항을 근거로 엔티티와 관계, 상태 불변식만 설계하세요.' },
    input_files: [{ path: path.relative(fs.realpathSync(h.dir), source), content_digest: prior.artifact.content_digest }] };
  const file = path.join(h.dir, 'followup.json'); fs.writeFileSync(file, JSON.stringify(input));
  const second = cli('run', '--input', 'followup.json', '--wait');
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const next = JSON.parse(second.stdout); assert.equal(next.status, 'completed'); assert.notEqual(next.id, prior.id);
  assert.equal(next.artifact.output_file, path.join(fs.realpathSync(h.dir), 'output', 'worklog', next.id, 'entities.md'));
  assert.equal(digest(fs.readFileSync(next.artifact.output_file)), next.artifact.content_digest);
  const details = await h.runtime(`/runs/${next.id}`);
  assert.equal(details.request.input.requirements, input.input.requirements, 'the input schema keeps the requested purpose, rather than replacing requirements with a filename');
  const attempt = details.attempts[0], prompt = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
  assert.ok(prompt.includes(source)); assert.ok(prompt.includes(prior.artifact.content_digest));
  const copies = fs.readdirSync(path.join(attempt.directory, 'inputs')).map(name => path.join(attempt.directory, 'inputs', name));
  const snapshot = copies.find(candidate => fs.readFileSync(candidate, 'utf8') === sourceContents);
  assert.ok(snapshot, 'the next worker receives the frozen prior artifact as a readable input file');
  assert.ok(prompt.includes(snapshot));
  assert.equal((await h.runtime('/plans')).length, 0, 'the requests remain independent runs');
  const fetched = cli('result', next.id); assert.equal(fetched.status, 0, fetched.stderr);
  assert.deepEqual(JSON.parse(fetched.stdout).artifact, next.artifact);
});
