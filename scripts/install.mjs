import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, atomic, assert, json, digest } from '../src/shared.mjs';

const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = object => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(object).map(([k, v]) => `<key>${xml(k)}</key>${typeof v === 'boolean' ? `<${v}/>` : Array.isArray(v) ? `<array>${v.map(s => `<string>${xml(s)}</string>`).join('')}</array>` : typeof v === 'object' ? `<dict>${Object.entries(v).map(([a, b]) => `<key>${xml(a)}</key><string>${xml(b)}</string>`).join('')}</dict>` : `<string>${xml(v)}</string>`}`).join('')}</dict></plist>`;

export function prepareInstall({ output, homeDir = os.homedir(), sourceApp = fs.existsSync(path.join(ROOT, 'dist/WorkLog.app')) ? path.join(ROOT, 'dist/WorkLog.app') : path.resolve(ROOT, '../../..') }) {
  const targetApp = path.join(homeDir, 'Applications/WorkLog.app'), dataDir = path.join(homeDir, 'Library/Application Support/WorkLog');
  const version = `0.3.1-${digest(fs.readFileSync(path.join(ROOT, 'harness/jobs.json'))).slice(0, 12)}`;
  const runtimeRoot = path.join(dataDir, 'versions', version), node = path.join(runtimeRoot, 'node'), harness = path.join(runtimeRoot, 'harness');
  const files = [];
  for (const role of ['runtime', 'manager']) {
    const label = `local.worklog.${role}`, target = path.join(homeDir, 'Library/LaunchAgents', `${label}.plist`);
    files.push({ target, content: plist({ Label: label, ProgramArguments: [node, path.join(harness, 'bin/harness.mjs'), 'serve', role],
      RunAtLoad: true, KeepAlive: true, ProcessType: 'Background',
      EnvironmentVariables: { HARNESS_DATA_DIR: dataDir, PATH: `${runtimeRoot}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}` },
      StandardOutPath: path.join(dataDir, `${role}.log`), StandardErrorPath: path.join(dataDir, `${role}.log`) }) });
  }
  files.push({ target: path.join(homeDir, 'Library/LaunchAgents/local.worklog.gui.plist'), content: plist({ Label: 'local.worklog.gui',
    ProgramArguments: [path.join(targetApp, 'Contents/MacOS/WorkLog'), '--background'], RunAtLoad: true, KeepAlive: false,
    EnvironmentVariables: { HARNESS_DATA_DIR: dataDir } }) });
  const hooks = {};
  for (const engine of ['codex', 'claude']) {
    const command = `HARNESS_DATA_DIR=${quote(dataDir)} ${quote(node)} ${quote(path.join(harness, 'src/hook.mjs'))} ${engine}`;
    const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'PreToolUse', 'PostToolUse'];
    if (engine === 'claude') events.push('PostToolUseFailure', 'StopFailure');
    hooks[engine] = { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 2 }] }]])) };
  }
  const plan = { version, sourceApp, targetApp, dataDir, runtimeRoot, files, hooks,
    note: '준비만 완료. 실제 설치는 --apply를 명시해야 수행됩니다. 기존 훅을 보존하며 회사 정책의 비활성화 설정을 바꾸지 않습니다.' };
  fs.mkdirSync(output, { recursive: true });
  for (const f of files) atomic(path.join(output, path.basename(f.target)), f.content);
  for (const engine of ['codex', 'claude']) atomic(path.join(output, `${engine}-hooks.json`), JSON.stringify(hooks[engine], null, 2));
  atomic(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2));
  return plan;
}
export function applyInstall(plan, { homeDir = os.homedir(), activate = true } = {}) {
  // Intentional first-install boundary: never overwrite an existing app or LaunchAgent blindly.
  assert(!fs.existsSync(plan.targetApp), '이미 설치된 앱이 있습니다. 실행 중 버전 보존을 위한 업데이트 절차가 필요합니다.');
  assert(plan.files.every(f => !fs.existsSync(f.target)), '기존 WorkLog LaunchAgent가 있습니다. 설치를 중단했습니다.');
  assert(fs.existsSync(path.join(plan.sourceApp, 'Contents/MacOS/node')), '먼저 macOS 앱을 빌드하세요.');
  const replacements = [];
  for (const engine of ['codex', 'claude']) {
    const target = path.join(homeDir, engine === 'codex' ? '.codex/hooks.json' : '.claude/settings.json');
    const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const config = previous ? JSON.parse(previous) : {};
    assert(config && typeof config === 'object' && !Array.isArray(config), `${target} 형식을 확인하세요.`);
    config.hooks ||= {};
    for (const [event, entries] of Object.entries(plan.hooks[engine].hooks)) {
      config.hooks[event] ||= []; assert(Array.isArray(config.hooks[event]), `${engine} ${event} 설정 형식을 확인하세요.`);
      config.hooks[event].push(...entries);
    }
    replacements.push({ target, previous, next: JSON.stringify(config, null, 2) });
  }
  const backupDir = path.join(plan.dataDir, 'install-backups', new Date().toISOString().replaceAll(':', '-'));
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  atomic(path.join(backupDir, 'intent.json'), JSON.stringify({ app: plan.targetApp, files: [...plan.files.map(f => f.target), ...replacements.map(f => f.target)] }, null, 2));
  fs.mkdirSync(path.dirname(plan.targetApp), { recursive: true });
  fs.cpSync(plan.sourceApp, plan.targetApp, { recursive: true });
  fs.mkdirSync(plan.runtimeRoot, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(plan.sourceApp, 'Contents/MacOS/node'), path.join(plan.runtimeRoot, 'node')); fs.chmodSync(path.join(plan.runtimeRoot, 'node'), 0o755);
  fs.copyFileSync(path.join(plan.sourceApp, 'Contents/MacOS/WorkLogKeychain'), path.join(plan.runtimeRoot, 'WorkLogKeychain')); fs.chmodSync(path.join(plan.runtimeRoot, 'WorkLogKeychain'), 0o755);
  fs.cpSync(path.join(plan.sourceApp, 'Contents/Resources/harness'), path.join(plan.runtimeRoot, 'harness'), { recursive: true });
  for (const [i, f] of replacements.entries()) { if (f.previous !== null) atomic(path.join(backupDir, `${i}.json`), f.previous); atomic(f.target, f.next); }
  for (const f of plan.files) atomic(f.target, f.content);
  atomic(path.join(backupDir, 'completed.json'), json({ completed_at: new Date().toISOString() }));
  if (activate) {
    for (const f of plan.files) {
      const r = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, f.target], { encoding: 'utf8' });
      assert(r.status === 0, `설치 파일은 보존했습니다. 서비스 등록 실패: ${r.stderr}`);
    }
  }
  return { installed: plan.targetApp, data_root: plan.dataDir, activated: activate, backup_dir: backupDir };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : path.join(os.tmpdir(), `worklog-install-plan-${process.pid}`);
  try {
    const plan = prepareInstall({ output });
    console.log(json(process.argv.includes('--apply') ? applyInstall(plan) : { ...plan, output }));
  } catch (e) { console.error(json({ error: e.message })); process.exitCode = 1; }
}
