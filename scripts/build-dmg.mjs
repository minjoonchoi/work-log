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
    const installer = path.join(volume, 'WorkLog 설치.app'), contents = path.join(installer, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    fs.cpSync(app, path.join(contents, 'Resources/WorkLog.app'), { recursive: true, verbatimSymlinks: true });
    fs.copyFileSync(path.join(app, 'Contents/Resources/WorkLog.icns'), path.join(contents, 'Resources/WorkLog.icns'));
    fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.worklog.installer</string><key>CFBundleName</key><string>WorkLog 설치</string><key>CFBundleExecutable</key><string>WorkLogInstaller</string><key>CFBundleIconFile</key><string>WorkLog.icns</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>13.0</string></dict></plist>');
    run('swiftc', ['-O', '-target', 'arm64-apple-macos13.0', '-framework', 'Cocoa', path.join(ROOT, 'apps/macos/installer.swift'), '-o', path.join(contents, 'MacOS/WorkLogInstaller')]);
    run('codesign', ['--force', '--sign', '-', installer]);
    run('codesign', ['--verify', '--deep', '--strict', installer]);
    fs.writeFileSync(path.join(volume, '설치 안내.txt'), 'WorkLog 설치.app을 더블클릭하세요.\n현재 사용자의 ~/Applications/WorkLog.app에 설치합니다.\n기존 업무 기록과 설정은 유지됩니다. /Applications의 이전 앱은 변경하지 않습니다.\n');
    const temporary = path.join(stage, 'WorkLog.dmg'), destination = path.resolve(outputDir, 'WorkLog-macos-arm64.dmg');
    run('hdiutil', ['create', '-volname', 'WorkLog', '-srcfolder', volume, '-format', 'UDZO', '-ov', temporary]);
    run('hdiutil', ['verify', temporary]);
    fs.renameSync(temporary, destination);
    return destination;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
