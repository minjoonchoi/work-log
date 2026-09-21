import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness } from '../helpers.mjs';
import { digest, stableId } from '../../src/shared.mjs';

async function setup(t) {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const workspace = path.join(fs.realpathSync(h.dir), 'project'); fs.mkdirSync(workspace);
  return { h, workspace };
}
const read = file => fs.readFileSync(file, 'utf8');
const referenceList = attempt => JSON.parse(read(path.join(attempt.directory, 'prompt.txt')).match(/\n자료 파일 참조[^:]+: ([^\n]+)\n/)[1]);

test('verified public artifact is copied under the original workspace and retained in managed storage; legacy and internal runs stay private', async t => {
  const { h, workspace } = await setup(t);
  const done = await h.finish(await h.run({ workspace }));
  assert.equal(done.status, 'completed', done.message);
  assert.equal(done.artifact.output_file, path.join(workspace, 'output/worklog', done.id, 'prd.md'));
  assert.equal(digest(fs.readFileSync(done.artifact.output_file)), done.artifact.content_digest);
  assert.equal(read(done.artifact.output_file), read(done.artifact.file));
  const old = await h.finish(await h.run()); assert.equal(old.status, 'completed'); assert.equal(old.artifact.output_file, undefined);
  const internal = await h.finish(await h.run({ workspace, task: 'session.summarize', internal: true,
    input: { title: '작업 기록', events: [{ kind: 'input', event_at: '2026-09-19T00:00:00Z', text: '요구를 정리했습니다.' }] } }));
  assert.equal(internal.status, 'completed', internal.message); assert.equal(internal.artifact.output_file, undefined);
  assert.deepEqual(fs.readdirSync(path.join(workspace, 'output/worklog')), [done.id]);
});

test('input paths freeze exact UTF-8 contents at acceptance and each worker consumes private snapshots without prompt body duplication', async t => {
  const { h, workspace } = await setup(t);
  const source = path.join(workspace, 'requirements.md'), original = '\ufeff# 원문\n고유원문표시-acceptance-freeze\n';
  fs.writeFileSync(source, original);
  const run = await h.run({ workspace, input_files: [{ path: 'requirements.md', content_digest: digest(original) }], fixture: { delayMs: 150, copyInputSnapshot: true } });
  fs.writeFileSync(source, '# 이후 사용자 변경\n');
  const done = await h.finish(run); assert.equal(done.status, 'completed', done.message);
  assert.match(read(done.artifact.output_file), /고유원문표시-acceptance-freeze/);
  assert.equal(read(source), '# 이후 사용자 변경\n');
  const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'));
  const definition = JSON.parse(db.prepare('SELECT definition FROM runs WHERE id=?').get(done.id).definition); db.close();
  assert.equal(definition.input_files[0].content, original);
  assert.equal(definition.input_files[0].path, source);
  assert.deepEqual(done.request.input_files, [{ path: source, content_digest: digest(original) }]);
  for (const attempt of done.attempts) {
    const [reference] = referenceList(attempt);
    assert.equal(reference.source_path, source); assert.equal(reference.content_digest, digest(original));
    assert.equal(path.dirname(reference.path), path.join(fs.realpathSync(attempt.directory), 'inputs'));
    assert.equal(read(reference.path), original);
    const prompt = read(path.join(attempt.directory, 'prompt.txt'));
    // Review includes its candidate verification report, but source text is only in the input file.
    assert.ok(!prompt.includes('고유원문표시-acceptance-freeze'));
    assert.match(prompt, /원본 또는 스냅샷을 변경하지 마세요/);
  }
});

test('invalid, escaped, linked, changed, binary, oversized or credential input files fail before a run or event is registered', async t => {
  const { h, workspace } = await setup(t);
  const outside = path.join(h.dir, 'outside.txt'); fs.writeFileSync(outside, 'outside');
  fs.writeFileSync(path.join(workspace, 'plain.txt'), 'safe source');
  fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0xff, 0xfe]));
  fs.writeFileSync(path.join(workspace, 'zero.bin'), Buffer.from([65, 0, 66]));
  fs.writeFileSync(path.join(workspace, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
  fs.writeFileSync(path.join(workspace, 'secret.txt'), 'api_key = "placeholder-secret"');
  fs.symlinkSync(outside, path.join(workspace, 'linked.txt'));
  fs.symlinkSync(h.dir, path.join(workspace, 'linked-parent'));
  const invalid = [
    { input_files: [{ path: 'plain.txt' }] },
    { workspace: 'relative', input_files: [{ path: 'plain.txt' }] },
    ...['../outside.txt', outside, 'linked.txt', 'linked-parent/outside.txt', 'binary.bin', 'zero.bin', 'large.txt', 'secret.txt', 'missing.txt']
      .map(file => ({ workspace, input_files: [{ path: file }] })),
    { workspace, input_files: [{ path: 'plain.txt', content_digest: '0'.repeat(64) }] },
    { workspace, input_files: [{ path: 'plain.txt' }, { path: path.join(workspace, 'plain.txt') }] }
  ];
  for (const request of invalid) await assert.rejects(h.run(request));
  assert.deepEqual(await h.runtime('/runs'), []); assert.equal((await h.runtime('/events')).events.length, 0);
  assert.equal(fs.existsSync(path.join(workspace, 'output')), false);
});

