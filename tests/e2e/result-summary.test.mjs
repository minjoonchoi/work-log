import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Harness } from '../helpers.mjs';
import { parseResultSummary } from '../../src/result-summary.mjs';

const input = { title: '초대 권한 수정', description: 'h2. 목표\n일반 팀원의 초대를 거부한다.', sessions: [{
  id: 'session-result', engine: 'codex', start_at: '2026-09-21T01:00:00Z', end_at: '2026-09-21T01:05:00Z', summary: null,
  events: [{ kind: 'input', event_at: '2026-09-21T01:00:00Z', text: '초대 권한을 수정하세요.' },
    { kind: 'output', event_at: '2026-09-21T01:05:00Z', text: '비관리자 초대를 거부하도록 수정했고 회귀 테스트 3개가 통과했습니다. 배포는 수행하지 않았습니다.' }]
}] };

test('completion result uses one headless generation, format validation and configured backend settings', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const task = (await h.runtime('/execution-settings')).tasks.find(task => task.id === 'work-item.result.summarize');
  assert.equal(task.backend, 'codex'); assert.deepEqual(Object.keys(task.backends.codex.defaults), ['produce']);
  assert.match(task.instruction, /완료 근거|완료 사실|완료로/);
  const run = await h.finish(await h.run({ task: task.id, input, internal: true }));
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
  assert.equal(run.artifact.validation_scope, 'format');
  const value = parseResultSummary(fs.readFileSync(run.artifact.file, 'utf8'));
  assert.match(value.text, /비관리자.*회귀 테스트 3개.*배포는 수행하지 않았/);
  assert.doesNotMatch(value.text, /[\r\n]/);
  const prompt = fs.readFileSync(`${run.attempts[0].directory}/prompt.txt`, 'utf8');
  assert.match(prompt, /Done 상태 자체를.*증거/);
  assert.match(prompt, /Jira 상태 변경·댓글 게시/);
});

test('empty history remains unconfirmed and malformed result never receives a second model call', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const run = await h.finish(await h.run({ task: 'work-item.result.summarize', input: { ...input, sessions: [] }, internal: true }));
  assert.equal(run.status, 'completed', run.message);
  assert.match(parseResultSummary(fs.readFileSync(run.artifact.file, 'utf8')).text, /결과는 미확인/);
  for (const scenario of ['result-summary-invalid', 'result-summary-list']) {
    const failed = await h.finish(await h.run({ task: 'work-item.result.summarize', input, internal: true, fixture: { scenario } }));
    assert.equal(failed.status, 'failed'); assert.equal(failed.artifact, null);
    assert.equal(failed.attempts.length, 1); assert.match(failed.message, /형식 검사/);
  }
});

test('completion contract rejects additional fields and paragraph separators rather than flattening them silently', () => {
  for (const value of [{ text: '결과', title: '제목' }, { text: '  ' }, { text: '결과\n' }, { text: '첫 결과\u2028다음 결과' },
    { text: 'h2. 결과' }, { text: '1. 결과' }, { text: 'x'.repeat(1501) }]) {
    assert.throws(() => parseResultSummary(JSON.stringify(value)));
  }
  assert.deepEqual(parseResultSummary(JSON.stringify({ text: '결과를 확인했습니다. 배포 여부는 미확인입니다.' })),
    { text: '결과를 확인했습니다. 배포 여부는 미확인입니다.' });
});
