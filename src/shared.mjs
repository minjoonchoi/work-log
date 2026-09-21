import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const id = (prefix = '') => prefix + crypto.randomUUID();
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const stableId = (prefix, value) => prefix + digest(value).slice(0, 24);
export const now = () => new Date().toISOString();
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const json = value => JSON.stringify(value);
export function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
export function assert(condition, message, status = 400) { if (!condition) fail(message, status); }
export function dataRoot(value) { return path.resolve(value || process.env.HARNESS_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/WorkLog')); }
export function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function initRoot(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, 'token');
  try { fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  return fs.readFileSync(f, 'utf8').trim();
}
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export function lockService(dir, role) {
  initRoot(dir);
  const file = path.join(dir, `${role}.lock`);
  const value = { pid: process.pid, nonce: id() };
  for (let n = 0; n < 3; n++) {
    try {
      fs.writeFileSync(file, json(value), { flag: 'wx', mode: 0o600 });
      const release = () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).nonce === value.nonce) fs.unlinkSync(file); } catch {}
      };
      process.once('exit', release);
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`${role} 잠금 확인이 필요합니다.`, 409); }
      assert(!alive(owner.pid), `${role} 서비스가 이미 실행 중입니다.`, 409);
      // Only reclaim a dead owner's unchanged lock.
      if (fs.readFileSync(file, 'utf8') === json(owner)) fs.unlinkSync(file);
    }
  }
  fail(`${role} 잠금을 획득하지 못했습니다.`, 409);
}
export function database(file, schema) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(schema);
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function redact(text) {
  return String(text).replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
export function redactValue(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /^(password|api[_-]?key|access[_-]?token|secret)$/i.test(k) ? '[REDACTED]' : redactValue(v)]));
  return value;
}
// Executable source snapshots must remain byte-for-byte faithful. Logging still uses
// redact/redactValue, but ingest refuses recognizable tokens and named secret string
// nonempty literals (including placeholders) instead of silently rewriting source code.
// Variable/environment expressions such as password = input.password remain valid.
export function redactExecutionRequest(value) {
  const safe = redactValue(value);
  const token = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,})\b/;
  const name = '(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)';
  const nonemptyString = "(?:\"[^\"]|'[^']|`[^`])";
  const literal = new RegExp(`\\b${name}["']?\\s*[:=]\\s*${nonemptyString}`, 'i');
  const typedLiteral = new RegExp(`\\b${name}\\s*:\\s*(?:str|string|String|&str)\\s*=\\s*${nonemptyString}`, 'i');
  const preserve = (original, target) => {
    if (!Array.isArray(original?.source_files)) return;
    for (const file of original.source_files) for (const text of [file?.path, file?.content]) {
      if (typeof text !== 'string') continue; // The job schema handles invalid shapes.
      assert(!token.test(text) && !literal.test(text) && !typedLiteral.test(text),
        '코드 원본에 자격증명 토큰 또는 하드코딩한 비밀 문자열이 있습니다. 변수·환경 설정 참조로 제거한 원본을 제공하세요.');
    }
    target.source_files = structuredClone(original.source_files);
  };
  preserve(value?.input, safe?.input);
  if (Array.isArray(value?.steps)) value.steps.forEach((step, index) => preserve(step?.input, safe?.steps?.[index]?.input));
  return safe;
}
export function readEndpoint(dir, role) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${role}.endpoint.json`), 'utf8')); }
  catch { return null; }
}
export async function request(dir, role, endpoint, options = {}) {
  const info = readEndpoint(dir, role);
  if (!info) fail(`${role} 연결 정보가 없습니다.`, 503);
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${info.port}${endpoint}`, {
    ...options, signal: options.signal || AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options.headers },
    ...(options.body && typeof options.body !== 'string' ? { body: json(options.body) } : {})
  });
  const result = await response.json();
  if (!response.ok) fail(result.error || `HTTP ${response.status}`, response.status);
  return result;
}
export async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; assert(size <= 2 * 1024 * 1024, '요청이 너무 큽니다.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { fail('유효한 JSON이 필요합니다.'); }
}
export async function serve({ dir, role, port = 0, handler, publicHandler, streamHandler }) {
  const token = initRoot(dir);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const host = req.headers.host || '';
      assert(/^(127\.0\.0\.1|localhost):\d+$/.test(host), 'Invalid host', 403);
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        assert(origin.hostname === '127.0.0.1' && origin.port === String(server.address().port), 'Invalid origin', 403);
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (publicHandler && await publicHandler(req, res, url)) return;
      assert(req.headers.authorization === `Bearer ${token}`, '인증이 필요합니다.', 401);
      if (streamHandler && await streamHandler(req, res, url)) return;
      const result = await handler(req, url);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(json(result ?? {}));
    } catch (e) {
      if (!res.headersSent) res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
      res.end(json({ error: e.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const endpoint = { port: server.address().port, pid: process.pid, instance: id(), started_at: now() };
  atomic(path.join(dir, `${role}.endpoint.json`), json(endpoint));
  return { server, endpoint };
}
export function validateEvent(raw) {
  assert(raw && typeof raw === 'object', '이벤트가 필요합니다.');
  for (const key of ['id', 'engine', 'agent_session_id', 'kind', 'event_at']) assert(typeof raw[key] === 'string' && raw[key].length > 0, `이벤트 ${key}가 필요합니다.`);
  assert(Number.isFinite(Date.parse(raw.event_at)), '이벤트 시각이 잘못되었습니다.');
  assert(['input', 'output', 'session.started', 'session.ended', 'turn.interrupted', 'turn.failed', 'tool.started', 'tool.finished', 'run.updated'].includes(raw.kind), '지원하지 않는 이벤트입니다.');
  if (raw.kind === 'input') assert(typeof raw.turn_id === 'string' && raw.turn_id.length, '입력 연결용 turn_id가 필요합니다.');
  assert(!raw.role || ['user', 'worker', 'metadata'].includes(raw.role), '잘못된 세션 역할입니다.');
  return { ...raw, event_at: new Date(raw.event_at).toISOString(), observed_at: raw.observed_at || now(), role: raw.role || 'user', text: raw.text == null ? null : redact(raw.text) };
}
