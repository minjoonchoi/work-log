import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, assert } from '../src/shared.mjs';

export function buildDMG(app, outputDir, { run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  assert(result.status === 0, `${command} 실패`);
} } = {}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-dmg-'));
  try {
    const volume = path.join(stage, 'volume');
    fs.mkdirSync(volume);
    fs.cpSync(app, path.join(volume, 'WorkLog.app'), { recursive: true, verbatimSymlinks: true });
    fs.symlinkSync('/Applications', path.join(volume, 'Applications'));
    fs.copyFileSync(path.join(ROOT, 'apps/macos/dmg/finder-layout.bin'), path.join(volume, '.DS_Store'));
    fs.copyFileSync(path.join(ROOT, 'apps/macos/dmg/background.png'), path.join(volume, '.background.png'));
    const temporary = path.join(stage, 'WorkLog.dmg'), destination = path.resolve(outputDir, 'WorkLog-macos-arm64.dmg');
    run('hdiutil', ['create', '-volname', 'WorkLog', '-srcfolder', volume, '-format', 'UDZO', '-ov', temporary]);
    run('hdiutil', ['verify', temporary]);
    fs.renameSync(temporary, destination);
    return destination;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
