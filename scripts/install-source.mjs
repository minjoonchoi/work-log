import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROOT, assert } from '../src/shared.mjs';
import { createInstallReporter } from './install-output.mjs';
import { buildMac } from './build-mac.mjs';
import { prepareInstall, applyInstall } from './install.mjs';
import { locations, readManifest, locked, safePath, stat, inventory, canonical } from './install-state.mjs';

// Only remove known build copies whose entire contents still match the installed receipt.
// A caller-supplied app, a modified build, and other applications remain caller-owned.
export function cleanBuildCopies({ homeDir, projectRoot = ROOT, sourceApp } = {}) {
  const removed = [], preserved = [];
  const root = path.resolve(projectRoot);
  const candidates = ['dist/WorkLog.app', 'dist/package/WorkLog/WorkLog.app'].map(file => path.join(root, file));
  let protectedSource = sourceApp && path.resolve(sourceApp);
  try { if (protectedSource) protectedSource = fs.realpathSync(protectedSource); } catch {}
  try {
    locked(homeDir, loc => {
      const receipt = readManifest(loc);
      assert(receipt?.state === 'installed', '완료된 설치 소유 기록을 확인할 수 없습니다.');
      safePath(loc.home, loc.app);
      const expected = canonical(receipt.trees[0].entries);
      assert(canonical(inventory(loc.app)) === expected, '설치본 전체 내용이 소유 기록과 다릅니다.');
      for (const candidate of candidates) {
        try {
          safePath(root, candidate);
          if (!stat(candidate)) continue;
          assert(fs.realpathSync(candidate) !== protectedSource, '직접 지정한 원본 앱은 보존합니다.');
          assert(path.resolve(candidate) !== loc.app, '설치된 앱은 보존합니다.');
          assert(canonical(inventory(candidate)) === expected, '설치본과 다른 버전이거나 변경·추가된 파일이 있어 보존합니다.');
          fs.rmSync(candidate, { recursive: true });
          removed.push(candidate);
        } catch (error) { preserved.push({ path: candidate, reason: error.message }); }
      }
    });
  } catch (error) {
    // Cleanup cannot turn a completed installation into a reported install failure.
    for (const candidate of candidates) {
      if (!removed.includes(candidate) && !preserved.some(row => row.path === candidate)) {
        preserved.push({ path: candidate, reason: error.message });
      }
    }
  }
  return { removed, preserved };
}

export function installFromSource({ homeDir = os.homedir(), output, sourceApp, activate = true,
  projectRoot = ROOT, build = buildMac, onProgress = () => {} } = {}) {
  assert(sourceApp === undefined || (typeof sourceApp === 'string' && sourceApp.trim().length > 0),
    '--source-app에는 비어 있지 않은 앱 경로가 필요합니다.');
  const loc = locations(homeDir);
  onProgress('설치 준비 상태를 확인합니다.');
  // Read only: applyInstall still owns the lock and validates an existing installation.
  const previous = readManifest(loc);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-source-install-'));
  try {
    let app = sourceApp && path.resolve(sourceApp);
    if (!app && previous?.state === 'installed') app = loc.app;
    if (!app) {
      onProgress('macOS 앱을 빌드합니다.');
      // Build tools can emit arbitrary output. Keep CLI stdout for the final result.
      app = build({ outputDir: stage, archive: false, stdio: ['ignore', 2, 2], onProgress }).app;
    }
    const plan = prepareInstall({ homeDir, output: output || path.join(stage, 'plan'), sourceApp: app });
    const result = applyInstall(plan, { activate, onProgress });
    onProgress('설치본과 일치하는 중복 빌드 앱을 정리합니다.');
    return { ...result, build_cleanup: cleanBuildCopies({ homeDir, projectRoot, sourceApp }) };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

const invokedAsProgram = process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedAsProgram) {
  const reporter = createInstallReporter({ json: process.argv.includes('--json') });
  try {
    const { values } = parseArgs({ options: { json: { type: 'boolean' }, output: { type: 'string' }, 'home-dir': { type: 'string' },
      'source-app': { type: 'string' }, 'no-activate': { type: 'boolean' } } });
    reporter.result('install', installFromSource({ output: values.output, homeDir: values['home-dir'],
      sourceApp: values['source-app'], activate: !values['no-activate'], onProgress: reporter.progress }));
  } catch (error) { reporter.error('install', error); process.exitCode = 1; }
}
