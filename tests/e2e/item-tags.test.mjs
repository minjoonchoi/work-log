import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, eventually } from '../helpers.mjs';

const post = body => ({ method: 'POST', body });
const put = body => ({ method: 'PUT', body });
const detail = (h, item) => h.manager(`/items/${item}`);
const tagged = async (h, item, tags, version) => h.manager(`/items/${item}/tags`, put({ version: version ?? (await detail(h, item)).item.version, tags }));
async function setup(t, { runtime = false } = {}) {
  const h = new Harness(); t.after(() => h.close());
  if (runtime) await h.start('runtime'); await h.start('manager'); return h;
}
const seed = (h, names) => h.ingest(names.flatMap((name, index) => pair(`tags-${name}`, `09:${String(index).padStart(2, '0')}:00`,
  `09:${String(index).padStart(2, '0')}:30`, 'first', { work_item_id: name, text: `${name} 원본 업무` })));
function rows(h, sql) {
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); }
}

test('manual tags normalize, deduplicate and persist without changing metadata protection or observed work activity', async t => {
  const h = await setup(t); await seed(h, ['normalization']);
  const before = await detail(h, 'normalization'); assert.deepEqual(before.item.tags, []);
  const changed = await tagged(h, 'normalization', [' ＢＡＣＫＥＮＤ ', 'backend', ' 요구사항   정리 ', 'PM/PO']);
  assert.deepEqual(changed.item.tags, ['backend', 'pm/po', '요구사항 정리']);
  assert.equal(changed.item.version, before.item.version + 1);
  for (const key of ['title', 'description', 'manual', 'metadata_protected', 'last_activity']) assert.equal(changed.item[key], before.item[key]);
  assert.deepEqual(changed.events, before.events); assert.deepEqual((await detail(h, 'normalization')).sessions, before.sessions);
  const unchanged = await tagged(h, 'normalization', ['요구사항 정리', 'BACKEND', 'pm/po']);
  assert.equal(unchanged.item.version, changed.item.version, 'reordering an identical normalized set does not invalidate unrelated snapshots');
  assert.deepEqual(await h.manager('/tags'), [{ name: 'backend', count: 1 }, { name: 'pm/po', count: 1 }, { name: '요구사항 정리', count: 1 }]);
  await h.stop('manager'); await h.start('manager');
  assert.deepEqual((await detail(h, 'normalization')).item.tags, changed.item.tags);
  assert.deepEqual(rows(h, 'SELECT tag FROM work_item_tags ORDER BY tag'), changed.item.tags.map(tag => ({ tag })));
  const cleared = await tagged(h, 'normalization', []);
  assert.deepEqual(cleared.item.tags, []); assert.deepEqual(await h.manager('/tags'), []);
});

test('invalid tags and stale metadata versions reject atomically, including an old merged alias', async t => {
  const h = await setup(t); await seed(h, ['validation-a', 'validation-b']);
  await tagged(h, 'validation-a', ['existing']); const current = await detail(h, 'validation-a');
  for (const tags of [null, 'backend', [null], [''], ['   '], ['x'.repeat(41)], ['two\nlines'], ['a\u0000b'],
    ['a\u202eb'], Array.from({ length: 21 }, (_, index) => `tag-${index}`)]) {
    await assert.rejects(tagged(h, 'validation-a', tags, current.item.version), error => error.status === 400);
  }
  for (const body of [{ tags: [] }, { version: current.item.version }, { version: '3', tags: [] },
    { version: 1.5, tags: [] }, { version: current.item.version, tags: [], unexpected: true }]) {
    await assert.rejects(h.manager('/items/validation-a/tags', put(body)), error => error.status === 400);
  }
  await assert.rejects(tagged(h, 'validation-a', ['stale'], current.item.version - 1), error => error.status === 409);
  assert.deepEqual((await detail(h, 'validation-a')).item, current.item);
  await h.manager('/merge', post({ ids: ['validation-a', 'validation-b'], target: 'validation-b', operation_id: 'tag-alias-merge' }));
  const merged = await detail(h, 'validation-b');
  await assert.rejects(tagged(h, 'validation-a', ['wrong-target'], merged.item.version), error => error.status === 409);
  assert.deepEqual((await detail(h, 'validation-b')).item.tags, ['existing']);
});

