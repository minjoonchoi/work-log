#!/usr/bin/env node
// Protocol double only: this is not Claude/Codex or a live model.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), codex = args[0] === 'exec';
if (args.includes('--version')) { console.log('protocol-double 1.0'); process.exit(0); }
const review = process.env.HARNESS_STAGE === 'review';
fs.writeFileSync(path.join(process.cwd(), '../invocation.json'), JSON.stringify(args));
const output = codex ? args[args.indexOf('-o') + 1] : path.join(process.cwd(), '../claude-structured.json');
const prompt = fs.readFileSync(0, 'utf8');
const result = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs'), output, review ? 'review' : 'produce'],
  { input: prompt, encoding: 'utf8', cwd: process.cwd(), env: process.env });
if (result.status !== 0) process.exit(result.status || 1);
process.stdout.write(codex ? JSON.stringify({ type: 'thread.started', thread_id: 'protocol-thread' }) + '\n' + result.stdout + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }) + '\n'
  : JSON.stringify({ is_error: false, session_id: 'protocol-session', usage: { input_tokens: 10, output_tokens: 20 }, structured_output: JSON.parse(fs.readFileSync(output)) }));
