import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../helpers.mjs';

test('parallel workers cannot turn test questions into user waits or retries; genuine blockers return once', async t => {
  const h = new Harness(); t.after(() => h.close());
  const cli = path.join(h.dir, 'question-double.mjs');
  fs.writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('question-double 1'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
if (!prompt.includes('사용자 질문은 상위 요청 에이전트만 담당합니다')) throw Error('missing guard');
const emit = value => console.log(JSON.stringify(value));
emit({ type: 'turn.started' });
if (prompt.includes('MISSING_REQUIRED_FACT')) {
  fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ status:'blocked', result:{message:'필수 API 계약이 없으며 제공된 파일에서 확인할 수 없습니다.'} }));
  emit({type:'turn.completed'});
} else {
  emit({ type:'item.started', item:{id:'q', type:'mcp_tool_call', tool:'request_user_input_async', arguments:{question:'임시 질문 테스트'} } });
  setTimeout(() => { fs.writeFileSync('continued', 'unexpected'); }, 1500);
}
`, { mode: 0o700 });
  h.env = { HARNESS_CODEX_BIN: cli }; await h.start('runtime');
  const requests = await Promise.all(['one', 'two'].map(id => h.run({ engine: 'codex', input: { requirements: '질문 도구를 mock으로 검증 ' + id } })));
  const results = await Promise.all(requests.map(run => h.finish(run)));
  for (const run of results) {
    assert.equal(run.status, 'failed', run.message);
    assert.match(run.message, /worker_user_input_forbidden/);
    assert.equal(run.attempts.length, 1, 'no question-driven retry or repair');
    assert.equal(fs.existsSync(path.join(run.attempts[0].directory, 'workspace/continued')), false);
  }
  const blocked = await h.finish(await h.run({ engine: 'codex', input: { requirements: 'MISSING_REQUIRED_FACT' } }));
  assert.equal(blocked.status, 'blocked', blocked.message);
  assert.equal(blocked.attempts.length, 1);
  assert.match(blocked.message, /필수 API 계약/);
});
