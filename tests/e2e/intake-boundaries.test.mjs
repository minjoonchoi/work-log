import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';

async function setup(t) { const h = await new Harness().start('runtime'); t.after(() => h.close()); return h; }

test('natural single-job intake distinguishes source material from requested artifacts and read-only reviews', async t => {
  const h = await setup(t);
  const examples = [
    ['기존 PRD를 참고해서 HTML 목업만 만들어 줘', 'mockup.html.create'],
    ['PRD 검토만 해줘, 수정 금지', 'document.review'],
    ['코드 리뷰만 해줘, 수정하지 마', 'code.review'],
    ['API 설계를 검토해 줘', 'document.review'],
    ['테스트 시나리오를 검토해 줘', 'document.review'],
    ['검증 보고서를 검토해 줘', 'document.review'],
    ['업무 공유 문서를 검토해 줘', 'document.review'],
    ['Review the stakeholder brief', 'document.review'],
    ['테스트 실행 결과를 검토해 줘', 'document.review'],
    ['Review the test scenarios', 'document.review'],
    ['Review the verification report', 'document.review'],
    ['코드의 보안을 검토해 줘', 'security.review'],
    ['화면 접근성 검토만 해줘', 'accessibility.review'],
    ['프로젝트 계획서를 작성해 줘', 'project.plan'],
    ['기존 PRD를 기반으로 API 설계해 줘', 'api.design'],
    ['백엔드 구현하지 말고 API 설계만 해줘', 'api.design'],
    ['진행 결과 요약을 참고해서 상태 보고서를 작성해 줘', 'status.report'],
    ['PRD 문서 수정해 줘', 'document.update'],
    ['PRD 작성 방법만 설명해 줘', 'text.generate'],
    ['Please explain how to run tests', 'text.generate'],
    ['How can I run tests?', 'text.generate'],
    ['테스트를 실행하는 방법을 설명해 줘', 'text.generate'],
    ['E2E 테스트는 실행하지 말고 실행 방법만 설명해 주세요.', 'text.generate']
  ];
  for (const [prompt, task] of examples) {
    const run = await h.run({ task: undefined, prompt });
    assert.equal(run.task, task, prompt);
    const result = await h.finish(run); assert.equal(result.status, 'completed', `${prompt}: ${result.message}`);
    const worker = fs.readFileSync(path.join(result.attempts[0].directory, 'prompt.txt'), 'utf8');
    assert.ok(worker.includes(prompt), 'original request and its prohibitions remain intact');
  }
});

test('ambiguous or composite natural requests are rejected before scheduling instead of falling back to text', async t => {
  const h = await setup(t);
  for (const prompt of [
    'API 설계와 백엔드 구현', 'PRD, HTML 목업과 엔티티 설계 모두 작성', 'PRD 검토 및 수정',
    '코드 리뷰 후 버그 수정', '기획서를 만들어 줘', '이 프로젝트 작업을 진행해 줘', 'PRD',
    '코드는 수정하지 마', 'API 설계하고 백엔드 구현해 줘', 'PRD 수정해 줘', 'PRD 실행해 줘',
    '검증 보고서', '테스트 시나리오', '테스트 시나리오 수정해 줘', '검증 보고서를 갱신해 줘',
    '테스트 실행 결과를 요약해 줘', 'E2E 테스트 실행 후 결과 검토해 줘',
    '테스트 시나리오 작성 후 검토해 줘', '검증 보고서 검토 후 작성해 줘',
    '리뷰 반영 내용을 검토해 줘', '업무 공유 문서', '업무 공유 문서 검토 후 작성해 줘',
    '업무 공유 문서 작성하고 상태 보고서 작성해 줘'
  ]) await assert.rejects(h.run({ task: undefined, prompt }), /한 종류의 산출물.*work 스킬.*orchestrate/, prompt);
  assert.deepEqual(await h.runtime('/runs'), []);
});

test('explicit structured requests keep their selected task despite mentioned adjacent work', async t => {
  const h = await setup(t);
  const result = await h.finish(await h.run({ task: 'document.review', input: {
    requirements: 'PRD와 API 설계에서 용어 일치만 검토하고 원본이나 백엔드 코드를 수정하지 않는다.'
  } }));
  assert.equal(result.task, 'document.review'); assert.equal(result.status, 'completed', result.message);
  assert.equal((await h.runtime('/runs')).length, 1);
});
