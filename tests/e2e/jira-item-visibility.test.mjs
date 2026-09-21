import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Harness, pair, eventually } from '../helpers.mjs';
import { atlFixture, authorize, createIssue } from '../fixtures/atlassian.mjs';

const post = body => ({ method: 'POST', body });
const operation = 'visibility-linked-issue';
const detail = (h, item) => h.manager(`/items/${item.id}`);
const refresh = h => h.manager(`/jira-links/${operation}/refresh`, post({}));
const visibility = (h, item, action) => h.manager(`/items/${action}`, post({ ids: [item.id], operation_id: `visibility-${action}-request` }));
const transition = (h, current, op = 'visibility-status-write') => h.manager(`/jira-links/${operation}/transition`, post({
  operation_id: op, transition_id: '21', expected_status_id: current.jira_links[0].view.data.issue.status.id,
  expected_updated: current.jira_links[0].view.data.issue.updated
}));
const content = (h, current) => h.manager(`/jira-links/${operation}/content`, post({ operation_id: 'visibility-content-write',
  version: current.item.version, expected_updated: current.jira_links[0].view.data.issue.updated }));
const connect = (h, item, issue) => h.manager(`/items/${item.id}/jira/link`, post({ operation_id: operation,
  version: item.version, cloud_id: 'cloud-test', issue_id: issue.id, key: issue.key }));
const writes = f => f.state.calls.filter(call => ['POST', 'PUT'].includes(call.method));

async function setup(t, linked = true) {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('manager'); await authorize(h);
  await h.ingest(pair('jira-visibility', '09:00:00', '09:05:00'));
  const item = (await h.manager('/items'))[0], issue = f.addIssue({ summary: '원래 Jira 제목' });
  if (linked) {
    await connect(h, item, issue);
    await eventually(() => detail(h, item), row => !!row.jira_links[0]?.view?.data);
  }
  return { h, f, item, issue };
}

// Pause a chosen token read in the isolated Keychain executable. This exercises
// the real manager -> client -> credential subprocess -> HTTP send boundary.
function pauseTokenRead(h, number) {
  const executable = h.env.HARNESS_KEYCHAIN_BIN, counter = `${executable}.reads`, waiting = `${executable}.waiting`, release = `${executable}.release`;
  const source = fs.readFileSync(executable, 'utf8');
  const gate = `if(r.operation==='get'&&r.account.startsWith('oauth-')){
    const counter=${JSON.stringify(counter)}, waiting=${JSON.stringify(waiting)}, release=${JSON.stringify(release)};
    const count=fs.existsSync(counter)?Number(fs.readFileSync(counter)):0;fs.writeFileSync(counter,String(count+1));
    if(count+1===${number}){fs.writeFileSync(waiting,'ready');
      const deadline=Date.now()+10000;while(!fs.existsSync(release)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
      if(!fs.existsSync(release))process.exit(4);
    }
  }`;
  assert.ok(source.includes("if(fs.existsSync(file+'.locked'))"));
  fs.writeFileSync(executable, source.replace("if(fs.existsSync(file+'.locked'))", `${gate}\nif(fs.existsSync(file+'.locked'))`));
  return { ready: () => eventually(() => fs.existsSync(waiting)), release: () => fs.writeFileSync(release, 'continue') };
}

test('deleted item rejects refresh, status/content writes and link/create commands without Jira traffic', async t => {
  const { h, f, item, issue } = await setup(t), current = await detail(h, item);
  await visibility(h, item, 'delete');
  const count = f.state.calls.length;
  for (const command of [() => refresh(h), () => transition(h, current), () => content(h, current),
    () => connect(h, item, issue), () => createIssue(h, item, 'visibility-create-rejected')]) {
    await assert.rejects(command(), /삭제된 업무|업무를 찾을 수 없습니다/);
  }
  assert.equal(f.state.calls.length, count); assert.equal(writes(f).length, 0);
  await visibility(h, item, 'restore');
  assert.equal((await refresh(h)).issue.id, issue.id);
});

