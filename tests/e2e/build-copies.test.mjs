import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanReleaseApps } from '../../scripts/build-copies.mjs';

function bundle(app) {
  fs.mkdirSync(path.join(app, 'Contents/Resources/harness'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<key>CFBundleIdentifier</key><string>local.worklog.harness</string>');
  fs.writeFileSync(path.join(app, 'Contents/Resources/harness/package.json'), '{"name":"work-log"}');
}
test('release cleanup removes recognized legacy apps, preserving archives and unrelated files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-release-clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['WorkLog.app','package/WorkLog/WorkLog.app']) bundle(path.join(root,name));
  for (const name of ['WorkLog-macos-arm64.dmg','WorkLog-macos-arm64.zip','notes.txt']) fs.writeFileSync(path.join(root,name),name);
  const result=cleanReleaseApps(root);
  assert.equal(result.removed.length,2); assert.deepEqual(result.preserved,[]);
  for (const name of ['WorkLog-macos-arm64.dmg','WorkLog-macos-arm64.zip','notes.txt']) assert.equal(fs.readFileSync(path.join(root,name),'utf8'),name);
});
test('release cleanup preserves unrecognized apps and never follows a linked app', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'worklog-release-clean-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const output=path.join(root,'dist'); fs.mkdirSync(output);
  const external=path.join(root,'external.app'); bundle(external);
  fs.symlinkSync(external,path.join(output,'WorkLog.app'));
  const unknown=path.join(output,'package/WorkLog/WorkLog.app'); fs.mkdirSync(unknown,{recursive:true});
  fs.writeFileSync(path.join(unknown,'user.txt'),'keep');
  const result=cleanReleaseApps(output); assert.equal(result.removed.length,0); assert.equal(result.preserved.length,2);
  assert.ok(fs.existsSync(external)); assert.equal(fs.readFileSync(path.join(unknown,'user.txt'),'utf8'),'keep');
});
