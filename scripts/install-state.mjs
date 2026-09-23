import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { assert, digest, json, atomic, alive } from '../src/shared.mjs';

export const OWNER = 'worklog';
export const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const stat = file => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export function locations(homeDir = os.homedir()) {
  const home = path.resolve(homeDir), data = path.join(home, 'Library/Application Support/WorkLog');
  return { home, data, manifest: path.join(data, 'installation.json'), app: path.join(home, 'Applications/WorkLog.app'),
    configs: { claude: path.join(home, '.claude/settings.json'), codex: path.join(home, '.codex/hooks.json') },
    agents: ['runtime', 'manager', 'gui'].map(role => ({ label: `local.worklog.${role}`, path: path.join(home, `Library/LaunchAgents/local.worklog.${role}.plist`) })) };
}
export function skillLinks(loc, names, runtime) {
  return names.flatMap(name => ['.claude/skills', '.agents/skills', '.codex/worklog/skills'].map(root =>
    ({ path: path.join(loc.home, root, name), target: path.join(runtime, 'harness/skills', name) })));
}

// Never traverse a replaced parent symlink into another application's files.
export function safePath(home, target, { symlink = false } = {}) {
  const rel = path.relative(home, target);
  assert(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), '설치 경로가 사용자 홈 범위를 벗어났습니다.');
  let current = home;
  const parts = rel.split(path.sep);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    const info = stat(current); if (!info) continue;
    const leaf = i === parts.length - 1;
    assert(!info.isSymbolicLink() || (leaf && symlink), `심링크로 바뀐 경로를 보존했습니다: ${current}`);
    if (!leaf) assert(info.isDirectory(), `상위 경로가 디렉터리가 아닙니다: ${current}`);
  }
}

