import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, assert, atomic } from '../src/shared.mjs';

export function buildDMG(app, outputDir, { run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  assert(result.status === 0, `${command} 실패`);
} } = {}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-dmg-'));
  try {
    const volume = path.join(stage, 'volume'), installer = path.join(volume, 'WorkLog 설치.app');
    const contents = path.join(installer, 'Contents'), resources = path.join(contents, 'Resources');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true }); fs.mkdirSync(resources, { recursive: true });
    fs.cpSync(app, path.join(resources, 'WorkLog.app'), { recursive: true });
    fs.copyFileSync(path.join(app, 'Contents/Resources/WorkLog.icns'), path.join(resources, 'WorkLog.icns'));
    atomic(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.worklog.installer</string>
<key>CFBundleName</key><string>WorkLog 설치</string><key>CFBundleExecutable</key><string>WorkLogInstaller</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>WorkLog.icns</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/></dict></plist>`);
    run('swiftc', ['-O', '-target', 'arm64-apple-macos13.0', '-framework', 'Cocoa', path.join(ROOT, 'apps/macos/installer.swift'), '-o', path.join(contents, 'MacOS/WorkLogInstaller')]);
    run('codesign', ['--force', '--sign', '-', installer]);
    run('codesign', ['--verify', '--deep', '--strict', installer]);
    atomic(path.join(volume, '설치 안내.txt'), 'WorkLog · macOS 13 이상 / Apple Silicon\n\n1. WorkLog 설치 앱을 더블클릭합니다.\n2. 설치 버튼을 누릅니다.\n3. 설치 완료 후 WorkLog 열기를 누르고 연결 설정을 진행합니다.\n\n~/Applications/WorkLog.app에 설치되며 기존 업무 기록은 유지됩니다.\n설치 후 이 디스크 이미지를 추출해도 됩니다.\n현재 개발용 ad-hoc 서명이며 Apple 공증은 포함되지 않았습니다. 회사 보안 정책에 따라 실행 승인이 필요할 수 있습니다.\n');
    const temporary = path.join(stage, 'WorkLog.dmg'), destination = path.resolve(outputDir, 'WorkLog-macos-arm64.dmg');
    run('hdiutil', ['create', '-volname', 'WorkLog 설치', '-srcfolder', volume, '-format', 'UDZO', '-ov', temporary]);
    run('hdiutil', ['verify', temporary]);
    fs.renameSync(temporary, destination);
    return destination;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
