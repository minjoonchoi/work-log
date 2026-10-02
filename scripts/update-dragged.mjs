import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assert, atomic } from '../src/shared.mjs';
import { locked, readManifest, saveManifest, safePath, safeInstallationPath, inventory, canonical, matches, stat, quote, validateManifest } from './install-state.mjs';
import { stopOwnedServices } from './service-control.mjs';

export function appBuildId(app) {
  const file = path.join(app, 'Contents/Resources/build-id');
  if (!fs.existsSync(file)) return null;
  const value = fs.readFileSync(file, 'utf8').trim();
  assert(/^[0-9a-f-]{36}$/.test(value), '앱 빌드 식별자가 잘못되었습니다. DMG를 다시 빌드하세요.');
  return value;
}
function exact(loc, tree, target = tree.path) {
  safePath(loc.home, target);
  assert(stat(target)?.isDirectory() && canonical(inventory(target)) === canonical(tree.entries), `변경된 실행 파일을 보존했습니다: ${target}`);
}
function discard(loc, tree, target) {
  if (!stat(target)) return;
  safePath(loc.home, target);
  const expected = new Map(tree.entries.map(entry => [entry.relative, entry]));
  assert(inventory(target).every(entry => canonical(entry) === canonical(expected.get(entry.relative))), `변경된 복구 파일을 보존했습니다: ${target}`);
  fs.rmSync(target, { recursive: true });
}
function paths(loc, receipt) {
  const update = receipt.runtime_update;
  assert(update && /^[0-9a-f-]{36}$/.test(update.id) && ['pending', 'committed'].includes(update.phase), '앱 갱신 복구 기록을 확인하세요.');
  const previous = validateManifest(loc, update.previous);
  assert(previous.state === 'installed' && !previous.runtime_update && !previous.replacement
    && previous.id === receipt.id && previous.version === receipt.version, '앱 갱신 소유 기록이 다릅니다.');
  const target = receipt.trees[1].path;
  return { previous, target, stage: path.join(path.dirname(target), `.worklog-update-${update.id}`),
    backup: path.join(path.dirname(target), `.worklog-backup-${update.id}`) };
}
function recover(loc, receipt) {
  if (!receipt.runtime_update) return receipt;
  const { previous, target, stage, backup } = paths(loc, receipt);
  if (receipt.runtime_update.phase === 'committed') {
    exact(loc, receipt.trees[1]);
    discard(loc, previous.trees[1], backup); discard(loc, receipt.trees[1], stage);
    delete receipt.runtime_update; saveManifest(loc, receipt); return receipt;
  }
  // Validate all rollback inputs before changing anything. The app itself has
  // already been replaced by Finder; only our per-user runtime is rolled back.
  if (stat(backup)) {
    exact(loc, previous.trees[1], backup);
    if (stat(target)) exact(loc, receipt.trees[1], target);
  } else exact(loc, previous.trees[1], target);
  if (stat(stage)) exact(loc, receipt.trees[1], stage);
  if (stat(backup)) { discard(loc, receipt.trees[1], target); fs.renameSync(backup, target); }
  discard(loc, receipt.trees[1], stage);
  saveManifest(loc, previous); return previous;
}

