// Deliberately bounded Markdown -> Confluence storage XHTML. Unsupported syntax
// remains readable literal text; raw HTML, images and executable URLs stay inert.
export const escapeStorage = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const escape = escapeStorage;
export function safeStorageLink(value) {
  if (!/^https?:\/\//i.test(value) || /[\s<>\\\u0000-\u001f\u007f]/.test(value)) return false;
  try { const url = new URL(value); return !!url.hostname && !url.username && !url.password; } catch { return false; }
}
function inline(text, depth = 0) {
  if (depth > 8) return escape(text);
  const token = /(`+)([^`\n]+)\1|\*\*([^\n]+?)\*\*|(?<!!)\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let value = '', offset = 0;
  for (const match of text.matchAll(token)) {
    value += escape(text.slice(offset, match.index));
    if (match[1]) value += `<code>${escape(match[2])}</code>`;
    else if (match[3]) value += `<strong>${inline(match[3], depth + 1)}</strong>`;
    else if (safeStorageLink(match[5])) value += `<a href="${escape(match[5])}">${escape(match[4])}</a>`;
    else value += escape(match[0]);
    offset = match.index + match[0].length;
  }
  return value + escape(text.slice(offset));
}
const heading = line => /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
const item = line => /^\s*([-+*]|\d{1,9}[.)])[ \t]+(.+)$/.exec(line);
const listKind = match => /^\d/.test(match[1]) ? 'ol' : 'ul';
export function confluenceStorage(markdown) {
  const lines = String(markdown).replaceAll('\r\n', '\n').split('\n'), blocks = [], pending = [];
  const flush = () => { if (pending.length) blocks.push(`<p>${pending.splice(0).map(line => inline(line)).join('<br />')}</p>`); };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], title = heading(line), list = item(line), fence = /^(`{3,}|~{3,})[^\n]*$/.exec(line);
    if (fence) {
      flush(); const code = [], end = new RegExp(`^${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++index < lines.length) { if (end.test(lines[index])) break; code.push(lines[index]); }
      blocks.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
    } else if (title) {
      flush(); blocks.push(`<h${title[1].length}>${inline(title[2])}</h${title[1].length}>`);
    } else if (list) {
      flush(); const tag = listKind(list), items = [];
      let next = list;
      while (next && listKind(next) === tag) {
        items.push(`<li>${inline(next[2])}</li>`);
        const following = item(lines[index + 1] || '');
        if (!following || listKind(following) !== tag) break;
        next = following; index++;
      }
      blocks.push(`<${tag}>${items.join('')}</${tag}>`);
    } else if (!line.trim()) flush();
    else pending.push(line);
  }
  flush(); return blocks.join('\n') || '<p></p>';
}
