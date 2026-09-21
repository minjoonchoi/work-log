import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, initRoot, digest } from '../../src/shared.mjs';
import { Harness } from '../helpers.mjs';

async function cli(dir, args, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), ...args], {
    cwd: dir, env: { ...process.env, HARNESS_DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { exit, stdout, stderr, notices: stderr.split('\n').filter(line => line.startsWith('[work]')) };
}
async function endpoint(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-cli-plan-'));
  const token = initRoot(dir), calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      let body = ''; for await (const chunk of req) body += chunk;
      const call = { method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined }; calls.push(call);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(await handler(call, calls)));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(dir, 'runtime.endpoint.json'), JSON.stringify({ port: server.address().port }));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, calls };
}
function snapshot(status, completed = 0, pending = 1) {
  return { id: 'plan-cli-test', status, progress: { total: 2, completed, running: status === 'running' ? 1 : 0, pending, blocked: status === 'blocked' ? 1 : 0, failed: 0, cancelled: status === 'cancelled' ? 2 : 0 },
    steps: [{ id: 'prd', task: 'prd.create', label: 'PRD 작성', run_id: 'run-first', status: completed ? 'completed' : status, stage: 'produce' },
      { id: 'html', task: 'mockup.html.create', label: 'HTML 목업', run_id: completed ? 'run-second' : undefined, status: completed === 2 ? 'completed' : completed ? status : 'pending', stage: 'review' }],
    artifacts: completed === 2 ? [{ step_id: 'prd', file: '/verified/prd.md' }, { step_id: 'html', file: '/verified/mockup.html' }] : [] };
}
const plan = {
  prompt: 'PRD를 작성하고 목업을 만들어 주세요.', idempotency_key: 'test-origin-turn-1',
  steps: [{ id: 'prd', task: 'prd.create', output_key: 'prd', request_excerpt: 'PRD를 작성', input: { requirements: '초대 기능의 제품 요구사항' }, depends_on: [] },
    { id: 'html', task: 'mockup.html.create', output_key: 'mockup', request_excerpt: '목업을 만들어 주세요.', input: { requirements: '선행 PRD의 동작형 목업' }, depends_on: ['prd'] }]
};

test('orchestrate CLI submits one structured plan, waits on the accepted ID, and separates concise progress from final JSON', async t => {
  let polls = 0;
  const { dir, calls } = await endpoint(t, call => {
    if (call.method === 'POST') { assert.equal(call.url, '/plans'); assert.deepEqual(call.body, { ...plan, engine: 'fixture', workspace: fs.realpathSync(dir) }); return snapshot('running'); }
    assert.equal(call.url, '/plans/plan-cli-test');
    polls += 1;
    return polls < 3 ? snapshot('running') : polls < 5 ? snapshot('running', 1, 0) : snapshot('completed', 2, 0);
  });
  const file = path.join(dir, 'plan.json'); fs.writeFileSync(file, JSON.stringify(plan));
  const result = await cli(dir, ['orchestrate', '--input', file, '--engine', 'fixture', '--wait']);
  assert.equal(result.exit, 0, result.stderr); assert.equal(result.stdout.trim().split('\n').length, 1);
  const final = JSON.parse(result.stdout); assert.equal(final.status, 'completed'); assert.equal(final.artifacts.length, 2);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(result.notices.length, 3); assert.match(result.notices[0], /시작.*완료 0\/2/);
  assert.match(result.notices[1], /진행.*완료 1\/2.*HTML 목업\(검토\)/);
  assert.match(result.notices[2], /완료.*완료 2\/2/); assert.ok(result.notices.every(line => !line.includes('%')));
});

