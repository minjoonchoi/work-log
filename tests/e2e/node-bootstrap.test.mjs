import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shared.mjs';

const release = 'node-v22.23.2-darwin-arm64';
const archiveUrl = `https://nodejs.org/dist/v22.23.2/${release}.tar.gz`;
const archiveHash = '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const executable = (file, source) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, { mode: 0o755 });
  return file;
};
const report = `console.log(JSON.stringify({node: process.execPath, args: process.argv.slice(1),
  bundleNode: process.env.HARNESS_BUNDLE_NODE, path: process.env.PATH,
  childNode: require('node:child_process').spawnSync('node', ['-p', 'process.execPath'], {encoding:'utf8'}).stdout.trim()}))`;

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-node-bootstrap-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'Project with spaces'), home = path.join(dir, "User's Home");
  const bin = path.join(dir, 'tools'), curlLog = path.join(dir, 'curl.log'), checksumLog = path.join(dir, 'checksum.log');
  for (const directory of [path.join(root, 'scripts'), home, bin]) fs.mkdirSync(directory, { recursive: true });
  for (const name of ['with-node.sh', 'node-probe.cjs']) fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(root, 'scripts', name));
  fs.chmodSync(path.join(root, 'scripts/with-node.sh'), 0o755);
  fs.copyFileSync(path.join(ROOT, 'Makefile'), path.join(root, 'Makefile'));
  // Only allow known system utilities: the host's Node, npm and nvm cannot leak into discovery.
  for (const name of ['awk', 'basename', 'cat', 'chmod', 'cp', 'cut', 'dirname', 'env', 'find', 'grep', 'head', 'mkdir', 'mktemp', 'mv', 'readlink', 'rm', 'rmdir', 'sed', 'sh', 'sort', 'tail', 'tar', 'tr', 'wc']) {
    const source = ['/usr/bin', '/bin'].map(directory => path.join(directory, name)).find(file => fs.existsSync(file));
    if (source) fs.symlinkSync(source, path.join(bin, name));
  }
  executable(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -m) echo arm64;; *) echo Darwin;; esac\n');
  executable(path.join(bin, 'otool'), `#!/bin/sh
for candidate do :; done
printf '%s:\\n' "$candidate"
cat "$candidate.libs"
`);
  executable(path.join(bin, 'curl'), `#!/bin/sh
printf '%s\\n' "$@" >> "$BOOTSTRAP_CURL_LOG"
if [ "$BOOTSTRAP_NETWORK_FAILURE" = 1 ]; then echo 'fixture: network unavailable' >&2; exit 6; fi
output=; url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) shift; output=$1;;
    https://*) url=$1;;
  esac
  shift
done
if [ "$url" != ${quote(archiveUrl)} ] || [ -z "$output" ]; then echo 'unexpected download request' >&2; exit 64; fi
cp "$BOOTSTRAP_ARCHIVE" "$output"
`);
  executable(path.join(bin, 'shasum'), `#!/bin/sh
printf '%s\\n' "$@" >> "$BOOTSTRAP_CHECKSUM_LOG"
if [ "$BOOTSTRAP_CORRUPT_ARCHIVE" = 1 ]; then exec /usr/bin/shasum "$@"; fi
for candidate do :; done
printf '%s  %s\\n' ${quote(archiveHash)} "$candidate"
`);
  const env = { ...process.env, HOME: home, PATH: bin, BOOTSTRAP_CURL_LOG: curlLog, BOOTSTRAP_CHECKSUM_LOG: checksumLog };
  for (const key of ['NODE', 'NPM', 'NODE_OPTIONS', 'NODE_PATH', 'HARNESS_BUNDLE_NODE', 'HARNESS_NODE_CACHE', 'HARNESS_NODE_DOWNLOAD', 'HARNESS_DATA_DIR', 'NVM_BIN', 'NVM_DIR']) delete env[key];
  const cache = path.join(root, '.data/node');
  const f = {
    dir, root, home, bin, env, cache,
    cachedNode: path.join(cache, release, 'bin/node'),
    calls: () => fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8').trim().split('\n') : [],
    checksums: () => fs.existsSync(checksumLog) ? fs.readFileSync(checksumLog, 'utf8').trim().split('\n') : [],
    run(args = ['node', '-e', report], overrides = {}) {
      return spawnSync('/bin/sh', [path.join(root, 'scripts/with-node.sh'), ...args], {
        cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000
      });
    }
  };
  f.runtime = (directory, { version = '22.23.2', arch = 'arm64', portable = true, npm = true, sqlite = true, name = 'node' } = {}) => {
    const node = path.join(directory, name);
    executable(node, `#!/bin/sh
runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export BOOTSTRAP_ACTIVE_NODE="$runtime_dir/${name}"
exec ${quote(process.execPath)} --require "$runtime_dir/bootstrap-runtime.cjs" "$@"
`);
    fs.writeFileSync(path.join(directory, 'bootstrap-runtime.cjs'), `const path = require('node:path');
      Object.defineProperty(process, 'execPath', {value: process.env.BOOTSTRAP_ACTIVE_NODE});
      Object.defineProperty(process, 'platform', {value: 'darwin'});
      Object.defineProperty(process, 'arch', {value: ${JSON.stringify(arch)}});
      Object.defineProperty(process, 'version', {value: ${JSON.stringify(`v${version}`)}});
      Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}});
      ${sqlite ? '' : `const Module = require('node:module'), load = Module._load;
      Module._load = function(id, ...args) { if(id === 'node:sqlite') throw new Error('fixture: SQLite unavailable'); return load.call(this, id, ...args); };`}
    `);
    fs.writeFileSync(`${node}.libs`, portable
      ? '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)\n'
      : '\t/opt/homebrew/opt/icu4c/lib/libicui18n.76.dylib (compatibility version 76.0.0, current version 76.1.0)\n');
    if (npm) executable(path.join(directory, 'npm'), `#!/usr/bin/env node
      if(process.argv[2] === '--version') console.log('10.9.3');
      else console.log(JSON.stringify({kind:'npm', node:process.execPath, args:process.argv.slice(2),
        bundleNode:process.env.HARNESS_BUNDLE_NODE, path:process.env.PATH,
        childNode:require('node:child_process').spawnSync('node',['-p','process.execPath'],{encoding:'utf8'}).stdout.trim()}));
    `);
    return node;
  };
  f.download = () => {
    const source = path.join(dir, 'download-source');
    f.runtime(path.join(source, release, 'bin'));
    const archive = path.join(dir, `${release}.tar.gz`);
    const tar = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', source, release], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    env.BOOTSTRAP_ARCHIVE = archive;
  };
  return f;
}

