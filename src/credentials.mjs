import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, assert, digest } from './shared.mjs';

// This runner intentionally has no command/output logging. Secrets travel only through pipes.
export function credentialProcess(binary, args, input, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', size = 0, failure;
    const timer = setTimeout(() => { failure = `${label} 응답 시간이 초과되었습니다.`; child.kill('SIGKILL'); }, 30000);
    const finish = message => { clearTimeout(timer); reject(new Error(message)); };
    child.on('error', () => finish(`${label} 실행 파일을 찾거나 실행할 수 없습니다.`));
    child.stdin.on('error', () => {});
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > 256 * 1024) { failure = `${label} 응답 한도를 초과했습니다.`; child.kill('SIGKILL'); }
      else output += bytes.toString('utf8');
    });
    child.stderr.on('data', bytes => {
      size += bytes.length;
      if (size > 256 * 1024) { failure = `${label} 응답 한도를 초과했습니다.`; child.kill('SIGKILL'); }
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(new Error(failure || `${label} 접근 실패. 설치·잠금·로그인 상태와 지정한 항목을 확인하세요.`));
      else resolve(output);
    });
    child.stdin.end(input || '');
  });
}

export class OnePasswordCredentials {
  constructor(binary) {
    this.binary = binary || process.env.HARNESS_OP_BIN || ['/opt/homebrew/bin/op', '/usr/local/bin/op'].find(p => fs.existsSync(p)) || 'op';
  }
  async read({ vault, item }) {
    const raw = await credentialProcess(this.binary,
      ['item', 'get', item, '--vault', vault, '--fields', 'label=client_id,label=client_secret', '--format', 'json', '--reveal'], null, '1Password CLI(op)');
    let data; try { data = JSON.parse(raw); } catch { throw new Error('1Password item 응답 형식을 확인하세요.'); }
    const fields = Array.isArray(data) ? data : data.fields;
    assert(Array.isArray(fields), '1Password item에 client_id와 client_secret 필드가 필요합니다.');
    const read = label => {
      const matches = fields.filter(f => f.label === label || f.id === label);
      assert(matches.length === 1 && typeof matches[0].value === 'string' && matches[0].value.trim(), `1Password ${label} 필드를 확인하세요.`);
      return matches[0].value;
    };
    return { client_id: read('client_id'), client_secret: read('client_secret') };
  }
}

export class KeychainTokens {
  constructor(dir, binary) {
    this.binary = binary || process.env.HARNESS_KEYCHAIN_BIN || [path.join(ROOT, '../WorkLogKeychain'), path.join(ROOT, '../../MacOS/WorkLogKeychain'), path.join(ROOT, 'dist/Work Log.app/Contents/MacOS/WorkLogKeychain')].find(p => fs.existsSync(p));
    this.account = `oauth-${digest(path.resolve(dir)).slice(0, 24)}`;
  }
  async command(operation, value) {
    assert(this.binary, 'macOS Keychain 도우미가 없습니다. 최신 앱을 빌드하거나 설치하세요.', 503);
    const raw = await credentialProcess(this.binary, [], JSON.stringify({ operation, account: this.account, ...(value === undefined ? {} : { value }) }), 'macOS Keychain');
    let result; try { result = JSON.parse(raw); } catch { throw new Error('Keychain 도우미 응답을 확인하세요.'); }
    assert(result.ok, 'macOS Keychain에 접근할 수 없습니다. 잠금과 접근 권한을 확인하세요.', 503);
    return result.value ?? null;
  }
  read() { return this.command('get'); }
  write(value) { return this.command('set', value); }
  remove() { return this.command('delete'); }
}
