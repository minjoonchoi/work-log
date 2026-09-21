import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, eventually } from '../helpers.mjs';
import { digest } from '../../src/shared.mjs';
import { materializeCodeBundle } from '../../src/code-bundle.mjs';

async function setup(t) {
  const h = await new Harness().start('runtime'); t.after(() => h.close()); return h;
}
const input = (source = 'export const allowed = false;\n') => ({
  requirements: '제공한 소스에서 요청한 권한 처리를 구현하세요.',
  source_files: [{ path: 'src/permission.mjs', content: source }],
  allowed_paths: ['src/permission.mjs']
});

test('backend implementation publishes actual source changes with base hashes and honest verification coverage', async t => {
  const h = await setup(t), source = path.join(h.dir, 'original.mjs'), request = input();
  fs.writeFileSync(source, request.source_files[0].content);
  const result = await h.finish(await h.run({ task: 'backend.implement', input: request }));
  assert.equal(result.status, 'completed', result.message);
  const text = fs.readFileSync(result.artifact.file, 'utf8'), bundle = JSON.parse(text);
  assert.equal(path.basename(result.artifact.file), 'changes.json');
  assert.deepEqual(bundle.files.map(file => file.path), request.allowed_paths);
  assert.match(bundle.files[0].content, /export const allowed/);
  assert.equal(fs.readFileSync(source, 'utf8'), request.source_files[0].content);
  const report = JSON.parse(fs.readFileSync(result.artifact.verify_report));
  const scope = report.checks.find(check => check.check === 'code bundle scope and source snapshots');
  assert.equal(scope.files[0].source_digest, digest(request.source_files[0].content));
  assert.equal(scope.files[0].content_digest, digest(bundle.files[0].content));
  const syntax = report.checks.find(check => check.check.startsWith('JavaScript syntax:'));
  assert.equal(syntax.exit_code, 0); assert.equal(syntax.passed, true);
  const coverage = report.checks.find(check => check.check === 'code verification coverage recorded');
  assert.equal(coverage.project_build, 'not_run'); assert.equal(coverage.runtime_tests, 'not_run'); assert.equal(coverage.project_applied, false);
  const exported = await materializeCodeBundle(text, request, path.join(fs.realpathSync(h.dir), 'exported'));
  assert.equal(fs.readFileSync(path.join(exported.directory, 'src/permission.mjs'), 'utf8'), bundle.files[0].content);
  await assert.rejects(materializeCodeBundle(text, request, exported.directory), /EEXIST/);
});

test('invalid frontend source syntax triggers repair before independent review', async t => {
  const h = await setup(t);
  const result = await h.finish(await h.run({ task: 'frontend.implement', input: input(), fixture: { scenario: 'code-invalid-syntax-once' } }));
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.round, 1);
  assert.deepEqual(result.attempts.map(attempt => attempt.stage), ['produce', 'repair', 'review']);
  const first = JSON.parse(fs.readFileSync(path.join(result.attempts[0].directory, 'verification.json')));
  assert.equal(first.passed, false);
  assert.equal(first.checks.find(check => check.check.startsWith('JavaScript syntax:')).passed, false);
  assert.match(fs.readFileSync(path.join(result.attempts[1].directory, 'prompt.txt'), 'utf8'), /SyntaxError/);
});

test('out-of-scope changes, duplicate paths, unchanged output, deletions and loose files never reach review or publication', async t => {
  const h = await setup(t);
  for (const scenario of ['code-disallowed-path', 'code-duplicate', 'code-no-change', 'code-delete', 'code-extra-file']) {
    const result = await h.finish(await h.run({ task: 'bug.fix', input: input(), fixture: { scenario } }));
    assert.equal(result.status, 'blocked', `${scenario}: ${result.message}`);
    assert.equal(result.artifact, null); assert.ok(result.attempts.every(attempt => attempt.stage !== 'review'));
  }
});

test('unsafe or ambiguous source scope is rejected before an implementation worker starts', async t => {
  const h = await setup(t);
  for (const allowed_paths of [['../outside.mjs'], ['/tmp/outside.mjs'], ['src\\outside.mjs'], ['.git/config'], ['.GIT/config'],
    ['src/File.mjs', 'src/file.mjs'], ['src/module', 'src/module/file.mjs'], ['src/*.mjs']]) {
    await assert.rejects(h.run({ task: 'frontend.implement', input: { ...input(), allowed_paths } }), /경로/);
  }
  await assert.rejects(h.run({ task: 'backend.implement', input: { requirements: '서비스를 구현하세요.' } }), /source_files|allowed_paths/);
  assert.deepEqual(await h.runtime('/runs'), []);
});

