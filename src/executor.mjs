import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runProcess } from './process-runner.mjs';
import { ROOT, atomic, assert, json, redact, redactValue } from './shared.mjs';
const versions = new Map();

function errorMessage(value) {
  // Codex may wrap the server's JSON error in another error.message string.
  // Read only known message fields, never stringify the complete response.
  for (let depth = 0; depth < 4; depth += 1) {
    if (value && typeof value === 'object') value = value.error?.message ?? value.message;
    else if (typeof value === 'string') {
      try {
        const nested = JSON.parse(value);
        if (nested && typeof nested === 'object' && (typeof nested.message === 'string' || typeof nested.error?.message === 'string')) {
          value = nested; continue;
        }
        if (nested && typeof nested === 'object') return null;
      } catch { /* Plain error text is already the message. */ }
      return redact(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    } else return null;
  }
  return null;
}

export function commandFor(engine, context) {
  const { cwd, schemaPath, outputPath, stage, execution } = context;
  if (['codex', 'claude'].includes(engine)) {
    assert(execution && typeof execution.model === 'string' && execution.model.trim(), `${engine} 모델 설정이 필요합니다.`);
    assert(typeof execution.effort === 'string' && execution.effort.trim(), `${engine} effort 설정이 필요합니다.`);
  }
  if (engine === 'codex') return {
    command: process.env.HARNESS_CODEX_BIN || 'codex', args: ['exec', '--json', '--model', execution.model,
      '-c', `model_reasoning_effort="${execution.effort}"`, '--dangerously-bypass-approvals-and-sandbox',
      '--output-schema', schemaPath, '-o', outputPath, '-C', cwd, '--skip-git-repo-check', '-']
  };
  if (engine === 'claude') return {
    command: process.env.HARNESS_CLAUDE_BIN || 'claude', args: ['-p', '--model', execution.model, '--effort', execution.effort,
      '--output-format', 'json', '--json-schema', fs.readFileSync(schemaPath, 'utf8'),
      '--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
      '--tools', stage === 'review' ? 'Read' : 'Read,Write,Edit,Bash', '--no-session-persistence']
  };
  assert(engine === 'fixture' && process.env.HARNESS_TEST_MODE === '1', '허용되지 않은 실행 엔진입니다.');
  return { command: process.execPath, args: [path.join(ROOT, 'tests/fixtures/worker.mjs'), outputPath, stage] };
}

export function execute(context) {
  const { engine, cwd, attemptDir, stage, prompt, limits, onSpawn, parent, fixture, execution } = context;
  const outputPath = path.join(attemptDir, 'result.json');
  const schemaPath = path.join(attemptDir, 'schema.json');
  atomic(schemaPath, json(context.schema || JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/task-result.schema.json'), 'utf8'))));
  atomic(path.join(attemptDir, 'prompt.txt'), redact(prompt));
  const { command, args } = commandFor(engine, { ...context, outputPath, schemaPath });
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CODEX_HOME',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
  const env = Object.fromEntries(allowed.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  Object.assign(env, { HARNESS_DATA_DIR: context.dataDir, HARNESS_WORKER: '1', HARNESS_PARENT: json(parent),
    HARNESS_ATTEMPT_ID: parent.task_id, HARNESS_ENGINE: engine, HARNESS_STAGE: stage,
    HARNESS_TEST_MODE: process.env.HARNESS_TEST_MODE || '' });
  if (!versions.has(command)) {
    // Version probes belong to the same headless worker and inherit its hook guard.
    const check = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 2500, env });
    versions.set(command, check.status === 0 ? check.stdout.trim().slice(0, 200) : 'unavailable');
  }
  if (engine === 'fixture') {
    // Source snapshots can exceed the OS argv/environment limit. Fixture workers
    // receive a private file; real CLIs receive their task exclusively on stdin.
    env.HARNESS_FIXTURE_FILE = path.join(attemptDir, 'fixture-input.json');
    atomic(env.HARNESS_FIXTURE_FILE, json(fixture || {}));
  }
  const processRun = runProcess({ command, args, cwd, env, stdin: prompt, attemptDir, limits, onSpawn });
  const promise = processRun.promise.then(({ ok, stdout, observation: observed }) => {
    let nativeSession = null, usage = null, terminalFailure = null, streamError = null;
    if (engine === 'codex') {
      for (const line of stdout.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') nativeSession = event.thread_id;
          if (event.type === 'turn.completed') { terminalFailure = null; streamError = null; if (event.usage) usage = event.usage; }
          if (event.type === 'turn.failed') terminalFailure = errorMessage(event.error) || 'Codex 작업이 실패했습니다 (turn.failed).';
          // Item-level error messages are advisory. A top-level error only
          // supplies failure detail when the process itself did not succeed.
          if (event.type === 'error') streamError = errorMessage(event);
        } catch { /* Only recognized protocol events carry metadata. */ }
      }
    } else if (engine === 'claude') {
      try { const outer = JSON.parse(stdout); nativeSession = outer.session_id || null; usage = outer.usage || null; } catch {}
    }
    const failure = terminalFailure || (!ok && streamError);
    const observation = { ...observed, ...(failure ? { reason: observed.reason || 'engine_failure', error: failure } : {}),
      engine, model: execution?.model || null, effort: execution?.effort || null,
      permission_mode: ['codex', 'claude'].includes(engine) ? 'bypass' : null,
      cli_version: versions.get(command), native_session_id: nativeSession, usage };
    atomic(path.join(attemptDir, 'process.json'), json(observation));
    if (!ok || terminalFailure) return { ok: false, observation };
    try {
      let result;
      if (engine === 'claude') {
        const outer = JSON.parse(stdout);
        assert(!outer.is_error && outer.structured_output, 'Claude의 구조화 결과가 없습니다.');
        result = outer.structured_output;
      } else {
        assert(fs.statSync(outputPath).size <= 1024 * 1024, '결과 파일이 너무 큽니다.');
        result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      }
      result = redactValue(result); atomic(outputPath, json(result));
      return { ok: true, result, observation };
    } catch (e) {
      const failed = { ...observation, reason: 'protocol_failure', error: e.message };
      atomic(path.join(attemptDir, 'process.json'), json(failed));
      return { ok: false, observation: failed };
    }
  });
  return { promise, cancel: processRun.cancel };
}

function exactKeys(object, keys) {
  assert(object && typeof object === 'object' && !Array.isArray(object), '결과는 객체여야 합니다.');
  assert(Object.keys(object).length === keys.length && keys.every(k => Object.hasOwn(object, k)), `결과 필드는 ${keys.join(', ')}여야 합니다.`);
}
export function validateResult(value, stage, job) {
  exactKeys(value, ['status', 'result']);
  assert(['done', 'revise', 'blocked', 'failed'].includes(value.status), '알 수 없는 작업 상태입니다.');
  if (['blocked', 'failed'].includes(value.status)) {
    exactKeys(value.result, ['message']); assert(typeof value.result.message === 'string' && value.result.message.length > 0, '사유가 필요합니다.'); return value;
  }
  if (value.status === 'revise') {
    assert(stage === 'review', '검토 작업만 수정을 요구할 수 있습니다.');
    exactKeys(value.result, ['issues']); assert(Array.isArray(value.result.issues) && value.result.issues.length, '수정 지적이 필요합니다.');
    for (const issue of value.result.issues) {
      exactKeys(issue, ['rule', 'detail']); assert(job.rules.includes(issue.rule) && typeof issue.detail === 'string' && issue.detail.length > 0, '등록된 규칙과 수정 근거가 필요합니다.');
    }
  } else if (stage === 'review') {
    exactKeys(value.result, ['evaluations']); assert(Array.isArray(value.result.evaluations), '검토 근거가 필요합니다.');
    const evaluated = new Set();
    for (const evaluation of value.result.evaluations) {
      exactKeys(evaluation, ['rule', 'passed', 'evidence']);
      assert(job.rules.includes(evaluation.rule) && !evaluated.has(evaluation.rule) && evaluation.passed === true && typeof evaluation.evidence === 'string' && evaluation.evidence.trim(), '통과 판정과 규칙별 근거가 필요합니다.');
      evaluated.add(evaluation.rule);
    }
    assert(job.rules.every(r => evaluated.has(r)), '필수 검토 규칙이 누락되었습니다.');
  } else {
    exactKeys(value.result, ['file']); assert(typeof value.result.file === 'string' && value.result.file === job.file, '등록된 산출물 경로가 필요합니다.');
  }
  return value;
}