test('tag counts and exact filters compose with title searches, Jira state and untagged work', async t => {
  const h = await setup(t); await seed(h, ['filter-a', 'filter-b', 'filter-c']);
  await tagged(h, 'filter-a', ['backend', 'review']); await tagged(h, 'filter-b', ['backend']);
  assert.deepEqual(await h.manager('/tags'), [{ name: 'backend', count: 2 }, { name: 'review', count: 1 }]);
  assert.deepEqual((await h.manager('/items?tag=BACKEND')).map(item => item.id), ['filter-b', 'filter-a']);
  assert.deepEqual((await h.manager('/items?tag=backend&q=filter-a&jira=unlinked')).map(item => item.id), ['filter-a']);
  assert.deepEqual(await h.manager('/items?tag=backend&jira=linked'), []);
  assert.deepEqual((await h.manager('/items?untagged=true')).map(item => item.id), ['filter-c']);
  assert.deepEqual(await h.manager('/items?tag=missing'), []);
  for (const endpoint of ['/items?tag=backend&untagged=true', '/items?tag=', '/items?tag=a&tag=b', '/items?untagged=yes',
    '/items?untagged=true&untagged=false', '/tags?trash=invalid', '/tags?trash=true&trash=false', '/tags?unexpected=yes']) {
    await assert.rejects(h.manager(endpoint), error => error.status === 400);
  }
});

test('merging unions canonical tags once while preserving sessions, original events and summary records', async t => {
  const h = await setup(t, { runtime: true }); await seed(h, ['merge-tag-a', 'merge-tag-b', 'merge-tag-c']);
  await tagged(h, 'merge-tag-a', ['backend', 'review']); await tagged(h, 'merge-tag-b', ['frontend', 'review']);
  await tagged(h, 'merge-tag-c', ['planning']);
  const before = await detail(h, 'merge-tag-a'), session = before.sessions[0].id;
  await h.manager(`/sessions/${session}/summary/regenerate`, post({ operation_id: 'summary-before-tag-merge' }));
  await eventually(() => h.manager('/writing/summary-before-tag-merge'), row => row.state === 'completed', 15000);
  const rawEvents = rows(h, 'SELECT id,payload FROM events ORDER BY seq');
  const summary = rows(h, 'SELECT * FROM session_summaries');
  const operation = { ids: ['merge-tag-a', 'merge-tag-b'], target: 'merge-tag-a', operation_id: 'merge-tags-first' };
  await h.manager('/merge', post(operation));
  assert.equal((await h.manager('/merge', post(operation))).repeated, true);
  await h.manager('/merge', post({ ids: ['merge-tag-b', 'merge-tag-c'], target: 'merge-tag-c', operation_id: 'merge-tags-through-alias' }));
  const result = await detail(h, 'merge-tag-c');
  assert.deepEqual(result.item.tags, ['backend', 'frontend', 'planning', 'review']);
  assert.equal(result.sessions.length, 3); assert.ok(result.sessions.some(row => row.id === session));
  assert.deepEqual(rows(h, 'SELECT id,payload FROM events ORDER BY seq'), rawEvents);
  assert.deepEqual(rows(h, 'SELECT * FROM session_summaries'), summary);
  assert.deepEqual(await h.manager('/tags'), result.item.tags.map(name => ({ name, count: 1 })));
  assert.deepEqual([...new Set(rows(h, 'SELECT work_item_id FROM work_item_tags').map(row => row.work_item_id))], ['merge-tag-c']);
});

