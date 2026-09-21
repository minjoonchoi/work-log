// A small, escaped Markdown view for local work item descriptions. The source
// remains editable text; no HTML, images or embedded content is executed.
export function descriptionPreview(source) {
  return source.replace(/^(?:#{1,6}\s+|\s*[-*+]\s+|\s*\d+[.)]\s+)/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/\s+/g, ' ').trim();
}
export function descriptionHTML(source, esc) {
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
