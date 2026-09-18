import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert, json, alive } from '../src/shared.mjs';
import { locations, stat, safePath, locked, readManifest, saveManifest, matches, inventory,
  canonical, readConfig, writeConfig, hookPositions, quote } from './install-state.mjs';

export function prepareUninstall({ homeDir = os.homedir() } = {}) {
  const loc = locations(homeDir), receipt = readManifest(loc);
  if (!receipt) return { status: [loc.app, ...loc.agents.map(a => a.path)].some(p => stat(p)) ? 'unmanaged' : 'not_installed',
    removed: [], note: '설치 소유 기록이 없는 항목은 이름으로 추측하여 삭제하지 않습니다.' };
  return { status: receipt.state === 'uninstalled' ? 'uninstalled' : 'planned', installation_id: receipt.id, manifest: loc.manifest,
    hooks: receipt.hooks.map(h => ({ path: h.path, events: h.entries.map(e => e.event) })),
    links: receipt.links, files: receipt.files.map(f => f.path), app: receipt.trees[0].path, runtime: receipt.trees[1].path,
    preserve: ['업무 SQLite·산출물·로그·설치 백업', '사용자 설정과 다른 훅·스킬', 'macOS Keychain OAuth 토큰'],
    note: '제거 시 현재 내용과 소유 기록을 다시 대조합니다. 변경되거나 식별이 모호한 항목은 보존합니다.' };
}

