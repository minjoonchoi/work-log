import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';
import { parseTextRewrite } from '../../src/text-rewrite.mjs';

const description = `h2. 배경
* 현재 상황: 초대 권한 정책을 정리하고 있다.
* 문제점: 관리자 권한 검사가 빠져 있다.
* 작업 필요성: 비관리자의 초대를 막아야 한다.

h2. 목표
관리자만 새 팀원을 초대할 수 있다.

h2. 요구사항
* 관리자는 초대할 수 있다.
* 일반 팀원은 초대할 수 없다.
* 거부 이유를 표시한다.

h2. 작업 범위
* 초대 API에 권한 검사를 적용한다.
* 초대 화면의 오류 안내를 정리한다.
* 다른 권한 정책은 변경하지 않는다.

h2. 참고사항
* 관련 이슈는 WL-7이다.
* 배포 일정은 미확인이다.`;
const parse = (value, metadataFormat = 'work-item-jira-v2') => parseTextRewrite(JSON.stringify({ title: '초대 권한 정리', description: value }), 'work-item-metadata', { metadataFormat });
const sessions = [{ id: 'session-concise', engine: 'codex', start_at: '2026-09-22T01:00:00Z', end_at: '2026-09-22T01:05:00Z', summary: null,
  events: [{ kind: 'input', event_at: '2026-09-22T01:00:00Z', text: '관리자만 팀원을 초대하도록 권한을 수정하세요.' },
    { kind: 'output', event_at: '2026-09-22T01:05:00Z', text: '초대 API에 관리자 검사를 적용했고 회귀 테스트 12개가 통과했습니다. 초대 화면의 거부 안내도 추가했습니다. 배포는 수행하지 않았습니다.' }]
}];
const request = { task: 'text.rewrite', internal: true, input: { format: 'work-item-metadata', sessions } };

test('concise metadata and result comments use separate one-generation contracts without shortening source history', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const metadata = await h.finish(await h.run(request));
  assert.equal(metadata.status, 'completed', metadata.message);
  assert.deepEqual(metadata.attempts.map(attempt => attempt.stage), ['produce']);
  const result = JSON.parse(fs.readFileSync(metadata.artifact.file, 'utf8'));
  parse(result.description);
  assert.doesNotMatch(result.description, /회귀 테스트 12개/);
  const prompt = fs.readFileSync(path.join(metadata.attempts[0].directory, 'prompt.txt'), 'utf8');
  assert.ok(prompt.includes(sessions[0].events[1].text), 'full source remains available to generation');
  assert.match(prompt, /본문은 최대 12문장/); assert.match(prompt, /각 문장은 최대 120자/);
  assert.match(prompt, /work-item\.result\.summarize 결과 요약 댓글/);
  const comment = await h.finish(await h.run({ task: 'work-item.result.summarize', internal: true,
    input: { title: result.title, description: result.description, sessions } }));
  assert.equal(comment.status, 'completed', comment.message);
  assert.deepEqual(comment.attempts.map(attempt => attempt.stage), ['produce']);
  assert.match(JSON.parse(fs.readFileSync(comment.artifact.file, 'utf8')).text, /회귀 테스트 12개.*배포는 수행하지 않았/);
  assert.match(fs.readFileSync(path.join(comment.attempts[0].directory, 'prompt.txt'), 'utf8'), /업무 설명에서 생략한 구체적 변경·산출물·검증 결과/);
});

test('excessive metadata fails format validation without publishing or additional model attempts', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  for (const scenario of ['rewrite-long-sentence', 'rewrite-many-sentences', 'rewrite-compound-sentences']) {
    const run = await h.finish(await h.run({ ...request, fixture: { scenario } }));
    assert.equal(run.status, 'failed', scenario); assert.equal(run.artifact, null);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
    assert.deepEqual(run.steps.map(step => step.task), ['produce', 'verify']);
  }
});

test('v2 accepts twelve short statements and checks every section including Unicode and punctuation boundaries', () => {
  assert.equal(parse(description).description, description);
  assert.equal(parse(description.replace('관리자는 초대할 수 있다.', '🙂'.repeat(120))).description.includes('🙂'.repeat(120)), true);
  assert.throws(() => parse(description.replace('관리자는 초대할 수 있다.', '🙂'.repeat(121))), /최대 120자/);
  for (const [before, after] of [
    ['h2. 목표\n관리자만 새 팀원을 초대할 수 있다.', 'h2. 목표\n목표 하나.\n목표 둘.'],
    ['* 관련 이슈는 WL-7이다.', '* 관련 이슈는 WL-7이다.\n* 참고 하나.'],
    ['* 초대 API에 권한 검사를 적용한다.', '* 초대 API에 권한 검사를 적용한다.\n* 범위 하나.'],
    ['* 현재 상황:', '추가 도입문.\n* 현재 상황:'],
    ['* 거부 이유를 표시한다.', '* 거부 이유를 표시한다. 원인을 확인한다.'],
    ['* 거부 이유를 표시한다.', '* 거부 이유를 표시한다.원인을 확인한다.'],
    ['* 거부 이유를 표시한다.', '* 거부 이유를 표시한다.\u2028원인을 확인한다.'],
    ['* 거부 이유를 표시한다.', '* 거부 이유를 표시한다.\n  숨겨진 둘째 문장.']
  ]) assert.throws(() => parse(description.replace(before, after)), undefined, after);
  const technical = description.replace('* 관련 이슈는 WL-7이다.', '* Dr. Smith의 v1.2.3 자료 [API|https://example.test/api?rate=3.14]를 참고한다.');
  assert.equal(parse(technical).description, technical);
});

test('old Jira metadata and manual descriptions remain readable without the new generation limit', () => {
  const legacy = description.replace('* 거부 이유를 표시한다.', `* ${'기존 내용'.repeat(40)}`);
  assert.equal(parse(legacy, 'work-item-jira-v1').description, legacy);
  assert.equal(parse(legacy, null).description, legacy);
  assert.throws(() => parse(legacy), /최대 120자/);
});

test('a frozen Jira v1 generation can resume after v2 becomes the default', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-concise-metadata-'));
  const h = new Harness(); h.serviceRoot = root;
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const folder of ['src', 'harness', 'contracts', 'tests/fixtures']) fs.cpSync(path.join(ROOT, folder), path.join(root, folder), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const jobs = path.join(root, 'harness/jobs.json'), catalog = JSON.parse(fs.readFileSync(jobs));
  catalog.jobs['text.rewrite'].metadata_format = 'work-item-jira-v1'; fs.writeFileSync(jobs, JSON.stringify(catalog));
  await h.start('runtime');
  const legacy = await h.run({ ...request, fixture: { scenario: 'rewrite-long-sentence', delayMs: 1500 } });
  await eventually(() => h.runtime(`/runs/${legacy.id}`), run => run.attempts[0]?.pid);
  await h.stop('runtime');
  catalog.jobs['text.rewrite'].metadata_format = 'work-item-jira-v2'; fs.writeFileSync(jobs, JSON.stringify(catalog));
  await h.start('runtime'); await h.runtime(`/runs/${legacy.id}/resume`, { method: 'POST', body: {} });
  const resumed = await h.finish(legacy); assert.equal(resumed.status, 'completed', resumed.message);
  assert.match(JSON.parse(fs.readFileSync(resumed.artifact.file, 'utf8')).description, new RegExp('가'.repeat(121)));
  const fresh = await h.finish(await h.run({ ...request, fixture: { scenario: 'rewrite-long-sentence' } }));
  assert.equal(fresh.status, 'failed'); assert.equal(fresh.artifact, null); assert.equal(fresh.attempts.length, 1);
});
