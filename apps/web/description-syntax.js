// Bounded Jira wiki syntax shared by local previews and Jira's ADF conversion.
// Unsupported macros, images, HTML and unsafe links remain ordinary text.
export function safeDescriptionLink(value) {
  if (!/^https?:\/\//i.test(value) || /[\s<>\\\u0000-\u001f\u007f]/.test(value)) return false;
  try { const url = new URL(value); return !!url.hostname && !url.username && !url.password; } catch { return false; }
}

function literalBlockEnd(line) {
  const macro = /^\{(code|noformat|panel|quote)(?::[^}]*)?\}\s*$/.exec(line);
  if (macro) return new RegExp(`^\\{${macro[1]}\\}\\s*$`);
  const fence = /^(`{3,}|~{3,})/.exec(line);
  return fence ? new RegExp(`^${fence[1][0]}{${fence[1].length},}\\s*$`) : null;
}

export function isJiraWiki(source) {
  let literalEnd = null;
  const visible = [];
  for (const line of String(source).replace(/\r\n?/g, '\n').split('\n')) {
    if (literalEnd) { if (literalEnd.test(line)) literalEnd = null; continue; }
    literalEnd = literalBlockEnd(line);
    if (literalEnd) continue;
    if (/^#{1,6}[ \t]+\S/.test(line)) return false;
    if (/^h[1-6]\.[ \t]+\S/.test(line)) return true;
    visible.push(line);
  }
  return /\{\{[^{}\n]+\}\}|\[[^\]\n]+\|https?:\/\/[^\]\n]+\]/i.test(visible.join('\n'));
}

const text = (value, marks = []) => ({ text: value, marks });
export function jiraWikiInline(value, marks = [], depth = 0) {
  const result = [], literals = /<!--[^\n]*?-->|<\/?[A-Za-z](?:"[^"\n]*"|'[^'\n]*'|[^'">\n])*?>|![^!\n]+!/g;
  let offset = 0;
  for (const literal of value.matchAll(literals)) {
    result.push(...formattedInline(value.slice(offset, literal.index), marks, depth));
    result.push(text(literal[0], marks));
    offset = literal.index + literal[0].length;
  }
  result.push(...formattedInline(value.slice(offset), marks, depth));
  return result;
}
function formattedInline(value, marks, depth) {
  if (depth > 8) return [text(value, marks)];
  const result = [], tokens = /\{\{([^{}\n]+)\}\}|\{[a-zA-Z][^{}\n]*\}|\*([^*\n]+)\*|\[([^\]\n]+)\]/g;
  let offset = 0;
  for (const token of value.matchAll(tokens)) {
    if (token.index > offset) result.push(text(value.slice(offset, token.index), marks));
    // ADF permits code together with a link, but not strong or other marks.
    if (token[1]) result.push(text(token[1], [...marks.filter(mark => mark.type === 'link'), { type: 'code' }]));
    else if (token[2]) result.push(...jiraWikiInline(token[2], marks.some(mark => mark.type === 'strong') ? marks : [...marks, { type: 'strong' }], depth + 1));
    else if (token[3]) {
      const split = token[3].lastIndexOf('|'), label = split < 0 ? token[3] : token[3].slice(0, split), href = split < 0 ? token[3] : token[3].slice(split + 1);
      if (label && safeDescriptionLink(href) && !marks.some(mark => mark.type === 'link')) result.push(...jiraWikiInline(label, [...marks, { type: 'link', href }], depth + 1));
      else result.push(text(token[0], marks));
    } else result.push(text(token[0], marks));
    offset = token.index + token[0].length;
  }
  if (offset < value.length) result.push(text(value.slice(offset), marks));
  return result;
}

export function parseJiraWiki(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n'), blocks = [], pending = [];
  const flush = () => { if (pending.length) blocks.push({ type: 'paragraph', lines: pending.splice(0).map(line => jiraWikiInline(line)) }); };
  const item = line => /^\s*([*#])[ \t]+(.+)$/.exec(line);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], heading = /^h([1-6])\.[ \t]+(.+?)\s*$/.exec(line), bullet = item(line);
    const end = literalBlockEnd(line);
    if (end) {
      flush(); const literal = [line];
      while (++index < lines.length) { literal.push(lines[index]); if (end.test(lines[index])) break; }
      blocks.push({ type: 'paragraph', lines: literal.map(value => value ? [text(value)] : []) });
    } else if (heading) {
      flush(); blocks.push({ type: 'heading', level: Number(heading[1]), content: jiraWikiInline(heading[2]) });
    } else if (bullet) {
      flush(); const list = { type: bullet[1] === '*' ? 'bulletList' : 'orderedList', items: [] };
      let next = bullet;
      while (next && next[1] === bullet[1]) {
        list.items.push(jiraWikiInline(next[2]));
        const following = item(lines[index + 1] || '');
        if (!following || following[1] !== bullet[1]) break;
        next = following; index++;
      }
      blocks.push(list);
    } else if (!line.trim()) flush();
    else pending.push(line);
  }
  flush(); return blocks;
}
