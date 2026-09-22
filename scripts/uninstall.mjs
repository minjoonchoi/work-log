import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert, json } from '../src/shared.mjs';
import { stopOwnedServices } from './service-control.mjs';
import { removeAgentConnection } from './agent-connections.mjs';
import { locations, stat, safePath, locked, readManifest, saveManifest, matches, inventory,
  canonical, removeEmptyDirectories } from './install-state.mjs';

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

export function applyUninstall({ homeDir = os.homedir(), deactivate = true, launchctl = spawnSync, stopTimeoutMs = 10000 } = {}) {
  const initial = prepareUninstall({ homeDir });
  if (['not_installed', 'unmanaged', 'uninstalled'].includes(initial.status)) return initial;
  return locked(homeDir, loc => {
    const receipt = readManifest(loc); assert(receipt, '설치 기록이 변경되었습니다.');
    if (receipt.state === 'uninstalled') return { status: 'uninstalled', removed: [] };
    const removed = [], preserved = [];
    receipt.state = 'uninstalling'; saveManifest(loc, receipt);
    preserved.push(...stopOwnedServices(loc, receipt, { launchctl, deactivate, timeoutMs: stopTimeoutMs }));
    if (!preserved.length) {
      for (const engine of ['claude', 'codex']) removeAgentConnection(loc, receipt, engine, removed, preserved);
      let dependent = preserved.length > 0;
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
    removeEmptyDirectories(loc, receipt, removed);
    receipt.state = preserved.length ? 'needs_attention' : 'uninstalled';
    receipt.uninstall = { at: new Date().toISOString(), removed, preserved }; saveManifest(loc, receipt);
    return { status: receipt.state, installation_id: receipt.id, removed, preserved, data_root: loc.data,
      note: '업무 DB·산출물·로그·백업·Keychain 토큰은 보존합니다. 기존 사용자 설정은 보존하며 WorkLog가 만든 빈 설정·디렉터리만 정리합니다.' };
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