function success(result) {
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}
function failure(result, message) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, message);
}
function selected(result, node) {
  assert.equal(result.node, node);
  assert.equal(result.bundleNode, node);
  assert.equal(result.path.split(path.delimiter)[0], path.dirname(node));
  assert.equal(result.childNode, node, 'npm and child processes inherit the selected Node on PATH');
}

test('bootstrap downloads and verifies pinned Node when PATH has no Node, then reuses its cache for npm', t => {
  const f = fixture(t); f.download();
  selected(success(f.run()), f.cachedNode);
  assert.equal(f.calls().filter(value => value === archiveUrl).length, 1);
  assert.ok(f.checksums().length > 0, 'download must be checked before execution');
  const npm = success(f.run(['npm', 'ci', '--ignore-scripts']));
  selected(npm, f.cachedNode);
  assert.deepEqual(npm.args, ['ci', '--ignore-scripts']);
  assert.equal(f.calls().filter(value => value === archiveUrl).length, 1, 'cached Node prevents a second download');
});

test('bootstrap reuses portable PATH Node and preserves command arguments', t => {
  const f = fixture(t), node = f.runtime(path.join(f.dir, 'available/bin'));
  const result = success(f.run(['node', '-e', report, '--', 'two words', "quote's", '$(untouched)'], { PATH: `${path.dirname(node)}:${f.bin}` }));
  selected(result, node);
  assert.deepEqual(result.args, ['two words', "quote's", '$(untouched)']);
  assert.deepEqual(f.calls(), []);
});

