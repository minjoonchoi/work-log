import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, atomic, assert, digest } from '../src/shared.mjs';
import { createInstallReporter } from './install-output.mjs';
import { intact, replaceInstall, recoverReplacement } from './replace-install.mjs';
import { OWNER, quote, locations, stat, safePath, locked, readManifest, saveManifest, recordDirectories,
  inventory } from './install-state.mjs';

const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = object => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(object).map(([k, v]) => `<key>${xml(k)}</key>${typeof v === 'boolean' ? `<${v}/>` : Array.isArray(v) ? `<array>${v.map(s => `<string>${xml(s)}</string>`).join('')}</array>` : typeof v === 'object' ? `<dict>${Object.entries(v).map(([a, b]) => `<key>${xml(a)}</key>${typeof b === 'boolean' ? `<${b}/>` : `<string>${xml(b)}</string>`}`).join('')}</dict>` : `<string>${xml(v)}</string>`}`).join('')}</dict></plist>`;

export function prepareInstall({ output, homeDir = os.homedir(), sourceApp }) {
  const loc = locations(homeDir), current = readManifest(loc);
  const previous = current?.state === 'installed' ? current : null;
  const installationId = previous?.id || crypto.randomUUID();
  const buildApp = path.join(ROOT, 'dist/WorkLog.app'), packagedApp = path.resolve(ROOT, '../../..');
  sourceApp ||= fs.existsSync(buildApp) ? buildApp
    : fs.existsSync(path.join(packagedApp, 'Contents/MacOS/WorkLogKeychain')) ? packagedApp
    : fs.existsSync(loc.app) ? loc.app : buildApp;
  const skills = ['work'];
  // Keep existing hook commands and symlinks stable; exact payloads are tracked
  // by receipt inventories, not by this installation slot's name.
  const version = previous?.version || `0.3.1-${digest(fs.readFileSync(path.join(ROOT, 'harness/jobs.json'))).slice(0, 12)}`;
  const runtimeRoot = path.join(loc.data, 'versions', version), node = path.join(runtimeRoot, 'node'), harness = path.join(runtimeRoot, 'harness');
  const files = [];
  for (const role of ['runtime', 'manager']) {
    const label = `local.worklog.${role}`, target = path.join(loc.home, 'Library/LaunchAgents', `${label}.plist`);
    const argv = [node, path.join(harness, 'bin/harness.mjs'), 'serve', role];
    files.push({ target, label, argv, content: plist({ Label: label, ProgramArguments: argv,
      RunAtLoad: true, KeepAlive: role === 'runtime' ? { SuccessfulExit: false } : true, ProcessType: 'Background',
      EnvironmentVariables: { HARNESS_DATA_DIR: loc.data, PATH: `${runtimeRoot}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}` },
      StandardOutPath: path.join(loc.data, `${role}.log`), StandardErrorPath: path.join(loc.data, `${role}.log`) }) });
  }
  const argv = [path.join(loc.app, 'Contents/MacOS/WorkLog'), '--background'];
  files.push({ target: loc.agents[2].path, label: 'local.worklog.gui', argv, content: plist({ Label: 'local.worklog.gui',
    ProgramArguments: argv, RunAtLoad: true, KeepAlive: false, EnvironmentVariables: { HARNESS_DATA_DIR: loc.data } }) });
  const hooks = {}, links = [];
  const plan = { installationId, homeDir: loc.home, version, sourceApp: path.resolve(sourceApp), targetApp: loc.app,
    dataDir: loc.data, runtimeRoot, files, hooks, links, skills, manifest: loc.manifest,
    note: '준비만 완료. --apply로 설치합니다. 기존 지시문을 보존하며 WorkLog 소유 기록과 일치하는 항목만 제거할 수 있습니다.' };
  fs.mkdirSync(output, { recursive: true });
  for (const f of files) atomic(path.join(output, path.basename(f.target)), f.content);
  atomic(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2));
  return plan;
}

export function checkInstallation({ homeDir = os.homedir(), activate = true, launchctl = spawnSync,
  stopTimeoutMs = 10000, onProgress = () => {} } = {}) {
  return locked(homeDir, loc => {
    assert(!activate || loc.home === path.resolve(os.homedir()) || launchctl !== spawnSync, '다른 홈에는 서비스를 활성화할 수 없습니다. --no-activate를 사용하세요.');
    const receipt = recoverReplacement(loc, readManifest(loc), { activate, launchctl, stopTimeoutMs, onProgress });
    if (receipt?.state === 'installed') intact(loc, receipt);
    else assert(!receipt || receipt.state === 'uninstalled', '이전 설치 또는 제거가 미완료입니다. uninstall 결과를 먼저 확인하세요.');
    return receipt;
  });
}

export function applyInstall(plan, { homeDir = plan.homeDir, activate = true, launchctl = spawnSync, onProgress = () => {},
  reinstall = false, stopTimeoutMs = 10000 } = {}) {
  return locked(homeDir, loc => {
    onProgress('설치 경로와 기존 소유 기록을 확인합니다.');
    assert(plan.homeDir === loc.home && plan.dataDir === loc.data && plan.targetApp === loc.app
      && plan.runtimeRoot === path.join(loc.data, 'versions', plan.version), '설치 계획과 대상 홈이 다릅니다.');
    const previous = readManifest(loc);
    assert(!previous?.replacement, '중단된 재설치가 있습니다. make install로 복구한 뒤 다시 실행하세요.');
    if (previous?.state === 'installed') {
      intact(loc, previous);
      if (!reinstall) return { status: 'already_installed', installed: loc.app, installation_id: previous.id, manifest: loc.manifest, note: '기존 설치를 유지했습니다. make install로 최신 소스를 재설치할 수 있습니다.' };
    }
    assert(!previous || ['uninstalled', 'installed'].includes(previous.state), '이전 설치 또는 제거가 미완료입니다. uninstall 결과를 먼저 확인하세요.');
    assert(!activate || loc.home === path.resolve(os.homedir()) || launchctl !== spawnSync, '다른 홈에는 서비스를 활성화할 수 없습니다. --no-activate를 사용하세요.');
    if (previous?.state !== 'installed') for (const target of [loc.app, plan.runtimeRoot, ...plan.files.map(f => f.target)]) {
      safePath(loc.home, target, { symlink: true });
      assert(!stat(target), `이미 설치되었거나 사용자가 소유한 경로가 있습니다. 덮어쓰지 않습니다: ${target}`);
    }
    if (activate && previous?.state !== 'installed') for (const file of plan.files) {
      const existing = launchctl('launchctl', ['print', `gui/${process.getuid()}/${file.label}`], { encoding: 'utf8', timeout: 15000 });
      assert(existing.status !== 0, `이미 등록된 서비스가 있습니다. 소유를 인계하지 않습니다: ${file.label}`);
      assert(/could not find (?:specified )?service|service not found/i.test(existing.stderr || ''), `기존 서비스 확인 실패: ${existing.stderr || existing.error?.message || existing.status}`);
    }
    for (const file of ['Contents/MacOS/node', 'Contents/MacOS/WorkLogKeychain', ...plan.skills.map(s => `Contents/Resources/harness/skills/${s}/SKILL.md`)])
      assert(fs.existsSync(path.join(plan.sourceApp, file)), `최신 macOS 앱을 먼저 빌드하세요: ${file}`);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-install-stage-'));
    let receipt;
    try {
      onProgress('앱과 실행 파일을 준비합니다.');
      const stagedApp = path.join(stage, 'app'), stagedRuntime = path.join(stage, 'runtime');
      fs.cpSync(plan.sourceApp, stagedApp, { recursive: true, verbatimSymlinks: true });
      fs.mkdirSync(stagedRuntime);
      for (const file of ['node', 'WorkLogKeychain']) {
        fs.copyFileSync(path.join(plan.sourceApp, 'Contents/MacOS', file), path.join(stagedRuntime, file)); fs.chmodSync(path.join(stagedRuntime, file), 0o755);
      }
      fs.cpSync(path.join(plan.sourceApp, 'Contents/Resources/harness'), path.join(stagedRuntime, 'harness'), { recursive: true, verbatimSymlinks: true });
      for (const name of plan.skills) {
        const helper = path.join(stagedRuntime, 'harness/skills', name, 'scripts/harness');
        atomic(helper, `#!/bin/sh\nexport HARNESS_DATA_DIR=${quote(loc.data)}\nexec ${quote(path.join(plan.runtimeRoot, 'node'))} ${quote(path.join(plan.runtimeRoot, 'harness/bin/harness.mjs'))} "$@"\n`);
        fs.chmodSync(helper, 0o755);
      }
      if (previous?.state === 'installed') return replaceInstall(loc, previous, plan, [stagedApp, stagedRuntime],
        { activate, launchctl, stopTimeoutMs, onProgress });
      const backupDir = path.join(loc.data, 'install-backups', plan.installationId);
      receipt = { format: 2, owner: OWNER, id: plan.installationId, home: loc.home, version: plan.version, skills: plan.skills, state: 'installing', created_at: new Date().toISOString(),
        trees: [{ path: loc.app, entries: inventory(stagedApp) }, { path: plan.runtimeRoot, entries: inventory(stagedRuntime) }],
        files: plan.files.map(f => ({ path: f.target, label: f.label, argv: f.argv, content: f.content, digest: digest(f.content), mode: 0o600, activation: 'not_started' })),
        links: [], hooks: [], created_directories: [], created_configs: [], backup_dir: backupDir };
      recordDirectories(loc, receipt, [loc.app, ...receipt.files.map(f => f.path)]);
      saveManifest(loc, receipt); // Persist exact ownership before the first shared configuration write.
      readManifest(loc); // Validate the same boundaries used by the uninstaller.
      onProgress('앱과 백그라운드 서비스 설정을 설치합니다.');
      for (const [i, source] of [stagedApp, stagedRuntime].entries()) {
        const target = receipt.trees[i].path; safePath(loc.home, target); assert(!stat(target), `설치 대상이 변경되었습니다: ${target}`);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      }
      for (const f of receipt.files) {
        safePath(loc.home, f.path); fs.mkdirSync(path.dirname(f.path), { recursive: true, mode: 0o700 });
        fs.writeFileSync(f.path, f.content, { flag: 'wx', mode: 0o600 });
      }
      if (activate) onProgress('백그라운드 서비스와 메뉴 막대 앱을 시작합니다.');
      if (activate) for (const f of receipt.files) {
        f.activation = 'starting'; saveManifest(loc, receipt);
        const r = launchctl('launchctl', ['bootstrap', `gui/${process.getuid()}`, f.path], { encoding: 'utf8', timeout: 15000 });
        assert(r.status === 0, `설치 파일과 소유 기록은 보존했습니다. 서비스 등록 실패: ${r.stderr || r.error?.message || r.status}`);
        f.activation = 'registered'; saveManifest(loc, receipt);
      }
      receipt.state = 'installed'; saveManifest(loc, receipt);
      return { status: 'installed', installed: loc.app, data_root: loc.data, activated: activate, backup_dir: backupDir,
        installation_id: receipt.id, manifest: loc.manifest, links: receipt.links.map(l => l.path) };
    } catch (e) {
      if (receipt) { receipt.state = 'install_failed'; receipt.error = e.message; saveManifest(loc, receipt); }
      throw e;
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  });
}

const invokedAsProgram = process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedAsProgram) {
  const reporter = createInstallReporter({ json: process.argv.includes('--json') });
  try {
    const { values } = parseArgs({ options: { json: { type: 'boolean' }, apply: { type: 'boolean' }, output: { type: 'string' }, 'home-dir': { type: 'string' }, 'source-app': { type: 'string' }, 'no-activate': { type: 'boolean' } } });
    reporter.progress('설치 계획을 준비합니다.');
    if (values.apply) checkInstallation({ homeDir: values['home-dir'], activate: !values['no-activate'], onProgress: reporter.progress });
    const output = values.output || fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-install-plan-'));
    const plan = prepareInstall({ output, homeDir: values['home-dir'], sourceApp: values['source-app'] });
    reporter.result('install', values.apply ? applyInstall(plan, { activate: !values['no-activate'], reinstall: true, onProgress: reporter.progress }) : { ...plan, output });
  } catch (e) { reporter.error('install', e); process.exitCode = 1; }
}
