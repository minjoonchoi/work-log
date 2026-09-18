import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, initRoot, request, sleep, id, json, readEndpoint } from '../src/shared.mjs';

export async function eventually(fn, predicate = Boolean, timeout = 10000) {
  const deadline = Date.now() + timeout; let value, lastError;
  while (Date.now() < deadline) {
    try { value = await fn(); if (predicate(value)) return value; } catch (e) { lastError = e; }
    await sleep(60);
  }
  throw new Error(`조건 대기 실패: ${lastError?.message || json(value)}`);
}
export class Harness {
  constructor(dir) { this.dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-e2e-')); initRoot(this.dir); this.processes = {}; this.logs = {}; }
  async start(role) {
    this.logs[role] = '';
    const child = spawn(this.executable || process.execPath, [path.join(this.serviceRoot || ROOT, `src/${role}.mjs`)], {
      cwd: ROOT, env: { ...process.env, ...this.env, HARNESS_DATA_DIR: this.dir, HARNESS_TEST_MODE: this.testMode === false ? '0' : '1' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    this.processes[role] = child;
    child.stdout.on('data', b => this.logs[role] += b.toString()); child.stderr.on('data', b => this.logs[role] += b.toString());
    await eventually(() => {
      if (child.exitCode !== null) throw new Error(this.logs[role]);
      return this.logs[role].includes('"ready":true');
    });
    return this;
  }
  async stop(role, signal = 'SIGTERM') {
    const child = this.processes[role]; if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(signal); await exit; delete this.processes[role];
  }
  async close(remove = true) { for (const role of Object.keys(this.processes)) await this.stop(role); if (remove) fs.rmSync(this.dir, { recursive: true, force: true }); }
  manager(url, options) { return request(this.dir, 'manager', `/api${url}`, options); }
  runtime(url, options) { return request(this.dir, 'runtime', url, options); }
  ingest(events) { return this.manager('/events', { method: 'POST', body: { events } }); }
  hook(engine, event, extra = {}) {
    const r = spawnSync(this.executable || process.execPath, [path.join(this.serviceRoot || ROOT, 'src/hook.mjs'), engine], { input: json(event), encoding: 'utf8', env: { ...process.env, HARNESS_DATA_DIR: this.dir, ...extra } });
    if (r.status !== 0 || r.stdout) throw new Error(`훅 실패: ${r.stdout} ${r.stderr}`); return r;
  }
  run(input = {}) { return this.runtime('/runs', { method: 'POST', body: { prompt: '권한 관리 기능의 PRD를 작성하세요', task: 'prd.create', engine: 'fixture', ...input } }); }
  finish(run, timeout = 15000) { return eventually(() => this.runtime(`/runs/${run.id}`), r => ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(r.status), timeout); }
}
export function event(agent, kind, at, turn = 't1', extra = {}) {
  return { id: id('source-'), engine: 'codex', agent_session_id: agent, kind, event_at: at.includes('T') ? at : `2026-09-17T${at}Z`, turn_id: turn, text: `${kind} ${turn}`, ...extra };
}
export function pair(agent, start, end, turn = 't1', extra = {}) { return [event(agent, 'input', start, turn, extra), event(agent, 'output', end, turn, extra)]; }