test('delete then restore during final transition authentication invalidates the old command; a fresh command succeeds', async t => {
  const { h, f, item, issue } = await setup(t), current = await detail(h, item);
  const gate = pauseTokenRead(h, 4);
  const rejected = assert.rejects(transition(h, current), /업무 목록 상태가 변경/);
  try {
    await gate.ready();
    assert.ok(f.state.calls.some(call => call.path.endsWith('/transitions') && call.method === 'GET'));
    await visibility(h, item, 'delete'); await visibility(h, item, 'restore');
  } finally { gate.release(); }
  await rejected;
  assert.equal(writes(f).length, 0); assert.equal(issue.fields.status.id, '10000');
  const restored = await detail(h, item);
  assert.equal(restored.jira_links[0].change.state, 'failed');
  assert.equal((await transition(h, restored, 'visibility-fresh-status')).state, 'applied');
  assert.equal(writes(f).length, 1); assert.equal(issue.fields.status.id, '3');
});

test('deletion during final content authentication prevents PUT and preserves an explicit failed intent', async t => {
  const { h, f, item, issue } = await setup(t), current = await detail(h, item);
  const gate = pauseTokenRead(h, 5), rejected = assert.rejects(content(h, current), /업무 목록 상태가 변경/);
  try { await gate.ready(); await visibility(h, item, 'delete'); }
  finally { gate.release(); }
  await rejected; assert.equal(writes(f).length, 0); assert.equal(issue.fields.summary, '원래 Jira 제목');
  await visibility(h, item, 'restore');
  assert.equal((await detail(h, item)).jira_links[0].content_change.state, 'failed');
});

test('delete and restore while a refresh is reading Jira discards that obsolete observation', async t => {
  const { h, f, item, issue } = await setup(t), current = await detail(h, item);
  const before = f.state.calls.length; f.setStatus(issue, 'progress'); f.state.issueReadDelay = 500;
  const rejected = assert.rejects(refresh(h), /업무 목록 상태가 변경/);
  await eventually(() => f.state.calls.slice(before).some(call => call.path.endsWith(`/issue/${issue.id}`)));
  await visibility(h, item, 'delete'); await visibility(h, item, 'restore'); await rejected;
  const restored = await detail(h, item);
  assert.equal(restored.jira_links[0].view.observed_at, current.jira_links[0].view.observed_at);
  assert.equal(restored.jira_links[0].view.data.issue.status.id, '10000'); assert.equal(writes(f).length, 0);
  f.state.issueReadDelay = 0; assert.equal((await refresh(h)).issue.status.id, '3');
});

test('existing-issue lookup cannot link the old item snapshot after deletion and restoration', async t => {
  const { h, f, item, issue } = await setup(t, false); f.state.issueReadDelay = 500;
  const rejected = assert.rejects(connect(h, item, issue), /업무 목록 상태가 변경/);
  await eventually(() => f.state.calls.some(call => call.path.endsWith(`/issue/${issue.key}`)));
  await visibility(h, item, 'delete'); await visibility(h, item, 'restore'); await rejected;
  assert.equal((await detail(h, item)).jira_links.length, 0); assert.equal(writes(f).length, 0);
});

test('new issue creation rechecks visibility after final token read, before the outgoing POST', async t => {
  const { h, f, item } = await setup(t, false), gate = pauseTokenRead(h, 2);
  const rejected = assert.rejects(createIssue(h, item, 'visibility-create-race'), /업무 목록 상태가 변경/);
  try { await gate.ready(); await visibility(h, item, 'delete'); await visibility(h, item, 'restore'); }
  finally { gate.release(); }
  await rejected; assert.equal(writes(f).length, 0); assert.equal(f.state.issues.length, 1);
  assert.equal((await detail(h, item)).jira_links[0].state, 'failed');
});