test('blocked CLI plans remain incomplete with exit 2 and result queries preserve partial work', async t => {
  const blocked = { ...snapshot('blocked', 1, 0), message: '필수 권한 정책이 필요합니다.', artifacts: [{ step_id: 'prd', file: '/verified/prd.md' }] };
  const { dir } = await endpoint(t, () => blocked);
  const file = path.join(dir, 'plan.json'); fs.writeFileSync(file, JSON.stringify(plan));
  const result = await cli(dir, ['orchestrate', '--input', file, '--wait']);
  assert.equal(result.exit, 2); assert.equal(JSON.parse(result.stdout).status, 'blocked');
  assert.match(result.notices.at(-1), /확인 필요.*완료 1\/2/);
  const fetched = await cli(dir, ['result', 'plan-cli-test']); const value = JSON.parse(fetched.stdout);
  assert.equal(value.progress.completed, 1); assert.equal(value.artifacts[0].file, '/verified/prd.md');
  assert.equal(value.steps[0].run_id, 'run-first'); assert.equal(value.message, blocked.message);
});

test('CLI plan cancel and resume use plan control routes and resume waits without another submission', async t => {
  const { dir, calls } = await endpoint(t, call => {
    if (call.url.endsWith('/cancel')) return snapshot('cancelled', 0, 0);
    if (call.url.endsWith('/resume')) return snapshot('running', 1, 0);
    return snapshot('completed', 2, 0);
  });
  const cancelled = await cli(dir, ['cancel', 'plan-cli-test']); assert.equal(JSON.parse(cancelled.stdout).status, 'cancelled');
  const resumed = await cli(dir, ['resume', 'plan-cli-test', '--wait']); assert.equal(resumed.exit, 0, resumed.stderr);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['POST', '/plans/plan-cli-test/cancel'], ['POST', '/plans/plan-cli-test/resume'], ['GET', '/plans/plan-cli-test']]);
  assert.match(resumed.notices.at(-1), /완료 2\/2/);
});

test('CLI rejects worker recursion and malformed orchestration before submitting any request', async t => {
  const { dir, calls } = await endpoint(t, () => assert.fail('must not reach service'));
  const file = path.join(dir, 'plan.json'); fs.writeFileSync(file, JSON.stringify(plan));
  const recursive = await cli(dir, ['orchestrate', '--input', file], { HARNESS_WORKER: '1' });
  assert.equal(recursive.exit, 1); assert.match(recursive.stderr, /재귀 실행/);
  const workerResume = await cli(dir, ['resume', 'plan-cli-test'], { HARNESS_WORKER: '1' });
  assert.equal(workerResume.exit, 1); assert.match(workerResume.stderr, /실행을 제어/);
  const missing = await cli(dir, ['orchestrate', '--wait']); assert.equal(missing.exit, 1); assert.match(missing.stderr, /--input/);
  const evidence = await cli(dir, ['evidence', 'plan-cli-test']); assert.equal(evidence.exit, 1); assert.match(evidence.stderr, /run_id/);
  assert.equal(calls.length, 0);
});

