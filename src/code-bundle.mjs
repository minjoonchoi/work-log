import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assert, digest } from './shared.mjs';
import { validateSchema } from './schema.mjs';

const inputSchema = JSON.parse(fs.readFileSync(new URL('../contracts/inputs/code.schema.json', import.meta.url)));
const bundleSchema = JSON.parse(fs.readFileSync(new URL('../contracts/code-bundle.schema.json', import.meta.url)));

// Bundles contain literal, portable repository-relative file names, never globs or operations.
function fileKey(value) {
  assert(typeof value === 'string' && value.length > 0 && value === value.trim()
    && !/[\\\x00-\x1f\x7f:*?<>|]/.test(value) && !path.posix.isAbsolute(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !/[. ]$/.test(part)),
  `안전한 상대 파일 경로가 필요합니다: ${value}`);
  return value.normalize('NFC').toLowerCase();
}

function distinctPaths(paths, label) {
  const keys = new Set();
  for (const file of paths) {
    const key = fileKey(file);
    assert(!keys.has(key), `${label} 파일 경로가 중복됩니다: ${file}`);
    keys.add(key);
  }
  for (const key of keys) {
    const parts = key.split('/'); parts.pop();
    while (parts.length) {
      assert(!keys.has(parts.join('/')), `${label} 파일과 디렉터리 경로가 충돌합니다: ${key}`);
      parts.pop();
    }
  }
}

export function validateCodeInput(input) {
  validateSchema(inputSchema, input, '코드 작업 input');
  distinctPaths(input.allowed_paths, '허용');
  distinctPaths(input.source_files.map(file => file.path), '원본');
  const sourceKeys = new Map(input.source_files.map(file => [fileKey(file.path), file.path]));
  for (const file of input.allowed_paths) assert(!sourceKeys.has(fileKey(file)) || sourceKeys.get(fileKey(file)) === file,
    `원본과 허용 경로의 대소문자 또는 문자 정규화가 다릅니다: ${file}`);
  distinctPaths([...new Set([...input.allowed_paths, ...input.source_files.map(file => file.path)])], '원본과 허용');
  return input;
}

export function parseCodeBundle(text, input) {
  validateCodeInput(input);
  const bundle = typeof text === 'string' ? JSON.parse(text) : text;
  validateSchema(bundleSchema, bundle, '코드 변경 묶음');
  distinctPaths(bundle.files.map(file => file.path), '산출물');
  const allowed = new Set(input.allowed_paths), sources = new Map(input.source_files.map(file => [file.path, file.content]));
  for (const file of bundle.files) {
    assert(allowed.has(file.path), `허용되지 않은 코드 파일입니다: ${file.path}`);
    assert(!sources.has(file.path) || sources.get(file.path) !== file.content, `원본과 동일한 파일을 변경 결과로 반환했습니다: ${file.path}`);
  }
  return bundle;
}

function javascriptContext(filename, snapshots) {
  if (filename.endsWith('.mjs')) return { modes: ['module'], source: 'file_extension' };
  if (filename.endsWith('.cjs')) return { modes: ['commonjs'], source: 'file_extension' };
  for (let directory = path.posix.dirname(filename);; directory = path.posix.dirname(directory)) {
    const packageFile = path.posix.join(directory, 'package.json');
    if (snapshots.has(packageFile)) {
      const content = snapshots.get(packageFile), metadata = JSON.parse(content);
      const type = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata.type : undefined;
      return { modes: ['module', 'commonjs'].includes(type) ? [type] : ['module', 'commonjs'],
        source: 'package_snapshot', file: packageFile, content_digest: digest(content) };
    }
    if (directory === '.') break;
  }
  // Without project metadata, a successful parser mode establishes syntax only.
  return { modes: ['module', 'commonjs'], source: 'unspecified' };
}