test('syntax validation never executes generated module bodies or imports; unsupported language coverage remains explicit', async t => {
  const h = await setup(t), marker = path.join(h.dir, 'executed');
  const source = `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'executed');\nthrow new Error('must not execute');\n`;
  const result = await h.finish(await h.run({ task: 'refactor', input: input(source) }));
  assert.equal(result.status, 'completed', result.message); assert.equal(fs.existsSync(marker), false);
  const request = { requirements: '제공한 타입스크립트 함수의 테스트 작성', source_files: [], allowed_paths: ['tests/permission.test.ts'] };
  const tests = await h.finish(await h.run({ task: 'test.create', input: request }));
  assert.equal(tests.status, 'completed', tests.message);
  const verification = JSON.parse(fs.readFileSync(tests.artifact.verify_report));
  const coverage = verification.checks.find(check => check.check === 'code verification coverage recorded');
  assert.deepEqual(coverage.syntax_not_checked, request.allowed_paths); assert.equal(coverage.runtime_tests, 'not_run');
});

test('JavaScript bundles use the nearest supplied package type and record unresolved module context honestly', async t => {
  const h = await setup(t), content = 'if (process.env.SKIP) return;\nmodule.exports = 1;\n';
  const cases = [
    { file: 'src/compat.js', packages: [{ path: 'package.json', content: '{"type":"module"}' },
      { path: 'src/package.json', content: '{"type":"commonjs"}' }], confirmed: true, source: 'package_snapshot' },
    { file: 'src/compat.js', packages: [], confirmed: false, source: 'unspecified' },
    { file: 'src/compat.cjs', packages: [{ path: 'package.json', content: '{"type":"module"}' }], confirmed: true, source: 'file_extension' }
  ];
  for (const example of cases) {
    const request = { requirements: '주어진 CommonJS 모듈의 동작을 보존하면서 수정하세요.',
      source_files: [...example.packages, { path: example.file, content }], allowed_paths: [example.file] };
    const run = await h.finish(await h.run({ task: 'refactor', input: request }));
    assert.equal(run.status, 'completed', run.message); assert.equal(run.round, 0);
    const report = JSON.parse(fs.readFileSync(run.artifact.verify_report));
    const syntax = report.checks.find(check => check.check.startsWith('JavaScript syntax:'));
    assert.equal(syntax.passed, true); assert.equal(syntax.parser_mode, 'commonjs');
    assert.equal(syntax.module_context.confirmed, example.confirmed); assert.equal(syntax.module_context.source, example.source);
    if (example.source === 'package_snapshot') {
      assert.equal(syntax.module_context.file, 'src/package.json');
      assert.equal(syntax.module_context.content_digest, digest(example.packages[1].content));
    }
    assert.equal(report.checks.find(check => check.check === 'code verification coverage recorded').runtime_tests, 'not_run');
  }
});

test('explicit JavaScript module context cannot pass under a different parser mode', async t => {
  const h = await setup(t);
  for (const [file, packageType, content] of [
    ['src/invalid.js', 'commonjs', 'export const value = 1;\n'],
    ['src/invalid.mjs', 'commonjs', 'if (process.env.SKIP) return;\nmodule.exports = 1;\n']
  ]) {
    const request = { requirements: '명시한 모듈 문맥에 맞는 코드만 반환하세요.', source_files: [
      { path: 'package.json', content: JSON.stringify({ type: packageType }) }, { path: file, content }
    ], allowed_paths: [file] };
    const run = await h.finish(await h.run({ task: 'refactor', input: request }));
    assert.equal(run.status, 'blocked', run.message); assert.equal(run.artifact, null);
    assert.ok(run.attempts.every(attempt => attempt.stage !== 'review'));
    const report = JSON.parse(fs.readFileSync(path.join(run.attempts[0].directory, 'verification.json')));
    const syntax = report.checks.find(check => check.check.startsWith('JavaScript syntax:'));
    assert.equal(syntax.passed, false); assert.equal(syntax.module_context.confirmed, true);
    assert.equal(syntax.attempts.length, 1);
    assert.match(syntax.error, /SyntaxError/);
  }
});

