import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { execute } from '../../src/executor.mjs';
import { ROOT } from '../../src/shared.mjs';
import { managerStore } from '../../src/manager-store.mjs';
import { hookCommand, locations, quote, readManifest } from '../../scripts/install-state.mjs';
import { prepareInstall, applyInstall } from '../../scripts/install.mjs';
import { connectAgent, getAgentConnections } from '../../scripts/agent-connections.mjs';
import { applyUninstall } from '../../scripts/uninstall.mjs';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-worker-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const hook = path.join(ROOT, 'src/hook.mjs');

test('direct worker hooks exit silently before stdin, database, spool or error handling', async t => {
  const dir = path.join(temporary(t), 'unused-data');
  const child = spawn(process.execPath, [hook, 'codex'], {
    env: { ...process.env, HARNESS_WORKER: '1', HARNESS_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  child.stdin.on('error', () => {});
  // Leave stdin open: a worker hook must not wait for an event or EOF.
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  const status = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer); child.stdin.destroy();
  assert.equal(status, 0); assert.equal(stdout, ''); assert.equal(stderr, '');
  assert.equal(fs.existsSync(dir), false);
  const invalid = spawnSync(process.execPath, [hook, 'claude'], {
    input: '{invalid json', encoding: 'utf8', env: { ...process.env, HARNESS_WORKER: '1', HARNESS_DATA_DIR: dir }
  });
  assert.equal(invalid.status, 0); assert.equal(invalid.stdout, ''); assert.equal(invalid.stderr, '');
  assert.equal(fs.existsSync(dir), false);
});

test('ordinary user hooks still record lifecycle, tools and correlated input/output', t => {
  const dir = temporary(t), events = [
    { hook_event_name: 'SessionStart' },
    { hook_event_name: 'UserPromptSubmit', prompt: '일반 사용자 요청' },
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'tool-1', tool_input: { file_path: 'example.txt' } },
    { hook_event_name: 'Stop', last_assistant_message: '일반 사용자 응답' },
    { hook_event_name: 'SessionEnd' }
  ];
  for (const event of events) {
    const result = spawnSync(process.execPath, [hook, 'codex'], {
      input: JSON.stringify({ session_id: 'user-session', ...event }), encoding: 'utf8',
      env: { ...process.env, HARNESS_WORKER: '0', HARNESS_DATA_DIR: dir }
    });
    assert.equal(result.status, 0); assert.equal(result.stdout, '');
  }
  const rows = fs.readdirSync(path.join(dir, 'spool')).map(file => JSON.parse(fs.readFileSync(path.join(dir, 'spool', file))));
  assert.equal(rows.length, events.length); assert.ok(rows.every(row => row.role === 'user'));
  const input = rows.find(row => row.kind === 'input'), output = rows.find(row => row.kind === 'output');
  assert.equal(output.turn_id, null); assert.equal(output.turn_source, 'missing');
  assert.equal(input.turn_source, 'local'); assert.equal(input.text, '일반 사용자 요청');
  assert.ok(rows.some(row => row.kind === 'tool.started' && row.call_id === 'tool-1'));
  assert.equal(fs.existsSync(path.join(dir, 'hook-state.sqlite')), false);
  const store = managerStore(dir); t.after(() => store.db.close());
  store.ingestMany(rows);
  const detail = store.detail(store.items()[0].id), projected = detail.events.find(row => row.kind === 'output');
  assert.equal(projected.turn_id, input.turn_id); assert.equal(projected.resolution, 'matched');
  assert.equal(detail.sessions[0].pending, false);
});

test('owned shell hook commands skip workers before spawning Node and still run for users', t => {
  const dir = temporary(t), loc = locations(path.join(dir, "User's Home")), runtime = path.join(dir, "Runtime's Node");
  const marker = path.join(dir, 'node-spawned');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'node'), `#!/bin/sh\nprintf '%s' invoked > ${quote(marker)}\n`, { mode: 0o755 });
  for (const engine of ['codex', 'claude']) {
    const command = hookCommand(loc, runtime, 'owned-installation', engine);
    const worker = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, HARNESS_WORKER: '1' } });
    assert.equal(worker.status, 0); assert.equal(worker.stdout, ''); assert.equal(worker.stderr, '');
    assert.equal(fs.existsSync(marker), false);
    const user = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, HARNESS_WORKER: '0' } });
    assert.equal(user.status, 0); assert.equal(fs.readFileSync(marker, 'utf8'), 'invoked'); fs.unlinkSync(marker);
  }
});

test('all model stages and CLI version probes pass the worker marker without disabling native hooks', async t => {
  const dir = temporary(t), trace = path.join(dir, 'trace.jsonl'), dataDir = path.join(dir, 'no-hook-data');
  const original = { codex: process.env.HARNESS_CODEX_BIN, claude: process.env.HARNESS_CLAUDE_BIN };
  t.after(() => {
    for (const engine of ['codex', 'claude']) {
      const key = `HARNESS_${engine.toUpperCase()}_BIN`;
      if (original[engine] === undefined) delete process.env[key]; else process.env[key] = original[engine];
    }
  });
  for (const engine of ['codex', 'claude']) {
    const cli = path.join(dir, `${engine}-double.mjs`);
    fs.writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ worker: process.env.HARNESS_WORKER, stage: process.env.HARNESS_STAGE, args }) + '\\n');
