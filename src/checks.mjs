import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assert, atomic, digest, json, now } from './shared.mjs';
import { runProcess } from './process-runner.mjs';

export function sourceSnapshot(watch) {
  const files = [];
  const visit = relative => {
    const file = path.resolve(ROOT, relative);
    assert(file.startsWith(ROOT + path.sep), '검사 대상은 하네스 디렉터리 안이어야 합니다.');
    if (!fs.existsSync(file)) { files.push({ path: relative, digest: null }); return; }
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), '검사 대상에 심볼릭 링크가 있습니다.');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).filter(n => n !== '.DS_Store').sort()) visit(path.join(relative, name));
    } else {
      assert(stat.isFile() && stat.size <= 16 * 1024 * 1024 && files.length < 5000, '검사 대상 크기 제한을 초과했습니다.');
      files.push({ path: relative, digest: digest(fs.readFileSync(file)) });
    }
  };
  watch.forEach(visit);
  return { digest: digest(json(files)), files };
}

export function initialEvidence(row, profile, profileId) {
  return { run_id: row.id, epoch: row.epoch, profile: profileId, profile_digest: digest(json(profile)),
    validation_scope: profile.validation_scope, target_root: ROOT, before: null, after: null, overall: 'incomplete',
    checks: profile.checks.map(check => ({ id: check.id, label: check.label, status: 'not_run', started_at: null, ended_at: null, observation: null, logs: null })) };
}

export function saveEvidence(db, dir, data) {
  const bytes = json(data), contentDigest = digest(bytes);
  const file = path.join(dir, 'runs', data.run_id, 'evidence', `${data.epoch}-${contentDigest}.json`);
  atomic(file, bytes);
  db.prepare('INSERT INTO check_evidence(run_id,epoch,file,content_digest) VALUES(?,?,?,?) ON CONFLICT(run_id,epoch) DO UPDATE SET file=excluded.file,content_digest=excluded.content_digest')
    .run(data.run_id, data.epoch, file, contentDigest);
  return { file, content_digest: contentDigest, epoch: data.epoch };
}

export function readEvidence(db, dir, row) {
  const ref = db.prepare('SELECT file,content_digest,epoch FROM check_evidence WHERE run_id=? AND epoch=?').get(row.id, row.epoch);
  assert(ref, '검사 실행 근거가 없습니다.');
  const root = fs.realpathSync(path.join(dir, 'runs', row.id, 'evidence')) + path.sep;
  assert(!fs.lstatSync(ref.file).isSymbolicLink() && fs.realpathSync(ref.file).startsWith(root), '검사 근거 경로가 잘못되었습니다.');
  const bytes = fs.readFileSync(ref.file); assert(digest(bytes) === ref.content_digest, '검사 근거 해시가 다릅니다.');
  const data = JSON.parse(bytes);
  assert(data.run_id === row.id && data.epoch === row.epoch, '검사 시도와 근거가 다릅니다.');
  return { ...ref, data };
}

function observationLogs(directory) {
  return Object.fromEntries(['stdout.log', 'stderr.log', 'process.json'].map(name => {
    const file = path.join(directory, name); return [name, { file, content_digest: digest(fs.readFileSync(file)) }];
  }));
}

export function checkEvidenceIntegrity(data) {
  for (const check of data.checks) for (const log of Object.values(check.logs || {})) {
    assert(fs.lstatSync(log.file).isFile() && !fs.lstatSync(log.file).isSymbolicLink() && digest(fs.readFileSync(log.file)) === log.content_digest, '검사 로그 해시가 다릅니다.');
  }
}

