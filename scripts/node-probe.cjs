// This probe must also run on older Node versions so bootstrap failures are actionable.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 17) || process.versions.node.includes('-')) {
    throw new Error(`Node 22.17.0 이상이 필요합니다 (현재 ${process.version}).`);
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try { db.prepare('SELECT 1').get(); } finally { db.close(); }
  const node = fs.realpathSync(process.execPath);
  if (process.argv.includes('--portable')) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      throw new Error('현재 앱 빌드는 macOS Apple Silicon(arm64) Node를 사용합니다.');
    }
    const result = spawnSync('otool', ['-L', node], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0 || !result.stdout?.trim()) throw new Error('Node 의존성 검사에 실패했습니다. Xcode Command Line Tools의 otool을 확인하세요.');
    const libraries = result.stdout.trim().split('\n').slice(1).map(line => line.trim().split(' (')[0]);
    if (!libraries.length || libraries.some(lib => !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/Library/'))) {
      throw new Error('앱에 포함할 Node는 macOS 시스템 라이브러리만 참조해야 합니다. Homebrew 등의 외부 라이브러리에 의존하는 Node 대신 nvm/공식 배포본을 지정하세요.');
    }
  }
  process.stdout.write(`${node}\n`);
} catch (error) {
  process.stderr.write(`WorkLog: ${error.message}\n`);
  process.exitCode = 1;
}
