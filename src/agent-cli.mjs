import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const executable = file => {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; }
};

// GUI/LaunchAgent processes do not load interactive shell startup files.
// Preserve explicit overrides and PATH precedence; discover standard user installs
// without sourcing shell code or changing the application's global environment.
export function agentCLI(engine, { env = process.env, home = env.HOME || os.homedir(), runtime = process.execPath } = {}) {
  const override = env[`HARNESS_${engine.toUpperCase()}_BIN`];
  const inherited = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const directories = [...inherited, path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'),
    path.join(home, '.volta/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const versions = path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions/node');
  try {
    directories.push(...fs.readdirSync(versions).filter(name => /^v\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(name => path.join(versions, name, 'bin')));
  } catch { /* nvm is optional. */ }
  const selected = override || directories.map(dir => path.join(dir, engine)).find(executable) || engine;
  const command = path.isAbsolute(selected) ? selected : selected.includes(path.sep) ? path.resolve(selected) : selected;
  const bin = path.isAbsolute(command) ? path.dirname(command) : null;
  return { command, path: [...new Set([...(bin ? [bin] : []), ...inherited, path.dirname(runtime), ...directories])].join(path.delimiter) };
}
