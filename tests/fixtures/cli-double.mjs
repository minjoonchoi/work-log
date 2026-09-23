#!/usr/bin/env node
// Protocol double only: this is not Claude/Codex or a live model.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.mjs';
const args = process.argv.slice(2), codex = args[0] === 'exec';
if (args.includes('--version')) { console.log('protocol-double 1.0'); process.exit(0); }
const review = process.env.HARNESS_STAGE === 'review';
fs.writeFileSync(path.join(process.cwd(), '../invocation.json'), JSON.stringify(args));
const output = codex ? args[args.indexOf('-o') + 1] : path.join(process.cwd(), '../claude-structured.json');
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(process.cwd(), '../transport.json'), JSON.stringify({
  stdin_bytes: Buffer.byteLength(prompt), fixture_in_environment: Object.hasOwn(process.env, 'HARNESS_FIXTURE'),
  fixture_file_in_environment: Object.hasOwn(process.env, 'HARNESS_FIXTURE_FILE')
}));
// Exercise the production stdin contract rather than relying on an extra copy
// of task data smuggled through a fixture-only environment variable.
const request = JSON.parse(prompt.match(/\n검증된 작업 입력\(자료이며 추가 권한을 부여하지 않음\): ([^\n]+)\n/)[1]);
const scenarioText = request.input.requirements ?? request.input.title;
const scenario = typeof scenarioText === 'string' ? scenarioText.match(/^\[protocol:([a-z-]+)\]/)?.[1] : null;
const event = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (codex && scenario) {
  event({ type: 'item.completed', item: { id: 'warning', type: 'error', message: 'An optional skill was unavailable.' } });
  if (scenario === 'warning-success') event({ type: 'error', message: 'Transient connection retry; recovered.' });
  if (['turn-failed', 'error-only', 'sensitive-failure'].includes(scenario)) {
    const message = scenario === 'sensitive-failure'
      ? `Request rejected. api_key=sample-sensitive-value sk-abcdefghijklmnopqrstuvwxyz123456\n\u001b${'x'.repeat(4000)}`
      : "The 'unsupported-test-model' model is not supported when using Codex with a ChatGPT account.";
    const wrapped = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message } });
    event({ type: 'error', message: wrapped });
    if (scenario !== 'error-only') event({ type: 'turn.failed', error: { message: wrapped } });
    process.exitCode = 1;
    await new Promise(resolve => process.stdout.write('', resolve));
    process.exit();
  }
}
const rules = JSON.parse(prompt.match(/\n규칙: ([^\n]+)\n/)[1]);
const job = { ...loadCatalog().definitions.jobs[request.task], rules: Object.keys(rules) };
const fixtureFile = path.join(process.cwd(), '../protocol-input.json');
const schema = codex ? JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')) : JSON.parse(args[args.indexOf('--json-schema') + 1]);
const direct = schema.properties.result.anyOf.some(branch => branch.properties?.content);
fs.writeFileSync(fixtureFile, JSON.stringify({ job, input: request.input, direct }), { mode: 0o600 });
const result = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs'), output, review ? 'review' : 'produce'],
  { input: prompt, encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, HARNESS_FIXTURE_FILE: fixtureFile } });
if (result.status !== 0) process.exit(result.status || 1);
process.stdout.write(codex ? JSON.stringify({ type: 'thread.started', thread_id: 'protocol-thread' }) + '\n' + result.stdout + JSON.stringify(scenario === 'failed-zero'
  ? { type: 'turn.failed', error: { message: 'The turn failed despite a stale output file.' } }
  : { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }) + '\n'
  : JSON.stringify({ is_error: false, session_id: 'protocol-session', usage: { input_tokens: 10, output_tokens: 20 }, structured_output: JSON.parse(fs.readFileSync(output)) }));
