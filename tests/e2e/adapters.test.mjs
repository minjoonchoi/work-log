import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, event, pair, eventually } from '../helpers.mjs';
import { ROOT } from '../../src/shared.mjs';

for (const engine of ['codex', 'claude']) test(`${engine} process adapter: stdin, argv, structured output and read-only independent review`, async t => {
  const cli = path.join(ROOT, 'tests/fixtures/cli-double.mjs'); fs.chmodSync(cli, 0o755);
  const h = new Harness(); h.env = { [engine === 'codex' ? 'HARNESS_CODEX_BIN' : 'HARNESS_CLAUDE_BIN']: cli };
  await h.start('runtime'); t.after(() => h.close());
  const result = await h.finish(await h.run({ engine }));
  assert.equal(result.status, 'completed', result.message);
  const { execution_profiles: profiles } = await h.runtime('/catalog');
  const expected = profiles.document.stages.produce[engine];
  const calls = result.attempts.map(a => JSON.parse(fs.readFileSync(path.join(a.directory, 'invocation.json'))));
  assert.ok(calls[0].includes(engine === 'codex' ? '--output-schema' : '--json-schema'));
  if (engine === 'codex') {
    assert.ok(calls.every(c => c.includes('--dangerously-bypass-approvals-and-sandbox')));
    assert.ok(calls.every(c => !c.includes('--sandbox') && !c.includes('approval_policy="never"')));
    assert.equal(calls[0][calls[0].indexOf('--model') + 1], expected.model);
    assert.ok(calls[0].includes('model_reasoning_effort="medium"'));
    assert.ok(calls[1].includes('model_reasoning_effort="high"'));
  } else {
    assert.ok(calls.every(c => c.includes('--allow-dangerously-skip-permissions')));
    assert.ok(calls.every(c => c[c.indexOf('--permission-mode') + 1] === 'bypassPermissions'));
    assert.equal(calls[0][calls[0].indexOf('--model') + 1], 'sonnet');
    assert.equal(calls[0][calls[0].indexOf('--effort') + 1], 'medium');
    assert.equal(calls[1][calls[1].indexOf('--effort') + 1], 'high');
    assert.equal(calls[1][calls[1].indexOf('--tools') + 1], 'Read');
  }
  const observed = JSON.parse(fs.readFileSync(path.join(result.attempts[0].directory, 'process.json')));
  assert.equal(observed.native_session_id, engine === 'codex' ? 'protocol-thread' : 'protocol-session');
  assert.equal(observed.usage.output_tokens, 20);
  assert.equal(observed.model, expected.model);
  assert.equal(observed.effort, 'medium');
  assert.equal(observed.permission_mode, 'bypass');
});

test('Codex fatal JSONL errors retain the safe server cause, while advisory messages preserve successful runs', async t => {
  const cli = path.join(ROOT, 'tests/fixtures/cli-double.mjs'); fs.chmodSync(cli, 0o755);
  const h = new Harness(); h.env = { HARNESS_CODEX_BIN: cli };
  await h.start('runtime'); await h.start('manager'); t.after(() => h.close());
  const { execution_profiles: profiles } = await h.runtime('/catalog');
  for (const scenario of ['turn-failed', 'error-only', 'sensitive-failure', 'failed-zero', 'warning-success']) {
    const itemId = `item-adapter-${scenario}`;
    const run = await h.finish(await h.run({ engine: 'codex', task: 'session.summarize', work_item_id: itemId, input: {
      title: `[protocol:${scenario}] 작업 세션 요약`,
      events: [{ kind: 'input', event_at: '2026-09-19T01:00:00Z', text: '요청한 작업을 완료했습니다.' }]
    } }));
    const invocation = JSON.parse(fs.readFileSync(path.join(run.attempts[0].directory, 'invocation.json')));
    assert.equal(invocation[invocation.indexOf('--model') + 1], profiles.metadata.stages.produce.codex.model);
    assert.ok(invocation.includes('model_reasoning_effort="low"'));
    if (scenario === 'warning-success') {
      assert.equal(run.status, 'completed', run.message);
      assert.ok(run.artifact); continue;
    }
    assert.equal(run.status, 'failed', run.message); assert.equal(run.artifact, null);
    const observation = JSON.parse(fs.readFileSync(path.join(run.attempts[0].directory, 'process.json')));
    assert.equal(observation.reason, 'engine_failure');
    assert.equal(observation.code, scenario === 'failed-zero' ? 0 : 1);
    assert.ok(observation.error.length <= 2000);
    assert.doesNotMatch(observation.error, /[\x00-\x1f\x7f]|sample-sensitive-value|sk-abcdefghijklmnopqrstuvwxyz123456/);
    assert.ok(run.message.includes(observation.error));
    if (scenario === 'sensitive-failure') assert.match(observation.error, /Request rejected.*\[REDACTED\]/);
    else assert.match(observation.error, scenario === 'failed-zero' ? /stale output file/ : /model is not supported when using Codex with a ChatGPT account/);
    const detail = await eventually(() => h.manager(`/items/${itemId}`), item => item.runs?.some(value => value.id === run.id && value.status === 'failed'));
    assert.equal(detail.runs.find(value => value.id === run.id).message, run.message);
  }
});

