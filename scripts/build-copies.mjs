import fs from 'node:fs';
import path from 'node:path';
import { safePath } from './install-state.mjs';

export function assertWorkLogBuild(root, app) {
  safePath(root, app);
  const plist = path.join(app, 'Contents/Info.plist');
  const manifest = path.join(app, 'Contents/Resources/harness/package.json');
  safePath(root, plist); safePath(root, manifest);
  if (!/<key>CFBundleIdentifier<\/key>\s*<string>local\.worklog\.harness<\/string>/.test(fs.readFileSync(plist, 'utf8'))
    || JSON.parse(fs.readFileSync(manifest, 'utf8')).name !== 'work-log') throw new Error('WorkLog 빌드 앱인지 확인되지 않아 보존합니다.');
}

export function cleanReleaseApps(outputDir) {
  const root = path.resolve(outputDir), removed = [], preserved = [];
  for (const relative of ['WorkLog.app', 'package/WorkLog/WorkLog.app']) {
    const app = path.join(root, relative);
    try {
      if (!fs.existsSync(app)) continue;
      assertWorkLogBuild(root, app);
      fs.rmSync(app, { recursive: true }); removed.push(app);
    } catch (error) { preserved.push({ path: app, reason: error.message }); }
  }
  return { removed, preserved };
}
