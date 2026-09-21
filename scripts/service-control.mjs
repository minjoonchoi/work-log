import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assert, alive, json, request } from '../src/shared.mjs';
import { canonical, locked, matches, readManifest, safePath, saveManifest, stat } from './install-state.mjs';

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const options = { encoding: 'utf8', timeout: 15000 };
export const missingService = result => result.status !== 0 && /could not find (?:specified )?service|service not found/i.test(result.stderr || '');
function ownedService(result, file) {
  assert(result.status === 0, `서비스 조회 실패: ${result.stderr || result.error?.message || result.status}`);
  const program = result.stdout?.match(/(?:^|\n)\s*program = (.+)/)?.[1]?.trim();
  const args = result.stdout?.match(/(?:^|\n)\s*arguments = \{\s*\n([\s\S]*?)\n\s*\}/)?.[1]?.split('\n').map(s => s.trim()).filter(Boolean);
  assert(program === file.argv[0] && canonical(args) === canonical(file.argv), '같은 이름의 다른 서비스가 있어 종료하지 않았습니다.');
}
function waitUntil(check, timeoutMs, message) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    assert(performance.now() < deadline, message);
    pause(Math.min(100, Math.max(1, deadline - performance.now())));
  }
}

// bootout can return before launchd removes the service and its process exits.
// Keep ownership checks throughout the bounded wait; never force-kill by name.
export function stopOwnedServices(loc, receipt, { launchctl = spawnSync, deactivate = true,
  includeGUI = true, roles, timeoutMs = 10000 } = {}) {
  const preserved = [], files = receipt.files.filter(f => (includeGUI || f.label !== 'local.worklog.gui')
    && (!roles || roles.includes(f.label.split('.').at(-1))));
  if (!deactivate) assert(files.every(f => f.activation === 'not_started'), '활성화한 서비스의 종료 확인을 생략할 수 없습니다.');
  for (const file of [...files].reverse()) {
    if (file.activation === 'not_started') continue;
    try {
      safePath(loc.home, file.path);
      assert(!stat(file.path) || matches(file.path, { ...file, kind: 'file' }), '서비스 설정이 변경되어 실행 중인 서비스 소유를 확인할 수 없습니다.');
      const target = `gui/${process.getuid()}/${file.label}`;
      const current = launchctl('launchctl', ['print', target], options);
      let pid;
      if (!missingService(current)) {
        ownedService(current, file);
        pid = Number(current.stdout.match(/(?:^|\n)\s*pid = (\d+)/)?.[1]);
        const stopped = launchctl('launchctl', ['bootout', target], options);
        assert(stopped.status === 0 || missingService(launchctl('launchctl', ['print', target], options)),
          `서비스 종료 실패: ${stopped.stderr || stopped.error?.message || stopped.status}`);
        waitUntil(() => {
          const next = launchctl('launchctl', ['print', target], options);
          if (missingService(next)) return true;
          ownedService(next, file); return false;
        }, timeoutMs, '서비스 종료 대기 시간이 초과되었습니다. 설치 파일은 보존합니다.');
      }
      if (Number.isSafeInteger(pid) && pid > 1) waitUntil(() => !alive(pid), timeoutMs, '서비스 프로세스 종료 대기 시간이 초과되었습니다.');
      file.activation = 'stopped'; saveManifest(loc, receipt);
    } catch (error) { preserved.push({ path: file.path, reason: error.message }); }
  }
  for (const role of ['runtime', 'manager']) {
    if (roles && !roles.includes(role)) continue;
    const file = path.join(loc.data, `${role}.lock`);
    try {
      safePath(loc.home, file);
      if (stat(file)) {
        const { pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert(Number.isSafeInteger(pid) && pid > 1, '서비스 프로세스 식별자를 확인하지 못했습니다.');
        // Test/development services not activated by this installation are not ours to stop.
        if (!deactivate) assert(!alive(pid), '프로세스 종료가 아직 확인되지 않았습니다. 종료 후 다시 제거하세요.');
        else waitUntil(() => !alive(pid), timeoutMs, '프로세스 종료가 아직 확인되지 않았습니다. 종료 후 다시 제거하세요.');
      }
    } catch (error) { preserved.push({ path: file, reason: error.message }); }
  }
  return preserved;
}

export async function controlServices(action, { homeDir = os.homedir(), appPath, dataDir,
  launchctl = spawnSync, timeoutMs = 10000, runtimeRequest = request } = {}) {
  assert(['start', 'stop'].includes(action), '서비스 동작은 start 또는 stop이어야 합니다.');
  return locked(homeDir, async loc => {
    assert(path.resolve(appPath || '') === loc.app && path.resolve(dataDir || '') === loc.data, '설치된 WorkLog 앱과 데이터 경로가 일치하지 않습니다.');
    const receipt = readManifest(loc);
    assert(receipt?.state === 'installed', '완료된 WorkLog 설치 기록이 필요합니다.');
    if (action === 'stop') {
      const preserved = stopOwnedServices(loc, receipt, { launchctl, roles: ['manager'], timeoutMs });
      if (preserved.length) return { status: 'needs_attention', preserved };
      const runtime = receipt.files.find(f => f.label === 'local.worklog.runtime');
      safePath(loc.home, runtime.path);
      assert(matches(runtime.path, { ...runtime, kind: 'file' }), '실행 서비스 설정이 변경되어 종료하지 않았습니다.');
      const current = launchctl('launchctl', ['print', `gui/${process.getuid()}/${runtime.label}`], options);
      if (!missingService(current)) {
        ownedService(current, runtime);
        if (/(?:^|\n)\s*pid = \d+/.test(current.stdout)) {
          const result = await runtimeRequest(loc.data, 'runtime', '/lifecycle/quit', { method: 'POST', body: {} });
          assert(result.status === 'draining' && Number.isSafeInteger(result.remaining_user_runs) && result.remaining_user_runs >= 0, '실행 서비스 종료 상태를 확인하지 못했습니다.');
          if (result.remaining_user_runs > 0) return { status: 'user_work_continues', remaining_user_runs: result.remaining_user_runs, preserved: [] };
        }
      }
      preserved.push(...stopOwnedServices(loc, receipt, { launchctl, roles: ['runtime'], timeoutMs }));
      return { status: preserved.length ? 'needs_attention' : 'stopped', preserved };
    }
    for (const file of receipt.files.filter(f => f.label !== 'local.worklog.gui')) {
      safePath(loc.home, file.path);
      assert(matches(file.path, { ...file, kind: 'file' }), '서비스 설정이 변경되어 시작하지 않았습니다.');
      const target = `gui/${process.getuid()}/${file.label}`;
      const current = launchctl('launchctl', ['print', target], options);
      if (missingService(current)) {
        file.activation = 'starting'; saveManifest(loc, receipt);
        const started = launchctl('launchctl', ['bootstrap', `gui/${process.getuid()}`, file.path], options);
        assert(started.status === 0, `서비스 시작 실패: ${started.stderr || started.error?.message || started.status}`);
      } else {
        ownedService(current, file);
        if (!/(?:^|\n)\s*pid = \d+/.test(current.stdout)) {
          const kicked = launchctl('launchctl', ['kickstart', target], options);
          assert(kicked.status === 0, `서비스 재시작 실패: ${kicked.stderr || kicked.error?.message || kicked.status}`);
        }
      }
      file.activation = 'registered'; saveManifest(loc, receipt);
      if (file.label === 'local.worklog.runtime') {
        const deadline = performance.now() + timeoutMs;
        while (true) {
          try {
            const result = await runtimeRequest(loc.data, 'runtime', '/lifecycle/start', { method: 'POST', body: {} });
            assert(result.status === 'running', '실행 서비스 시작 상태를 확인하지 못했습니다.'); break;
          } catch (error) {
            if (performance.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
            // A draining runtime may exit between the first PID observation and
            // /lifecycle/start. Reconcile launchd again instead of polling a dead port.
            const latest = launchctl('launchctl', ['print', target], options);
            if (missingService(latest)) {
              const started = launchctl('launchctl', ['bootstrap', `gui/${process.getuid()}`, file.path], options);
              assert(started.status === 0, `서비스 시작 실패: ${started.stderr || started.error?.message || started.status}`);
            } else {
              ownedService(latest, file);
              if (!/(?:^|\n)\s*pid = \d+/.test(latest.stdout)) {
                const kicked = launchctl('launchctl', ['kickstart', target], options);
                assert(kicked.status === 0, `서비스 재시작 실패: ${kicked.stderr || kicked.error?.message || kicked.status}`);
              }
            }
          }
        }
      }
    }
    return { status: 'started' };
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      'home-dir': { type: 'string' }, 'app-path': { type: 'string' }, 'data-root': { type: 'string' }
    } });
    const result = await controlServices(positionals[0], { homeDir: values['home-dir'], appPath: values['app-path'], dataDir: values['data-root'] });
    console.log(json(result)); if (result.status === 'needs_attention') process.exitCode = 2;
  } catch (error) { console.log(json({ error: error.message })); process.exitCode = 1; }
}
