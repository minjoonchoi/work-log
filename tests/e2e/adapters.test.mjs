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
  const calls = result.attempts.map(a => JSON.parse(fs.readFileSync(path.join(a.directory, 'invocation.json'))));
  assert.ok(calls[0].includes(engine === 'codex' ? '--output-schema' : '--json-schema'));
  if (engine === 'codex') {
    assert.ok(calls.every(c => c.includes('--dangerously-bypass-approvals-and-sandbox')));
    assert.ok(calls.every(c => !c.includes('--sandbox') && !c.includes('approval_policy="never"')));
    assert.equal(calls[0][calls[0].indexOf('--model') + 1], 'gpt-5.6');
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
  assert.equal(observed.model, engine === 'codex' ? 'gpt-5.6' : 'sonnet');
  assert.equal(observed.effort, 'medium');
  assert.equal(observed.permission_mode, 'bypass');
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
