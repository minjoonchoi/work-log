import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { execute } from '../../src/executor.mjs';
import { codexDirectArguments } from '../../src/worker-policy.mjs';

const direct = { mode: 'direct', max_tool_calls: 0, max_model_turns: 1 };
const schema = { type: 'object', properties: { status: { const: 'done' }, result: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }, required: ['status', 'result'], additionalProperties: false };

function context(t, engine, scenario, policy = direct) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-bounded-'));
  const attemptDir = path.join(dir, 'attempt'), cwd = path.join(attemptDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const cli = path.join(dir, 'cli.mjs'), key = `HARNESS_${engine.toUpperCase()}_BIN`, before = process.env[key];
  fs.writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('bounded-cli-double 1'); process.exit(0); }
const scenario = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'invocation.json'))}, JSON.stringify({ args, worker: process.env.HARNESS_WORKER, home: process.env.HOME, codex_home: process.env.CODEX_HOME }));
const event = value => process.stdout.write(JSON.stringify(value) + '\\n');
const codex = args[0] === 'exec';
const result = { status: 'done', result: { content: '작업 요약입니다.' } };
const writeResult = () => { if (codex) { fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(result)); event({ type: 'turn.completed', usage: { output_tokens: 5 } }); } else event({ type: 'result', is_error: false, num_turns: 1, structured_output: result }); };
if (scenario === 'unsupported') { process.stderr.write('error: unknown option --safe-mode'); process.exit(2); }
if (codex) event({ type: 'turn.started' });
const tool = id => codex ? { type: 'item.started', item: { type: 'command_execution', id, command: 'unexpected command' } } : { type: 'assistant', message: { id: 'message-' + id, content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } };
if (scenario === 'tool' || scenario === 'allow-one' || scenario === 'too-many-tools') {
  const value = Buffer.from(JSON.stringify(tool('한글 도구')) + '\\n');
  // Pipes may split both JSON records and UTF-8 code points.
  const split = value.indexOf(Buffer.from('한')) + 1;
  process.stdout.write(value.subarray(0, split)); process.stdout.write(value.subarray(split));
  if (codex) event({ type: 'item.completed', item: { type: 'command_execution', id: '한글 도구' } });
  if (scenario === 'too-many-tools') event(tool('second'));
  if (scenario !== 'allow-one') { setTimeout(() => { fs.writeFileSync(${JSON.stringify(path.join(dir, 'continued'))}, 'unexpected continuation'); writeResult(); }, 1200); }
  else writeResult();
} else if (scenario === 'too-many-turns') {
  if (codex) event({ type: 'turn.started' });
  else for (const id of ['one', 'two']) event({ type: 'assistant', message: { id, content: [{ type: 'text', text: id }] } });
  setTimeout(writeResult, 1200);
} else {
  if (!codex) event({ type: 'assistant', message: { id: 'one', content: [{ type: 'tool_use', id: 'schema-output', name: 'StructuredOutput', input: result }] } });
  writeResult();
}
`, { mode: 0o755 });
  process.env[key] = cli;
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, ctx: { engine, cwd, attemptDir, stage: 'produce', prompt: scenario, schema,
    dataDir: path.join(dir, 'data'), parent: { task_id: 'test-attempt' }, workerPolicy: policy,
    execution: { model: engine === 'codex' ? 'gpt-5.6-luna' : 'sonnet', effort: 'high' },
    limits: { timeoutMs: 3000, maxOutputBytes: 100000 } } };
}

for (const engine of ['codex', 'claude']) {
  test(`${engine}: direct generation returns content in one invocation with worker-only settings and measured latency`, async t => {
    const { dir, ctx } = context(t, engine, 'success');
    const returned = await execute(ctx).promise;
    assert.equal(returned.ok, true, JSON.stringify(returned.observation));
    assert.equal(returned.result.result.content, '작업 요약입니다.');
    assert.deepEqual(fs.readdirSync(ctx.cwd), []);
    assert.deepEqual(returned.observation.worker_policy, direct);
    assert.equal(returned.observation.observed_tool_calls, 0);
    assert.ok(returned.observation.elapsed_ms >= returned.observation.first_stdout_ms);
    assert.ok(returned.observation.first_stdout_at);
    const { args, worker, home, codex_home } = JSON.parse(fs.readFileSync(path.join(dir, 'invocation.json')));
    assert.equal(worker, '1'); assert.equal(home, process.env.HOME); assert.equal(codex_home, process.env.CODEX_HOME);
    assert.equal(args[args.indexOf('--model') + 1], engine === 'codex' ? 'gpt-5.6-luna' : 'sonnet');
    if (engine === 'codex') {
      for (const flag of ['--ignore-user-config', '--strict-config', 'project_doc_max_bytes=0', 'skills.include_instructions=false', 'features.shell_tool=false', 'features.skip_host_skill_discovery=true', 'model_reasoning_effort="high"']) assert.ok(args.includes(flag), flag);
      assert.equal(returned.observation.observed_model_turns, null);
      assert.equal(returned.observation.model_turn_limit_enforcement, 'not_exposed_by_cli');
    } else {
      assert.equal(args[args.indexOf('--tools') + 1], '');
      assert.equal(args[args.indexOf('--max-turns') + 1], '1');
      assert.ok(args.includes('--safe-mode')); assert.ok(args.includes('--strict-mcp-config'));
      assert.equal(returned.observation.observed_model_turns, 1);
    }
  });

  test(`${engine}: unexpected direct tool use stops the subprocess before continuation and cannot become successful`, async t => {
    const { dir, ctx } = context(t, engine, 'tool');
    const returned = await execute(ctx).promise;
    assert.equal(returned.ok, false); assert.equal(returned.observation.reason, 'worker_tool_limit');
    assert.equal(returned.observation.observed_tool_calls, 1);
    assert.equal(fs.existsSync(path.join(dir, 'continued')), false);
    assert.equal(fs.existsSync(path.join(ctx.attemptDir, 'result.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.attemptDir, 'process.json'))).reason, 'worker_tool_limit');
  });

  test(`${engine}: extra observable turns stop instead of continuing the worker`, async t => {
    const { ctx } = context(t, engine, 'too-many-turns');
    const returned = await execute(ctx).promise;
    assert.equal(returned.ok, false);
    assert.equal(returned.observation.reason, engine === 'codex' ? 'worker_user_turn_limit' : 'worker_model_turn_limit');
  });
}

test('artifact workers count start/completion once and stop when their finite tool budget is exceeded', async t => {
  for (const scenario of ['allow-one', 'too-many-tools']) {
    const { ctx } = context(t, 'codex', scenario, { mode: 'artifact', max_tool_calls: 1, max_model_turns: 2 });
    const returned = await execute(ctx).promise;
    assert.equal(returned.ok, scenario === 'allow-one');
    assert.equal(returned.observation.observed_tool_calls, scenario === 'allow-one' ? 1 : 2);
    if (!returned.ok) assert.equal(returned.observation.reason, 'worker_tool_limit');
  }
});

test('unsupported CLI switches fail explicitly without silently dropping worker restrictions', async t => {
  const { ctx } = context(t, 'claude', 'unsupported');
  const returned = await execute(ctx).promise;
  assert.equal(returned.ok, false); assert.equal(returned.observation.reason, 'worker_capability_unavailable');
  assert.match(returned.observation.error, /unknown option --safe-mode/);
});

test('installed Codex accepts the direct policy and sends no tools to an isolated local transport', { skip: process.env.HARNESS_LOCAL_CODEX_PROBE !== '1' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-local-codex-'));
  let requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: JSON.parse(raw) });
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Local capability probe; no model executed', type: 'invalid_request_error' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let child;
  t.after(async () => { child?.kill('SIGKILL'); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const args = ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', ...codexDirectArguments(),
    '-c', 'features.remote_models=false', '-c', 'model_provider="localprobe"', '-c',
    `model_providers.localprobe={name="Local test",base_url="${base}",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
    '--model', 'gpt-5.6-luna', '--skip-git-repo-check', '-C', dir, '-'];
  // No inherited credential, proxy or provider environment; isolated homes only.
  child = spawn('codex', args, { env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: dir, TMPDIR: dir, HARNESS_WORKER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', value => stderr += value); child.stdout.resume(); child.stdin.end('Return one short JSON result.');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timeout);
  assert.equal(code, 1, stderr); assert.equal(requests.length, 1, stderr);
  assert.equal(requests[0].url, '/v1/responses');
  assert.deepEqual(requests[0].body.tools || [], []);
  assert.doesNotMatch(JSON.stringify(requests[0].body.input), /<skills_instructions>|<available_skills>|worklog-request/);
});
