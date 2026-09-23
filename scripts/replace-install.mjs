import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assert, atomic, digest } from '../src/shared.mjs';
import { canonical, inventory, matches, safePath, saveManifest, stat, validateManifest } from './install-state.mjs';
import { missingService, ownedService, stopOwnedServices } from './service-control.mjs';

const options = { encoding: 'utf8', timeout: 15000 };
const exactTree = (loc, tree, target = tree.path) => {
  safePath(loc.home, target);
  assert(stat(target)?.isDirectory() && canonical(inventory(target)) === canonical(tree.entries),
    `기존 설치가 변경되었습니다. 수정·추가 파일을 보존합니다: ${target}`);
};

export function intact(loc, receipt) {
  for (const tree of receipt.trees) exactTree(loc, tree);
  for (const file of receipt.files) {
    safePath(loc.home, file.path);
    assert(matches(file.path, { ...file, kind: 'file' }), `기존 서비스 설정이 변경되었습니다: ${file.path}`);
  }
}

function startServices(loc, receipt, launchctl, selected = receipt.files) {
  for (const file of selected) {
    safePath(loc.home, file.path);
    assert(matches(file.path, { ...file, kind: 'file' }), `서비스 설정이 변경되었습니다: ${file.path}`);
    const current = launchctl('launchctl', ['print', `gui/${process.getuid()}/${file.label}`], options);
    if (!missingService(current)) { ownedService(current, file); file.activation = 'registered'; saveManifest(loc, receipt); continue; }
    file.activation = 'starting'; saveManifest(loc, receipt);
    const result = launchctl('launchctl', ['bootstrap', `gui/${process.getuid()}`, file.path], options);
    assert(result.status === 0, `서비스 등록 실패: ${result.stderr || result.error?.message || result.status}`);
    file.activation = 'registered'; saveManifest(loc, receipt);
  }
}

function transaction(loc, receipt) {
  const change = receipt.replacement;
  assert(change && /^[0-9a-f-]{36}$/.test(change.id) && ['pending', 'restored', 'committed'].includes(change.phase), '재설치 복구 기록을 확인하세요.');
  const previous = validateManifest(loc, change.previous);
  assert(!previous.replacement && previous.state === 'installed' && previous.id === receipt.id && previous.version === receipt.version,
    '재설치의 이전 소유 기록이 일치하지 않습니다.');
  return { previous, paths: receipt.trees.map((tree, i) => ({
    target: tree.path,
    backup: path.join(path.dirname(tree.path), `.worklog-reinstall-${change.id}-${i}`),
    stage: path.join(path.dirname(tree.path), `.worklog-stage-${change.id}-${i}`)
  })) };
}

function remainingOwned(loc, tree, file) {
  safePath(loc.home, file);
  const expected = new Map(tree.entries.map(entry => [entry.relative, entry]));
  const remaining = stat(file) ? inventory(file) : [];
  assert(remaining.every(entry => canonical(entry) === canonical(expected.get(entry.relative))),
    `재설치 파일이 변경되어 보존합니다: ${file}`);
  return remaining;
}

function removeExact(loc, tree, file) {
  // A previous cleanup may have stopped halfway. Missing entries are fine;
  // modified/added entries are never authorization to delete user data.
  for (const entry of remainingOwned(loc, tree, file).reverse()) {
    const target = path.join(file, entry.relative);
    safePath(loc.home, target, { symlink: entry.kind === 'symlink' });
    assert(matches(target, entry), `정리 도중 파일이 변경되었습니다: ${target}`);
    if (entry.kind === 'directory') fs.rmdirSync(target); else fs.unlinkSync(target);
  }
}

// The journal is part of the ownership receipt. Derive every recovery path from
// validated installation paths, never from an arbitrary saved filesystem path.
export function recoverReplacement(loc, receipt, { activate, launchctl, stopTimeoutMs, onProgress }) {
  if (!receipt?.replacement) return receipt;
  const { previous, paths } = transaction(loc, receipt);
  if (receipt.replacement.phase === 'restored') {
    intact(loc, receipt);
    if (activate) startServices(loc, receipt, launchctl, receipt.files.filter(file =>
      previous.files.some(old => old.label === file.label && ['registered', 'starting'].includes(old.activation))));
    delete receipt.replacement; saveManifest(loc, receipt); return receipt;
  }
  if (receipt.replacement.phase === 'committed') {
    intact(loc, receipt);
    for (const [i, entry] of paths.entries()) {
      removeExact(loc, previous.trees[i], entry.backup);
      removeExact(loc, receipt.trees[i], entry.stage);
    }
    delete receipt.replacement; saveManifest(loc, receipt); return receipt;
  }
  onProgress('중단된 재설치를 확인하고 이전 설치를 복원합니다.');
  // A crash can occur between replacing a plist and recording activation.
  const stopping = structuredClone(receipt);
  for (const [i, file] of stopping.files.entries()) {
    const old = previous.files[i];
    safePath(loc.home, file.path);
    assert(matches(file.path, { ...file, kind: 'file' }) || matches(old.path, { ...old, kind: 'file' }),
      `서비스 설정이 변경되어 복구하지 않았습니다: ${file.path}`);
    if (matches(old.path, { ...old, kind: 'file' })) stopping.files[i] = { ...old, activation: file.activation };
  }
  const blocked = stopOwnedServices(loc, stopping, { deactivate: activate, launchctl, timeoutMs: stopTimeoutMs });
  assert(!blocked.length, blocked.map(row => row.reason).join('\n'));
  // Validate the entire rollback before touching any replacement files.
  for (const [i, entry] of paths.entries()) {
    safePath(loc.home, entry.backup); safePath(loc.home, entry.stage);
    if (stat(entry.backup)) {
      exactTree(loc, previous.trees[i], entry.backup);
      remainingOwned(loc, receipt.trees[i], entry.target);
    } else exactTree(loc, previous.trees[i], entry.target);
    remainingOwned(loc, receipt.trees[i], entry.stage);
  }
  for (const [i, entry] of paths.entries()) {
    if (stat(entry.backup)) {
      removeExact(loc, receipt.trees[i], entry.target);
      fs.renameSync(entry.backup, entry.target);
    }
    removeExact(loc, receipt.trees[i], entry.stage);
  }
  for (const file of previous.files) atomic(file.path, file.content);
  const resume = previous.files.filter(file => ['registered', 'starting'].includes(file.activation));
  const restored = structuredClone(previous);
  for (const file of restored.files) if (file.activation !== 'not_started') file.activation = 'stopped';
  restored.replacement = { ...receipt.replacement, phase: 'restored' };
  saveManifest(loc, restored);
  if (activate) startServices(loc, restored, launchctl, restored.files.filter(file => resume.some(old => old.label === file.label)));
  delete restored.replacement; saveManifest(loc, restored);
  return restored;
}