function javascriptSyntax(content, mode) {
  return new Promise(resolve => {
    // --check parses stdin only. Model imports, commands and module bodies never execute.
    const child = spawn(process.execPath, ['--check', `--input-type=${mode}`], {
      env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'], shell: false
    });
    let error = '', overflow = false, timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 3000);
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      if (error.length + chunk.length > 65536) { overflow = true; child.kill('SIGKILL'); }
      else error += chunk.toString();
    });
    child.on('error', e => finish({ passed: false, error: e.message }));
    child.on('close', code => finish({ passed: code === 0 && !timedOut && !overflow, exit_code: code,
      ...((code !== 0 || timedOut || overflow) ? { error: timedOut ? '문법 검사 시간 초과' : overflow ? '문법 검사 출력 한도 초과' : error.trim() } : {}) }));
    child.stdin.on('error', () => {});
    child.stdin.end(content);
  });
}

async function checkJavaScript(file, snapshots) {
  const check = { rule: 'OUTPUT-001', check: `JavaScript syntax: ${file.path}`, method: 'node --check (stdin; no code execution)' };
  let context;
  try { context = javascriptContext(file.path, snapshots); }
  catch (error) { return { ...check, passed: false, error: `JavaScript package.json 문맥을 읽을 수 없습니다: ${error.message}` }; }
  const { modes, ...source } = context;
  const module_context = { ...source, confirmed: modes.length === 1 };
  const failures = [];
  for (const mode of modes) {
    const result = await javascriptSyntax(file.content, mode);
    if (result.passed) return { ...check, ...result, parser_mode: mode, module_context };
    failures.push({ mode, ...result });
  }
  return { ...check, passed: false, module_context, attempts: failures,
    error: failures.map(result => `${result.mode}: ${result.error}`).join('\n') };
}

export async function checkCodeBundle(text, input) {
  const checks = [];
  let bundle;
  try {
    bundle = parseCodeBundle(text, input);
    const sources = new Map(input.source_files.map(file => [file.path, file.content]));
    checks.push({ rule: 'SCOPE-001', check: 'code bundle scope and source snapshots', passed: true,
      files: bundle.files.map(file => ({ path: file.path, operation: sources.has(file.path) ? 'modify' : 'create',
        source_digest: sources.has(file.path) ? digest(sources.get(file.path)) : null, content_digest: digest(file.content) })) });
  } catch (e) {
    return [{ rule: 'SCOPE-001', check: 'code bundle scope and source snapshots', passed: false, error: e.message }];
  }
  const unvalidated = [];
  const snapshots = new Map([...input.source_files, ...bundle.files].map(file => [file.path, file.content]));
  for (const file of bundle.files) {
    if (/\.(mjs|cjs|js)$/.test(file.path)) checks.push(await checkJavaScript(file, snapshots));
    else if (file.path.endsWith('.json')) {
      try { JSON.parse(file.content); checks.push({ rule: 'OUTPUT-001', check: `JSON syntax: ${file.path}`, passed: true }); }
      catch (e) { checks.push({ rule: 'OUTPUT-001', check: `JSON syntax: ${file.path}`, passed: false, error: e.message }); }
    } else unvalidated.push(file.path);
  }
  // Scope/syntax passing is not evidence of a project build, runtime behavior or tests.
  checks.push({ rule: 'OUTPUT-001', check: 'code verification coverage recorded', passed: true,
    syntax_not_checked: unvalidated, project_build: 'not_run', runtime_tests: 'not_run', project_applied: false });
  return checks;
}

// Optional export to a NEW artifact directory, never apply to a working repository.
export async function materializeCodeBundle(text, input, destination) {
  const checks = await checkCodeBundle(text, input);
  assert(checks.every(check => check.passed), '검증에 실패한 코드 묶음은 내보낼 수 없습니다.');
  const root = path.resolve(destination);
  for (let parent = path.dirname(root);; parent = path.dirname(parent)) {
    assert(!fs.lstatSync(parent).isSymbolicLink(), '심링크 경로에는 코드 묶음을 내보낼 수 없습니다.');
    if (parent === path.dirname(parent)) break;
  }
  // Non-recursive creation and exclusive file writes refuse pre-existing targets.
  fs.mkdirSync(root, { mode: 0o700 });
  const bundle = parseCodeBundle(text, input);
  for (const file of bundle.files) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, file.content, { flag: 'wx', mode: 0o600 });
  }
  return { directory: root, files: checks[0].files, checks };
}
