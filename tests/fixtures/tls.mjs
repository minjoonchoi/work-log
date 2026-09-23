import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Short-lived, isolated test CA and localhost server. No system trust changes.
export function tlsFixture(dir, name = 'fixture-ca', { subjectAltName = 'DNS:localhost,IP:127.0.0.1' } = {}) {
  const root = path.join(dir, name); fs.mkdirSync(root, { recursive: true });
  const file = name => path.join(root, name);
  const run = args => {
    const result = spawnSync('openssl', args, { cwd: root, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  fs.writeFileSync(file('ca.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=WorkLog local test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', 'ca.cnf', '-keyout', 'ca.key', '-out', 'ca.pem']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr']);
  fs.writeFileSync(file('server.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${subjectAltName}\n`);
  run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'server.ext', '-out', 'server.pem']);
  return { caPath: file('ca.pem'), ca: fs.readFileSync(file('ca.pem'), 'utf8'),
    key: fs.readFileSync(file('server.key')), cert: fs.readFileSync(file('server.pem')),
    privateKeyPath: file('ca.key'), serverCertPath: file('server.pem') };
}
