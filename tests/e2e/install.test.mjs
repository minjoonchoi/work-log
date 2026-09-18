import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareInstall, applyInstall } from '../../scripts/install.mjs';

test('installer dry run leaves user settings alone; isolated installation preserves all existing hooks and settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-install-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const homeDir = path.join(dir, "User's Home"), sourceApp = path.join(dir, 'Source.app');
  fs.mkdirSync(path.join(sourceApp, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(sourceApp, 'Contents/Resources/harness'), { recursive: true });
  fs.writeFileSync(path.join(sourceApp, 'Contents/MacOS/node'), 'test-node-placeholder');
  fs.writeFileSync(path.join(sourceApp, 'Contents/MacOS/WorkLogKeychain'), 'test-keychain-placeholder');
  fs.writeFileSync(path.join(sourceApp, 'Contents/Resources/harness/immutable.txt'), 'v1');
  const config = { model: 'preserve-me', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'company-required-hook' }] }] } };
  for (const file of ['.codex/hooks.json', '.claude/settings.json']) {
    fs.mkdirSync(path.dirname(path.join(homeDir, file)), { recursive: true }); fs.writeFileSync(path.join(homeDir, file), JSON.stringify(config));
  }
  const plan = prepareInstall({ output: path.join(dir, 'plan'), homeDir, sourceApp });
  assert.equal(fs.existsSync(plan.targetApp), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeDir, '.codex/hooks.json'))), config);
  const result = applyInstall(plan, { homeDir, activate: false });
  assert.equal(result.activated, false);
  for (const file of ['.codex/hooks.json', '.claude/settings.json']) {
    const after = JSON.parse(fs.readFileSync(path.join(homeDir, file)));
    assert.equal(after.model, 'preserve-me'); assert.equal(after.hooks.Stop[0].hooks[0].command, 'company-required-hook');
    assert.equal(after.hooks.Stop.length, 2); assert.equal(after.hooks.UserPromptSubmit.length, 1);
  }
  assert.equal(fs.readFileSync(path.join(plan.runtimeRoot, 'harness/immutable.txt'), 'utf8'), 'v1');
  assert.equal(fs.readFileSync(path.join(plan.runtimeRoot, 'WorkLogKeychain'), 'utf8'), 'test-keychain-placeholder');
  assert.equal(plan.files.length, 3);
  assert.equal(plan.hooks.claude.hooks.PostToolUseFailure.length, 1);
  assert.equal(plan.hooks.codex.hooks.PostToolUseFailure, undefined);
  assert.ok(plan.files.some(file => file.content.includes('<string>--background</string>')));
  assert.throws(() => applyInstall(plan, { homeDir, activate: false }), /이미 설치/);
});
