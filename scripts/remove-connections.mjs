import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, digest } from '../src/shared.mjs';
import { safePath, stat } from './install-state.mjs';

// Called only after all owned services have stopped and before deleting helpers.
// Never enumerate/delete another application's Keychain records or CLI login.
export function removeLocalConnections(loc, receipt, removed, preserved, { credentialRunner = spawnSync } = {}) {
  const binary = path.join(receipt.trees[1].path, 'WorkLogKeychain');
  for (const prefix of ['oauth', 'client']) {
    try {
      safePath(loc.home, binary);
      const account = `${prefix}-${digest(path.resolve(loc.data)).slice(0, 24)}`;
      const result = credentialRunner(binary, [], { input: JSON.stringify({ operation: 'delete', account }), encoding: 'utf8', timeout: 30000 });
      assert(result.status === 0 && JSON.parse(result.stdout || '{}').ok === true,
        `Atlassian ${prefix === 'oauth' ? 'OAuth 토큰' : 'Client 자격증명'}을 Keychain에서 제거하지 못했습니다. Keychain 잠금과 접근 권한을 확인하고 다시 시도하세요.`);
      removed.push({ kind: 'keychain', service: 'local.worklog.atlassian', account });
    } catch (error) { preserved.push({ path: `Keychain:local.worklog.atlassian/${prefix}`, reason: error.message }); }
  }
  // Keep the application and settings available for retry if Keychain failed.
  if (preserved.length) return;
  const unlink = file => {
    safePath(loc.home, file);
    const info = stat(file); if (!info) return;
    assert(info.isFile(), `연결 파일이 일반 파일이 아니어서 보존했습니다: ${file}`);
    fs.unlinkSync(file); removed.push({ kind: 'connection_data', path: file });
  };
  for (const relative of ['integrations/atlassian.json', 'token', 'runtime.endpoint.json', 'manager.endpoint.json']) {
    try { unlink(path.join(loc.data, relative)); }
    catch (error) { preserved.push({ path: path.join(loc.data, relative), reason: error.message }); }
  }
  const backupRoot = path.join(loc.data, 'install-backups');
  try {
    safePath(loc.home, backupRoot);
    if (stat(backupRoot)) for (const id of fs.readdirSync(backupRoot)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const backups = path.join(backupRoot, id); safePath(loc.home, backups);
      assert(stat(backups)?.isDirectory(), `연결 백업 경로를 확인하세요: ${backups}`);
      for (const file of fs.readdirSync(backups)) {
        if (/^(claude|codex)-[0-9a-f-]{36}\.json$/.test(file)) unlink(path.join(backups, file));
      }
      if (!fs.readdirSync(backups).length) fs.rmdirSync(backups);
    }
    if (stat(backupRoot)?.isDirectory() && !fs.readdirSync(backupRoot).length) fs.rmdirSync(backupRoot);
  } catch (error) { preserved.push({ path: backupRoot, reason: error.message }); }
  const integrations = path.join(loc.data, 'integrations');
  try {
    safePath(loc.home, integrations);
    if (stat(integrations)?.isDirectory() && !fs.readdirSync(integrations).length) fs.rmdirSync(integrations);
  } catch (error) { preserved.push({ path: integrations, reason: error.message }); }
}
