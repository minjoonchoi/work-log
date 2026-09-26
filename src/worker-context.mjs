import fs from 'node:fs';
import path from 'node:path';
import { assert, atomic, json } from './shared.mjs';

const markerName = 'worker-context.json';
const runId = value => typeof value === 'string' && /^run-[a-zA-Z0-9-]+$/.test(value);
const attemptId = value => typeof value === 'string' && /^attempt-[a-zA-Z0-9-]+$/.test(value);

function ownedWorkspace(dir, cwd) {
  if (typeof dir !== 'string' || typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.length > 4096) return null;
  const root = fs.realpathSync(dir), current = fs.realpathSync(cwd);
  const parts = path.relative(root, current).split(path.sep);
  if (parts[0] !== 'runs' || !runId(parts[1]) || !attemptId(parts[2]) || parts[3] !== 'workspace') return null;
  const attempt = path.join(root, ...parts.slice(0, 3)), workspace = path.join(attempt, 'workspace');
  // Realpath containment also handles macOS /var versus /private/var aliases.
  if (fs.realpathSync(workspace) !== workspace) return null;
  return { root, attempt, workspace, run_id: parts[1], attempt_id: parts[2] };
}

// Persist executor-owned identity outside the writable output workspace. Direct
// text workers must still see an empty workspace. No prompt or secret is stored.
export function registerWorkerContext({ dataDir, cwd, attemptDir, engine, parent }) {
  if (!dataDir || !path.resolve(attemptDir).startsWith(path.resolve(dataDir, 'runs') + path.sep)) return;
  const owned = ownedWorkspace(dataDir, cwd);
  assert(owned && owned.attempt === fs.realpathSync(attemptDir) && owned.workspace === fs.realpathSync(cwd)
    && parent?.run_id === owned.run_id && parent?.task_id === owned.attempt_id
    && typeof parent.work_item_id === 'string' && parent.work_item_id.length > 0,
  '작업자 세션의 실행 소유 정보를 확인할 수 없습니다.');
  atomic(path.join(owned.attempt, markerName), json({ format: 1, engine, ...owned, work_item_id: parent.work_item_id }));
}

// Some launchers do not preserve arbitrary environment variables for hooks.
// Recognize only exact executor-registered workspaces, never titles, prompts,
// parent directories in an arbitrary project, or a folder name alone.
export function isWorkerWorkspace(dir, engine, cwd) {
  let fd;
  try {
    const owned = ownedWorkspace(dir, cwd);
    if (!owned) return false;
    fd = fs.openSync(path.join(owned.attempt, markerName), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > 8192) return false;
    const buffer = Buffer.alloc(8193), size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 8192) return false;
    const record = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    return record.format === 1 && record.engine === engine
      && Object.entries(owned).every(([key, value]) => record[key] === value)
      && typeof record.work_item_id === 'string' && record.work_item_id.length > 0;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
