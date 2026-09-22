import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';

// This checks instruction delivery and the existing execution/output contract.
// Fixture text does not establish the factual accuracy of real-model summaries.
test('metadata and both summary paths receive contribution evidence guidance without extra calls or output fields', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const events = [
    { kind: 'input', event_at: '2026-09-19T00:00:00Z', text: '목표는 처리 시간 30% 개선입니다. 팀에서 정한 API 계약을 참고하여 성능 확인 계획을 정리해 주세요.' },
    { kind: 'output', event_at: '2026-09-19T00:05:00Z', text: '사용자는 API 계약을 확정했고 에이전트는 docs/performance-plan.md를 작성했습니다. 협업자와 측정 조건을 합의했습니다. 이번 fixture 검사는 12개 중 12개가 통과했지만 운영 처리 시간은 아직 측정하지 않았습니다.' }
  ];
  const sessions = [{ id: 'performance-source', engine: 'codex', start_at: events[0].event_at, end_at: events[1].event_at, summary: null, events }];
  const requests = [
    { task: 'session.summarize', input: { title: '성능 확인 계획', events } },
    { task: 'text.rewrite', input: { format: 'session-summary', sessions } },
    { task: 'text.rewrite', input: { format: 'work-item-metadata', sessions } }
  ];
  for (const request of requests) {
    const run = await h.finish(await h.run({ ...request, prompt: '제공된 이력에서 확인한 작업만 기록하세요.', internal: true }));
    assert.equal(run.status, 'completed', run.message);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
    assert.deepEqual(run.steps.map(step => step.task), ['produce', 'verify', 'render']);
    const prompt = fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8');
    for (const criterion of ['분기·반기·연간', '역할·행동·산출물·결과', '사용자·에이전트·협업자', '목표 수치와 관측 결과',
      '측정 범위·기간', '근거 없는 영향·KPI·개선율·절감 시간', '팀 성과의 개인 기여', '파일·이슈·검사 결과']) {
      assert.ok(prompt.includes(criterion), `${request.task}/${request.input.format || 'plain'} prompt omitted ${criterion}`);
    }
    assert.ok(prompt.includes(events[0].text)); assert.ok(prompt.includes(events[1].text));
    const artifact = fs.readFileSync(run.artifact.file, 'utf8');
    if (request.task === 'text.rewrite') {
      const result = JSON.parse(artifact); assert.deepEqual(Object.keys(result).sort(), ['description', 'title']);
      if (request.input.format === 'work-item-metadata') {
        assert.deepEqual([...result.description.matchAll(/^h2\. (.+)$/gm)].map(match => match[1]), ['배경', '목표', '요구사항', '작업 범위', '참고사항']);
      } else {
        const lines = result.description.split('\n'); assert.ok(lines.length >= 1 && lines.length <= 5);
        assert.ok(lines.every(line => line.startsWith('- ')));
      }
    } else {
      const lines = artifact.trimEnd().split('\n'); assert.ok(lines.length >= 2 && lines.length <= 6);
      assert.ok(lines.slice(1).every(line => line.startsWith('- ')));
    }
    assert.equal(run.artifact.validation_scope, 'format');
  }
});