test('valid large source snapshots reach fixture and real CLI adapters without OS environment-size failures', async t => {
  const cli = path.join(ROOT, 'tests/fixtures/cli-double.mjs'); fs.chmodSync(cli, 0o755);
  const h = new Harness(); h.env = { HARNESS_CODEX_BIN: cli, HARNESS_CLAUDE_BIN: cli };
  await h.start('runtime'); t.after(() => h.close());
  // UTF-8 exceeds this Mac's 1 MiB ARG_MAX, while remaining within the source
  // character limit and the 2 MiB API limit. The requested output stays small.
  const content = `// ${'한'.repeat(500 * 1024)}\nexport const value = 1;\n`;
  const input = { requirements: '제공한 자료를 읽고 독립된 새 모듈 하나만 작성하세요.',
    source_files: [{ path: 'src/reference.mjs', content }], allowed_paths: ['src/result.mjs'] };
  for (const engine of ['fixture', 'codex', 'claude']) {
    const run = await h.finish(await h.run({ engine, task: 'backend.implement', input }));
    assert.equal(run.status, 'completed', `${engine}: ${run.message}`);
    assert.equal(run.request.input.source_files[0].content, content);
    const bundle = JSON.parse(fs.readFileSync(run.artifact.file));
    assert.deepEqual(bundle.files.map(file => file.path), input.allowed_paths);
    for (const attempt of run.attempts) {
      const observed = JSON.parse(fs.readFileSync(path.join(attempt.directory, 'process.json')));
      assert.equal(observed.code, 0); assert.equal(observed.error, null);
      if (engine === 'fixture') {
        const fixtureFile = path.join(attempt.directory, 'fixture-input.json');
        assert.equal(JSON.parse(fs.readFileSync(fixtureFile)).input.source_files[0].content, content);
        assert.equal(fs.statSync(fixtureFile).mode & 0o777, 0o600);
      } else {
        const transport = JSON.parse(fs.readFileSync(path.join(attempt.directory, 'transport.json')));
        assert.ok(transport.stdin_bytes > 1024 * 1024);
        assert.equal(transport.fixture_in_environment, false);
        assert.equal(transport.fixture_file_in_environment, false);
        assert.equal(fs.existsSync(path.join(attempt.directory, 'fixture-input.json')), false);
      }
    }
  }
});
test('source hook retry preserves original observed timestamp; bad hook input remains non-blocking and visible', async t => {
  const h = new Harness(); await h.start('manager'); t.after(() => h.close());
  const input = { event_id: 'original-key', session_id: 'hooks', turn_id: 'turn', hook_event_name: 'UserPromptSubmit', prompt: '유효한 입력' };
  h.hook('codex', input); await eventually(() => h.manager('/health'), v => v.events === 1);
  const [item] = await h.manager('/items'); const before = await h.manager(`/items/${item.id}`);
  h.hook('codex', input); await eventually(() => fs.readdirSync(path.join(h.dir, 'spool')).length, n => n === 0);
  const after = await h.manager(`/items/${item.id}`); assert.equal(after.events.length, 1); assert.equal(after.events[0].event_at, before.events[0].event_at);
  h.hook('codex', { ...input, prompt: 'x'.repeat(2 * 1024 * 1024) });
  assert.match((await h.manager('/health')).last_error, /훅 입력 한도/);
});
test('same source key with conflicting payload rejects the batch instead of silently replacing evidence', async t => {
  const h = new Harness(); await h.start('manager'); t.after(() => h.close());
  const e = event('a', 'input', '09:00:00'); await h.ingest([e]);
  await assert.rejects(h.ingest([{ ...e, text: '다른 내용' }]), /같은 원본 키/);
});
test('metadata editing and merge never alter authoritative run request or definition hash', async t => {
  const h = new Harness(); await h.start('runtime'); await h.start('manager'); t.after(() => h.close());
  const result = await h.finish(await h.run()); await h.ingest(pair('other', '09:00:00', '09:01:00'));
  const items = await eventually(() => h.manager('/items'), a => a.length === 2);
  await h.manager('/merge', { method: 'POST', body: { ids: items.map(i => i.id), target: items[0].id, operation_id: 'audit' } });
  const after = await h.runtime(`/runs/${result.id}`);
  assert.equal(after.definition_digest, result.definition_digest); assert.equal(after.status, result.status); assert.deepEqual(after.artifact, result.artifact);
});
test('unapproved fixture and multi-artifact natural-language request fail explicitly', async t => {
  const h = new Harness(); h.testMode = false; await h.start('runtime'); t.after(() => h.close());
  await assert.rejects(h.run(), /지원하지 않는 엔진/);
  await assert.rejects(h.run({ task: undefined, engine: 'codex', prompt: 'PRD, HTML 목업과 엔티티 설계 모두 작성' }), /한 종류의 산출물/);
});
