import test from 'node:test';
import assert from 'node:assert/strict';
import { spaceRestrictions, assertAllowedSpace, confluenceTargets, verifyParent } from '../../src/confluence-targets.mjs';

test('space policies distinguish unrestricted and blocked and validate distinct site/space identities', () => {
  assert.equal(spaceRestrictions(null), null); assert.deepEqual(spaceRestrictions([]), []);
  const rows = [{ cloud_id: 'site-a', space_id: '10' }, { cloud_id: 'site-b', space_id: '10' }];
  assert.deepEqual(spaceRestrictions(rows), rows);
  assert.throws(() => spaceRestrictions([...rows, rows[0]]), /중복/);
  assert.throws(() => spaceRestrictions([{ ...rows[0], space_id: '../10' }]), /ID/);
  assert.throws(() => spaceRestrictions([{ ...rows[0], extra: true }]), /ID/);
  assertAllowedSpace({ config: () => ({ confluence_spaces: rows }) }, 'site-b', '10');
  assert.throws(() => assertAllowedSpace({ config: () => ({ confluence_spaces: rows }) }, 'site-c', '10'), /허용되지/);
});

test('discovery rechecks a changed policy before returning and rejects invalid cursors without searching', async () => {
  let policy = null, calls = [];
  const client = { config: () => ({ confluence_spaces: policy }), apiOrigin: 'https://api.atlassian.com', site: async () => ({url:'https://test.atlassian.net'}),
    request: async url => { calls.push(url); if (url.endsWith('/spaces/10')) return {id:'10',key:'TEAM',status:'current'}; policy = []; return {results:[],_links:{}}; } };
  await assert.rejects(confluenceTargets(client,{cloud_id:'site-a',space_id:'10'}), /허용되지/);
  policy = null; calls = [];
  await assert.rejects(confluenceTargets(client,{cloud_id:'site-a',space_id:'10',cursor:'invalid'}), /탐색/);
  assert.equal(calls.length, 1);
  await assert.rejects(confluenceTargets(client,{cloud_id:'site-a',space_id:'10',cursor:Buffer.from('null').toString('base64url')}), error => error.status === 400);
});

test('parent preflight refuses archived, missing or cross-space content', async () => {
  const client = { config: () => null, request: async () => ({id:'100',spaceId:'10',status:'archived'}) };
  await assert.rejects(verifyParent(client,'site-a','10','100','page'), /사용할 수/);
  client.request = async () => ({id:'100',spaceId:'20',status:'current'});
  await assert.rejects(verifyParent(client,'site-a','10','100','folder'), /해당 공간/);
  await assert.rejects(verifyParent(client,'site-a','10','100','attachment'), /다시 선택/);
});
