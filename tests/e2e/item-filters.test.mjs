import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair } from '../helpers.mjs';

test('Jira filters compose with search and canonical merge groups, keeping unresolved creates out of unlinked results', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  await h.ingest(['plain', 'linked', 'unknown', 'sending', 'failed'].flatMap((name, i) =>
    pair(name, `0${i + 1}:00:00`, `0${i + 1}:05:00`, 'one', { work_item_id: name, text: `${name} 업무` })));
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  try {
    for (const state of ['linked', 'unknown', 'sending', 'failed']) {
      db.prepare('INSERT INTO jira_links VALUES(?,?,?,?,?,?,?)').run(`fixture-${state}`, state, state, '{}',
        state === 'linked' ? JSON.stringify({ key: 'DEV-27', id: '27', cloud_id: 'fixture' }) : null, null, new Date().toISOString());
    }
  } finally { db.close(); }
  const ids = async query => (await h.manager(`/items${query}`)).map(item => item.id).sort();
  assert.deepEqual(await ids('?jira=unlinked'), ['failed', 'plain']);
  assert.deepEqual(await ids('?jira=linked'), ['linked']);
  assert.equal((await h.manager('/items?jira=all')).length, 5);
  assert.deepEqual(await ids('?q=plain&jira=unlinked'), ['plain']);
  await h.manager('/merge', { method: 'POST', body: { ids: ['plain', 'linked'], target: 'plain', operation_id: 'filter-canonical-merge' } });
  assert.deepEqual(await ids('?jira=unlinked'), ['failed']);
  assert.deepEqual(await ids('?q=linked&jira=linked'), ['plain']);
  const [merged] = await h.manager('/items?jira=linked');
  assert.deepEqual(merged.jira_keys, ['DEV-27']); assert.equal(merged.session_count, 2);
  await h.manager('/items/delete', { method: 'POST', body: { ids: ['plain'], operation_id: 'filter-canonical-delete' } });
  assert.deepEqual(await ids('?jira=linked'), []);
  assert.deepEqual(await ids('?jira=linked&trash=true'), ['plain']);
  for (const query of ['?jira=missing', '?jira=all&jira=unlinked', '?trash=yes', '?q=a&q=b', '?other=field', `?q=${'x'.repeat(501)}`]) {
    await assert.rejects(h.manager(`/items${query}`), error => error.status === 400);
  }
});