test('source bundle exports refuse symlink parents without touching their targets', async t => {
  const h = new Harness(); t.after(() => h.close());
  const target = path.join(fs.realpathSync(h.dir), 'target'); fs.mkdirSync(target);
  const link = path.join(fs.realpathSync(h.dir), 'link'); fs.symlinkSync(target, link);
  const request = input();
  const bundle = JSON.stringify({ summary: '수정', files: [{ path: 'src/permission.mjs', content: 'export const allowed = true;\n' }] });
  await assert.rejects(materializeCodeBundle(bundle, request, path.join(link, 'exported')), /심링크/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('ordinary secret-variable expressions preserve exact source snapshots and hashes through direct runs and plans', async t => {
  const h = await setup(t);
  const source = `const defaults = { password: '', apiKey: "", secret: \`\` };\nexport function valid(input) { const password = input.password; const apiKey = input.apiKey; return password.length > 0 && Boolean(apiKey); }\n`;
  const request = { ...input(source), instructions: '로그 참고값 api_key=log-only-sensitive-value 는 기록에 마스킹하세요.' };
  const direct = await h.finish(await h.run({ task: 'refactor', input: request }));
  assert.equal(direct.status, 'completed', direct.message);
  const accepted = await h.runtime('/plans', { method: 'POST', body: {
    prompt: '로그인 판정 리팩터링', engine: 'fixture', steps: [{ id: 'login', task: 'refactor', output_key: 'login-source',
      request_excerpt: '로그인 판정 리팩터링', input: request, depends_on: [] }]
  } });
  const plan = await eventually(() => h.runtime(`/plans/${accepted.id}`), value => !['pending', 'running'].includes(value.status));
  assert.equal(plan.status, 'completed', plan.message);
  const planned = await h.runtime(`/runs/${plan.steps[0].run_id}`);
  for (const run of [direct, planned]) {
    assert.equal(run.request.input.source_files[0].content, source);
    assert.doesNotMatch(run.request.input.instructions, /log-only-sensitive-value/);
    const bundle = JSON.parse(fs.readFileSync(run.artifact.file));
    assert.ok(bundle.files[0].content.startsWith(source));
    const verification = JSON.parse(fs.readFileSync(run.artifact.verify_report));
    assert.equal(verification.checks.find(check => check.check === 'code bundle scope and source snapshots').files[0].source_digest, digest(source));
    for (const attempt of run.attempts) {
      for (const name of ['prompt.txt', 'stdout.log', 'stderr.log']) {
        const log = fs.readFileSync(path.join(attempt.directory, name), 'utf8');
        assert.doesNotMatch(log, /log-only-sensitive-value/);
      }
    }
  }
});

test('recognizable source credentials and hardcoded secret literals are rejected before run or plan persistence', async t => {
  const h = await setup(t);
  const sources = [
    "const password = 'sample-sensitive-value';\n",
    'const config = {"api_key": "sample-sensitive-value"};\n',
    'const accessToken = "sample-sensitive-value";\n',
    'const refresh_token = "sample-sensitive-value";\n',
    'const secret = `sample-sensitive-value`;\n',
    'const password: string = "sample-sensitive-value";\n',
    '// sample credential sk-abcdefghijklmnopqrstuvwxyz123456\nexport const valid = true;\n'
  ];
  for (const source of sources) {
    const request = input(source);
    await assert.rejects(h.run({ task: 'refactor', input: request }), /자격증명 토큰|비밀 문자열/);
    await assert.rejects(h.runtime('/plans', { method: 'POST', body: {
      prompt: '원본 리팩터링', engine: 'fixture', steps: [{ id: 'source', task: 'refactor', output_key: 'source',
        request_excerpt: '원본 리팩터링', input: request, depends_on: [] }]
    } }), /자격증명 토큰|비밀 문자열/);
  }
  assert.deepEqual(await h.runtime('/runs'), []);
  assert.deepEqual(await h.runtime('/plans'), []);
  assert.deepEqual((await h.runtime('/events')).events, []);
  for (const file of ['runtime.sqlite', 'runtime.sqlite-wal']) if (fs.existsSync(path.join(h.dir, file))) {
    const bytes = fs.readFileSync(path.join(h.dir, file));
    assert.equal(bytes.includes(Buffer.from('sample-sensitive-value')), false);
    assert.equal(bytes.includes(Buffer.from('sk-abcdefghijklmnopqrstuvwxyz123456')), false);
  }
});