test('a merge exceeding the bounded tag count fails before moving any item, tag or history', async t => {
  const h = await setup(t); await seed(h, ['limit-a', 'limit-b']);
  await tagged(h, 'limit-a', Array.from({ length: 20 }, (_, index) => `type-${index}`));
  await tagged(h, 'limit-b', ['one-more']);
  const before = await h.manager('/items'), tags = await h.manager('/tags'), sessions = await h.manager('/sessions');
  await assert.rejects(h.manager('/merge', post({ ids: ['limit-a', 'limit-b'], target: 'limit-a', operation_id: 'reject-overflow-tags' })), error => error.status === 400 && /20/.test(error.message));
  assert.deepEqual(await h.manager('/items'), before); assert.deepEqual(await h.manager('/tags'), tags);
  assert.deepEqual(await h.manager('/sessions'), sessions); assert.deepEqual(rows(h, 'SELECT * FROM merges'), []);
});

test('soft delete excludes tags from active counts while restore and late hooks keep the local assignments', async t => {
  const h = await setup(t); await seed(h, ['hidden-tags', 'visible-tags']);
  await tagged(h, 'hidden-tags', ['backend', 'archived-work']); await tagged(h, 'visible-tags', ['backend']);
  await h.manager('/items/delete', post({ ids: ['hidden-tags'], operation_id: 'delete-tagged-item' }));
  assert.deepEqual(await h.manager('/tags'), [{ name: 'backend', count: 1 }]);
  assert.deepEqual(await h.manager('/tags?trash=true'), [{ name: 'archived-work', count: 1 }, { name: 'backend', count: 1 }]);
  assert.deepEqual((await h.manager('/items?trash=true&tag=backend')).map(item => item.id), ['hidden-tags']);
  assert.deepEqual(await h.manager('/items?trash=true&untagged=true'), []);
  await assert.rejects(tagged(h, 'hidden-tags', ['blocked'], 1), error => error.status === 404);
  await h.ingest(pair('tags-hidden-tags', '10:00:00', '10:01:00', 'late', { work_item_id: 'hidden-tags' }));
  await h.stop('manager'); await h.start('manager');
  assert.deepEqual(await h.manager('/tags'), [{ name: 'backend', count: 1 }]);
  await h.manager('/items/restore', post({ ids: ['hidden-tags'], operation_id: 'restore-tagged-item' }));
  assert.deepEqual((await detail(h, 'hidden-tags')).item.tags, ['archived-work', 'backend']);
  assert.equal((await detail(h, 'hidden-tags')).sessions.length, 2);
  assert.deepEqual(await h.manager('/tags'), [{ name: 'archived-work', count: 1 }, { name: 'backend', count: 2 }]);
});

test('manual metadata regeneration preserves tags and tag edits alone never invoke a model', async t => {
  const h = await setup(t, { runtime: true }); await seed(h, ['generated-tags']);
  const taggedItem = (await tagged(h, 'generated-tags', ['backend', 'review'])).item;
  assert.equal(Boolean(taggedItem.metadata_protected), false);
  assert.deepEqual(await h.runtime('/runs'), []);
  await h.manager('/items/generated-tags/metadata/regenerate', post({ version: taggedItem.version, operation_id: 'rewrite-preserving-local-tags' }));
  await eventually(() => h.manager('/writing/rewrite-preserving-local-tags'), row => row.state === 'completed', 15000);
  const current = (await detail(h, 'generated-tags')).item;
  assert.deepEqual(current.tags, taggedItem.tags); assert.equal(current.version, taggedItem.version + 1);
  assert.equal(Boolean(current.metadata_protected), false); assert.equal((await h.runtime('/runs')).length, 1);
  await assert.rejects(tagged(h, 'generated-tags', ['old-dialog'], taggedItem.version), error => error.status === 409);
  assert.deepEqual((await tagged(h, 'generated-tags', ['backend'])).item.tags, ['backend']);
  assert.equal((await h.runtime('/runs')).length, 1);
});
