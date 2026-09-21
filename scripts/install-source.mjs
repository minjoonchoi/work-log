import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROOT, json, assert } from '../src/shared.mjs';
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
  projectRoot = ROOT, build = buildMac } = {}) {
  assert(sourceApp === undefined || (typeof sourceApp === 'string' && sourceApp.trim().length > 0),
    '--source-app에는 비어 있지 않은 앱 경로가 필요합니다.');
  const loc = locations(homeDir);
  // Read only: applyInstall still owns the lock and validates an existing installation.
  const previous = readManifest(loc);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-source-install-'));
  try {
    let app = sourceApp && path.resolve(sourceApp);
    if (!app && previous?.state === 'installed') app = loc.app;
    if (!app) app = build({ outputDir: stage, archive: false }).app;
    const plan = prepareInstall({ homeDir, output: output || path.join(stage, 'plan'), sourceApp: app });
    const result = applyInstall(plan, { activate });
    return { ...result, build_cleanup: cleanBuildCopies({ homeDir, projectRoot, sourceApp }) };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

const invokedAsProgram = process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedAsProgram) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' }, 'home-dir': { type: 'string' },
      'source-app': { type: 'string' }, 'no-activate': { type: 'boolean' } } });
    console.log(json(installFromSource({ output: values.output, homeDir: values['home-dir'],
      sourceApp: values['source-app'], activate: !values['no-activate'] })));
  } catch (error) { console.error(json({ error: error.message })); process.exitCode = 1; }
}
