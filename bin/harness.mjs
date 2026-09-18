#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, dataRoot, initRoot, request, json, sleep, readEndpoint } from '../src/shared.mjs';

const args = process.argv.slice(2), command = args.shift(), dir = dataRoot();
function option(name) { const i = args.indexOf(name); if (i < 0) return undefined; const value = args[i + 1]; args.splice(i, 2); return value; }
try {
  let result;
  if (command === 'serve') {
    if (!['runtime', 'manager'].includes(args[0])) throw new Error('serve runtime|manager');
    await import(`../src/${args[0]}.mjs`);
  } else if (command === 'start') {
    initRoot(dir);
    for (const role of ['runtime', 'manager']) {
      try { await request(dir, role, role === 'manager' ? '/api/health' : '/health'); continue; } catch {}
      const log = fs.openSync(path.join(dir, `${role}.log`), 'a', 0o600);
      const child = spawn(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), 'serve', role], { detached: true, stdio: ['ignore', log, log], env: process.env });
      child.unref(); fs.closeSync(log);
      let ready = false;
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        try { await request(dir, role, role === 'manager' ? '/api/health' : '/health'); ready = true; break; } catch {}
      }
      if (!ready) throw new Error(`${role} 시작 실패. ${dir}/${role}.log를 확인하세요.`);
    }
    result = { running: true, data_root: dir };
  } else if (command === 'run') {
    const waitIndex = args.indexOf('--wait'), wait = waitIndex >= 0; if (wait) args.splice(waitIndex, 1);
    const task = option('--task'), engine = option('--engine'), item = option('--item'), inputPath = option('--input');
    const payload = inputPath ? JSON.parse(fs.readFileSync(inputPath, 'utf8')) : { prompt: args.join(' '), task, engine, work_item_id: item };
    if (process.env.HARNESS_WORKER === '1') throw new Error('worker에서 하네스의 재귀 실행은 허용되지 않습니다.');
    result = await request(dir, 'runtime', '/runs', { method: 'POST', body: payload });
    if (wait) {
      let previous = '';
      while (['pending', 'running'].includes(result.status)) {
        const status = `${result.status}:${result.stage || 'pending'}:${result.round}`;
        if (status !== previous) { console.error(json({ status: result.status, stage: result.stage, round: result.round })); previous = status; }
        await sleep(500); result = await request(dir, 'runtime', `/runs/${result.id}`);
      }
      if (result.status !== 'completed') process.exitCode = result.status === 'blocked' ? 2 : 1;
    }
  } else if (command === 'catalog') {
    result = await request(dir, 'runtime', '/catalog');
  } else if (['status', 'cancel', 'resume', 'result', 'evidence'].includes(command)) {
    const runId = args[0];
    result = await request(dir, 'runtime', runId ? `/runs/${runId}${['cancel', 'resume', 'evidence'].includes(command) ? `/${command}` : ''}` : '/runs',
      ['cancel', 'resume'].includes(command) ? { method: 'POST', body: {} } : {});
    if (command === 'result') result = { status: result.status, artifact: result.artifact, evidence: result.evidence, message: result.message };
  } else if (command === 'doctor') {
    const check = binary => { const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 }); return { available: r.status === 0, version: (r.stdout || '').trim(), error: r.error?.code || null }; };
    result = { node: process.version, data_root: dir, codex: check(process.env.HARNESS_CODEX_BIN || 'codex'),
      claude: check(process.env.HARNESS_CLAUDE_BIN || 'claude'),
      browser: fs.existsSync(process.env.HARNESS_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), services: {} };
    for (const role of ['runtime', 'manager']) {
      try { result.services[role] = await request(dir, role, role === 'manager' ? '/api/health' : '/health'); }
      catch (e) { result.services[role] = { connected: false, error: e.message }; }
    }
  } else if (command === 'install-plan') {
    const { prepareInstall } = await import('../scripts/install.mjs'); result = prepareInstall({ output: option('--output') || path.join(ROOT, 'dist/install-plan') });
  } else {
    result = { usage: ['harness start', 'harness run "요구사항으로 PRD 작성" --wait [--engine codex|claude]', 'harness status [run-id]',
      'harness cancel|resume|result|evidence run-id', 'harness catalog', 'harness doctor', 'harness install-plan [--output directory]'],
      note: 'GUI는 관리 전용입니다. 요청은 CLI 또는 에이전트 세션에서 실행 서비스로 전달합니다.' };
  }
  if (result) console.log(json(result));
} catch (e) { console.error(json({ error: e.message })); process.exitCode = 1; }