export function locked(homeDir, fn) {
  const loc = locations(homeDir), lock = path.join(loc.data, 'installation.lock');
  safePath(loc.home, lock); fs.mkdirSync(loc.data, { recursive: true, mode: 0o700 });
  const contents = json({ pid: process.pid, nonce: crypto.randomUUID() });
  try { fs.writeFileSync(lock, contents, { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const previous = fs.readFileSync(lock, 'utf8');
    const owner = JSON.parse(previous);
    assert(Number.isSafeInteger(owner.pid) && owner.pid > 1 && !alive(owner.pid), '설치 또는 제거가 이미 실행 중입니다.');
    assert(fs.readFileSync(lock, 'utf8') === previous, '설치 잠금이 변경되었습니다.');
    fs.unlinkSync(lock); fs.writeFileSync(lock, contents, { flag: 'wx', mode: 0o600 });
  }
  const release = () => { if (stat(lock) && fs.readFileSync(lock, 'utf8') === contents) fs.unlinkSync(lock); };
  try {
    const result = fn(loc);
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release);
    release(); return result;
  } catch (error) { release(); throw error; }
}

export function saveManifest(loc, receipt) { safePath(loc.home, loc.manifest); atomic(loc.manifest, JSON.stringify(receipt, null, 2)); }
export function readManifest(loc) {
  safePath(loc.home, loc.manifest);
  if (!stat(loc.manifest)) return null;
  const m = JSON.parse(fs.readFileSync(loc.manifest, 'utf8'));
  return validateManifest(loc, m);
}

export function validateManifest(loc, m) {
  assert(m.owner === OWNER && [1, 2].includes(m.format) && /^[0-9a-f-]{36}$/.test(m.id) && m.home === loc.home, 'WorkLog 설치 소유 정보를 확인할 수 없습니다.');
  assert(typeof m.version === 'string' && /^\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(m.version), '설치 버전 형식이 잘못되었습니다.');
  const runtime = path.join(loc.data, 'versions', m.version);
  assert(Array.isArray(m.skills) && m.skills.length > 0 && new Set(m.skills).size === m.skills.length
    && m.skills.every(s => s === 'work'), '요청 스킬 목록이 잘못되었습니다.');
  assert(Array.isArray(m.trees) && m.trees.length === 2 && m.trees[0].path === loc.app && m.trees[1].path === runtime, '설치 파일의 허용 경로가 다릅니다.');
  for (const tree of m.trees) {
    assert(Array.isArray(tree.entries), '설치 파일 목록이 없습니다.');
    for (const entry of tree.entries) {
      assert(typeof entry.relative === 'string' && !path.isAbsolute(entry.relative) && !entry.relative.split(/[\\/]/).includes('..'), '설치 파일 경로가 잘못되었습니다.');
      assert(['file', 'directory', 'symlink'].includes(entry.kind), '설치 파일 유형이 잘못되었습니다.');
      if (entry.kind === 'file') assert(/^[a-f0-9]{64}$/.test(entry.digest), '설치 파일 해시가 없습니다.');
    }
  }
  const links = skillLinks(loc, m.skills, runtime);
  assert(Array.isArray(m.links) && (m.format === 2 || m.links.length === links.length)
    && new Set(m.links.map(l => l.path)).size === m.links.length, '지시문 연결 목록이 잘못되었습니다.');
  assert(m.links.every(l => links.some(expected => l.path === expected.path && l.target === expected.target)), '지시문 연결 경로가 다릅니다.');
  assert(m.links.every(link => link.pending === undefined || typeof link.pending === 'boolean'), '지시문 연결 생성 상태가 잘못되었습니다.');
  assert(Array.isArray(m.files) && m.files.length === loc.agents.length, '서비스 목록이 잘못되었습니다.');
  assert(m.files.every((f, i) => f.path === loc.agents[i].path && f.label === loc.agents[i].label
    && digest(f.content) === f.digest && Array.isArray(f.argv)
    && canonical(f.argv) === canonical(i === 2 ? [path.join(loc.app, 'Contents/MacOS/WorkLog'), '--background']
      : [path.join(runtime, 'node'), path.join(runtime, 'harness/bin/harness.mjs'), 'serve', ['runtime', 'manager'][i]])), '서비스 소유 정보가 잘못되었습니다.');
  assert(Array.isArray(m.hooks) && (m.format === 2 || m.hooks.length === 2)
    && new Set(m.hooks.map(h => h.engine)).size === m.hooks.length, '훅 소유 정보가 없습니다.');
  for (const h of m.hooks) {
    assert(['claude', 'codex'].includes(h.engine) && h.path === loc.configs[h.engine] && Array.isArray(h.entries), '훅 설정 경로가 다릅니다.');
    for (const entry of h.entries) assert(entry.hook?.type === 'command' && typeof entry.event === 'string'
      && [hookCommand(loc, runtime, m.id, h.engine), legacyHookCommand(loc, runtime, m.id, h.engine)].includes(entry.hook.command), '훅 소유 식별자가 다릅니다.');
  }
  if (m.format === 2) {
    const permittedDirs = new Set([loc.app, ...loc.agents.map(f => f.path), ...Object.values(loc.configs), ...links.map(l => l.path)]
      .flatMap(target => parentPaths(loc.home, target)));
    assert(Array.isArray(m.created_directories) && new Set(m.created_directories).size === m.created_directories.length
      && m.created_directories.every(dir => permittedDirs.has(dir)), '생성한 디렉터리 소유 경로가 다릅니다.');
    assert(Array.isArray(m.created_configs) && new Set(m.created_configs).size === m.created_configs.length
      && m.created_configs.every(file => Object.values(loc.configs).includes(file)), '생성한 설정 소유 경로가 다릅니다.');
  }
  return m;
}

export function parentPaths(home, target) {
  const result = [];
  for (let current = path.dirname(target); current !== home; current = path.dirname(current)) {
    assert(current.startsWith(`${home}${path.sep}`), '상위 경로가 사용자 홈 범위를 벗어났습니다.');
    result.unshift(current);
  }
  return result;
}

export function upgradeManifest(receipt) {
  receipt.format = 2; receipt.created_directories ||= []; receipt.created_configs ||= [];
  return receipt;
}

export function recordDirectories(loc, receipt, targets) {
  upgradeManifest(receipt);
  for (const target of targets) for (const dir of parentPaths(loc.home, target)) {
    if (!stat(dir) && !receipt.created_directories.includes(dir)) receipt.created_directories.push(dir);
  }
}

export function removeEmptyDirectories(loc, receipt, removed, targets = receipt.created_directories || []) {
  for (const dir of [...targets].sort((a, b) => b.length - a.length)) {
    try {
      safePath(loc.home, dir);
      const info = stat(dir);
      if (info?.isDirectory() && !fs.readdirSync(dir).length) { fs.rmdirSync(dir); removed.push({ kind: 'empty_directory', path: dir }); }
      if (!stat(dir)) receipt.created_directories = receipt.created_directories.filter(value => value !== dir);
    } catch { /* Changed or nonempty directories belong to the user now. */ }
  }
}

export function hookCommand(loc, runtime, id, engine) {
  return `if [ "\${HARNESS_WORKER:-}" = "1" ]; then exit 0; fi; ${legacyHookCommand(loc, runtime, id, engine)}`;
}

// Exact legacy receipts remain removable without accepting unrelated commands.
function legacyHookCommand(loc, runtime, id, engine) {
  return `WORKLOG_INSTALL_ID=${quote(id)} HARNESS_DATA_DIR=${quote(loc.data)} ${quote(path.join(runtime, 'node'))} ${quote(path.join(runtime, 'harness/src/hook.mjs'))} ${engine}`;
}

export function inventory(root) {
  const entries = [];
  function visit(relative) {
    const file = path.join(root, relative), info = fs.lstatSync(file);
    if (info.isSymbolicLink()) entries.push({ relative, kind: 'symlink', target: fs.readlinkSync(file) });
    else if (info.isDirectory()) {
      entries.push({ relative, kind: 'directory' });
      for (const child of fs.readdirSync(file).sort()) visit(path.join(relative, child));
    } else {
      assert(info.isFile(), '일반 파일이 아닌 설치 산출물이 있습니다.');
      entries.push({ relative, kind: 'file', digest: digest(fs.readFileSync(file)), mode: info.mode & 0o777 });
    }
  }
  visit(''); return entries;
}

export function matches(file, entry) {
  const info = stat(file); if (!info) return false;
  if (entry.kind === 'symlink') return info.isSymbolicLink() && fs.readlinkSync(file) === entry.target;
  if (entry.kind === 'directory') return info.isDirectory() && !info.isSymbolicLink();
  return info.isFile() && digest(fs.readFileSync(file)) === entry.digest && (entry.mode === undefined || (info.mode & 0o777) === entry.mode);
}

export function readConfig(loc, target) {
  safePath(loc.home, target);
  const info = stat(target);
  assert(!info || info.isFile(), `설정이 일반 파일이 아닙니다: ${target}`);
  const raw = info ? fs.readFileSync(target, 'utf8') : null, value = raw === null ? {} : JSON.parse(raw);
  assert(value && typeof value === 'object' && !Array.isArray(value), `설정 형식을 확인하세요: ${target}`);
  assert(value.hooks === undefined || (value.hooks && typeof value.hooks === 'object' && !Array.isArray(value.hooks)), `hooks 형식을 확인하세요: ${target}`);
  return { raw, value };
}

export function writeConfig(loc, target, before, value) {
  safePath(loc.home, target);
  assert((stat(target) ? fs.readFileSync(target, 'utf8') : null) === before, `설정이 동시에 변경되어 보존했습니다: ${target}`);
  atomic(target, JSON.stringify(value, null, 2));
}

// Match individual installed commands, preserving other hooks added to the same group.
export function hookPositions(config, record) {
  const groups = config.hooks?.[record.event];
  if (groups === undefined) return [];
  assert(Array.isArray(groups), `${record.event} 훅이 배열이 아닙니다.`);
  const found = [];
  groups.forEach((group, g) => {
    if (!group || !Array.isArray(group.hooks)) return;
    const { hooks, ...qualifiers } = group;
    hooks.forEach((hook, h) => {
      if (canonical(hook) === canonical(record.hook) && canonical(qualifiers) === canonical(record.qualifiers)) found.push({ g, h });
    });
  });
  return found;
}