const missingService = result => result.status !== 0 && /could not find (?:specified )?service|service not found/i.test(result.stderr || '');
function stopServices(loc, receipt, launchctl, deactivate, preserved) {
  if (!deactivate) assert(receipt.files.every(f => f.activation === 'not_started'), '활성화한 서비스의 종료 확인을 생략할 수 없습니다.');
  for (const f of receipt.files) {
    if (f.activation === 'not_started') continue;
    try {
      safePath(loc.home, f.path);
      assert(!stat(f.path) || matches(f.path, { ...f, kind: 'file' }), '서비스 설정이 변경되어 실행 중인 서비스 소유를 확인할 수 없습니다.');
      const target = `gui/${process.getuid()}/${f.label}`;
      const current = launchctl('launchctl', ['print', target], { encoding: 'utf8', timeout: 15000 });
      if (!missingService(current)) {
        assert(current.status === 0, `서비스 조회 실패: ${current.stderr || current.error?.message || current.status}`);
        const program = current.stdout.match(/(?:^|\n)\s*program = (.+)/)?.[1]?.trim();
        const args = current.stdout.match(/(?:^|\n)\s*arguments = \{\s*\n([\s\S]*?)\n\s*\}/)?.[1]?.split('\n').map(s => s.trim()).filter(Boolean);
        assert(program === f.argv[0] && canonical(args) === canonical(f.argv), '같은 이름의 다른 서비스가 있어 종료하지 않았습니다.');
        const stopped = launchctl('launchctl', ['bootout', target], { encoding: 'utf8', timeout: 15000 });
        assert(stopped.status === 0, `서비스 종료 실패: ${stopped.stderr || stopped.error?.message || stopped.status}`);
        assert(missingService(launchctl('launchctl', ['print', target], { encoding: 'utf8', timeout: 15000 })), '서비스 종료를 확인하지 못했습니다.');
      }
      f.activation = 'stopped'; saveManifest(loc, receipt);
    } catch (e) { preserved.push({ path: f.path, reason: e.message }); }
  }
  for (const role of ['runtime', 'manager']) {
    const file = path.join(loc.data, `${role}.lock`);
    try {
      safePath(loc.home, file);
      if (stat(file)) {
        const { pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert(Number.isSafeInteger(pid) && pid > 1 && !alive(pid), '프로세스 종료가 아직 확인되지 않았습니다. 종료 후 다시 제거하세요.');
      }
    } catch (e) { preserved.push({ path: file, reason: e.message }); }
  }
}

function removeHooks(loc, receipt, removed, preserved) {
  let dependent = false;
  for (const config of receipt.hooks) {
    try {
      const { raw, value } = readConfig(loc, config.path);
      if (raw === null) continue;
      const changed = [];
      for (const entry of config.entries) {
        const found = hookPositions(value, entry);
        if (found.length !== 1) continue; // Missing, edited, or duplicated commands are never guessed.
        const { g, h } = found[0], groups = value.hooks[entry.event], group = groups[g];
        group.hooks.splice(h, 1);
        if (!group.hooks.length) groups.splice(g, 1);
        if (!groups.length && !entry.eventExisted) delete value.hooks[entry.event];
        changed.push({ kind: 'hook', path: config.path, event: entry.event });
      }
      if (value.hooks && !Object.keys(value.hooks).length && !config.hooksExisted) delete value.hooks;
      if (changed.length) { writeConfig(loc, config.path, raw, value); removed.push(...changed); }
      const runtime = receipt.trees[1].path;
      const references = [`WORKLOG_INSTALL_ID=${quote(receipt.id)}`, quote(path.join(runtime, 'node')), quote(path.join(runtime, 'harness/src/hook.mjs'))];
      const referencesInstall = v => typeof v === 'string' ? references.some(ref => v.includes(ref))
        : v && typeof v === 'object' ? Object.values(v).some(referencesInstall) : false;
      if (referencesInstall(value)) {
        dependent = true; preserved.push({ path: config.path, reason: '변경되었거나 중복된 WorkLog 훅을 보존했습니다. 연결된 실행 파일도 유지합니다.' });
      }
    } catch (e) { dependent = true; preserved.push({ path: config.path, reason: e.message }); }
  }
  return dependent;
}

function removeTrees(loc, receipt, removed, preserved) {
  for (const tree of receipt.trees) {
    try {
      safePath(loc.home, tree.path);
      if (!stat(tree.path)) continue;
      assert(stat(tree.path).isDirectory(), '설치 디렉터리가 다른 유형으로 바뀌었습니다.');
      const expected = new Map(tree.entries.map(e => [e.relative, e]));
      // A partially copied tree is recoverable, but added/edited files preserve the entire tree.
      for (const current of inventory(tree.path)) assert(canonical(current) === canonical(expected.get(current.relative)), '사용자가 변경하거나 추가한 파일이 있어 디렉터리를 보존했습니다.');
      for (const entry of [...tree.entries].reverse()) {
        const target = path.join(tree.path, entry.relative); safePath(loc.home, target, { symlink: entry.kind === 'symlink' });
        if (!stat(target)) continue;
        assert(matches(target, entry), '제거 도중 내용이 바뀌어 남은 파일을 보존했습니다.');
        if (entry.kind === 'directory') fs.rmdirSync(target); else fs.unlinkSync(target);
      }
      removed.push({ kind: 'installation_files', path: tree.path });
    } catch (e) { preserved.push({ path: tree.path, reason: e.message }); }
  }
}

export function applyUninstall({ homeDir = os.homedir(), deactivate = true, launchctl = spawnSync } = {}) {
  const initial = prepareUninstall({ homeDir });
  if (['not_installed', 'unmanaged', 'uninstalled'].includes(initial.status)) return initial;
  return locked(homeDir, loc => {
    const receipt = readManifest(loc); assert(receipt, '설치 기록이 변경되었습니다.');
    if (receipt.state === 'uninstalled') return { status: 'uninstalled', removed: [] };
    const removed = [], preserved = [];
    receipt.state = 'uninstalling'; saveManifest(loc, receipt);
    stopServices(loc, receipt, launchctl, deactivate, preserved);
    if (!preserved.length) {
      let dependent = removeHooks(loc, receipt, removed, preserved);
      for (const link of receipt.links) {
        try {
          safePath(loc.home, link.path, { symlink: true }); const info = stat(link.path);
          if (!info) continue;
          assert(matches(link.path, { ...link, kind: 'symlink' })
            && (!link.identity || (info.dev === link.identity.dev && info.ino === link.identity.ino)), '연결 대상 또는 유형이 바뀌어 지시문 경로를 보존했습니다.');
          fs.unlinkSync(link.path); removed.push({ kind: 'symlink', path: link.path });
        } catch (e) { dependent = true; preserved.push({ path: link.path, reason: e.message }); }
      }
      for (const f of receipt.files) {
        try {
          safePath(loc.home, f.path); if (!stat(f.path)) continue;
          assert(matches(f.path, { ...f, kind: 'file' }), '변경된 서비스 설정을 보존했습니다.');
          fs.unlinkSync(f.path); removed.push({ kind: 'launch_agent', path: f.path });
        } catch (e) { dependent = true; preserved.push({ path: f.path, reason: e.message }); }
      }
      if (!dependent) removeTrees(loc, receipt, removed, preserved);
      else for (const tree of receipt.trees) if (stat(tree.path)) preserved.push({ path: tree.path, reason: '보존된 연결의 실행 파일을 유지했습니다.' });
    }
    receipt.state = preserved.length ? 'needs_attention' : 'uninstalled';
    receipt.uninstall = { at: new Date().toISOString(), removed, preserved }; saveManifest(loc, receipt);
    return { status: receipt.state, installation_id: receipt.id, removed, preserved, data_root: loc.data,
      note: '업무 DB·산출물·로그·백업·Keychain 토큰은 보존합니다. 사용자 설정 파일 자체는 삭제하지 않습니다.' };
  });
}

const invokedAsProgram = process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedAsProgram) {
  try {
    const { values } = parseArgs({ options: { apply: { type: 'boolean' }, 'home-dir': { type: 'string' }, 'no-deactivate': { type: 'boolean' } } });
    const options = { homeDir: values['home-dir'], deactivate: !values['no-deactivate'] };
    const result = values.apply ? applyUninstall(options) : prepareUninstall(options);
    console.log(json(result)); if (['needs_attention', 'unmanaged'].includes(result.status)) process.exitCode = 2;
  } catch (e) { console.error(json({ error: e.message })); process.exitCode = 1; }
}
