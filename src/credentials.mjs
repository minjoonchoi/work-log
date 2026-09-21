import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, assert, digest } from './shared.mjs';

// This runner intentionally has no command/output logging. Secrets travel only through pipes.
const credentialChildren = new Set();
let closingCredentials = false;
export async function stopCredentialProcesses() {
  closingCredentials = true;
  const children = [...credentialChildren];
  for (const child of children) child.cancel();
  await Promise.all(children.map(child => child.closed));
}
export function credentialProcess(binary, args, input, label) {
  if (closingCredentials) return Promise.reject(new Error('관리 서비스가 종료 중입니다.'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let output = '', size = 0, failure, killTimer, settled = false, closed;
    const signal = value => { if (child.pid) { try { process.kill(-child.pid, value); } catch {} } };
    const cancel = message => {
      if (settled) return;
      failure ||= message; signal('SIGTERM');
      killTimer ||= setTimeout(() => signal('SIGKILL'), 500);
    };
    const tracked = { cancel: () => cancel('관리 서비스가 종료 중입니다.'), closed: new Promise(done => { closed = done; }) };
    credentialChildren.add(tracked);
    const timer = setTimeout(() => cancel(`${label} 응답 시간이 초과되었습니다.`), 30000);
    const finish = code => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(killTimer); signal('SIGKILL');
      credentialChildren.delete(tracked); closed();
      if (failure || code !== 0) reject(new Error(failure || `${label} 접근 실패. 설치·잠금·로그인 상태와 지정한 항목을 확인하세요.`));
      else resolve(output);
    };
    child.on('error', () => { failure = `${label} 실행 파일을 찾거나 실행할 수 없습니다.`; finish(null); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > 256 * 1024) cancel(`${label} 응답 한도를 초과했습니다.`);
      else output += bytes.toString('utf8');
    });
    child.stderr.on('data', bytes => {
      size += bytes.length;
      if (size > 256 * 1024) cancel(`${label} 응답 한도를 초과했습니다.`);
    });
    child.on('close', finish);
    child.stdin.end(input || '');
  });
}

class KeychainRecord {
  constructor(dir, binary, prefix) {
    this.binary = binary || process.env.HARNESS_KEYCHAIN_BIN || [path.join(ROOT, '../WorkLogKeychain'), path.join(ROOT, '../../MacOS/WorkLogKeychain'), path.join(ROOT, 'dist/WorkLog.app/Contents/MacOS/WorkLogKeychain')].find(p => fs.existsSync(p));
    this.account = `${prefix}-${digest(path.resolve(dir)).slice(0, 24)}`;
  }
  async command(operation, value) {
    assert(this.binary, 'macOS Keychain 도우미가 없습니다. 최신 앱을 빌드하거나 설치하세요.', 503);
    let raw;
    try { raw = await credentialProcess(this.binary, [], JSON.stringify({ operation, account: this.account, ...(value === undefined ? {} : { value }) }), 'macOS Keychain'); }
    catch (error) { error.status = 503; throw error; }
    let result; try { result = JSON.parse(raw); } catch { assert(false, 'Keychain 도우미 응답을 확인하세요.', 503); }
    assert(result && typeof result === 'object' && !Array.isArray(result) && typeof result.ok === 'boolean', 'Keychain 도우미 응답을 확인하세요.', 503);
    assert(result.ok, 'macOS Keychain에 접근할 수 없습니다. 잠금과 접근 권한을 확인하세요.', 503);
    return result.value ?? null;
  }
  read() { return this.command('get'); }
  write(value) { return this.command('set', value); }
  remove() { return this.command('delete'); }
}

export class KeychainTokens extends KeychainRecord {
  constructor(dir, binary) { super(dir, binary, 'oauth'); }
}

export class KeychainClientCredentials extends KeychainRecord {
  constructor(dir, binary) { super(dir, binary, 'client'); }
  stored() { return this.command('get'); }
  async read(config) {
    const record = await this.stored();
    assert(config && typeof record?.client_id === 'string' && record.client_id === config.client_id
      && typeof record.credential_version === 'string' && record.credential_version === config.credential_version
      && typeof record.client_secret === 'string' && record.client_secret.trim() && record.client_secret.length <= 4096
      && !/[\u0000-\u001f\u007f]/.test(record.client_secret),
    '저장된 Client ID와 Client Secret을 확인할 수 없습니다. 연결 설정에서 다시 저장하세요.', 401);
    return { client_id: record.client_id, client_secret: record.client_secret };
  }
}
