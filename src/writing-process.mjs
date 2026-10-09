import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { atomic, json, now, redact, digest } from './shared.mjs';
import { codexDirectArguments } from './worker-policy.mjs';

let shared = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class WritingProcess {
  constructor({ command, args, engine, env, key }) {
    this.key = key; this.engine = engine; this.pending = new Map(); this.nextId = 0;
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-writing-'));
    this.command = command;
    this.args = engine === 'codex'
      ? ['app-server', '--listen', 'stdio://', ...codexDirectArguments().filter(value => !['--ephemeral', '--ignore-user-config'].includes(value))]
      : [...args, '--input-format', 'stream-json'];
    this.child = spawn(command, this.args, { cwd: this.directory, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.dead = false;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => { this.dead = true; this.resolveClosed(); this.fail(error); });
    this.child.on('close', () => { this.dead = true; this.resolveClosed(); this.fail(new Error('자동 작성 프로세스가 응답을 완료하기 전에 종료되었습니다.')); });
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stderr.on('data', chunk => {
      if (this.active) {
        this.active.stderr += chunk.toString('utf8'); this.active.bytes += chunk.length;
        if (this.active.bytes > this.active.limits.maxOutputBytes) this.fail(new Error('자동 작성 응답 크기 한도를 초과했습니다.'), 'output_limit');
      }
    });
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stderr.on('error', error => this.fail(error));
    this.ready = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('spawn', async () => {
        try {
          if (engine === 'codex') {
            await this.rpc('initialize', { clientInfo: { name: 'worklog', version: '0.3.1' } });
            this.send({ method: 'initialized', params: {} });
          }
          resolve();
        } catch (error) { reject(error); }
      });
    });
    this.ready.catch(() => {});
  }
  send(message) { this.child.stdin.write(json(message) + '\n'); }
  rpc(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ id, method, params }); });
  }
  receive(chunk) {
    const task = this.active;
    if (task) {
      task.bytes += chunk.length;
      if (task.bytes > task.limits.maxOutputBytes) { this.fail(new Error('자동 작성 응답 크기 한도를 초과했습니다.'), 'output_limit'); return; }
      task.stdout += chunk.toString('utf8');
    }
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > (task?.limits.maxOutputBytes || 1024 * 1024)) { this.fail(new Error('CLI 응답 크기 한도를 초과했습니다.'), 'output_limit'); return; }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { this.fail(new Error('CLI 스트림 응답을 읽을 수 없습니다.'), 'protocol_failure'); return; }
      if (event.id != null && !event.method) {
        const waiting = this.pending.get(event.id);
        if (waiting) { this.pending.delete(event.id); event.error ? waiting.reject(new Error(event.error.message || 'Codex 요청 실패')) : waiting.resolve(event.result); }
        continue;
      }
      // A text-only writer never answers approval or interactive tool requests.
      if (event.id != null && event.method) { this.fail(new Error('자동 작성에서 도구 또는 사용자 입력을 요청했습니다.'), 'worker_tool_limit'); return; }
      if (!task || task.finishing) continue;
      if (this.engine === 'claude') {
        if (event.type === 'assistant' && event.message?.content?.some(part => part.type === 'tool_use')) {
          this.fail(new Error('자동 작성에서 도구를 호출했습니다.'), 'worker_tool_limit'); return;
        }
        if (event.type === 'result') {
          if (event.is_error || typeof event.result !== 'string') this.fail(new Error(typeof event.result === 'string' ? event.result : 'Claude 최종 응답을 받지 못했습니다.'), 'engine_failure');
          else this.finish(event.result, event.session_id, event.usage);
        }
      } else {
        const p = event.params || {};
        if (p.threadId && p.threadId !== task.threadId) continue;
        if (['item/started', 'item/completed'].includes(event.method)) {
          const item = p.item;
          if (item && !['userMessage', 'agentMessage', 'reasoning'].includes(item.type)) { this.fail(new Error('자동 작성에서 도구를 호출했습니다.'), 'worker_tool_limit'); return; }
          if (event.method === 'item/completed' && item?.type === 'agentMessage' && item.phase !== 'commentary') task.text = item.text;
        }
        if (event.method === 'turn/completed') {
          if (p.turn?.status !== 'completed') this.fail(new Error(p.turn?.error?.message || `Codex 요청 실패: ${p.turn?.status}`), 'engine_failure');
          else this.finish(task.text, task.threadId, null);
        }
      }
    }
  }
  run(context) {
    if (this.active) throw new Error('자동 작성 프로세스가 이전 요청을 처리 중입니다.');
    clearTimeout(this.idleTimer);
    return new Promise(resolve => {
      const task = this.active = { ...context, resolve, started: now(), clock: performance.now(), text: '', bytes: 0, stdout: '', stderr: '', finishing: false };
      task.timer = setTimeout(() => this.fail(new Error('자동 작성 요청 시간이 초과되었습니다.'), 'timeout'), context.limits.timeoutMs);
      void (async () => {
        try {
          await this.ready;
          if (task.finishing) return;
          context.onSpawn?.(this.child.pid);
          if (this.engine === 'codex') {
            const started = await this.rpc('thread/start', { model: context.execution.model, cwd: context.cwd, ephemeral: true,
              approvalPolicy: 'never', sandbox: 'readOnly', config: { model_reasoning_effort: context.execution.effort },
              developerInstructions: '각 요청의 입력 자료만 사용하여 최종 텍스트를 작성하세요. 도구 호출은 금지합니다.' });
            task.threadId = started.thread.id;
            if (task.finishing) return;
            await this.rpc('turn/start', { threadId: task.threadId, input: [{ type: 'text', text: context.prompt }],
              model: context.execution.model, effort: context.execution.effort });
          } else this.send({ type: 'user', message: { role: 'user', content: context.prompt }, parent_tool_use_id: null, session_id: '' });
        } catch (error) { if (!task.finishing) this.fail(error); }
      })();
    });
  }
  finish(text, nativeSession, usage) {
    const task = this.active;
    if (!task || task.finishing) return;
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 1024 * 1024) { this.fail(new Error('최종 텍스트 응답이 없거나 너무 큽니다.'), 'protocol_failure'); return; }
    task.finishing = true; clearTimeout(task.timer);
    this.settle(task, { ok: true, text, nativeSession, usage, termination: null });
    // Keep the CLI alive across coordinator polls and the entire queued batch.
    this.idleTimer = setTimeout(() => { void this.close(); }, 60000); this.idleTimer.unref();
  }
  fail(error, reason = 'process_error') {
    for (const waiting of this.pending.values()) waiting.reject(error); this.pending.clear();
    const task = this.active;
    if (!task || task.finishing) return;
    task.finishing = true; clearTimeout(task.timer);
    void this.close().then(termination => this.settle(task, { ok: false, error, reason, termination }));
  }
  settle(task, { ok, text, nativeSession, usage, error, reason, termination }) {
    const observation = { command: this.command, args: this.args, cwd: task.cwd, pid: this.child.pid || null,
      started_at: task.started, ended_at: now(), elapsed_ms: Math.round(performance.now() - task.clock),
      persistent_process: true, request_completed: ok, termination_confirmed: termination,
      code: ok ? 0 : null, reason: reason || null, error: error ? redact(error.message) : null,
      native_session_id: nativeSession || null, usage: usage || null, bytes: task.bytes };
    atomic(path.join(task.attemptDir, 'stdout.log'), redact(task.stdout)); atomic(path.join(task.attemptDir, 'stderr.log'), redact(task.stderr));
    atomic(path.join(task.attemptDir, 'process.json'), json(observation));
    if (ok) atomic(path.join(task.attemptDir, 'response.txt'), redact(text));
    this.active = null;
    task.resolve({ ok, text: ok ? text : null, observation });
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      clearTimeout(this.idleTimer);
      const signal = name => { try { if (this.child.pid) process.kill(-this.child.pid, name); } catch {} };
      if (!this.dead) { signal('SIGTERM'); await Promise.race([this.closed, pause(500)]); }
      signal('SIGKILL'); await Promise.race([this.closed, pause(500)]);
      let alive = false; try { if (this.child.pid) { process.kill(-this.child.pid, 0); alive = true; } } catch {}
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.unref();
      this.dead = true; this.confirmed = !alive;
      if (this.confirmed) fs.rmSync(this.directory, { recursive: true, force: true });
      return this.confirmed;
    })();
    return this.closing;
  }
}

export function runWritingProcess(context) {
  let cancelled = false, owner;
  const envKey = Object.fromEntries(Object.entries(context.env).filter(([key]) => !['HARNESS_PARENT', 'HARNESS_ATTEMPT_ID', 'HARNESS_STAGE'].includes(key)));
  const key = digest(json([context.command, context.engine, context.engine === 'claude' ? context.args : null, envKey]));
  const promise = (async () => {
    if (shared && (shared.key !== key || shared.dead || shared.closing)) {
      if (!await shared.close()) throw new Error('이전 자동 작성 프로세스의 종료를 확인하지 못했습니다.');
      shared = null;
    }
    if (cancelled) throw new Error('자동 작성 요청을 취소했습니다.');
    owner = shared ||= new WritingProcess({ ...context, key });
    return owner.run(context);
  })().catch(error => ({ ok: false, observation: { error: error.message, reason: 'process_error', termination_confirmed: shared?.confirmed !== false } }));
  return { promise, cancel() { cancelled = true; owner?.fail(new Error('자동 작성 요청을 취소했습니다.'), 'cancelled'); } };
}
export async function closeWritingProcess() { if (shared) { await shared.close(); shared = null; } }