test('structured CLI runs PRD then entity design through the real runtime, with frozen handoff and verified final artifacts', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const request = {
    prompt: '초대 기능의 PRD를 작성하고 그 요구사항으로 엔티티를 설계해 주세요.', engine: 'fixture', idempotency_key: 'cli-real-dag',
    steps: [{ id: 'prd', task: 'prd.create', output_key: 'invitation-prd', request_excerpt: '초대 기능의 PRD를 작성',
      input: { requirements: '초대 수락과 거절 상태 및 수용 기준을 포함하는 제품 요구사항을 작성하세요.' }, depends_on: [] },
    { id: 'entities', task: 'entity.design', output_key: 'invitation-entities', request_excerpt: '그 요구사항으로 엔티티를 설계해 주세요.',
      input: { requirements: '선행 PRD를 근거로 초대 엔티티와 관계, 상태 불변식을 설계하세요.' }, depends_on: ['prd'] }]
  };
  const file = path.join(h.dir, 'plan.json'); fs.writeFileSync(file, JSON.stringify(request));
  const result = await cli(h.dir, ['orchestrate', '--input', file, '--wait']);
  assert.equal(result.exit, 0, `${result.stdout}\n${result.stderr}`);
  const final = JSON.parse(result.stdout);
  assert.equal(final.status, 'completed'); assert.equal(final.progress.completed, 2);
  assert.equal(final.artifacts.length, 2);
  for (const artifact of final.artifacts) {
    const step = final.steps.find(value => value.id === artifact.step_id);
    assert.ok(fs.existsSync(artifact.file));
    assert.equal(artifact.output_file, path.join(fs.realpathSync(h.dir), 'output', 'worklog', step.run_id, path.basename(artifact.file)));
    assert.equal(digest(fs.readFileSync(artifact.output_file)), artifact.content_digest);
    assert.deepEqual(fs.readFileSync(artifact.output_file), fs.readFileSync(artifact.file));
  }
  const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'), { readOnly: true }); t.after(() => db.close());
  const rows = db.prepare('SELECT * FROM runs ORDER BY created_at').all(); assert.equal(rows.length, 2);
  const downstream = rows.find(row => JSON.parse(row.request).task === 'entity.design');
  const definition = JSON.parse(downstream.definition);
  assert.equal(definition.upstream.length, 1); assert.equal(definition.upstream[0].task, 'prd.create');
  const prior = final.artifacts.find(a => a.task === 'prd.create');
  assert.equal(definition.upstream[0].content_digest, prior.content_digest);
  assert.equal(definition.upstream[0].output_file, prior.output_file);
  const downstreamView = await h.runtime(`/runs/${downstream.id}`);
  const workerPrompt = fs.readFileSync(path.join(downstreamView.attempts[0].directory, 'prompt.txt'), 'utf8');
  assert.ok(workerPrompt.includes(prior.output_file), 'the dependent worker can trace its frozen input to the published predecessor file');
  const stagedInputs = path.join(downstreamView.attempts[0].directory, 'inputs');
  assert.ok(fs.readdirSync(stagedInputs).some(name => digest(fs.readFileSync(path.join(stagedInputs, name))) === prior.content_digest));
  assert.equal(definition.plan_scope.output_key, 'invitation-entities');
  assert.equal(JSON.parse(downstream.request).input.requirements, request.steps[1].input.requirements);
  const replay = await cli(h.dir, ['orchestrate', '--input', file, '--wait']);
  assert.equal(replay.exit, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).id, final.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 2);
});

test('published skill and orchestration guide plans execute through CLI with their explicit review decisions', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const summary = await cli(h.dir, ['catalog', '--summary']);
  assert.equal(summary.exit, 0, summary.stderr);
  const catalog = JSON.parse(summary.stdout);
  assert.equal(catalog.jobs.find(job => job.id === 'text.generate').review_policy.omission_allowed, true);
  assert.equal(catalog.jobs.find(job => job.id === 'prd.create').review_policy.omission_allowed, false);
  for (const source of ['skills/work/SKILL.md', 'docs/task-orchestration.md']) {
    const markdown = fs.readFileSync(path.join(ROOT, source), 'utf8');
    const examples = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1])).filter(value => Array.isArray(value.steps));
    assert.equal(examples.length, 1, source);
    const request = { ...examples[0], engine: 'fixture', idempotency_key: `documented-plan:${source}` };
    const file = path.join(h.dir, `${path.basename(source)}.json`); fs.writeFileSync(file, JSON.stringify(request));
    const result = await cli(h.dir, ['orchestrate', '--input', file, '--wait']);
    assert.equal(result.exit, 0, `${source}: ${result.stdout}\n${result.stderr}`);
    const final = JSON.parse(result.stdout);
    assert.equal(final.status, 'completed'); assert.equal(final.progress.completed, request.steps.length);
    for (const step of final.steps) {
      const expected = request.steps.find(value => value.id === step.id);
      const run = await h.runtime(`/runs/${step.run_id}`);
      assert.deepEqual(step.review, expected.review); assert.deepEqual(run.review, expected.review);
      assert.ok(run.attempts.some(attempt => attempt.stage === 'review'));
      assert.equal(digest(fs.readFileSync(step.artifact.output_file)), step.artifact.content_digest);
    }
  }
});
