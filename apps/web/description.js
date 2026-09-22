import { isJiraWiki, parseJiraWiki } from './description-syntax.js';

// Small, escaped Jira wiki and legacy Markdown views. The source
// remains editable text; no HTML, images or embedded content is executed.
export function descriptionPreview(source) {
  if (isJiraWiki(source)) return parseJiraWiki(source).flatMap(block => block.content ? [block.content] : block.items || block.lines)
    .map(line => line.map(node => node.text).join('')).join(' ').replace(/\s+/g, ' ').trim();
  return source.replace(/^(?:#{1,6}\s+|\s*[-*+]\s+|\s*\d+[.)]\s+)/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/\s+/g, ' ').trim();
}
export function descriptionHTML(source, esc, { format = 'auto' } = {}) {
  if (format !== 'markdown' && isJiraWiki(source)) {
    const inline = nodes => nodes.map(node => {
      let value = esc(node.text);
      for (const mark of [...node.marks].reverse()) value = mark.type === 'link'
        ? `<a href="${esc(mark.href)}" target="_blank" rel="noopener noreferrer">${value}</a>`
        : `<${mark.type === 'strong' ? 'strong' : 'code'}>${value}</${mark.type === 'strong' ? 'strong' : 'code'}>`;
      return value;
    }).join('');
    return parseJiraWiki(source).map(block => block.type === 'heading' ? `<h3>${inline(block.content)}</h3>`
      : block.type === 'paragraph' ? `<p>${block.lines.map(inline).join('<br>')}</p>`
      : `<${block.type === 'bulletList' ? 'ul' : 'ol'}>${block.items.map(item => `<li>${inline(item)}</li>`).join('')}</${block.type === 'bulletList' ? 'ul' : 'ol'}>`).join('');
  }
  const inline = value => {
    let result = '', cursor = 0;
    for (const match of value.matchAll(/\*\*([^*\n]+)\*\*|`([^`\n]+)`/g)) {
      result += esc(value.slice(cursor, match.index));
      const tag = match[1] ? 'strong' : 'code';
      result += `<${tag}>${esc(match[1] || match[2])}</${tag}>`; cursor = match.index + match[0].length;
    }
    return result + esc(value.slice(cursor));
  };
  let html = '', paragraph = [], list = [], type = '', start = 1;
  const flush = () => {
    if (paragraph.length) html += `<p>${paragraph.map(inline).join('<br>')}</p>`;
    if (list.length) html += `<${type}${type === 'ol' ? ` start="${start}"` : ''}>${list.map(text => `<li>${inline(text)}</li>`).join('')}</${type}>`;
    paragraph = []; list = []; type = '';
  };
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) { flush(); html += `<h3>${inline(heading[1])}</h3>`; continue; }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/), numbered = line.match(/^\s*(\d{1,9})[.)]\s+(.+)$/);
    if (bullet || numbered) {
      const nextType = bullet ? 'ul' : 'ol';
      if (paragraph.length || (type && type !== nextType)) flush();
      if (!list.length && numbered) start = Number(numbered[1]);
      type = nextType; list.push(bullet ? bullet[1] : numbered[2]);
    } else { if (list.length) flush(); paragraph.push(line); }
  }
  flush(); return html;
}
