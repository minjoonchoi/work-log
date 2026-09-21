// A display/export projection. Historical report text remains unchanged in storage.
export function reportBodyMarkdown(body) {
  const result = []; let hidden = false, fence = null;
  for (const line of String(body || '').replace(/\r\n?/g, '\n').split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    } else if (marker) fence = marker[1];
    else {
      const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading && heading[1].length <= 2) hidden = false;
      if (heading && heading[1].length === 2 && ['근거 세션', '작성 근거'].includes(heading[2])) hidden = true;
    }
    if (!hidden) result.push(line);
  }
  return result.join('\n').replace(/\[(?:session|part):[^\]\r\n]+\]/g, '').trim();
}
