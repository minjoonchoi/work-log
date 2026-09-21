import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Harness } from '../helpers.mjs';

test('new metadata requires all four Markdown sections without a repair call; accepted artifacts retain the source', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const request = { task: 'text.rewrite', internal: true, input: { format: 'work-item-metadata', sessions: [{
    id: 'session-structured', engine: 'codex', start_at: '2026-09-19T00:00:00Z', end_at: '2026-09-19T00:01:00Z', summary: null,
    events: [{ kind: 'input', event_at: '2026-09-19T00:00:00Z', text: '초대 정책을 정리해 주세요.' }]
  }] } };
  for (const scenario of ['rewrite-legacy-paragraph', 'rewrite-empty-section']) {
    const run = await h.finish(await h.run({ ...request, fixture: { scenario } }));
    assert.equal(run.status, 'failed', run.message); assert.equal(run.artifact, null);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
  }
  const accepted = await h.finish(await h.run(request));
  assert.equal(accepted.status, 'completed', accepted.message);
  const result = JSON.parse(fs.readFileSync(accepted.artifact.file, 'utf8'));
  assert.deepEqual([...result.description.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['작업 배경', '목적', '범위', '결과']);
  assert.match(result.description, /미완료|미확인/); assert.equal(accepted.attempts.length, 1);
});
