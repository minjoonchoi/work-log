import path from 'node:path';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function sessionResume(session, observation) {
  if (!['codex', 'claude'].includes(session.engine) || observation?.source !== 'system_hook'
    || observation.role !== 'user' || observation.parent
    || ['exec', 'subagent', 'print'].includes(observation.native_session?.kind)
    || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(session.agent_session_id)) return null;
  const cwd = observation.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.length > 4096 || /[\u0000-\u001f\u007f]/.test(cwd)) return null;
  const invocation = session.engine === 'codex' ? 'codex resume' : 'claude --resume';
  return { command: `cd -- ${quote(cwd)} && ${invocation} ${quote(session.agent_session_id)}`, cwd, session_id: session.agent_session_id };
}
