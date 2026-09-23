#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, dataRoot, initRoot, request, json, sleep } from '../src/shared.mjs';
import { attachAgentOrigin } from '../src/agent-origin.mjs';

const args = process.argv.slice(2), command = args.shift(), dir = dataRoot();
function option(name) {
  const i = args.indexOf(name); if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 값이 필요합니다.`);
  args.splice(i, 2); return value;
}
function flag(name) { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; }
const stages = { plan: '계획', produce: '작성', verify: '검증', review: '검토', repair: '수정', render: '전달', pending: '대기' };
const statuses = { completed: '완료', blocked: '확인 필요', failed: '실패', cancelled: '취소', interrupted: '중단' };
const active = value => ['pending', 'ready', 'running'].includes(value.status);
const planResult = value => String(value.id || '').startsWith('plan-');
const terse = value => String(value || '').replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim().slice(0, 100);
function progress(value) {
  if (!planResult(value)) return `${stages[value.stage] || terse(value.stage) || '대기'}${value.round > 0 ? ` · 수정 ${value.round}회` : ''}`;
  const p = value.progress || {};
  const working = (value.steps || []).filter(s => ['running', 'ready'].includes(s.status)).slice(0, 3)
    .map(s => `${terse(s.label || s.task)}(${stages[s.stage] || terse(s.stage) || '진행'})`);
  return `완료 ${p.completed || 0}/${p.total ?? value.steps?.length ?? 0} · 진행 ${p.running || 0} · 대기 ${p.pending || 0}`
    + (p.blocked ? ` · 확인 필요 ${p.blocked}` : '') + (p.failed ? ` · 실패 ${p.failed}` : '')
    + (p.cancelled ? ` · 취소 ${p.cancelled}` : '') + (p.interrupted ? ` · 중단 ${p.interrupted}` : '')
    + (working.length ? ` · ${working.join(', ')}` : '');
}
function notify(value, event) {
  console.error(`[work] ${event} · ${progress(value)}${event === '시작' ? ` · ${value.id}` : ''}`);
}
async function waitFor(value, { announce = true } = {}) {
  if (announce) notify(value, '시작');
  let previous = progress(value), lastNotice = Date.now();
  while (active(value)) {
    await sleep(500);
    value = await request(dir, 'runtime', `/${planResult(value) ? 'plans' : 'runs'}/${encodeURIComponent(value.id)}`);
    const current = progress(value), elapsed = Date.now() - lastNotice;
    if (active(value) && ((current !== previous && elapsed >= 1500) || elapsed >= 30000)) {
      notify(value, '진행'); previous = current; lastNotice = Date.now();
    }
  }
  notify(value, statuses[value.status] || terse(value.status));
  if (value.status !== 'completed') process.exitCode = value.status === 'blocked' ? 2 : 1;
  return value;
}
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
  } else if (command === 'run' || command === 'orchestrate') {
    const wait = flag('--wait');
    const task = option('--task'), engine = option('--engine'), item = option('--item'), inputPath = option('--input');
    if (process.env.HARNESS_WORKER === '1') throw new Error('worker에서 하네스의 재귀 실행은 허용되지 않습니다.');
    if (command === 'orchestrate' && (!inputPath || task || args.length)) throw new Error('orchestrate는 prompt와 steps를 담은 --input JSON 파일이 필요합니다.');
    const payload = inputPath ? JSON.parse(fs.readFileSync(inputPath, 'utf8')) : { prompt: args.join(' ') };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('요청은 JSON 객체여야 합니다.');
    if (task) payload.task = task;
    if (engine) payload.engine = engine;
    if (item) payload.work_item_id = item;
    // The calling agent's project directory is distinct from the background
    // service and each worker's isolated temporary directory.
    payload.workspace ??= fs.realpathSync(process.cwd());
    const linkedPayload = await attachAgentOrigin(dir, payload);
    result = await request(dir, 'runtime', command === 'orchestrate' ? '/plans' : '/runs', { method: 'POST', body: linkedPayload });
    if (wait) result = await waitFor(result);
    else notify(result, '시작');
  } else if (command === 'catalog') {
    const summary = flag('--summary'), task = option('--task');
    if (args.length || (summary && task)) throw new Error('catalog는 --summary 또는 --task <업무 ID> 중 하나만 지정하세요.');
    result = await request(dir, 'runtime', '/catalog');
    if (task) {
      result = result.jobs.find(job => job.id === task);
      if (!result) throw new Error(`지원하지 않는 업무입니다: ${task}`);
    } else if (summary) {
      result = { version: result.version, jobs: result.jobs.map(({ id, label, category, kind, internal, boundary, routing, review_policy, source, template_id, description }) => ({
        id, label, category, kind, internal, review_policy, source, template_id, description,
        ...(boundary ? { boundary: { owns: boundary.owns, excludes: boundary.excludes, deliverable: boundary.deliverable } } : {}),
        routing
      })) };
    }
  } else if (['status', 'cancel', 'resume', 'result', 'evidence'].includes(command)) {
    const wait = flag('--wait'), runId = args[0], isPlan = String(runId || '').startsWith('plan-');
    if (!runId && command !== 'status') throw new Error(`${command}에는 run ID 또는 plan ID가 필요합니다.`);
    if (wait && !runId) throw new Error('--wait에는 run ID 또는 plan ID가 필요합니다.');
    if (args.length > 1 || (wait && !['status', 'resume'].includes(command))) throw new Error('지원하지 않는 명령 인자입니다.');
    if (isPlan && command === 'evidence') throw new Error('계획의 steps에 있는 run_id로 evidence를 조회하세요.');
    if (process.env.HARNESS_WORKER === '1' && ['resume', 'cancel'].includes(command)) throw new Error('worker에서 다른 작업의 실행을 제어할 수 없습니다.');
    result = await request(dir, 'runtime', runId ? `/${isPlan ? 'plans' : 'runs'}/${encodeURIComponent(runId)}${['cancel', 'resume', 'evidence'].includes(command) ? `/${command}` : ''}` : '/runs',
      ['cancel', 'resume'].includes(command) ? { method: 'POST', body: {} } : {});
    if (wait && runId) result = await waitFor(result, { announce: command === 'resume' });
    if (command === 'result') result = isPlan
      ? { id: result.id, status: result.status, progress: result.progress, artifacts: result.artifacts, steps: result.steps, message: result.message }
      : { status: result.status, artifact: result.artifact, evidence: result.evidence, message: result.message };
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
    result = { usage: ['harness start', 'harness run --input request.json --wait [--engine codex|claude]',
      'harness orchestrate --input plan.json --wait [--engine codex|claude]', 'harness status [run-id|plan-id] [--wait]',
      'harness cancel|result run-id|plan-id', 'harness resume run-id|plan-id [--wait]', 'harness evidence run-id',
      'harness catalog [--summary|--task task-id]', 'harness doctor', 'harness install-plan [--output directory]'],
      note: 'work 스킬이 사용자 요청을 등록 업무의 구조화된 계획으로 분할합니다. 서비스가 실행 순서와 검토·수정을 관리하며 stdout에는 최종 JSON, stderr에는 간단한 진행 상태를 출력합니다.' };
  }
  if (result) console.log(json(result));
} catch (e) { console.error(json({ error: e.message })); process.exitCode = 1; }
