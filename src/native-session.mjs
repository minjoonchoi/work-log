import fs from 'node:fs';
import path from 'node:path';

// Rollouts are not a stable API. Read only the bounded session_meta header,
// validate its identity and known source shape, and never inspect prompt text.
// Unknown/missing metadata must not suppress a real user's conversation.
export function readNativeSession(engine, sessionId, transcriptPath) {
  if (engine !== 'codex' || typeof sessionId !== 'string' || !sessionId
    || typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath)) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(256 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0), end = buffer.subarray(0, length).indexOf(10);
    if (end < 0) return null;
    const row = JSON.parse(buffer.subarray(0, end).toString('utf8')), meta = row.payload;
    if (row.type !== 'session_meta' || !meta || typeof meta.id !== 'string'
      || typeof meta.cli_version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(meta.cli_version)) return null;
    const source = meta.source;
    let kind, parent = null;
    if (['cli', 'vscode', 'exec'].includes(source)) kind = source;
    else if (source && typeof source === 'object' && !Array.isArray(source) && Object.keys(source).length === 1) {
      const child = source.subagent;
      if (['review', 'compact', 'memory_consolidation'].includes(child)) kind = 'subagent';
      else if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 1) {
        if (typeof child.other === 'string' && child.other.length) kind = 'subagent';
        else if (child.thread_spawn && typeof child.thread_spawn.parent_thread_id === 'string') {
          kind = 'subagent'; parent = child.thread_spawn.parent_thread_id;
        }
      }
    }
    // Child hooks can use their parent's session_id. Never persist a child
    // classification against that parent: every observation carries its own ID.
    if (!kind || (meta.id !== sessionId && !(kind === 'subagent' && parent === sessionId))) return null;
    return { adapter: 'codex-session-meta-v1', session_id: meta.id, hook_session_id: sessionId,
      kind, cli_version: meta.cli_version, ...(parent ? { parent_session_id: parent } : {}) };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function isNativeBackgroundEvent(event) {
  if (!['codex', 'claude'].includes(event.engine) || event.source !== 'system_hook' || event.role !== 'user') return false;
  const meta = event.native_session || readNativeSession(event.engine, event.agent_session_id, event.transcript_path);
  if (event.engine === 'claude') return meta?.adapter === 'claude-hook-origin-v1'
    && meta.hook_session_id === event.agent_session_id
    && ((meta.kind === 'print' && meta.session_id === event.agent_session_id && claudeHeadlessEntrypoints.has(meta.entrypoint))
      || (meta.kind === 'subagent' && typeof meta.session_id === 'string' && meta.session_id.length > 0
        && meta.parent_session_id === event.agent_session_id));
  return meta?.adapter === 'codex-session-meta-v1' && meta.hook_session_id === event.agent_session_id
    && (meta.session_id === event.agent_session_id || (meta.kind === 'subagent' && meta.parent_session_id === event.agent_session_id))
    && ['exec', 'subagent'].includes(meta.kind);
}

export function nativeBackgroundIdentity(event) {
  if (!isNativeBackgroundEvent(event)) return null;
  const meta = event.native_session || readNativeSession(event.engine, event.agent_session_id, event.transcript_path);
  // A shared parent hook ID cannot be marked as a background session.
  if (event.engine === 'claude' && meta.kind === 'subagent') return null;
  return meta.session_id === event.agent_session_id ? meta.kind : null;
}

// Claude Code 2.1.37's published CLI sets sdk-cli for -p/--print (and other
// noninteractive invocations); SDK launchers set sdk-ts or sdk-py. These are
// implementation identifiers, not a public hook mode field. Keep the allowlist
// narrow: cli, local-agent, vscode and unknown values do not prove headless mode.
const claudeHeadlessEntrypoints = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']);

export function readClaudeSession(raw, entrypoint) {
  if (typeof raw.session_id !== 'string' || !raw.session_id.trim()) return null;
  const base = { adapter: 'claude-hook-origin-v1', hook_session_id: raw.session_id };
  // agent_type alone also exists on interactive `claude --agent ...` sessions.
  // Only agent_id proves this hook belongs to a child, never its shared parent.
  if (typeof raw.agent_id === 'string' && raw.agent_id.trim()) return { ...base,
    session_id: raw.agent_id, parent_session_id: raw.session_id, kind: 'subagent' };
  if (claudeHeadlessEntrypoints.has(entrypoint)) return { ...base,
    session_id: raw.session_id, kind: 'print', entrypoint };
  if (['cli', 'claude-vscode', 'local-agent'].includes(entrypoint)) return { ...base,
    session_id: raw.session_id, kind: 'interactive', entrypoint };
  return null;
}

// A versioned, narrow heuristic, never proof of an internal session. Only
// otherwise unclassified first requests are held; users can explicitly admit them.
export function titleAutomationCandidate(event) {
  return ['codex', 'claude'].includes(event.engine) && event.source === 'system_hook'
    && event.role === 'user' && event.kind === 'input'
    && !event.native_session && !event.transcript_path && typeof event.text === 'string'
    && /^Generate a concise, single-line task title at most 36 characters(?=[\s.,:;!?]|$)/i.test(event.text.trimStart());
}
