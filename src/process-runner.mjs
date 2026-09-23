import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomic, json, now, redact } from './shared.mjs';

// Shared by model workers and registered checks. Neither caller builds a shell command.
export function runProcess({ command, args, cwd, env, stdin = '', attemptDir, limits, onSpawn = () => {}, onStdout }) {
  let child, timer, killTimer, reason = null, finished = false;
  const startedAt = now(), startedClock = performance.now();
  let firstStdoutAt = null, firstStdoutMs = null;
  const kill = why => {
    if (finished) return;
    reason ||= why;
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    killTimer ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500);
  };
  const promise = new Promise(resolve => {
    const stdout = [], stderr = []; let bytes = 0, retained = 0, settled = false;
    const finish = (code, signal, error) => {
      if (settled) return; settled = true; finished = true; clearTimeout(timer);
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      clearTimeout(killTimer);
      // Decode once so UTF-8 characters split across pipe chunks remain intact.
      const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8');
      atomic(path.join(attemptDir, 'stdout.log'), redact(out));
      atomic(path.join(attemptDir, 'stderr.log'), redact(err));
      const observation = { command, args, cwd, started_at: startedAt, ended_at: now(), code, signal: signal || null,
        error: error?.message || null, reason, bytes, pid: child?.pid || null,
        elapsed_ms: Math.round(performance.now() - startedClock), first_stdout_at: firstStdoutAt, first_stdout_ms: firstStdoutMs };
      atomic(path.join(attemptDir, 'process.json'), json(observation));
      resolve({ ok: !reason && !error && code === 0, stdout: out, stderr: err, observation });
    };
    try {
      child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      child.once('error', error => finish(null, null, error));
      child.once('spawn', () => {
        try { onSpawn(child.pid); child.stdin.end(stdin); }
        catch { kill('spawn_callback_failed'); child.stdin.end(); }
      });
      child.stdin.on('error', () => {});
      const collect = (stream, isStdout = false) => chunk => {
        bytes += chunk.length;
        const keep = Math.min(chunk.length, Math.max(0, limits.maxOutputBytes - retained));
        if (keep) { stream.push(chunk.subarray(0, keep)); retained += keep; }
        if (bytes > limits.maxOutputBytes) kill('output_limit');
        if (isStdout && !reason) {
          if (firstStdoutAt === null) { firstStdoutAt = now(); firstStdoutMs = Math.round(performance.now() - startedClock); }
          try { const violation = onStdout?.(chunk); if (violation) kill(violation); }
          catch { kill('worker_observer_failed'); }
        }
      };
      child.stdout.on('data', collect(stdout, true)); child.stderr.on('data', collect(stderr));
      child.once('close', (code, signal) => finish(code, signal));
      timer = setTimeout(() => kill('timeout'), limits.timeoutMs);
    } catch (e) { finish(null, null, e); }
  });
  return { promise, cancel: () => kill('cancelled') };
}
