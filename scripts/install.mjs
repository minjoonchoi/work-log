import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, atomic, assert, json, digest } from '../src/shared.mjs';
import { OWNER, quote, locations, stat, safePath, locked, readManifest, saveManifest, hookCommand,
  inventory, matches, readConfig, writeConfig, hookPositions, skillLinks } from './install-state.mjs';

const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = object => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(object).map(([k, v]) => `<key>${xml(k)}</key>${typeof v === 'boolean' ? `<${v}/>` : Array.isArray(v) ? `<array>${v.map(s => `<string>${xml(s)}</string>`).join('')}</array>` : typeof v === 'object' ? `<dict>${Object.entries(v).map(([a, b]) => `<key>${xml(a)}</key><string>${xml(b)}</string>`).join('')}</dict>` : `<string>${xml(v)}</string>`}`).join('')}</dict></plist>`;

export function prepareInstall({ output, homeDir = os.homedir(), sourceApp = fs.existsSync(path.join(ROOT, 'dist/WorkLog.app')) ? path.join(ROOT, 'dist/WorkLog.app') : path.resolve(ROOT, '../../..') }) {
  const loc = locations(homeDir), installationId = crypto.randomUUID();
  const skills = ['worklog-request'];
  const version = `0.3.1-${digest(fs.readFileSync(path.join(ROOT, 'harness/jobs.json'))).slice(0, 12)}`;
  const runtimeRoot = path.join(loc.data, 'versions', version), node = path.join(runtimeRoot, 'node'), harness = path.join(runtimeRoot, 'harness');
  const files = [];
  for (const role of ['runtime', 'manager']) {
    const label = `local.worklog.${role}`, target = path.join(loc.home, 'Library/LaunchAgents', `${label}.plist`);
    const argv = [node, path.join(harness, 'bin/harness.mjs'), 'serve', role];
    files.push({ target, label, argv, content: plist({ Label: label, ProgramArguments: argv,
      RunAtLoad: true, KeepAlive: true, ProcessType: 'Background',
      EnvironmentVariables: { HARNESS_DATA_DIR: loc.data, PATH: `${runtimeRoot}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}` },
      StandardOutPath: path.join(loc.data, `${role}.log`), StandardErrorPath: path.join(loc.data, `${role}.log`) }) });
  }
  const argv = [path.join(loc.app, 'Contents/MacOS/WorkLog'), '--background'];
  files.push({ target: loc.agents[2].path, label: 'local.worklog.gui', argv, content: plist({ Label: 'local.worklog.gui',
    ProgramArguments: argv, RunAtLoad: true, KeepAlive: false, EnvironmentVariables: { HARNESS_DATA_DIR: loc.data } }) });
  const hooks = {};
  for (const engine of ['claude', 'codex']) {
    const command = hookCommand(loc, runtimeRoot, installationId, engine);
    const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'PreToolUse', 'PostToolUse'];
    if (engine === 'claude') events.push('PostToolUseFailure', 'StopFailure');
    hooks[engine] = { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 2 }] }]])) };
  }
  const links = skillLinks(loc, skills, runtimeRoot).map(l => ({ target: l.path, source: l.target }));
  const plan = { installationId, homeDir: loc.home, version, sourceApp: path.resolve(sourceApp), targetApp: loc.app,
    dataDir: loc.data, runtimeRoot, files, hooks, links, skills, manifest: loc.manifest,
    note: '준비만 완료. --apply로 설치합니다. 기존 지시문을 보존하며 WorkLog 소유 기록과 일치하는 항목만 제거할 수 있습니다.' };
  fs.mkdirSync(output, { recursive: true });
  for (const f of files) atomic(path.join(output, path.basename(f.target)), f.content);
  for (const engine of ['codex', 'claude']) atomic(path.join(output, `${engine}-hooks.json`), JSON.stringify(hooks[engine], null, 2));
  atomic(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2));
  return plan;
}

function intact(loc, receipt) {
  for (const tree of receipt.trees) for (const e of tree.entries) {
    const target = path.join(tree.path, e.relative); safePath(loc.home, target, { symlink: e.kind === 'symlink' });
    assert(matches(target, e), `기존 설치가 변경되었습니다. 보존 후 확인이 필요합니다: ${target}`);
  }
  for (const f of receipt.files) { safePath(loc.home, f.path); assert(matches(f.path, { ...f, kind: 'file' }), `기존 서비스 설정이 변경되었습니다: ${f.path}`); }
  for (const link of receipt.links) { safePath(loc.home, link.path, { symlink: true }); assert(matches(link.path, { ...link, kind: 'symlink' }), `기존 지시문 연결이 변경되었습니다: ${link.path}`); }
  for (const hook of receipt.hooks) {
    const { value } = readConfig(loc, hook.path);
    assert(hook.entries.every(e => hookPositions(value, e).length === 1), `기존 훅이 변경되었습니다: ${hook.path}`);
  }
}

export function applyInstall(plan, { homeDir = plan.homeDir, activate = true, launchctl = spawnSync } = {}) {
  return locked(homeDir, loc => {
    assert(plan.homeDir === loc.home && plan.dataDir === loc.data && plan.targetApp === loc.app
      && plan.runtimeRoot === path.join(loc.data, 'versions', plan.version), '설치 계획과 대상 홈이 다릅니다.');
    const previous = readManifest(loc);
    if (previous?.state === 'installed') {
      intact(loc, previous);
      return { status: 'already_installed', installed: loc.app, installation_id: previous.id, manifest: loc.manifest, note: '기존 설치를 유지했습니다. 자동 업데이트는 수행하지 않습니다.' };
    }
    assert(!previous || previous.state === 'uninstalled', '이전 설치 또는 제거가 미완료입니다. uninstall 결과를 먼저 확인하세요.');
    assert(!activate || loc.home === path.resolve(os.homedir()) || launchctl !== spawnSync, '다른 홈에는 서비스를 활성화할 수 없습니다. --no-activate를 사용하세요.');
    for (const target of [loc.app, plan.runtimeRoot, ...plan.files.map(f => f.target), ...plan.links.map(l => l.target)]) {
      safePath(loc.home, target, { symlink: true });
      assert(!stat(target), `이미 설치되었거나 사용자가 소유한 경로가 있습니다. 덮어쓰지 않습니다: ${target}`);
    }
    if (activate) for (const file of plan.files) {
      const existing = launchctl('launchctl', ['print', `gui/${process.getuid()}/${file.label}`], { encoding: 'utf8', timeout: 15000 });
      assert(existing.status !== 0, `이미 등록된 서비스가 있습니다. 소유를 인계하지 않습니다: ${file.label}`);
      assert(/could not find (?:specified )?service|service not found/i.test(existing.stderr || ''), `기존 서비스 확인 실패: ${existing.stderr || existing.error?.message || existing.status}`);
    }
    const replacements = Object.entries(plan.hooks).map(([engine, hooks]) => {
      const target = loc.configs[engine], { raw, value } = readConfig(loc, target);
      const record = { engine, path: target, hooksExisted: value.hooks !== undefined, entries: [] };
      value.hooks ||= {};
      for (const [event, groups] of Object.entries(hooks.hooks)) {
        const eventExisted = value.hooks[event] !== undefined;
        value.hooks[event] ||= []; assert(Array.isArray(value.hooks[event]), `${engine} ${event} 설정 형식을 확인하세요.`);
        for (const group of groups) for (const hook of group.hooks) record.entries.push({ event, eventExisted, qualifiers: {}, hook });
        value.hooks[event].push(...structuredClone(groups));
      }
      return { target, raw, value, record };
    });
    for (const file of ['Contents/MacOS/node', 'Contents/MacOS/WorkLogKeychain', ...plan.skills.map(s => `Contents/Resources/harness/skills/${s}/SKILL.md`)])
      assert(fs.existsSync(path.join(plan.sourceApp, file)), `최신 macOS 앱을 먼저 빌드하세요: ${file}`);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-install-stage-'));
    let receipt;
    try {
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
      const backupDir = path.join(loc.data, 'install-backups', plan.installationId);
      receipt = { format: 1, owner: OWNER, id: plan.installationId, home: loc.home, version: plan.version, skills: plan.skills, state: 'installing', created_at: new Date().toISOString(),
        trees: [{ path: loc.app, entries: inventory(stagedApp) }, { path: plan.runtimeRoot, entries: inventory(stagedRuntime) }],
        files: plan.files.map(f => ({ path: f.target, label: f.label, argv: f.argv, content: f.content, digest: digest(f.content), mode: 0o600, activation: 'not_started' })),
        links: plan.links.map(l => ({ path: l.target, target: l.source })), hooks: replacements.map(r => r.record), backup_dir: backupDir };
      saveManifest(loc, receipt); // Persist exact ownership before the first shared configuration write.
      readManifest(loc); // Validate the same boundaries used by the uninstaller.
      for (const r of replacements) if (r.raw !== null) atomic(path.join(backupDir, `${r.record.engine}.json`), r.raw);
      for (const [i, source] of [stagedApp, stagedRuntime].entries()) {
        const target = receipt.trees[i].path; safePath(loc.home, target); assert(!stat(target), `설치 대상이 변경되었습니다: ${target}`);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      }
      for (const r of replacements) writeConfig(loc, r.target, r.raw, r.value);
      for (const link of receipt.links) {
        safePath(loc.home, link.path, { symlink: true }); fs.mkdirSync(path.dirname(link.path), { recursive: true, mode: 0o700 });
        fs.symlinkSync(link.target, link.path); const info = stat(link.path); link.identity = { dev: info.dev, ino: info.ino }; saveManifest(loc, receipt);
      }
      for (const f of receipt.files) {
        safePath(loc.home, f.path); fs.mkdirSync(path.dirname(f.path), { recursive: true, mode: 0o700 });
        fs.writeFileSync(f.path, f.content, { flag: 'wx', mode: 0o600 });
      }
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
  try {
    const { values } = parseArgs({ options: { apply: { type: 'boolean' }, output: { type: 'string' }, 'home-dir': { type: 'string' }, 'source-app': { type: 'string' }, 'no-activate': { type: 'boolean' } } });
    const output = values.output || fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-install-plan-'));
    const plan = prepareInstall({ output, homeDir: values['home-dir'], sourceApp: values['source-app'] });
    console.log(json(values.apply ? applyInstall(plan, { activate: !values['no-activate'] }) : { ...plan, output }));
  } catch (e) { console.error(json({ error: e.message })); process.exitCode = 1; }
}
