// A bounded Markdown subset for work item descriptions. Keep unsupported input
// as literal text; never interpret HTML or create executable/resource nodes.
const textNode = (text, marks = []) => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const document = content => ({ version: 1, type: 'doc', content });

export function plainTextADF(text) {
  const content = [];
  String(text).split('\n').forEach((line, index) => {
    if (index) content.push({ type: 'hardBreak' });
    if (line) content.push(textNode(line));
  });
  return document([{ type: 'paragraph', content }]);
}

function safeLink(value) {
  if (!/^https?:\/\//i.test(value) || /[\s<>\\\u0000-\u001f\u007f]/.test(value)) return false;
  try { const url = new URL(value); return !!url.hostname && !url.username && !url.password; } catch { return false; }
}
function inline(value, marks = [], depth = 0) {
  if (depth > 8) return value ? [textNode(value, marks)] : [];
  const content = [], token = /(`+)([^`\n]+)\1|\*\*([^\n]+?)\*\*|(?<!!)\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let offset = 0;
  for (const match of value.matchAll(token)) {
    if (match.index > offset) content.push(textNode(value.slice(offset, match.index), marks));
    if (match[3]) {
      const next = marks.some(mark => mark.type === 'strong') ? marks : [...marks, { type: 'strong' }];
      content.push(...inline(match[3], next, depth + 1));
    } else if (match[4] && safeLink(match[5]) && !marks.some(mark => mark.type === 'link')) {
      content.push(...inline(match[4], [...marks, { type: 'link', attrs: { href: match[5] } }], depth + 1));
    } else content.push(textNode(match[0], marks));
    offset = match.index + match[0].length;
  }
  if (offset < value.length) content.push(textNode(value.slice(offset), marks));
  return content;
}
function paragraph(lines, literal = false) {
  const content = [];
  lines.forEach((line, index) => {
    if (index) content.push({ type: 'hardBreak' });
    content.push(...(literal ? (line ? [textNode(line)] : []) : inline(line)));
  });
  return { type: 'paragraph', content };
}
const heading = line => /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
const listItem = line => /^([-+*]|\d{1,9}[.)])[ \t]+(.+)$/.exec(line);
const listKind = match => /^\d/.test(match[1]) ? 'orderedList' : 'bulletList';

export function jiraDescription(text) {
  const source = String(text), lines = source.replaceAll('\r\n', '\n').split('\n');
  // Legacy descriptions retain exact line breaks and literal text.
  if (!lines.some(line => heading(line) || listItem(line) || /^(`{3,}|~{3,})/.test(line))
      && !/\*\*[^\n]+?\*\*|\[[^\]\n]+\]\(/.test(source)) return plainTextADF(source);
  const content = [], pending = [];
  const flush = () => { if (pending.length) content.push(paragraph(pending.splice(0))); };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], title = heading(line), item = listItem(line), fence = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush(); const literal = [line], end = new RegExp(`^${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++index < lines.length) { literal.push(lines[index]); if (end.test(lines[index])) break; }
      content.push(paragraph(literal, true));
    } else if (title) {
      flush(); content.push({ type: 'heading', attrs: { level: title[1].length }, content: inline(title[2]) });
    } else if (item) {
      flush(); const kind = listKind(item), list = { type: kind,
        ...(kind === 'orderedList' ? { attrs: { order: Number.parseInt(item[1], 10) } } : {}), content: [] };
      let next = item;
      while (next && listKind(next) === kind) {
        list.content.push({ type: 'listItem', content: [paragraph([next[2]])] });
        const following = listItem(lines[index + 1] || '');
        if (!following || listKind(following) !== kind) break;
        next = following; index++;
      }
      content.push(list);
    } else if (!line.trim()) flush();
    else pending.push(line);
  }
  flush(); return document(content.length ? content : [{ type: 'paragraph', content: [] }]);
}
