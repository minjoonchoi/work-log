import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shared.mjs';

test('native CLI resolves symlinks, preserves arguments/environment/cwd and propagates exit codes', { skip: process.platform !== 'darwin' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mac = path.join(root, 'Work Log.app/Contents/MacOS');
  const scripts = path.join(root, 'Work Log.app/Contents/Resources/harness/bin');
  fs.mkdirSync(mac, { recursive: true }); fs.mkdirSync(scripts, { recursive: true });
  const helpers = path.join(root, 'Work Log.app/Contents/Helpers'); fs.mkdirSync(helpers);
  const binary = path.join(helpers, 'worklog');
  const build = spawnSync('clang', ['-Wall', '-Wextra', '-Werror', path.join(ROOT, 'apps/macos/cli.c'), '-o', binary], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  fs.symlinkSync(process.execPath, path.join(mac, 'node'));
  fs.writeFileSync(path.join(scripts, 'harness.mjs'), 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.WORKLOG_CLI_TEST})); process.exitCode=23;');
  const link = path.join(root, 'worklog'); fs.symlinkSync(binary, link);
  const result = spawnSync(link, ['query', 'items', '--search', '공백 " $() 포함'], {
    cwd: root, env: { ...process.env, WORKLOG_CLI_TEST: 'preserved' }, encoding: 'utf8'
  });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['query', 'items', '--search', '공백 " $() 포함'], cwd: fs.realpathSync(root), value: 'preserved' });
  fs.unlinkSync(path.join(mac, 'node'));
  const missing = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(missing.status, 127); assert.match(missing.stderr, /cannot start bundled runtime/);
});