// Caller owns installation.lock; staged payloads are complete before services stop.
export function replaceInstall(loc, previous, plan, staged, { activate, launchctl, stopTimeoutMs = 10000, onProgress }) {
  intact(loc, previous);
  assert(plan.runtimeRoot === previous.trees[1].path && plan.installationId === previous.id, '재설치 대상이 변경되었습니다. 다시 실행하세요.');
  const receipt = { ...structuredClone(previous), state: 'reinstalling', updated_at: new Date().toISOString(),
    trees: previous.trees.map((tree, i) => ({ path: tree.path, entries: inventory(staged[i]) })),
    files: plan.files.map(file => ({ path: file.target, label: file.label, argv: file.argv, content: file.content,
      digest: digest(file.content), mode: 0o600, activation: 'not_started' })),
    replacement: { id: crypto.randomUUID(), phase: 'pending', previous: structuredClone(previous) } };
  const { paths } = transaction(loc, receipt), prepared = [];
  let journaled = false, committed = false, stopAttempted = false;
  try {
    onProgress('기존 연결을 유지하며 새 설치 파일을 준비합니다.');
    for (const [i, entry] of paths.entries()) {
      safePath(loc.home, entry.stage); safePath(loc.home, entry.backup);
      assert(!stat(entry.stage) && !stat(entry.backup), '재설치 임시 경로가 이미 존재합니다.');
      // Stage alongside each target so the swap/rollback uses same-filesystem rename.
      fs.mkdirSync(entry.stage); prepared.push(entry.stage);
      fs.cpSync(staged[i], entry.stage, { recursive: true, verbatimSymlinks: true });
      exactTree(loc, receipt.trees[i], entry.stage);
    }
    onProgress('WorkLog 서비스의 종료를 확인합니다.');
    stopAttempted = true;
    const blocked = stopOwnedServices(loc, previous, { deactivate: activate, launchctl, timeoutMs: stopTimeoutMs });
    if (blocked.length) throw new Error(blocked.map(row => row.reason).join('\n'));
    intact(loc, previous);
    saveManifest(loc, receipt); journaled = true;
    onProgress('앱과 실행 파일을 교체합니다. 업무 데이터와 에이전트 연결은 유지합니다.');
    for (const [i, entry] of paths.entries()) {
      exactTree(loc, previous.trees[i], entry.target);
      fs.renameSync(entry.target, entry.backup);
      fs.renameSync(entry.stage, entry.target);
    }
    for (const file of receipt.files) atomic(file.path, file.content);
    if (activate) { onProgress('WorkLog 서비스와 메뉴 막대 앱을 다시 시작합니다.'); startServices(loc, receipt, launchctl); }
    receipt.state = 'installed'; receipt.replacement.phase = 'committed'; saveManifest(loc, receipt); committed = true;
    recoverReplacement(loc, receipt, { activate, launchctl, stopTimeoutMs, onProgress });
    return { status: 'reinstalled', installed: loc.app, data_root: loc.data, activated: activate,
      installation_id: receipt.id, manifest: loc.manifest, links: receipt.links.map(link => link.path) };
  } catch (error) {
    if (!journaled && stopAttempted && activate) {
      try { startServices(loc, previous, launchctl, previous.files.filter(file => receipt.replacement.previous.files.some(old =>
        old.label === file.label && ['registered', 'starting'].includes(old.activation)))); }
      catch (restart) { error.message += `\n이전 서비스 재시작을 확인하세요: ${restart.message}`; }
    }
    if (journaled && !committed) {
      try {
        recoverReplacement(loc, receipt, { activate, launchctl, stopTimeoutMs, onProgress });
        error.message += '\n이전 설치 파일을 복원했습니다.';
      } catch (recovery) { error.message += `\n복구 기록과 백업을 보존했습니다. make install로 다시 시도하세요: ${recovery.message}`; }
    }
    throw error;
  } finally {
    // After journaling, cleanup belongs to recovery; never delete its evidence.
    if (!journaled) for (const file of prepared) fs.rmSync(file, { recursive: true, force: true });
  }
}
