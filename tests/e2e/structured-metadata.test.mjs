import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';
import { parseTextRewrite } from '../../src/text-rewrite.mjs';

const request = { task: 'text.rewrite', internal: true, input: { format: 'work-item-metadata', sessions: [{
  id: 'session-structured', engine: 'codex', start_at: '2026-09-19T00:00:00Z', end_at: '2026-09-19T00:01:00Z', summary: null,
  events: [{ kind: 'input', event_at: '2026-09-19T00:00:00Z', text: '초대 정책을 정리해 주세요.' }]
}] } };
const description = `h2. 배경
초대 정책을 정리해 달라는 요청이 있었다.
* 현재 상황: 초대 정책 정리 요청
* 문제점: 미확인
* 작업 필요성: 정책 정리 요청에 대응

h2. 목표
요청된 초대 정책을 정리한다.

h2. 요구사항
* 초대 정책 정리

h2. 작업 범위
* 요청된 초대 정책. 제외 범위는 미확인.

h2. 참고사항
* 확인된 응답이 없어 완료 여부는 미확인.
* 원문 경로 /api/{userId}, 자료 https://example.test/docs?q=1.2
* {"observed":false}`;
const parse = (description, options = { metadataFormat: 'work-item-jira-v1' }) => parseTextRewrite(JSON.stringify({ title: '초대 정책 정리', description }), 'work-item-metadata', options);

test('new metadata requires the Jira template with one generation and retains supplied facts', async t => {
  const h = new Harness(); t.after(() => h.close());
  const instruction = '기존 사용자 지시문: ## 작업 배경, ## 목적, ## 범위, ## 결과 Markdown 절을 사용한다.\n  기존 공백 유지.\n';
  const settingsFile = path.join(h.dir, 'execution-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, revision: 3, tasks: { 'text.rewrite': { instruction,
    backend: 'codex', backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } } } } }));
  const settingsBytes = fs.readFileSync(settingsFile);
  await h.start('runtime');
  for (const scenario of ['rewrite-legacy-paragraph', 'rewrite-legacy-markdown', 'rewrite-empty-jira-section', 'rewrite-placeholder']) {
    const run = await h.finish(await h.run({ ...request, fixture: { scenario } }));
    assert.equal(run.status, 'failed', run.message); assert.equal(run.artifact, null);
    assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
  }
  const accepted = await h.finish(await h.run(request));
  assert.equal(accepted.status, 'completed', accepted.message);
  const result = JSON.parse(fs.readFileSync(accepted.artifact.file, 'utf8'));
  assert.deepEqual([...result.description.matchAll(/^h2\. (.+)$/gm)].map(match => match[1]), ['배경', '목표', '요구사항', '작업 범위', '참고사항']);
  for (const label of ['현재 상황', '문제점', '작업 필요성']) assert.match(result.description, new RegExp(`^\\* ${label}: \\S`, 'm'));
  assert.ok(result.description.includes(request.input.sessions[0].events[0].text));
  assert.match(result.description, /미완료|미확인/); assert.equal(accepted.attempts.length, 1);
  const prompt = fs.readFileSync(path.join(accepted.attempts[0].directory, 'prompt.txt'), 'utf8');
  assert.ok(prompt.includes(instruction)); assert.match(prompt, /업무 본문 고정 출력 계약: description은 h2\. 배경/);
  assert.match(prompt, /저장된 지시문에 이전 Markdown 형식이 있더라도 이 출력 계약을 우선/);
  assert.deepEqual(fs.readFileSync(settingsFile), settingsBytes);
  assert.equal((await h.runtime('/execution-settings')).tasks.find(task => task.id === 'text.rewrite').instruction, instruction);
});

