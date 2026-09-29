#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, dataRoot, initRoot, request, json, sleep } from '../src/shared.mjs';
import { attachAgentOrigin, inspectAgentContext } from '../src/agent-origin.mjs';
import { queryHelp, queryResources, validateQuery } from '../src/data-query.mjs';

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
    throw new Error('하네스 작업 위임은 제거되었습니다. WorkLog는 세션 이력 수집·정리만 지원합니다.');
  } else if (command === 'query') {
    if (!args.length || (args.length === 1 && ['--help', 'help'].includes(args[0]))) result = queryHelp;
    else {
      const resource = args.shift(), allowed = queryResources[resource];
      if (!Array.isArray(allowed)) throw new Error('지원하지 않는 조회 대상입니다. harness query --help를 확인하세요.');
      const params = new URLSearchParams({ resource });
      if (allowed.includes('id') && args[0] && !args[0].startsWith('--')) params.set('id', args.shift());
      for (const key of allowed.filter(key => key !== 'id')) {
        const value = option(`--${key}`); if (value !== undefined) params.set(key, value);
      }
      if (args.length) throw new Error('지원하지 않거나 중복된 조회 인자입니다. harness query --help를 확인하세요.');
      validateQuery(params);
      result = await request(dir, 'manager', `/api/query?${params}`);
    }
  } else if (command === 'context') {
    const engine = option('--engine') || 'codex', session = option('--session');
    if (args.length) throw new Error('context는 --engine codex|claude와 실제 --session ID만 받습니다.');
    if (process.env.HARNESS_WORKER === '1') throw new Error('worker에서 사용자 업무 연결을 조회하지 않습니다.');
    result = { status: 'ready', ...await inspectAgentContext(dir, { engine, session_id: session || (engine === 'codex' ? process.env.CODEX_THREAD_ID : undefined) }) };
  } else if (command === 'catalog') {
    throw new Error('직무 작업 카탈로그는 제거되었습니다. 자동 작성 설정은 앱에서 확인하세요.');
  } else if (['status', 'cancel', 'resume', 'result', 'evidence'].includes(command)) {
    const wait = flag('--wait'), runId = args[0], isPlan = String(runId || '').startsWith('plan-');
    if (!runId && command !== 'status') throw new Error(`${command}에는 run ID 또는 plan ID가 필요합니다.`);
    if (wait && !runId) throw new Error('--wait에는 run ID 또는 plan ID가 필요합니다.');
    if (command === 'resume' && args.length > 1) throw new Error('resume은 추가 입력을 받지 않고 원래 입력으로 재개합니다. 사용자 답변은 수정한 작업 입력에 포함해 새 요청으로 제출하세요.');
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
    result = { usage: ['worklog query --help', 'worklog query <items|item|sessions|session|history|runs|run|reports|report|tags> [id] [options]',
      'worklog status [run-id]', 'worklog result run-id', 'worklog doctor'],
      note: 'WorkLog는 로컬 세션 이력을 수집하고 요약합니다. 자동 작성과 연동 설정은 앱에서 관리합니다.' };
  }
  if (result) console.log(json(result));
} catch (e) { console.error(json({ error: e.message, ...(command === 'query' && e.status ? { status: e.status } : {}), ...(typeof e.code === 'string' && e.code.startsWith('agent_') ? { code: e.code, retryable: e.retryable } : {}) })); process.exitCode = 1; }