test('bootstrap rejects automatic Homebrew Node and downloads a portable runtime', t => {
  const f = fixture(t), node = f.runtime(path.join(f.dir, 'homebrew/bin'), { portable: false }); f.download();
  selected(success(f.run(undefined, { PATH: `${path.dirname(node)}:${f.bin}` })), f.cachedNode);
  assert.ok(f.calls().includes(archiveUrl));
});

test('explicit nvm Node path with spaces controls npm and child-process PATH', t => {
  const f = fixture(t), node = f.runtime(path.join(f.home, '.nvm/versions/node/v22.23.2/bin'));
  const result = success(f.run(['npm', 'run', 'build:mac'], { NODE: node }));
  selected(result, node);
  assert.deepEqual(result.args, ['run', 'build:mac']);
  assert.deepEqual(f.calls(), []);
});

test('HARNESS_BUNDLE_NODE takes precedence over NODE and resolves command names', t => {
  const f = fixture(t), node = f.runtime(path.join(f.dir, 'preferred/bin'));
  fs.symlinkSync(node, path.join(path.dirname(node), 'portable-node'));
  const result = success(f.run(undefined, { HARNESS_BUNDLE_NODE: 'portable-node', NODE: '/missing/node', PATH: `${path.dirname(node)}:${f.bin}` }));
  assert.equal(result.node, node);
  assert.equal(result.bundleNode, node);
  assert.deepEqual(f.calls(), []);
});

test('bootstrap discovers nvm without sourcing a user shell or requiring nvm on PATH', async t => {
  for (const source of ['NVM_BIN', 'NVM_DIR', 'default HOME']) await t.test(source, t => {
    const f = fixture(t), nvm = source === 'default HOME' ? path.join(f.home, '.nvm') : path.join(f.dir, 'nvm custom location');
    const node = f.runtime(path.join(nvm, 'versions/node/v22.23.2/bin'));
    const env = source === 'NVM_BIN' ? { NVM_BIN: path.dirname(node) } : source === 'NVM_DIR' ? { NVM_DIR: nvm } : {};
    selected(success(f.run(undefined, env)), node);
    assert.deepEqual(f.calls(), []);
  });
});

test('invalid explicit Node fails actionably instead of downloading or selecting another runtime', async t => {
  for (const reason of ['missing', 'old', 'sqlite', 'architecture', 'homebrew']) await t.test(reason, t => {
    const f = fixture(t);
    f.runtime(path.join(f.home, '.nvm/versions/node/v22.23.2/bin'));
    const node = reason === 'missing' ? path.join(f.dir, 'missing/node') : f.runtime(path.join(f.dir, 'explicit/bin'), {
      version: reason === 'old' ? '22.16.0' : '22.23.2', sqlite: reason !== 'sqlite',
      arch: reason === 'architecture' ? 'x64' : 'arm64', portable: reason !== 'homebrew'
    });
    failure(f.run(undefined, { NODE: node }), /NODE|Node|node/);
    assert.deepEqual(f.calls(), [], 'an explicit override never silently falls back');
    assert.equal(fs.existsSync(f.cachedNode), false);
  });
});

test('explicit Node with no sibling npm can run Node but gives an actionable npm failure', t => {
  const f = fixture(t), node = f.runtime(path.join(f.dir, 'node-only/bin'), { npm: false });
  selected(success(f.run(undefined, { NODE: node })), node);
  failure(f.run(['npm', 'ci'], { NODE: node }), /npm|NPM/);
  assert.deepEqual(f.calls(), []);
});

test('automatic Node with no npm falls back to a complete runtime for npm commands', t => {
  const f = fixture(t), node = f.runtime(path.join(f.dir, 'node-only/bin'), { npm: false }); f.download();
  selected(success(f.run(['npm', 'ci'], { PATH: `${path.dirname(node)}:${f.bin}` })), f.cachedNode);
  assert.ok(f.calls().includes(archiveUrl));
});

test('explicit NPM executable receives the selected Node environment', t => {
  const f = fixture(t), node = f.runtime(path.join(f.dir, 'node-only/bin'), { npm: false });
  const npm = executable(path.join(f.dir, 'npm custom/npm'), `#!/usr/bin/env node\n${report.replace('process.argv.slice(1)', 'process.argv.slice(2)')}\n`);
  const result = success(f.run(['npm', 'test'], { NODE: node, NPM: npm }));
  selected(result, node);
  assert.deepEqual(result.args, ['test']);
  assert.deepEqual(f.calls(), []);
});