test('Jira format validates exact headings, populated labels and wiki bullets without altering real braces', () => {
  assert.equal(parse(description).description, description);
  assert.equal(parse(description, { requireJiraDescription: true }).description, description);
  const invalid = [
    ['wrong heading', value => value.replace('h2. 목표', 'h2. 목적')],
    ['wrong order', value => value.replace('h2. 요구사항', 'h2. 작업 범위').replace('h2. 작업 범위\n* 요청된', 'h2. 요구사항\n* 요청된')],
    ['duplicate heading', value => `${value}\n\nh2. 목표\n중복`],
    ['extra subsection', value => `${value}\n\nh3. 결과\n미확인`],
    ['Markdown headings', value => value.replaceAll('h2. ', '## ')],
    ['missing heading', value => value.replace('h2. 요구사항\n', '')],
    ['empty body', value => value.replace(/h2\. 목표\n[^\n]+/, 'h2. 목표')],
    ['empty background label', value => value.replace('* 문제점: 미확인', '* 문제점: ')],
    ['missing background label', value => value.replace('* 문제점: 미확인\n', '')],
    ['duplicate background label', value => value.replace('* 문제점: 미확인', '* 문제점: 미확인\n* 문제점: 미확인')],
    ['Markdown list', value => value.replace('* 초대 정책 정리', '- 초대 정책 정리')],
    ['missing required bullet', value => value.replace('* 초대 정책 정리', '초대 정책 정리')],
    ['empty bullet', value => value.replace('* 초대 정책 정리', '* ')],
    ['goal without prose', value => value.replace('요청된 초대 정책을 정리한다.', '* 요청된 초대 정책을 정리한다.')],
    ['background placeholder', value => value.replace('초대 정책을 정리해 달라는 요청이 있었다.', '{왜 이 작업을 하게 되었는가}')],
    ['label placeholder', value => value.replace('* 문제점: 미확인', '* 문제점: {현재 확인된 문제점}')],
    ['bullet placeholder', value => value.replace('* 초대 정책 정리', '* {현재 확인된 요구사항}')]
  ];
  for (const [label, mutate] of invalid) assert.throws(() => parse(mutate(description)), undefined, label);
});

test('resumed work-item-v1 runs retain their frozen Markdown contract after new runs adopt Jira', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-structured-metadata-'));
  const h = new Harness(); h.serviceRoot = root;
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const folder of ['src', 'harness', 'contracts', 'tests/fixtures']) fs.cpSync(path.join(ROOT, folder), path.join(root, folder), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const jobs = path.join(root, 'harness/jobs.json'), definitions = JSON.parse(fs.readFileSync(jobs));
  definitions.jobs['text.rewrite'].metadata_format = 'work-item-v1'; fs.writeFileSync(jobs, JSON.stringify(definitions));
  await h.start('runtime');
  const legacy = await h.run({ ...request, fixture: { scenario: 'rewrite-legacy-markdown', delayMs: 1500 } });
  await eventually(() => h.runtime(`/runs/${legacy.id}`), run => run.attempts[0]?.pid);
  await h.stop('runtime');
  definitions.jobs['text.rewrite'].metadata_format = 'work-item-jira-v1'; fs.writeFileSync(jobs, JSON.stringify(definitions));
  await h.start('runtime'); await h.runtime(`/runs/${legacy.id}/resume`, { method: 'POST', body: {} });
  const restored = await h.finish(legacy); assert.equal(restored.status, 'completed', restored.message);
  const result = JSON.parse(fs.readFileSync(restored.artifact.file));
  assert.deepEqual([...result.description.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['작업 배경', '목적', '범위', '결과']);
  assert.ok(restored.attempts.every(attempt => attempt.stage === 'produce'));
  const fresh = await h.finish(await h.run({ ...request, fixture: { scenario: 'rewrite-legacy-markdown' } }));
  assert.equal(fresh.status, 'failed'); assert.equal(fresh.artifact, null); assert.equal(fresh.attempts.length, 1);
});

test('session summaries keep one to five dash bullets and old unstructured metadata remains readable', () => {
  const options = { metadataFormat: 'work-item-jira-v1', requireBulletSummary: true };
  const content = ['첫째', '둘째', '셋째', '넷째', '다섯째'].map(value => `- ${value}`).join('\n');
  const summary = description => parseTextRewrite(JSON.stringify({ title: '세션 정리', description }), 'session-summary', options);
  assert.equal(summary(content).description, content);
  assert.throws(() => summary(`${content}\n- 여섯째`), /최대 5줄/);
  assert.throws(() => summary('* 변경 항목'), /"- "/);
  assert.equal(parse('이전 버전의 일반 설명', {}).description, '이전 버전의 일반 설명');
  const old = '## 작업 배경\n배경\n\n## 목적\n목적\n\n## 범위\n범위\n\n## 결과\n미확인';
  assert.equal(parse(old, { requireStructuredDescription: true }).description, old);
});
