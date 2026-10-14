import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDMG } from '../../scripts/build-dmg.mjs';

for (const fail of [false, true]) test(`DMG packaging ${fail ? 'preserves previous image on failure' : 'includes per-user installer and payload without a machine-specific link'}`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-dmg-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'WorkLog.app'), target = path.join(dir, 'WorkLog-macos-arm64.dmg');
  fs.mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Resources/WorkLog.icns'), 'icon');
  fs.writeFileSync(target, 'previous');
  let staging;
  const run = (cmd, args) => {
    if (cmd !== 'hdiutil') return;
    if (args[0] === 'create') {
      const volume = args[args.indexOf('-srcfolder') + 1]; staging = path.dirname(volume);
      assert.ok(fs.existsSync(path.join(volume, 'WorkLog 설치.app/Contents/Resources/WorkLog.app/Contents/Resources/WorkLog.icns')));
      assert.equal(fs.existsSync(path.join(volume, 'Applications')), false);
      assert.match(fs.readFileSync(path.join(volume, '설치 안내.txt'), 'utf8'), /~\/Applications/);
      assert.match(fs.readFileSync(path.join(volume, 'WorkLog 설치.app/Contents/Info.plist'), 'utf8'), /WorkLogInstaller/);
      fs.writeFileSync(args.at(-1), 'new image');
    } else if (fail) throw new Error('verification failed');
  };
  if (fail) assert.throws(() => buildDMG(app, dir, { run }), /verification failed/);
  else assert.equal(buildDMG(app, dir, { run }), target);
  assert.equal(fs.readFileSync(target, 'utf8'), fail ? 'previous' : 'new image');
  assert.equal(fs.existsSync(staging), false);
});