const hook = spawnSync(process.execPath, [${JSON.stringify(hook)}, ${JSON.stringify(engine)}], { input: '{invalid', encoding: 'utf8', env: process.env });
if (hook.status !== 0 || hook.stdout || hook.stderr) process.exit(9);
if (args.includes('--version')) { console.log('worker-double 1.0'); process.exit(0); }
fs.readFileSync(0, 'utf8');
const result = { status: 'done', result: { file: 'artifact.md' } };
if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(result));
else console.log(JSON.stringify({ is_error: false, structured_output: result }));
`, { mode: 0o755 });
    process.env[`HARNESS_${engine.toUpperCase()}_BIN`] = cli;
    for (const stage of ['produce', 'review', 'repair']) {
      const attemptDir = path.join(dir, `${engine}-${stage}`), cwd = path.join(attemptDir, 'work');
      fs.mkdirSync(cwd, { recursive: true });
      const result = await execute({ engine, stage, attemptDir, cwd, dataDir, prompt: 'protocol input',
        parent: { task_id: `${engine}-${stage}` }, execution: { model: engine === 'codex' ? 'gpt-5.6-luna' : 'sonnet', effort: 'low' },
        limits: { timeoutMs: 3000, maxOutputBytes: 100000 } }).promise;
      assert.equal(result.ok, true, JSON.stringify(result.observation));
    }
  }
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 8); assert.ok(calls.every(call => call.worker === '1'));
  assert.equal(calls.filter(call => call.args.includes('--version')).length, 2);
  assert.ok(calls.every(call => !call.args.some(arg => /disable.*hooks|hooks.*disable/i.test(arg))));
  assert.equal(fs.existsSync(dataDir), false);
});

test('legacy owned hook receipts remain uninstallable while unrelated hooks are preserved', t => {
  const dir = temporary(t), homeDir = path.join(dir, 'Home'), sourceApp = path.join(dir, 'Source.app');
  const bin = path.join(sourceApp, 'Contents/MacOS'), bundle = path.join(sourceApp, 'Contents/Resources/harness');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(bundle, { recursive: true });
  for (const name of ['node', 'WorkLog', 'WorkLogKeychain']) fs.writeFileSync(path.join(bin, name), 'fixture binary');
  fs.cpSync(path.join(ROOT, 'skills'), path.join(bundle, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'src'), { recursive: true }); fs.writeFileSync(path.join(bundle, 'src/hook.mjs'), '// fixture hook');
  const loc = locations(homeDir), unrelated = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'company-required-hook' }] }] } };
  for (const target of Object.values(loc.configs)) {
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(unrelated));
  }
  const plan = prepareInstall({ output: path.join(dir, 'plan'), homeDir, sourceApp });
  applyInstall(plan, { activate: false });
  for (const engine of ['claude', 'codex']) connectAgent(engine, { homeDir });
  const receipt = readManifest(loc); receipt.format = 1; delete receipt.created_directories; delete receipt.created_configs;
  for (const link of receipt.links) { delete link.pending; delete link.identity; }
  for (const record of receipt.hooks) {
    const config = JSON.parse(fs.readFileSync(record.path));
    for (const entry of record.entries) {
      const current = entry.hook.command;
      const legacy = `WORKLOG_INSTALL_ID=${quote(receipt.id)} HARNESS_DATA_DIR=${quote(loc.data)} ${quote(path.join(plan.runtimeRoot, 'node'))} ${quote(path.join(plan.runtimeRoot, 'harness/src/hook.mjs'))} ${record.engine}`;
      for (const group of config.hooks[entry.event]) for (const installed of group.hooks) if (installed.command === current) installed.command = legacy;
      entry.hook.command = legacy;
    }
    fs.writeFileSync(record.path, JSON.stringify(config));
  }
  fs.writeFileSync(loc.manifest, JSON.stringify(receipt));
  assert.equal(readManifest(loc).id, receipt.id);
  assert.ok(getAgentConnections({ homeDir }).connections.every(row => row.state === 'connected'));
  const tampered = structuredClone(receipt); tampered.hooks[0].entries[0].hook.command += ' ; arbitrary-command';
  fs.writeFileSync(loc.manifest, JSON.stringify(tampered)); assert.throws(() => readManifest(loc), /훅 소유 식별자/);
  fs.writeFileSync(loc.manifest, JSON.stringify(receipt));
  const removed = applyUninstall({ homeDir, deactivate: false });
  assert.equal(removed.status, 'uninstalled', JSON.stringify(removed.preserved));
  for (const target of Object.values(loc.configs)) assert.deepEqual(JSON.parse(fs.readFileSync(target)), unrelated);
});