test('snapshot modification by a reviewer invalidates the attempt and prevents both managed and project publication', async t => {
  const { h, workspace } = await setup(t); fs.writeFileSync(path.join(workspace, 'source.md'), '유지할 원문');
  const done = await h.finish(await h.run({ workspace, input_files: [{ path: 'source.md' }], fixture: { scenario: 'tamper-input-snapshot' } }));
  assert.equal(done.status, 'failed'); assert.match(done.message, /input_integrity/); assert.equal(done.artifact, null);
  assert.equal(done.attempts.at(-1).status, 'failed'); assert.equal(read(path.join(workspace, 'source.md')), '유지할 원문');
  assert.equal(fs.existsSync(path.join(workspace, 'output')), false);
});

test('publication never overwrites an existing user file or follows an output symlink', async t => {
  const { h, workspace } = await setup(t), key = 'preserve-user-output', runId = stableId('run-', key);
  const target = path.join(workspace, 'output/worklog', runId, 'prd.md');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '사용자 파일');
  const conflict = await h.finish(await h.run({ workspace, idempotency_key: key }));
  assert.equal(conflict.status, 'failed'); assert.match(conflict.message, /덮어쓰지/); assert.equal(read(target), '사용자 파일');
  assert.equal(conflict.artifact, null);
  const linkedWorkspace = path.join(h.dir, 'linked-project'), outside = path.join(h.dir, 'external-output');
  fs.mkdirSync(linkedWorkspace); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(linkedWorkspace, 'output'));
  const linked = await h.finish(await h.run({ workspace: linkedWorkspace }));
  assert.equal(linked.status, 'failed'); assert.match(linked.message, /심링크/); assert.deepEqual(fs.readdirSync(outside), []);
});

test('crash between managed and project publication resumes from intent without another model attempt', async t => {
  const { h, workspace } = await setup(t), exit = new Promise(resolve => h.processes.runtime.once('exit', resolve));
  const run = await h.run({ workspace, fixture: { crashAfterManagedPublish: true } });
  assert.equal(await exit, 73); await h.start('runtime');
  const before = await h.runtime(`/runs/${run.id}`); assert.equal(before.status, 'interrupted'); assert.equal(before.attempts.length, 2);
  const intent = JSON.parse(read(path.join(h.dir, 'runs', run.id, 'publication-intent.json')));
  assert.equal(fs.existsSync(intent.output_file), false);
  const done = await h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} });
  assert.equal(done.status, 'completed'); assert.equal(digest(fs.readFileSync(done.artifact.output_file)), done.artifact.content_digest);
  assert.equal((await h.runtime(`/runs/${run.id}`)).attempts.length, before.attempts.length);
});

test('changed project publication blocks crash recovery without repeating workers or replacing user data', async t => {
  const { h, workspace } = await setup(t), exit = new Promise(resolve => h.processes.runtime.once('exit', resolve));
  const run = await h.run({ workspace, fixture: { crashAfterPublish: true } });
  assert.equal(await exit, 73);
  const intent = JSON.parse(read(path.join(h.dir, 'runs', run.id, 'publication-intent.json')));
  fs.writeFileSync(intent.output_file, '프로젝트에서 변경한 결과'); await h.start('runtime');
  await assert.rejects(h.runtime(`/runs/${run.id}/resume`, { method: 'POST', body: {} }), /덮어쓰지/);
  const after = await h.runtime(`/runs/${run.id}`); assert.equal(after.status, 'interrupted'); assert.equal(after.attempts.length, 2);
  assert.equal(read(intent.output_file), '프로젝트에서 변경한 결과');
});

test('idempotency reuses the frozen run after source changes or deletion and rejects changed declarations', async t => {
  const { h, workspace } = await setup(t); fs.writeFileSync(path.join(workspace, 'source.md'), '원본 자료');
  const request = { workspace, idempotency_key: 'files-idempotency', input_files: [{ path: 'source.md' }] };
  const run = await h.run(request); assert.equal((await h.run(request)).id, run.id);
  const done = await h.finish(run); assert.equal(done.status, 'completed', done.message);
  fs.writeFileSync(path.join(workspace, 'source.md'), '다른 원본 자료');
  assert.equal((await h.run(request)).id, run.id);
  fs.unlinkSync(path.join(workspace, 'source.md'));
  await h.stop('runtime'); await h.start('runtime');
  assert.equal((await h.run(request)).id, run.id, 'durable acceptance survives missing original files and service restart');
  await assert.rejects(h.run({ ...request, input_files: [{ path: 'source.md', content_digest: digest('다른 원본 자료') }] }), /같은 실행 요청 키에 다른 입력 선언/);
  const other = path.join(h.dir, 'other-project'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'source.md'), '원본 자료');
  await assert.rejects(h.run({ ...request, workspace: other }), /같은 실행 요청 키에 다른 입력 선언/);
  const moved = `${workspace}-moved`; fs.renameSync(workspace, moved);
  assert.equal((await h.run(request)).id, run.id, 'the accepted declaration does not require the original workspace to remain present');
  assert.equal((await h.runtime('/runs')).length, 1);
});