// Return null only for a fresh installation. No hooks, credentials, settings,
// launch-agent configuration or data files are rewritten by this operation.
export function updateDraggedApp(sourceApp, { homeDir, checkpoint = () => {} } = {}) {
  return locked(homeDir, loc => {
    let previous = readManifest(loc);
    if (!previous || previous.state === 'uninstalled') return null;
    assert(sourceApp === loc.app, '새 앱을 기존 WorkLog가 설치된 Applications 폴더에 대치하세요.');
    safeInstallationPath(loc, sourceApp);
    assert(!previous.replacement, '진행 중인 소스 설치를 먼저 복구하세요.');
    assert(previous.files.length === 1, '기존 앱에서 make install로 단일 서비스 설치를 완료한 뒤 업데이트하세요.');
    // Updating during active work would mix two runtimes. The new native host
    // calls us before it starts its services, so any live locks belong to old work.
    const blocked = stopOwnedServices(loc, previous, { deactivate: false, includeGUI: false });
    assert(!blocked.length, '실행 중인 WorkLog를 메뉴에서 종료하고 새 앱을 다시 실행하세요. 업무 종료를 기다린 뒤 업데이트합니다.');
    previous = recover(loc, previous);
    assert(previous.state === 'installed', '이전 설치 제거가 완료되지 않았습니다. 먼저 제거 결과를 확인하세요.');
    for (const file of previous.files) {
      safePath(loc.home, file.path);
      assert(matches(file.path, { ...file, kind: 'file' }), `변경된 서비스 설정을 보존했습니다: ${file.path}`);
    }
    const buildId = appBuildId(sourceApp), appEntries = inventory(sourceApp);
    const sameApp = canonical(appEntries) === canonical(previous.trees[0].entries);
    if (sameApp && previous.build_id === buildId) {
      exact(loc, previous.trees[1]);
      return { status: 'already_installed', installed: loc.app };
    }
    exact(loc, previous.trees[1]);
    // Record the delivered app for safe removal even if runtime updating fails.
    previous = { ...structuredClone(previous), trees: [{ path: loc.app, entries: appEntries }, previous.trees[1]] };
    const id = crypto.randomUUID(), target = previous.trees[1].path;
    const stage = path.join(path.dirname(target), `.worklog-update-${id}`);
    safePath(loc.home, stage); assert(!stat(stage), '앱 갱신 임시 경로가 이미 존재합니다.');
    let journaled = false, receipt;
    try {
      fs.mkdirSync(stage);
      for (const file of ['node', 'WorkLogKeychain']) {
        fs.copyFileSync(path.join(sourceApp, 'Contents/MacOS', file), path.join(stage, file)); fs.chmodSync(path.join(stage, file), 0o755);
      }
      fs.cpSync(path.join(sourceApp, 'Contents/Resources/harness'), path.join(stage, 'harness'), { recursive: true, verbatimSymlinks: true });
      for (const skill of previous.skills) {
        const helper = path.join(stage, 'harness/skills', skill, 'scripts/harness');
        atomic(helper, `#!/bin/sh\nexport HARNESS_DATA_DIR=${quote(loc.data)}\nexec ${quote(path.join(target, 'node'))} ${quote(path.join(target, 'harness/bin/harness.mjs'))} "$@"\n`);
        fs.chmodSync(helper, 0o755);
      }
      receipt = { ...structuredClone(previous), build_id: buildId, state: 'updating', updated_at: new Date().toISOString(),
        trees: [previous.trees[0], { path: target, entries: inventory(stage) }],
        runtime_update: { id, phase: 'pending', previous } };
      const { backup } = paths(loc, receipt);
      safePath(loc.home, backup); assert(!stat(backup), '앱 갱신 백업 경로가 이미 존재합니다.');
      exact(loc, previous.trees[1]);
      saveManifest(loc, receipt); journaled = true;
      checkpoint('journaled');
      fs.renameSync(target, backup); checkpoint('backed_up');
      fs.renameSync(stage, target); checkpoint('swapped');
      receipt.state = 'installed'; receipt.runtime_update.phase = 'committed';
      saveManifest(loc, receipt); checkpoint('committed');
      recover(loc, receipt);
      return { status: 'updated', installed: loc.app, build_id: buildId };
    } catch (error) {
      if (journaled) {
        try { recover(loc, readManifest(loc)); }
        catch (recovery) { error.message += `\n복구 파일을 보존했습니다. 앱을 다시 실행하세요: ${recovery.message}`; }
      }
      throw error;
    } finally { if (!journaled) fs.rmSync(stage, { recursive: true, force: true }); }
  });
}
