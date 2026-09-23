import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, assert, atomic, json } from '../src/shared.mjs';

export function buildMac({ outputDir = path.join(ROOT, 'dist'), archive = true, stdio = 'inherit', onProgress = () => {} } = {}) {
  const run = (command, args) => { const result = spawnSync(command, args, { stdio }); assert(result.status === 0, `${command} 실패`); };
  // Check the actual runtime before replacing a previous successful build.
  const candidate = process.env.HARNESS_BUNDLE_NODE || process.execPath;
  const probe = spawnSync(candidate, [path.join(ROOT, 'scripts/node-probe.cjs'), '--portable'], { encoding: 'utf8', timeout: 15000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert(probe.status === 0, `앱에 포함할 Node를 확인하세요. make build는 로컬 Node 선택과 자동 준비를 지원합니다.\n${probe.stderr || probe.error?.message || ''}`);
  const node = probe.stdout.trim();
  assert(fs.existsSync(node), 'HARNESS_BUNDLE_NODE에 Node 22.17+ 실행 파일 경로를 지정하세요.');
  const app = path.resolve(outputDir, 'WorkLog.app'), contents = path.join(app, 'Contents'), resources = path.join(contents, 'Resources');
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true }); fs.mkdirSync(resources, { recursive: true });
  const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.worklog.harness</string><key>CFBundleName</key><string>WorkLog</string><key>CFBundleDisplayName</key><string>WorkLog</string>
<key>CFBundleIconFile</key><string>WorkLog.icns</string>
<key>CFBundleExecutable</key><string>WorkLog</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>4</string><key>CFBundleShortVersionString</key><string>0.3.1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
${process.env.HARNESS_GUI_DATA_DIR ? `<key>HarnessDataRoot</key><string>${xml(path.resolve(process.env.HARNESS_GUI_DATA_DIR))}</string>` : ''}
</dict></plist>`;
  atomic(path.join(contents, 'Info.plist'), plist);
  onProgress('앱 아이콘을 생성하고 GUI를 컴파일합니다.');
  run('swift', [path.join(ROOT, 'scripts/build-icons.swift'), path.join(ROOT, 'apps/macos/assets/worklog.svg'), path.join(resources, 'WorkLog.icns')]);
  run('swiftc', ['-O', '-target', 'arm64-apple-macos13.0', '-framework', 'Cocoa', '-framework', 'WebKit', path.join(ROOT, 'apps/macos/main.swift'), '-o', path.join(contents, 'MacOS/WorkLog')]);
  run('swiftc', ['-O', '-target', 'arm64-apple-macos13.0', '-framework', 'Security', '-framework', 'LocalAuthentication', path.join(ROOT, 'apps/macos/keychain.swift'), '-o', path.join(contents, 'MacOS/WorkLogKeychain')]);
  onProgress('실행 환경과 앱 리소스를 구성합니다.');
  fs.copyFileSync(node, path.join(contents, 'MacOS/node')); fs.chmodSync(path.join(contents, 'MacOS/node'), 0o755);
  const bundled = path.join(resources, 'harness'); fs.mkdirSync(bundled, { recursive: true });
  for (const folder of ['src', 'bin', 'harness', 'contracts', 'apps/web', 'skills']) fs.cpSync(path.join(ROOT, folder), path.join(bundled, folder), { recursive: true });
  // Recreate only this build's generated scripts directory; do not ship development fixture launchers.
  fs.rmSync(path.join(bundled, 'scripts'), { recursive: true, force: true });
  fs.mkdirSync(path.join(bundled, 'scripts'), { recursive: true });
  for (const file of ['install.mjs', 'replace-install.mjs', 'uninstall.mjs', 'install-state.mjs', 'install-output.mjs', 'agent-connections.mjs', 'service-control.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(bundled, 'scripts', file));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(bundled, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(bundled, 'package-lock.json'));
  for (const pkg of ['playwright', 'playwright-core', 'undici', 'ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string']) fs.cpSync(path.join(ROOT, 'node_modules', pkg), path.join(bundled, 'node_modules', pkg), { recursive: true });
  for (const license of ['LICENSE', 'LICENSE.md']) if (fs.existsSync(path.join(path.dirname(node), '..', license))) fs.copyFileSync(path.join(path.dirname(node), '..', license), path.join(resources, `node-${license}`));
  onProgress('앱에 서명하고 빌드 결과를 확인합니다.');
  run('codesign', ['--force', '--deep', '--sign', '-', app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  let archivePath = null;
  if (archive) {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-package-'));
    try {
      const packageDir = path.join(stage, 'WorkLog');
      fs.mkdirSync(packageDir);
      fs.cpSync(app, path.join(packageDir, 'WorkLog.app'), { recursive: true });
      atomic(path.join(packageDir, 'Install WorkLog.command'), '#!/bin/zsh\nset -eu\nPACKAGE_DIR="${0:A:h}"\n"$PACKAGE_DIR/WorkLog.app/Contents/MacOS/node" "$PACKAGE_DIR/WorkLog.app/Contents/Resources/harness/scripts/install.mjs" --apply\n');
      fs.chmodSync(path.join(packageDir, 'Install WorkLog.command'), 0o755);
      atomic(path.join(packageDir, 'Uninstall WorkLog.command'), '#!/bin/zsh\nset -eu\nPACKAGE_DIR="${0:A:h}"\n"$PACKAGE_DIR/WorkLog.app/Contents/MacOS/node" "$PACKAGE_DIR/WorkLog.app/Contents/Resources/harness/scripts/uninstall.mjs" --apply\n');
      fs.chmodSync(path.join(packageDir, 'Uninstall WorkLog.command'), 0o755);
      atomic(path.join(packageDir, 'INSTALL.txt'), 'WorkLog 0.3.1 · macOS Apple Silicon\n\nInstall WorkLog.command는 ~/Applications 앱과 WorkLog 백그라운드 서비스만 설치합니다. Claude/Codex 설정은 변경하지 않습니다.\n앱의 연결 설정에서 Claude와 Codex를 각각 연결하거나 해제하세요. 연결 시 요청 스킬의 심링크와 기록 훅을 추가하고 기존 설정을 보존합니다.\nUninstall WorkLog.command는 앱에서 연결한 훅·스킬 연결을 포함해 WorkLog 소유 설치 항목을 제거합니다. 업무 DB·사용자 등록 작업 유형·산출물·로그·Keychain 토큰은 보존합니다.\n먼저 사내 허용 정책을 확인하세요. 기존 WorkLog 설치는 소유 기록을 확인해 재설치하며 업무 데이터와 에이전트 연결을 유지합니다.\n이 빌드는 개발용 ad-hoc 서명이며 공증되지 않았습니다.\n');
      archivePath = path.resolve(outputDir, 'WorkLog-macos-arm64.zip');
      run('ditto', ['-c', '-k', '--keepParent', packageDir, archivePath]);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  return { app, archive: archivePath, signing: 'local ad-hoc; not notarized', test_data_root: process.env.HARNESS_GUI_DATA_DIR || null };
}

const invokedAsProgram = process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedAsProgram) console.log(json(buildMac()));
