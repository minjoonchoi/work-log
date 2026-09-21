import fs from 'node:fs';
import path from 'node:path';
import { assert, digest, id, redactExecutionRequest } from './shared.mjs';
import { canonicalJson } from './schema.mjs';

const maxInputBytes = 2 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function normalizeWorkspace(value) {
  assert(typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value), 'workspace는 절대 디렉터리 경로여야 합니다.');
  const stat = fs.lstatSync(value);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'workspace는 심링크가 아닌 기존 디렉터리여야 합니다.');
  return fs.realpathSync(value);
}

function inside(root, file) {
  const relative = path.relative(root, file);
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), '파일은 workspace 안에 있어야 합니다.');
  return relative;
}

function noLinks(root, file, { createParents = false } = {}) {
  assert(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink() && fs.realpathSync(root) === root,
    'workspace 경로가 변경되었습니다.');
  const parts = inside(root, file).split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const last = index === parts.length - 1;
    if (createParents && !last) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (e) { if (last && e.code === 'ENOENT') return; throw e; }
    assert(!stat.isSymbolicLink(), '심링크 파일 또는 디렉터리는 사용할 수 없습니다.');
    assert(last ? stat.isFile() : stat.isDirectory(), last ? '일반 파일만 사용할 수 있습니다.' : '파일 경로의 상위 항목이 디렉터리가 아닙니다.');
  }
}

function readRegular(root, file, maximum = Infinity) {
  noLinks(root, file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.size <= maximum, '자료 파일이 일반 파일이 아니거나 총 2 MiB 제한을 초과했습니다.');
    const bytes = fs.readFileSync(fd);
    assert(bytes.length <= maximum, '자료 파일의 총 2 MiB 제한을 초과했습니다.');
    noLinks(root, file);
    return bytes;
  } finally { fs.closeSync(fd); }
}

function faithfulText(bytes, originalPath) {
  let content;
  try { content = decoder.decode(bytes); } catch { assert(false, '자료 파일은 UTF-8 텍스트여야 합니다.'); }
  assert(!content.includes('\0') && Buffer.from(content).equals(bytes), '자료 파일은 원문을 보존할 수 있는 UTF-8 텍스트여야 합니다.');
  // Reuse the source snapshot policy: reject recognized credentials without rewriting source.
  redactExecutionRequest({ input: { source_files: [{ path: originalPath, content }] } });
  return content;
}

export function snapshotInputFiles(workspace, files = []) {
  assert(!files.length || workspace, 'input_files에는 workspace가 필요합니다.');
  let bytesRead = 0;
  const seen = new Set();
  return files.map(reference => {
    assert(typeof reference.path === 'string' && reference.path.length && !/[\\\x00-\x1f\x7f]/.test(reference.path)
      && !reference.path.split('/').includes('..'), '자료 파일 경로에 경로 탈출 또는 잘못된 문자가 있습니다.');
    const original = path.resolve(workspace, reference.path);
    inside(workspace, original);
    const key = original.normalize('NFC').toLowerCase();
    assert(!seen.has(key), '같은 자료 파일이 중복되었습니다.'); seen.add(key);
    const bytes = readRegular(workspace, original, maxInputBytes - bytesRead); bytesRead += bytes.length;
    const contentDigest = digest(bytes);
    assert(!reference.content_digest || contentDigest === reference.content_digest, '자료 파일의 요청한 해시와 실제 내용이 다릅니다.');
    return { path: original, content: faithfulText(bytes, original), content_digest: contentDigest };
  });
}

export function executionInputDigest(request, definition) {
  return digest(canonicalJson({ task: request.task, input: request.input,
    ...(request.review ? { review: request.review } : {}),
    ...(definition.input_files?.length ? { input_files: definition.input_files.map(({ path, content_digest }) => ({ path, content_digest })) } : {}) }));
}

export function materializeInputs(attemptDir, definition) {
  const sources = [
    ...(definition.input_files || []).map(file => ({ ...file, kind: 'input_file', source_path: file.path })),
    ...(definition.upstream || []).map(file => ({ ...file, kind: 'upstream', source_path: file.output_file || file.file || null }))
  ];
  let size = 0;
  for (const source of sources) {
    assert(typeof source.content === 'string' && digest(source.content) === source.content_digest, '고정된 입력 자료의 해시가 다릅니다.');
    size += Buffer.byteLength(source.content);
    assert(size <= maxInputBytes, '첨부 자료와 선행 산출물의 총 2 MiB 제한을 초과했습니다.');
    faithfulText(Buffer.from(source.content), source.source_path || source.task || '선행 산출물');
  }
  if (!sources.length) return { directory: null, references: [] };
  const directory = path.join(fs.realpathSync(attemptDir), 'inputs');
  fs.mkdirSync(directory, { mode: 0o700 });
  const references = sources.map((source, index) => {
    const basename = path.basename(source.source_path || source.file || 'artifact.txt').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-180) || 'artifact.txt';
    const file = path.join(directory, `${String(index + 1).padStart(2, '0')}-${basename}`);
    fs.writeFileSync(file, source.content, { flag: 'wx', mode: 0o400 });
    return { kind: source.kind, path: file, source_path: source.source_path, content_digest: source.content_digest,
      ...(source.step_id ? { step_id: source.step_id, task: source.task, output_key: source.output_key } : {}) };
  });
  return { directory, references };
}

export function verifyInputSnapshots(snapshot) {
  if (!snapshot.directory) return;
  assert(fs.lstatSync(snapshot.directory).isDirectory() && !fs.lstatSync(snapshot.directory).isSymbolicLink(), '입력 스냅샷 디렉터리가 변경되었습니다.');
  assert(fs.readdirSync(snapshot.directory).length === snapshot.references.length, '작업자가 입력 스냅샷 파일을 추가하거나 삭제했습니다.');
  for (const file of snapshot.references) {
    assert(digest(readRegular(fs.realpathSync(snapshot.directory), file.path)) === file.content_digest, '작업자가 읽기 전용 입력 스냅샷을 변경했습니다.');
  }
}

export function outputPath(workspace, runId, filename) {
  assert(/^run-[A-Za-z0-9-]+$/.test(runId) && typeof filename === 'string' && filename === path.basename(filename)
    && !['.', '..'].includes(filename) && !/[\\\x00-\x1f\x7f]/.test(filename), '산출물 게시 경로가 잘못되었습니다.');
  return path.join(workspace, 'output', 'worklog', runId, filename);
}

export function publishOutput({ workspace, output_file, bytes, content_digest }) {
  assert(digest(bytes) === content_digest, '게시할 산출물의 해시가 다릅니다.');
  noLinks(workspace, output_file, { createParents: true });
  const verifyExisting = () => assert(digest(readRegular(workspace, output_file)) === content_digest,
    'output 산출물이 기존 파일과 다릅니다. 사용자 파일을 덮어쓰지 않았습니다.', 409);
  if (fs.existsSync(output_file)) { verifyExisting(); return output_file; }
  const temporary = path.join(path.dirname(output_file), `.worklog-${id()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    noLinks(workspace, output_file);
    // A link publishes atomically without replacing a file that appeared concurrently.
    try { fs.linkSync(temporary, output_file); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    verifyExisting(); return output_file;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