test('checksum mismatch prevents extraction and cached runtime execution', t => {
  const f = fixture(t); f.download();
  failure(f.run(undefined, { BOOTSTRAP_CORRUPT_ARCHIVE: '1' }), /SHA|checksum|체크섬|검증/i);
  assert.ok(f.calls().includes(archiveUrl));
  assert.ok(f.checksums().length > 0);
  assert.equal(fs.existsSync(f.cachedNode), false);
});

test('network failure leaves no usable cached runtime and preserves unrelated cache contents', t => {
  const f = fixture(t); fs.mkdirSync(f.cache, { recursive: true });
  const sentinel = path.join(f.cache, 'keep.txt'); fs.writeFileSync(sentinel, 'user data');
  failure(f.run(undefined, { BOOTSTRAP_NETWORK_FAILURE: '1' }), /download|network|다운로드|Node/i);
  assert.equal(fs.existsSync(f.cachedNode), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'user data');
});

test('download opt-out fails without network access when no runtime is available', t => {
  const f = fixture(t);
  failure(f.run(undefined, { HARNESS_NODE_DOWNLOAD: '0' }), /HARNESS_NODE_DOWNLOAD|Node|node/);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(f.cachedNode), false);
});

test('custom cache location is populated and reused', t => {
  const f = fixture(t); f.download();
  const cache = path.join(f.dir, 'custom Node cache'), node = path.join(cache, release, 'bin/node');
  selected(success(f.run(undefined, { HARNESS_NODE_CACHE: cache })), node);
  selected(success(f.run(undefined, { HARNESS_NODE_CACHE: cache, HARNESS_NODE_DOWNLOAD: '0' })), node);
  assert.equal(f.calls().filter(value => value === archiveUrl).length, 1);
  assert.equal(fs.existsSync(f.cachedNode), false);
});

test('existing-only mode permits Homebrew Node and never downloads', t => {
  const f = fixture(t), node = f.runtime(path.join(f.dir, 'homebrew/bin'), { portable: false, npm: false });
  selected(success(f.run(['--existing', 'node', '-e', report], { PATH: `${path.dirname(node)}:${f.bin}` })), node);
  assert.deepEqual(f.calls(), []);
});

test('existing-only mode reuses cache with no global Node', t => {
  const f = fixture(t), node = f.runtime(path.dirname(f.cachedNode), { npm: false });
  selected(success(f.run(['--existing', 'node', '-e', report])), node);
  assert.deepEqual(f.calls(), []);
});

test('existing-only mode can use installed or built app Node without npm', async t => {
  for (const source of ['installed', 'built']) await t.test(source, t => {
    const f = fixture(t), app = source === 'installed' ? path.join(f.home, 'Applications/WorkLog.app') : path.join(f.root, 'dist/WorkLog.app');
    const node = f.runtime(path.join(app, 'Contents/MacOS'), { npm: false });
    selected(success(f.run(['--existing', 'node', '-e', report])), node);
    assert.deepEqual(f.calls(), []);
  });
});

test('existing-only mode with no runtime fails without attempting a download', t => {
  const f = fixture(t);
  failure(f.run(['--existing', 'node', '-e', report]), /Node|node/);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(f.cachedNode), false);
});

test('make install bootstraps before npm ci and build, then runs installation with the same cached Node', t => {
  const f = fixture(t); f.download();
  fs.writeFileSync(path.join(f.root, 'scripts/install.mjs'), `import {createRequire} from 'node:module';
    const require=createRequire(import.meta.url);
    ${report.replace('process.argv.slice(1)', 'process.argv.slice(2)')}
  `);
  const result = spawnSync('/usr/bin/make', ['install', 'INSTALL_ARGS=--no-activate'], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15000
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const calls = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.args), [['ci'], ['run', 'build:mac'], ['--apply', '--no-activate']]);
  for (const call of calls) selected(call, f.cachedNode);
  assert.equal(f.calls().filter(value => value === archiveUrl).length, 1);
});
