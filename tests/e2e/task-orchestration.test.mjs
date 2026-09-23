import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness } from '../helpers.mjs';

async function setup(t) { const h = await new Harness().start('runtime'); t.after(() => h.close()); return h; }
const summary = { task: 'text.rewrite', internal: true, input: { format: 'session-summary', sessions: [{
  id: 'session-one', engine: 'codex', start_at: '2026-09-22T01:00:00Z', end_at: '2026-09-22T01:05:00Z', summary: null,
  events: [{ kind: 'output', event_at: '2026-09-22T01:05:00Z', text: '정해진 범위의 수정과 검사를 마쳤습니다.' }]
}] } };

test('direct generation returns content only; service owns artifact persistence, code gates and frozen one-attempt budget', async t => {
  const h = await setup(t), run = await h.finish(await h.run(summary));
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
  const attempt = run.attempts[0], raw = JSON.parse(fs.readFileSync(path.join(attempt.directory, 'result.json')));
  assert.deepEqual(Object.keys(raw.result), ['content']);
  assert.equal(fs.readFileSync(run.artifact.file, 'utf8'), raw.result.content);
  assert.equal(JSON.parse(raw.result.content).description, '- 정해진 범위의 수정과 검사를 마쳤습니다.');
  const prompt = fs.readFileSync(path.join(attempt.directory, 'prompt.txt'), 'utf8');
  assert.match(prompt, /도구·스킬·파일 읽기\/쓰기·명령·하위 에이전트 호출 없이/);
  assert.doesNotMatch(prompt, /파일을 작업 디렉터리에 작성하세요/);
  const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'), { readOnly: true });
  const definition = JSON.parse(db.prepare('SELECT definition FROM runs WHERE id=?').get(run.id).definition); db.close();
  assert.equal(definition.worker_policy.max_agent_attempts, 1); assert.equal(definition.worker_policy.max_repairs, 0);
  assert.equal(definition.worker_policy.max_tool_calls, 0);
  assert.deepEqual(definition.execution_profile.stages.produce.codex, { model: 'gpt-5.6-luna', effort: 'high' });
});

test('factual summaries default to one generation; an explicit review request adds gates and professional design keeps them', async t => {
  const h = await setup(t);
  for (const task of ['meeting.summarize', 'progress.summarize']) {
    const base = { task, input: { requirements: '제공된 사실만 정리하세요.', source_text: '요구 검토를 완료했고 다음 배포 일자는 미정입니다.' } };
    const simple = await h.finish(await h.run(base));
    assert.equal(simple.status, 'completed', simple.message); assert.deepEqual(simple.attempts.map(a => a.stage), ['produce']);
    const invalid = await h.finish(await h.run({ ...base, fixture: { scenario: 'missing-section' } }));
    assert.equal(invalid.status, 'failed'); assert.equal(invalid.attempts.length, 1); assert.equal(invalid.artifact, null);
    const reviewed = await h.finish(await h.run({ ...base, review: { required: true, reason: '독립 대조를 요청했습니다.' }, fixture: { scenario: 'revise-once' } }));
    assert.equal(reviewed.status, 'completed', reviewed.message);
    assert.deepEqual(reviewed.attempts.map(a => a.stage), ['produce', 'review', 'repair', 'review']);
  }
  const prd = await h.finish(await h.run()); assert.equal(prd.status, 'completed');
  assert.deepEqual(prd.attempts.map(a => a.stage), ['produce', 'review']);
});

test('direct downstream text receives frozen predecessor contents without a file-reading tool', async t => {
  const h = await setup(t);
  const review = { required: false, reason: '제공된 사실의 짧은 형식 변환입니다.' };
  const accepted = await h.runtime('/plans', { method: 'POST', body: { engine: 'fixture', prompt: '원문 안내를 작성하고 변환본을 작성하세요.',
    steps: [
      { id: 'source', task: 'text.generate', input: { requirements: '원문 안내를 작성' }, review, depends_on: [], output_key: 'source', request_excerpt: '원문 안내를 작성' },
      { id: 'formatted', task: 'text.generate', input: { requirements: '변환본을 작성' }, review, depends_on: ['source'], output_key: 'formatted', request_excerpt: '변환본을 작성' }
    ], fixture: { copyInputSnapshot: true } } });
  // The first step has no references; fixture copying is meaningful only downstream.
  const { eventually } = await import('../helpers.mjs');
  const finished = await eventually(() => h.runtime(`/plans/${accepted.id}`), row => !['pending', 'running'].includes(row.status));
  assert.equal(finished.status, 'completed', finished.message);
  const run = await h.runtime(`/runs/${finished.steps[1].run_id}`);
  const prompt = fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8');
  assert.match(prompt, /고정된 자료 본문/);
  assert.ok(prompt.includes('REQ-001')); assert.equal(run.attempts.length, 1);
});