export async function executeChecks({ profile, evidence, limits, createAttempt, endAttempt, setProcess, current, save }) {
  try {
    evidence.before = sourceSnapshot(profile.watch); save(evidence);
    const commands = profile.checks.map(check => {
      for (const file of check.requires || []) assert(fs.existsSync(path.join(ROOT, file)), `검사에 필요한 파일이 없습니다: ${file}`);
      let args = [...check.args];
      if (check.test_directory) {
        const directory = path.join(ROOT, check.test_directory);
        assert(fs.existsSync(directory), `검사 소스가 없는 배포 패키지입니다: ${check.test_directory}`);
        const files = fs.readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort();
        assert(files.length, '실행할 E2E 테스트가 없습니다.');
        args.push(...files.map(name => path.join(check.test_directory, name)));
      }
      return { command: process.execPath, args };
    });
    for (let i = 0; i < profile.checks.length && current(); i++) {
      const check = profile.checks[i], result = evidence.checks[i];
      const { id, directory, onSpawn } = createAttempt(check.id);
      result.started_at = now(); result.status = 'running'; result.attempt_id = id; save(evidence);
      const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'HARNESS_BROWSER'];
      const env = Object.fromEntries(allowed.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
      // Do not forward model API keys or live-model opt-in flags to registered tests.
      Object.assign(env, { CI: '1', HARNESS_CHECK_ACTIVE: '1', HARNESS_CHECK_ATTEMPT_DIR: directory });
      const processRun = runProcess({ ...commands[i], cwd: ROOT, env, attemptDir: directory,
        limits: { ...limits, timeoutMs: Math.min(check.timeoutMs || limits.checkTimeoutMs || limits.timeoutMs, limits.checkTimeoutMs || limits.timeoutMs) }, onSpawn });
      setProcess(processRun);
      const observed = await processRun.promise;
      result.observation = observed.observation; result.ended_at = observed.observation.ended_at;
      result.status = !current() ? 'interrupted' : observed.ok ? 'passed' : 'failed';
      result.logs = observationLogs(directory);
      endAttempt(id, observed); save(evidence);
      if (observed.observation.termination_confirmed === false) {
        evidence.message = `${check.id} 검사의 프로세스 트리 종료를 확인하지 못해 후행 검사를 시작하지 않았습니다. 남은 프로세스를 확인하기 전에는 같은 실행을 재개할 수 없습니다.`;
        save(evidence); break;
      }
      // Keep collecting independent required checks after a test failure. Never repair code here.
    }
    evidence.after = sourceSnapshot(profile.watch);
    evidence.overall = evidence.before.digest !== evidence.after.digest ? 'source_changed'
      : evidence.checks.some(c => c.status === 'failed') ? 'failed'
      : evidence.checks.every(c => c.status === 'passed') ? 'passed' : 'incomplete';
    save(evidence);
    return { status: evidence.overall === 'passed' ? 'completed' : evidence.overall === 'source_changed' ? 'blocked' : 'failed',
      message: evidence.message || (evidence.overall === 'passed' ? '등록된 검사를 모두 통과했습니다. 실모델 검증 여부는 프로필 범위를 확인하세요.'
        : evidence.overall === 'source_changed' ? '검사 중 대상 소스가 변경되어 결과를 재사용할 수 없습니다.' : '실패 또는 미실행 검사가 있습니다. 실행 근거를 확인하세요.') };
  } catch (e) {
    evidence.overall = 'incomplete'; evidence.message = e.message; save(evidence);
    return { status: 'blocked', message: e.message };
  }
}

const escape = value => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
export function renderEvidenceReport(sources, capturedAt) {
  const lines = ['# 검증 보고서', '', `근거 고정 시각: ${capturedAt}`, '',
    '이 보고서는 저장된 실행 근거를 정해진 형식으로 옮긴 결과입니다. 보고서 생성 완료가 대상 검사의 통과를 뜻하지 않습니다.', ''];
  for (const source of sources) {
    const data = source.data;
    lines.push(`## ${escape(data.profile)} · ${escape(data.run_id)}`, '',
      `실행 상태: **${source.run_status}** · 검사 판정: **${data.overall}** · 근거 고정 시점 소스 일치: **${source.source_current ? 'yes' : 'no / unknown'}**`, '',
      `검증 범위: ${data.validation_scope}`, '',
      `실행 시도: ${data.epoch} · 근거 SHA-256: \`${source.content_digest}\``, '',
      `대상 지문: \`${data.before?.digest || '관찰하지 않음'}\` → \`${data.after?.digest || '관찰하지 않음'}\``, '',
      '| 검사 | 상태 | 시작 | 종료 | 종료 코드 | 사유 |', '|---|---|---|---|---|---|');
    for (const check of data.checks) lines.push(`| ${escape(check.label)} | ${check.status} | ${escape(check.started_at)} | ${escape(check.ended_at)} | ${escape(check.observation?.code)} | ${escape(check.observation?.reason || check.observation?.error)} |`);
    lines.push('');
    for (const check of data.checks) if (check.observation) {
      lines.push(`### ${escape(check.id)} 실행 근거`, '', `명령과 인자: \`${escape(json([check.observation.command, ...check.observation.args]))}\``, '', `작업 위치: \`${escape(check.observation.cwd)}\``, '');
      for (const [name, ref] of Object.entries(check.logs || {})) lines.push(`- ${name}: ${ref.file} · SHA-256 \`${ref.content_digest}\``);
      lines.push('');
    }
    if (data.message) lines.push(`확인 필요: ${data.message}`, '');
  }
  lines.push('시나리오 설계 문서는 검사 실행 근거가 아닙니다. 실패 원인 판단·코드 수정·실모델 호출은 이 업무에서 자동 실행하지 않습니다.', '');
  return lines.join('\n');
}
