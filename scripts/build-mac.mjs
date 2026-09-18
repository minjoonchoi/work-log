import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, assert, atomic, json } from '../src/shared.mjs';

function run(command, args) { const result = spawnSync(command, args, { stdio: 'inherit' }); assert(result.status === 0, `${command} 실패`); }
const app = path.join(ROOT, 'dist/WorkLog.app'), contents = path.join(app, 'Contents'), resources = path.join(contents, 'Resources');
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true }); fs.mkdirSync(resources, { recursive: true });
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.worklog.harness</string><key>CFBundleName</key><string>WorkLog</string><key>CFBundleDisplayName</key><string>WorkLog</string>
<key>CFBundleExecutable</key><string>WorkLog</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>4</string><key>CFBundleShortVersionString</key><string>0.3.1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
${process.env.HARNESS_GUI_DATA_DIR ? `<key>HarnessDataRoot</key><string>${xml(path.resolve(process.env.HARNESS_GUI_DATA_DIR))}</string>` : ''}
</dict></plist>`;
atomic(path.join(contents, 'Info.plist'), plist);
run('swiftc', ['-O', '-target', 'arm64-apple-macos13.0', '-framework', 'Cocoa', '-framework', 'WebKit', path.join(ROOT, 'apps/macos/main.swift'), '-o', path.join(contents, 'MacOS/WorkLog')]);
run('swiftc', ['-O', '-target', 'arm64-apple-macos13.0', '-framework', 'Security', '-framework', 'LocalAuthentication', path.join(ROOT, 'apps/macos/keychain.swift'), '-o', path.join(contents, 'MacOS/WorkLogKeychain')]);
const node = process.env.HARNESS_BUNDLE_NODE || path.join(os.homedir(), '.nvm/versions/node/v22.17.0/bin/node');
assert(fs.existsSync(node), 'HARNESS_BUNDLE_NODE에 독립 배포 가능한 Node 22.17+ 실행 파일을 지정하세요.');
const libraries = spawnSync('otool', ['-L', node], { encoding: 'utf8' }).stdout;
assert(!libraries.includes('/opt/homebrew/') && !libraries.includes('/usr/local/opt/'), 'Homebrew 동적 라이브러리에 의존하는 Node는 번들링할 수 없습니다.');
fs.copyFileSync(node, path.join(contents, 'MacOS/node')); fs.chmodSync(path.join(contents, 'MacOS/node'), 0o755);
const bundled = path.join(resources, 'harness'); fs.mkdirSync(bundled, { recursive: true });
for (const folder of ['src', 'bin', 'harness', 'contracts', 'apps/web', 'skills']) fs.cpSync(path.join(ROOT, folder), path.join(bundled, folder), { recursive: true });
// Recreate only this build's generated scripts directory; do not ship development fixture launchers.
fs.rmSync(path.join(bundled, 'scripts'), { recursive: true, force: true });
fs.mkdirSync(path.join(bundled, 'scripts'), { recursive: true });
for (const file of ['install.mjs', 'uninstall.mjs', 'install-state.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(bundled, 'scripts', file));
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(bundled, 'package.json'));
fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(bundled, 'package-lock.json'));
for (const pkg of ['playwright', 'playwright-core', 'ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string']) fs.cpSync(path.join(ROOT, 'node_modules', pkg), path.join(bundled, 'node_modules', pkg), { recursive: true });
for (const license of ['LICENSE', 'LICENSE.md']) if (fs.existsSync(path.join(path.dirname(node), '..', license))) fs.copyFileSync(path.join(path.dirname(node), '..', license), path.join(resources, `node-${license}`));
run('codesign', ['--force', '--deep', '--sign', '-', app]);
run('codesign', ['--verify', '--deep', '--strict', app]);
const packageDir = path.join(ROOT, 'dist/package/WorkLog');
fs.rmSync(packageDir, { recursive: true, force: true }); fs.mkdirSync(packageDir, { recursive: true });
fs.cpSync(app, path.join(packageDir, 'WorkLog.app'), { recursive: true });
atomic(path.join(packageDir, 'Install WorkLog.command'), '#!/bin/zsh\nset -eu\nPACKAGE_DIR="${0:A:h}"\n"$PACKAGE_DIR/WorkLog.app/Contents/MacOS/node" "$PACKAGE_DIR/WorkLog.app/Contents/Resources/harness/scripts/install.mjs" --apply\n');
fs.chmodSync(path.join(packageDir, 'Install WorkLog.command'), 0o755);
atomic(path.join(packageDir, 'Uninstall WorkLog.command'), '#!/bin/zsh\nset -eu\nPACKAGE_DIR="${0:A:h}"\n"$PACKAGE_DIR/WorkLog.app/Contents/MacOS/node" "$PACKAGE_DIR/WorkLog.app/Contents/Resources/harness/scripts/uninstall.mjs" --apply\n');
fs.chmodSync(path.join(packageDir, 'Uninstall WorkLog.command'), 0o755);
atomic(path.join(packageDir, 'INSTALL.txt'), 'WorkLog 0.3.1 · macOS Apple Silicon\n\nInstall WorkLog.command 실행 시 ~/Applications 앱, 사용자 LaunchAgent 3개, Claude/Codex 기록 훅을 설치합니다. 기존 훅을 보존하고 설정 백업과 소유 기록을 남깁니다.\nUninstall WorkLog.command는 소유 기록과 일치하는 훅·스킬 연결·설치 파일만 제거합니다. 업무 DB·산출물·로그·Keychain 토큰은 보존합니다.\n먼저 사내 허용 정책을 확인하세요. 기존 설치는 덮어쓰지 않습니다.\n이 빌드는 개발용 ad-hoc 서명이며 공증되지 않았습니다.\n');
run('ditto', ['-c', '-k', '--keepParent', packageDir, path.join(ROOT, 'dist/WorkLog-macos-arm64.zip')]);
console.log(json({ app, archive: path.join(ROOT, 'dist/WorkLog-macos-arm64.zip'), signing: 'local ad-hoc; not notarized', test_data_root: process.env.HARNESS_GUI_DATA_DIR || null }));
