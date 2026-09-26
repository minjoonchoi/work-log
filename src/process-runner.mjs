import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomic, json, now, redact } from './shared.mjs';

// Shared by model workers and registered checks. Neither caller builds a shell command.
export function runProcess({ command, args, cwd, env, stdin = '', attemptDir, limits, onSpawn = () => {}, onStdout }) {
  const terminationGraceMs = 1000;
  let child, timer, killTimer, settleTimer, groupTimer, reason = null, finished = false, cancel;
  const startedAt = now(), startedClock = performance.now();
  let firstStdoutAt = null, firstStdoutMs = null;
  const promise = new Promise(resolve => {
    const stdout = [], stderr = []; let bytes = 0, retained = 0;
    let code = null, signal = null, error = null, parentExited = false, stdioClosed = false, groupEnded = false;
    const signalGroup = value => { if (child?.pid && !groupEnded) { try { process.kill(-child.pid, value); } catch {} } };
    const groupAlive = () => {
      if (!child?.pid || groupEnded) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (e) { if (e.code === 'ESRCH' && parentExited) groupEnded = true; return e.code !== 'ESRCH'; }
    };
    const finish = () => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(settleTimer); clearInterval(groupTimer);
      const confirmed = !child?.pid || (parentExited && stdioClosed && !groupAlive());
      if (!confirmed) {
        reason ||= 'termination_unconfirmed';
        error = new Error([error?.message, '프로세스 종료를 확인하지 못했습니다. 남은 프로세스가 있을 수 있어 같은 작업을 안전하게 재개할 수 없습니다.'].filter(Boolean).join(' '));
      }
      // Escaped descendants can retain inherited pipes after the owned process
      // group is gone. Detach our handles after the bounded grace period; never
      // claim their termination or keep the runtime promise waiting for close.
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
      // Decode once so UTF-8 characters split across pipe chunks remain intact.
      const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8');
      atomic(path.join(attemptDir, 'stdout.log'), redact(out));
      atomic(path.join(attemptDir, 'stderr.log'), redact(err));
      const observation = { command, args, cwd, started_at: startedAt, ended_at: now(), code, signal: signal || null,
        error: error?.message || null, reason, bytes, pid: child?.pid || null,
        termination_confirmed: confirmed, parent_exit_observed: parentExited, stdio_closed: stdioClosed,
        termination_grace_ms: terminationGraceMs,
        timeout_ms: limits.timeoutMs, elapsed_ms: Math.round(performance.now() - startedClock), first_stdout_at: firstStdoutAt, first_stdout_ms: firstStdoutMs };
      atomic(path.join(attemptDir, 'process.json'), json(observation));
      resolve({ ok: !reason && !error && code === 0, stdout: out, stderr: err, observation });
    };
    const maybeFinish = () => { if (!finished && parentExited && stdioClosed && !groupAlive()) finish(); };
    const terminate = why => {
      if (finished) return;
      reason ||= why;
      clearTimeout(timer);
      signalGroup('SIGTERM');
      killTimer ||= setTimeout(() => { signalGroup('SIGKILL'); maybeFinish(); }, 500);
      settleTimer ||= setTimeout(finish, terminationGraceMs);
      groupTimer ||= setInterval(maybeFinish, 25);
    };
    cancel = () => terminate('cancelled');
    try {
      child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      child.once('error', failure => {
        if (finished) return;
        error = failure;
        if (!child.pid) finish(); else terminate('process_error');
      });
      child.once('spawn', () => {
        if (finished) return;
        if (reason) { terminate(reason); return; }
        try { onSpawn(child.pid); child.stdin.end(stdin); }
        catch { terminate('spawn_callback_failed'); child.stdin.destroy(); }
      });
      child.stdin.on('error', () => {});
      const collect = (stream, isStdout = false) => chunk => {
        if (finished) return;
        bytes += chunk.length;
        const keep = Math.min(chunk.length, Math.max(0, limits.maxOutputBytes - retained));
        if (keep) { stream.push(chunk.subarray(0, keep)); retained += keep; }
        if (bytes > limits.maxOutputBytes) terminate('output_limit');
        if (isStdout && !reason) {
          if (firstStdoutAt === null) { firstStdoutAt = now(); firstStdoutMs = Math.round(performance.now() - startedClock); }
          try { const violation = onStdout?.(chunk); if (violation) terminate(violation); }
          catch { terminate('worker_observer_failed'); }
        }
      };
      child.stdout.on('data', collect(stdout, true)); child.stderr.on('data', collect(stderr));
      for (const stream of [child.stdout, child.stderr]) stream.on('error', failure => {
        if (finished) return; error = failure; terminate('stream_error');
      });
      child.once('exit', (exitCode, exitSignal) => {
        code = exitCode; signal = exitSignal; parentExited = true;
        groupAlive(); // Never signal this numeric group again after observing its disappearance.
        maybeFinish();
        // A completed parent must not leave us waiting until its (possibly
        // hour-long) task deadline for inherited pipes held by a descendant.
        // Ordinary pipe draining still gets a full cleanup grace and succeeds.
        if (!finished) terminate(null);
      });
      child.once('close', (exitCode, exitSignal) => {
        if (finished) return;
        code = exitCode; signal = exitSignal; stdioClosed = true;
        signalGroup('SIGKILL'); maybeFinish();
        if (!finished) terminate(null);
      });
      timer = setTimeout(() => terminate('timeout'), limits.timeoutMs);
    } catch (e) { error = e; if (child?.pid) terminate('process_error'); else finish(); }
  });
  return { promise, cancel: () => cancel?.() };
}
