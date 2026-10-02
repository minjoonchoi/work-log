import { assert, digest } from './shared.mjs';

// The documented v2 space API has no partial-name filter. Scan its paginated
// catalog server-side so search includes spaces the UI has never loaded.
export async function searchSpaces(client, cloud, site, query, cursor) {
  const key = digest(JSON.stringify({ cloud, query }));
  let remote = null;
  if (cursor) {
    let decoded; try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { /* Invalid cursor below. */ }
    assert(decoded?.key === key && typeof decoded.cursor === 'string' && decoded.cursor.length > 0 && decoded.cursor.length <= 2000, '공간 검색 조건이 변경되었습니다. 다시 검색하세요.');
    remote = decoded.cursor;
  }
  const endpoint = `/ex/confluence/${cloud}/wiki/api/v2/spaces`, seen = new Set();
  const term = query.normalize('NFKC').toLocaleLowerCase();
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ status: 'current', limit: '50' });
    if (remote) { assert(!seen.has(remote), 'Confluence 공간 검색 페이지가 반복되었습니다.', 502); seen.add(remote); params.set('cursor', remote); }
    const result = await client.request(`${endpoint}?${params}`);
    assert(Array.isArray(result?.results) && result.results.length <= 50, 'Confluence 공간 검색 응답을 확인하세요.', 502);
    const spaces = result.results.filter(row => !row.status || row.status === 'current').map(row => {
      assert(typeof row.id === 'string' && /^\d{1,30}$/.test(row.id) && typeof row.key === 'string' && typeof row.name === 'string', 'Confluence 공간 검색 결과를 확인하세요.', 502);
      return { id: row.id, key: row.key, name: row.name };
    }).filter(row => `${row.name} ${row.key}`.normalize('NFKC').toLocaleLowerCase().includes(term));
    remote = null;
    if (result._links?.next) {
      let next; try { next = new URL(result._links.next, client.apiOrigin); } catch { /* Validated below. */ }
      assert(next && [new URL(client.apiOrigin).origin, new URL(site.url).origin].includes(next.origin) && !next.username && !next.password && !next.hash
        && [endpoint, '/wiki/api/v2/spaces'].includes(next.pathname)
        && [...next.searchParams.keys()].every(k => ['status', 'limit', 'cursor'].includes(k))
        && next.searchParams.getAll('cursor').length === 1, 'Confluence 공간 검색 페이지를 확인하세요.', 502);
      remote = next.searchParams.get('cursor');
      assert(remote && remote.length <= 2000 && !seen.has(remote) && !/[\u0000-\u001f\u007f]/.test(remote), 'Confluence 공간 검색 페이지를 확인하세요.', 502);
    }
    const next_cursor = remote ? Buffer.from(JSON.stringify({ key, cursor: remote })).toString('base64url') : null;
    if (spaces.length || !remote || page === 9) return { spaces, next_cursor };
  }
}
