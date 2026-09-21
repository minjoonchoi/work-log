import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../tests/helpers.mjs';
import { ROOT, atomic, json, id } from '../src/shared.mjs';

// The harness exercises its own registered checks and renderer. No model is selected.
const dir = path.join(ROOT, 'output/self-verification', new Date().toISOString().replaceAll(':', '-'));
const h = new Harness(dir); h.testMode = false;
const workItemId = id('item-');
let result;
try {
  await h.start('runtime'); await h.start('manager');
  const run = await h.runtime('/runs', { method: 'POST', body: {
    prompt: '하네스 서비스와 GUI의 E2E 검사를 실행해 주세요.', task: 'checks.run', work_item_id: workItemId, input: { profile: process.argv[2] || 'harness.e2e' }
  } });
  const checked = await h.finish(run, 540000);
  const report = await h.runtime('/runs', { method: 'POST', body: {
    prompt: '방금 수행한 검사의 실행 근거 보고서를 작성해 주세요.', task: 'verification.report', work_item_id: workItemId, input: { run_ids: [run.id] }
  } });
  const rendered = await h.finish(report);
  result = { checked_at: new Date().toISOString(), data_root: dir, checks: checked, report: rendered,
    passed: checked.status === 'completed' && rendered.status === 'completed' };
  if (rendered.artifact) fs.copyFileSync(rendered.artifact.file, path.join(dir, 'verification.md'));
  atomic(path.join(dir, 'result.json'), json(result));
  atomic(path.join(ROOT, 'output/self-verification/latest.json'), json({ result: path.join(dir, 'result.json'), report: path.join(dir, 'verification.md'), passed: result.passed }));
  if (!result.passed) process.exitCode = 1;
} finally { await h.close(false); }
console.log(json({ passed: result?.passed || false, result: path.join(dir, 'result.json'), report: path.join(dir, 'verification.md') }));
