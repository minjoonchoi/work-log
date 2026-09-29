import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['style.css', 'quick.css', 'icons.css'];
const sources = files.map(file => [file, fs.readFileSync(path.join(root, 'apps/web', file), 'utf8')]);
const definitions = new Set(sources.flatMap(([, css]) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1])));
// Calendar column count is supplied by app.js, not a visual token.
const runtimeProperties = new Set(['--days']);
const errors = [];
for (const [file, source] of sources) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of css.matchAll(/var\((--[\w-]+)/g)) {
    if (!definitions.has(match[1]) && !runtimeProperties.has(match[1])) errors.push(file + ': undefined token ' + match[1]);
  }
  const components = css.replace(/:root\s*\{[^}]*\}/g, '');
  if (/#[\da-f]{3,8}\b/i.test(components)) errors.push(file + ': component colors must use semantic tokens');
  if (/font-size\s*:\s*\d+(?:\.\d+)?px/.test(components)) errors.push(file + ': component font sizes must use type tokens');
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Design tokens: references, component colors and type sizes verified.');
