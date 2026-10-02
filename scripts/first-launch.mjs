import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert } from '../src/shared.mjs';
import { locked, readManifest, saveManifest } from './install-state.mjs';
import { missingService, ownedService } from './service-control.mjs';
import { fileURLToPath } from 'node:url';
import { prepareInstall, applyInstall } from './install.mjs';

export function installDraggedApp(sourceApp, { homeDir = os.homedir(), activate = true, launchctl = spawnSync } = {}) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-first-launch-'));
  try {
    const plan = prepareInstall({ sourceApp, homeDir, output, adopt: true });
    assert(!activate || path.resolve(homeDir) === path.resolve(os.homedir()) || launchctl !== spawnSync, '다른 홈에는 서비스를 활성화할 수 없습니다.');
    const result = applyInstall(plan, { homeDir, activate: false });
    if (activate) locked(homeDir, loc => {
      const receipt = readManifest(loc), file = receipt.files[0];
      const target = `gui/${process.getuid()}/${file.label}`;
      const current = launchctl('launchctl', ['print', target], { encoding: 'utf8' });
      if (!missingService(current)) ownedService(current, file);
      else {
        fs.writeFileSync(path.join(loc.data, '.open-after-install'), '');
        file.activation = 'starting'; saveManifest(loc, receipt);
        const started = launchctl('launchctl', ['bootstrap', `gui/${process.getuid()}`, file.path], { encoding: 'utf8' });
        assert(started.status === 0, `서비스 등록 실패: ${started.stderr || started.error?.message || started.status}`);
      }
      file.activation = 'registered'; saveManifest(loc, receipt);
    });
    return result;
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(installDraggedApp(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
