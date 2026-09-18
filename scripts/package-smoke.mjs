import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Harness, eventually } from '../tests/helpers.mjs';
import { ROOT, atomic } from '../src/shared.mjs';

const app = path.join(ROOT, 'dist/WorkLog.app');
const h = new Harness(); h.executable = path.join(app, 'Contents/MacOS/node');
h.serviceRoot = path.join(app, 'Contents/Resources/harness'); h.testMode = false;
const report = { checked_at: new Date().toISOString(), app, checks: [] };
try {
  assert.ok(!fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8').includes('HarnessDataRoot')); report.checks.push('release app contains no development data-root override');
  const node = spawnSync(h.executable, ['--version'], { encoding: 'utf8' }); assert.equal(node.status, 0); report.node = node.stdout.trim();
  await h.start('runtime'); await h.start('manager');
  assert.equal((await h.runtime('/health')).role, 'execution'); assert.equal((await h.manager('/health')).role, 'management');
  report.checks.push('bundled Node and bundled service code start independently');
  for (const engine of ['codex', 'claude']) {
    h.hook(engine, { hook_event_name: 'UserPromptSubmit', session_id: 'package-session', turn_id: 'one', prompt: `${engine} 설치 패키지 검증` });
    h.hook(engine, { hook_event_name: 'Stop', session_id: 'package-session', turn_id: 'one', last_assistant_message: '패키지 훅 이력 검증' });
  }
  const items = await eventually(() => h.manager('/items'), rows => rows.length === 2 && rows.every(r => r.session_count === 1));
  for (const item of items) assert.equal((await h.manager(`/items/${item.id}`)).sessions[0].pending, false);
  report.checks.push('bundled hooks feed SQLite and management API for both engines');
  await assert.rejects(h.run(), /지원하지 않는 엔진/); report.checks.push('fixture execution disabled in normal packaged service');
  const catalog = await h.runtime('/catalog');
  assert.ok(['test.scenarios.plan', 'checks.run', 'verification.report'].every(id => catalog.jobs.some(j => j.id === id)));
  assert.ok(catalog.check_profiles.every(p => !p.id.startsWith('fixture.')));
  assert.ok(catalog.jobs.every(j => j.input_schema));
  await assert.rejects(h.runtime('/runs', { method: 'POST', body: { task: 'prd.create', input: {} } }), /input.*위반/);
  const checkRun = await h.finish(await h.runtime('/runs', { method: 'POST', body: { task: 'checks.run', input: { profile: 'harness.e2e' } } }));
  assert.equal(checkRun.status, 'blocked', 'the release app does not pretend to execute absent development tests');
  assert.ok((await h.runtime(`/runs/${checkRun.id}/evidence`)).data.checks.every(c => c.status === 'not_run'));
  assert.equal(checkRun.steps[0].next_node, '$blocked');
  const rendered = await h.finish(await h.runtime('/runs', { method: 'POST', body: { task: 'verification.report', input: { run_ids: [checkRun.id] } } }));
  assert.equal(rendered.status, 'completed'); assert.equal(rendered.steps[0].next_node, '$completed');
  report.checks.push('reusable jobs bundled; absent development test sources produce not_run evidence');
  report.checks.push('bundled schemas validate structured inputs; local workflow produces a report with recorded transitions');
  assert.equal(spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status, 0); report.checks.push('ad-hoc signature verification');
  assert.equal(spawnSync('unzip', ['-tq', path.join(ROOT, 'dist/WorkLog-macos-arm64.zip')]).status, 0); report.checks.push('distribution ZIP integrity');
  report.passed = true;
} finally { await h.close(); }
atomic(path.join(ROOT, 'output/package-validation.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
