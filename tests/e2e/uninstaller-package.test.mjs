import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shared.mjs';

const app = path.join(ROOT, 'dist/WorkLog.app');
for (const dragged of [false, true]) test(`staged GUI removal survives ${dragged ? 'drag installation' : 'standard installation'} and preserves work data`, {
  skip: process.platform !== 'darwin' || !fs.existsSync(path.join(app, 'Contents/Helpers/WorkLog Uninstaller.app'))
}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-ui-uninstall-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'Team User'); fs.mkdirSync(home);
  const run = (node, script, args) => {
    const result = spawnSync(node, [script, ...args], { encoding: 'utf8', timeout: 90000 });
    assert.equal(result.status, 0, result.stderr + result.stdout); return result;
  };
  const installed = path.join(home, 'Applications/WorkLog.app');
  if (dragged) {
    fs.cpSync(app, installed, { recursive: true });
    const script = pathToFileURL(path.join(installed, 'Contents/Resources/harness/scripts/first-launch.mjs')).href;
    const result = spawnSync(path.join(installed, 'Contents/MacOS/node'), ['--input-type=module', '-e',
      `import { installDraggedApp } from ${JSON.stringify(script)}; installDraggedApp(${JSON.stringify(installed)}, { homeDir: ${JSON.stringify(home)}, activate: false });`], { encoding: 'utf8', timeout: 90000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } else run(path.join(app, 'Contents/MacOS/node'), path.join(app, 'Contents/Resources/harness/scripts/install.mjs'),
    ['--apply', '--no-activate', '--source-app', app, '--home-dir', home, '--output', path.join(temp, 'plan')]);
  const stage = path.join(temp, 'outside-app'); fs.mkdirSync(stage);
  fs.cpSync(path.join(installed, 'Contents/MacOS/node'), path.join(stage, 'node'));
  fs.cpSync(path.join(installed, 'Contents/Resources/harness'), path.join(stage, 'harness'), { recursive: true });
  const marker = path.join(home, 'Library/Application Support/WorkLog/work-record.txt'); fs.writeFileSync(marker, 'keep');
  run(path.join(stage, 'node'), path.join(stage, 'harness/scripts/uninstall.mjs'), ['--apply', '--no-deactivate', '--home-dir', home]);
  assert.equal(fs.existsSync(installed), false);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(stage, 'node')), true);
  run(path.join(stage, 'node'), path.join(stage, 'harness/scripts/uninstall.mjs'), ['--apply', '--no-deactivate', '--home-dir', home]);
});
