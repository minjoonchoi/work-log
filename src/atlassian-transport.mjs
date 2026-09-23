import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { Agent } from 'undici';
import { digest } from './shared.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400, code: 'ca_certificate_invalid', not_sent: true });
export function certificatePath(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value))
    throw invalid('추가 CA 인증서 파일 경로를 확인하세요.');
  const input = value.trim();
  if (!input) return null;
  const expanded = input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input;
  if (!path.isAbsolute(expanded)) throw invalid('추가 CA 인증서는 절대 경로 또는 ~/로 시작하는 파일 경로를 입력하세요.');
  return path.normalize(expanded);
}

export function readCertificates(file) {
  if (!file) return null;
  let fd, source;
  try {
    // A FIFO/device must not block the manager or be read as a credential file.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd), limit = 2 * 1024 * 1024;
    if (!stat.isFile() || !stat.size || stat.size > limit) throw invalid('추가 CA 인증서는 2MB 이하의 비어 있지 않은 PEM 파일이어야 합니다.');
    const buffer = Buffer.alloc(limit + 1); let size = 0, bytes;
    do { bytes = fs.readSync(fd, buffer, size, buffer.length - size, null); size += bytes; } while (bytes && size < buffer.length);
    if (size > limit) throw invalid('추가 CA 인증서 파일은 2MB 이하여야 합니다.');
    source = buffer.subarray(0, size).toString('utf8');
  } catch (e) {
    if (e.code === 'ca_certificate_invalid') throw e;
    throw invalid('추가 CA 인증서 파일을 읽을 수 없습니다. 파일 경로와 읽기 권한을 확인하세요.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  const blocks = source.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  const remainder = source.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').replace(/^\s*#.*$/gm, '').trim();
  if (!blocks.length || remainder) throw invalid('추가 CA 파일은 PEM 인증서만 포함해야 합니다. 개인 키나 다른 형식의 파일은 사용할 수 없습니다.');
  try {
    for (const block of blocks) if (!new X509Certificate(block).ca) throw new Error('not a CA');
  } catch { throw invalid('회사에서 제공한 루트·중간 CA의 유효한 PEM 인증서 파일을 지정하세요.'); }
  return { certificates: blocks, fingerprint: digest(source) };
}

// A dedicated dispatcher keeps custom trust local to Atlassian. Never change
// process-wide TLS defaults or the global fetch dispatcher (including workers).
export class AtlassianTransport {
  constructor() { this.agent = null; this.fingerprint = null; }
  close() {
    const agent = this.agent; this.agent = null; this.fingerprint = null;
    // Graceful close lets already-dispatched responses finish under their snapshot.
    if (agent) void agent.close().catch(() => {});
  }
  fetch(url, options, file) {
    const bundle = readCertificates(file);
    if (!bundle) { this.close(); return fetch(url, options); }
    if (bundle.fingerprint !== this.fingerprint) {
      const defaults = tls.getCACertificates ? tls.getCACertificates('default') : tls.rootCertificates;
      const agent = new Agent({ connect: { ca: [...defaults, ...bundle.certificates], rejectUnauthorized: true } });
      this.close(); this.agent = agent; this.fingerprint = bundle.fingerprint;
    }
    return fetch(url, { ...options, dispatcher: this.agent });
  }
}

export function connectionFailure(cause, target, status, code) {
  if (cause?.code === 'ca_certificate_invalid') return cause;
  const codes = new Set();
  const collect = (e, depth = 0) => {
    if (!e || depth > 4) return;
    if (e.code) codes.add(e.code);
    if (e.name === 'TimeoutError' || e.name === 'AbortError') codes.add(e.name);
    collect(e.cause, depth + 1);
    for (const nested of (Array.isArray(e.errors) ? e.errors : []).slice(0, 8)) collect(nested, depth + 1);
  };
  collect(cause);
  const known = ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
    'ETIMEDOUT', 'TimeoutError', 'AbortError', 'ECONNREFUSED', 'ECONNRESET'];
  const reason = known.find(value => codes.has(value));
  const hint = reason && known.indexOf(reason) < 7 ? 'TLS 인증서 검증에 실패했습니다. 추가 CA 인증서 경로와 인증서 유효기간·서버 주소를 확인하세요.'
    : ['ENOTFOUND', 'EAI_AGAIN'].includes(reason) ? '서버 주소를 찾지 못했습니다. DNS·VPN 설정을 확인하세요.'
      : ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'TimeoutError', 'AbortError'].includes(reason) ? '연결 시간이 초과되었습니다. 네트워크·회사 프록시 설정을 확인하세요.'
        : '네트워크 연결에 실패했습니다. 회사 프록시·방화벽과 연결 상태를 확인하세요.';
  // Never display raw fetch messages, headers, URLs or token payloads.
  return Object.assign(new Error(`${target}: ${hint}${reason ? ` (${reason})` : ''}`), { status, code });
}
