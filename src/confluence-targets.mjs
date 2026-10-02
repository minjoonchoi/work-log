import { assert, digest } from './shared.mjs';

export function spaceRestrictions(value) {
  if (value === undefined || value === null) return value;
  assert(Array.isArray(value) && value.length <= 500, '게시 허용 공간은 최대 500개까지 선택하세요.');
  const seen = new Set();
  return value.map(row => {
    assert(row && Object.keys(row).every(k => ['cloud_id', 'space_id', 'name', 'key'].includes(k))
      && typeof row.cloud_id === 'string' && /^[a-zA-Z0-9-]{1,200}$/.test(row.cloud_id)
      && typeof row.space_id === 'string' && /^\d{1,30}$/.test(row.space_id), '게시 허용 공간의 사이트와 ID를 확인하세요.');
    const result = { cloud_id: row.cloud_id, space_id: row.space_id };
    for (const key of ['name', 'key']) if (row[key] !== undefined) {
      assert(typeof row[key] === 'string' && row[key].length <= 300 && !/[\u0000-\u001f\u007f]/.test(row[key]), '게시 허용 공간의 이름을 확인하세요.'); result[key] = row[key];
    }
    const id = `${row.cloud_id}/${row.space_id}`; assert(!seen.has(id), '같은 게시 허용 공간이 중복되었습니다.'); seen.add(id);
    return result;
  }).sort((a, b) => `${a.cloud_id}/${a.space_id}`.localeCompare(`${b.cloud_id}/${b.space_id}`));
}
export function assertAllowedSpace(client, cloud, space) {
  assert(typeof cloud === 'string' && /^[a-zA-Z0-9-]{1,200}$/.test(cloud) && typeof space === 'string' && /^\d{1,30}$/.test(space), 'Confluence 사이트와 공간을 확인하세요.');
  const allowed = client.config()?.confluence_spaces;
  assert(allowed == null || allowed.some(row => row.cloud_id === cloud && row.space_id === space),
    '게시가 허용되지 않은 Confluence 공간입니다. Atlassian 설정에서 허용 공간을 선택하세요.', 403);
}
export function parentSelection(id, type) {
  if (id == null || id === '') { assert(type == null || type === '', '상위 페이지·폴더를 선택하세요.'); return null; }
  assert(typeof id === 'string' && /^\d{1,30}$/.test(id) && ['page', 'folder'].includes(type), '상위 페이지·폴더를 다시 선택하세요.');
  return { id, type };
}
export async function verifyParent(client, cloud, space, id, type) {
  const parent = parentSelection(id, type); if (!parent) return null;
  assertAllowedSpace(client, cloud, space);
  const row = await client.request(`/ex/confluence/${cloud}/wiki/api/v2/${type === 'folder' ? 'folders' : 'pages'}/${id}`);
  assert(row?.id === id && row.spaceId === space && row.status === 'current', '선택한 상위 페이지·폴더가 해당 공간에 없거나 사용할 수 없습니다. 다시 선택하세요.', 409);
  return { id, type, title: row.title };
}
// Pagination links are never fetched directly. Reconstruct only the expected
// endpoint and bind a local cursor to the exact space/search/parent selection.
function pageParams(cursor, key) {
  if (!cursor) return {};
  assert(typeof cursor === 'string' && cursor.length <= 12000, '탐색 페이지를 다시 불러오세요.');
  let value; try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { assert(false, '탐색 페이지를 다시 불러오세요.'); }
  assert(value && typeof value === 'object' && value.key === key && (typeof value.cursor === 'string' && value.cursor.length <= 4096 || Number.isSafeInteger(value.start) && value.start >= 0), '탐색 대상이 변경되었습니다. 처음부터 다시 불러오세요.');
  return value.cursor ? { cursor: value.cursor } : { start: String(value.start) };
}
export async function confluenceTargets(client, { cloud_id, space_id, query = '', cursor = null, parent_id = null, parent_type = null }) {
  assertAllowedSpace(client, cloud_id, space_id);
  assert(typeof query === 'string' && query.length <= 200 && !/[\u0000-\u001f\u007f]/.test(query), '검색어는 200자 이내로 입력하세요.');
  const site = await client.site(cloud_id, 'confluence');
  const parent = parentSelection(parent_id, parent_type);
  assert(!parent || !query.trim(), '공간 검색과 하위 탐색을 동시에 요청할 수 없습니다.');
  const prefix = `/ex/confluence/${cloud_id}`;
  let apiPath, params;
  if (parent) {
    await verifyParent(client, cloud_id, space_id, parent.id, parent.type);
    apiPath = `/wiki/api/v2/${parent.type === 'folder' ? 'folders' : 'pages'}/${parent.id}/direct-children`;
    params = { limit: '50' };
  } else {
    const space = await client.request(`${prefix}/wiki/api/v2/spaces/${space_id}`);
    assert(space?.id === space_id && space.status === 'current' && typeof space.key === 'string', '선택한 공간을 확인하세요.', 409);
    apiPath = '/wiki/rest/api/search';
    const literal = query.trim().replace(/[+\-!(){}\[\]^"~*?:\\/|&]/g, '\\$&');
    const cql = `space = ${JSON.stringify(space.key)} AND type IN (page, folder)${literal ? ` AND title ~ ${JSON.stringify(literal)}` : ''} ORDER BY title ASC`;
    params = { cql, limit: '50', expand: 'content.space' };
  }
  const key = digest(JSON.stringify({ cloud_id, space_id, apiPath, params }));
  const result = await client.request(`${prefix}${apiPath}?${new URLSearchParams({ ...params, ...pageParams(cursor, key) })}`);
  assert(Array.isArray(result?.results) && result.results.length <= 50, 'Confluence 탐색 응답을 확인하세요.', 502);
  const items = result.results.map(row => row.content || row).filter(row => ['page', 'folder'].includes(row.type) && (!row.status || row.status === 'current'))
    .filter(row => !(row.spaceId || row.space?.id) || (row.spaceId || row.space?.id) === space_id)
    .map(row => { assert(typeof row.id === 'string' && /^\d+$/.test(row.id) && typeof row.title === 'string', 'Confluence 탐색 항목을 확인하세요.', 502); return { id: row.id, type: row.type, title: row.title }; });
  let next_cursor = null;
  if (result._links?.next) {
    let next; try { next = new URL(result._links.next, client.apiOrigin); } catch { assert(false, 'Confluence 탐색 페이지를 확인하세요.', 502); }
    assert([new URL(client.apiOrigin).origin, new URL(site.url).origin].includes(next.origin) && !next.username && !next.password && !next.hash
      && [apiPath, prefix + apiPath].includes(next.pathname)
      && [...next.searchParams.keys()].every(k => ['cursor', 'start', ...Object.keys(params)].includes(k))
      && next.searchParams.getAll('cursor').length <= 1 && next.searchParams.getAll('start').length <= 1, 'Confluence 탐색 페이지를 확인하세요.', 502);
    const remote = next.searchParams.get('cursor'), start = next.searchParams.get('start');
    assert(remote && remote.length <= 4096 || start !== null && /^\d{1,9}$/.test(start), 'Confluence 탐색 페이지를 확인하세요.', 502);
    next_cursor = Buffer.from(JSON.stringify({ key, ...(remote ? { cursor: remote } : { start: Number(start) }) })).toString('base64url');
    assert(next_cursor !== cursor, 'Confluence 탐색 페이지가 반복되었습니다.', 502);
  }
  assertAllowedSpace(client, cloud_id, space_id);
  return { items, next_cursor };
}
