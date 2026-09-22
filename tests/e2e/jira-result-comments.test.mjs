import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, eventually } from '../helpers.mjs';
import { atlFixture, authorize, adfText } from '../fixtures/atlassian.mjs';
import { managerStore } from '../../src/manager-store.mjs';
import { integrationStore } from '../../src/integration-store.mjs';
import { jiraResultComments } from '../../src/jira-result-comments.mjs';

const post = body => ({ method: 'POST', body });
const linkOperation = 'result-comment-link';
const itemId = 'result-comment-work-item';
const state = h => h.manager(`/items/${itemId}`).then(detail => detail.jira_links.find(link => link.operation_id === linkOperation)?.result_comment);
const waitState = (h, value) => eventually(() => state(h), row => row?.state === value, 20000);
const comments = f => f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/comment'));
const runs = h => h.runtime('/runs').then(rows => rows.filter(row => row.task === 'work-item.result.summarize'));
const retry = (h, operation = 'retry-result-comment') => h.manager(`/jira-links/${linkOperation}/result-comment/retry`, post({ operation_id: operation }));
const reconcile = h => h.manager(`/jira-links/${linkOperation}/result-comment/reconcile`, post({}));
function journal(h) {
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  try { return db.prepare('SELECT * FROM jira_result_comments ORDER BY seq').all(); }
  finally { db.close(); }
}
async function setup(t, fixture = {}) {
  const h = new Harness(), f = await atlFixture(h);
  h.env = { ...h.env, HARNESS_RESULT_FIXTURE: JSON.stringify(fixture) };
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('runtime'); await h.start('manager'); await authorize(h);
  for (const [agent, start, end, text] of [['result-codex', '09:00:00', '09:05:00', '초대 만료 정책을 구현하고 거부 경로 검사를 통과했습니다.'],
    ['result-claude', '10:00:00', '10:05:00', 'API 명세를 수정했습니다. 실제 배포는 미확인입니다.']]) {
    const events = pair(agent, start, end, 'first', { work_item_id: itemId, engine: agent.includes('claude') ? 'claude' : 'codex' });
    events[0].text = '초대 기능을 확인해 주세요.'; events[1].text = text; await h.ingest(events);
  }
  const item = (await h.manager(`/items/${itemId}`)).item, issue = f.addIssue();
  await h.manager(`/items/${itemId}/jira/link`, post({ operation_id: linkOperation, version: item.version,
    cloud_id: 'cloud-test', issue_id: issue.id, key: issue.key }));
  await eventually(() => h.manager(`/items/${itemId}`), detail => !!detail.jira_links[0].view?.data);
  const transition = async (transitionId = '31', operation = 'complete-result-comment') => {
    const current = await h.manager(`/jira-links/${linkOperation}/refresh`, post({}));
    return h.manager(`/jira-links/${linkOperation}/transition`, post({ operation_id: operation, transition_id: transitionId,
      expected_status_id: current.issue.status.id, expected_updated: current.issue.updated }));
  };
  return { h, f, issue, item, transition };
}

test('Done journals its frozen user evidence before transition and posts one separate verified result paragraph', async t => {
  const { h, f, issue, transition } = await setup(t);
  f.state.transitionDelay = 300;
  const pending = transition();
  await eventually(() => journal(h), rows => rows.length === 1);
  const captured = journal(h)[0], snapshot = JSON.parse(captured.snapshot);
  assert.equal(captured.state, 'waiting_transition'); assert.equal(snapshot.input.sessions.length, 2);
  assert.deepEqual(snapshot.input.sessions.map(session => session.engine).sort(), ['claude', 'codex']);
  assert.equal(captured.run_id, null); assert.equal(issue.fields.status.statusCategory.key, 'new');
  assert.equal((await pending).state, 'applied');
  const result = await waitState(h, 'posted');
  assert.equal(issue.fields.status.statusCategory.key, 'done'); assert.equal(comments(f).length, 1);
  assert.equal(f.state.comments.length, 1); assert.equal(f.state.worklogs.length, 0);
  assert.equal(adfText(f.state.comments[0].body), result.text); assert.doesNotMatch(result.text, /[\r\n]/);
  assert.match(result.text, /거부 경로 검사를 통과/); assert.match(result.text, /실제 배포는 미확인/);
  const marker = f.state.comments[0].properties.find(property => property.key === 'work-log-result').value;
  assert.equal(marker.operation_id, captured.operation_id); assert.equal(marker.source_digest, captured.source_digest);
  const run = await h.runtime(`/runs/${result.run_id}`); assert.equal(run.status, 'completed');
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
  assert.ok(fs.readFileSync(path.join(run.attempts[0].directory, 'prompt.txt'), 'utf8').includes('실제 배포는 미확인'));
  assert.equal(journal(h)[0].snapshot, captured.snapshot); assert.equal(journal(h)[0].source_digest, captured.source_digest);
  await h.stop('manager'); await h.start('manager');
  assert.equal((await state(h)).comment_id, result.comment_id); assert.equal(comments(f).length, 1); assert.equal((await runs(h)).length, 1);
});

test('non-Done transitions and externally linked Done issues do not generate result comments', async t => {
  const { h, f, issue, transition } = await setup(t);
  assert.equal((await transition('21')).state, 'applied');
  assert.equal(journal(h).length, 0); assert.equal((await runs(h)).length, 0);
  f.setStatus(issue, 'done'); await h.manager(`/jira-links/${linkOperation}/refresh`, post({}));
  assert.equal(await state(h), null); assert.equal((await runs(h)).length, 0); assert.equal(comments(f).length, 0);
});

test('failed generation leaves Jira Done and explicit retry uses a new run with the original snapshot', async t => {
  const { h, f, issue, transition } = await setup(t, { scenario: 'result-summary-invalid' });
  await transition(); const failed = await waitState(h, 'failed'), before = journal(h)[0];
  assert.equal(issue.fields.status.statusCategory.key, 'done'); assert.equal(comments(f).length, 0);
  assert.ok(failed.run_id); assert.match(failed.message, /형식/);
  await h.stop('manager'); h.env.HARNESS_RESULT_FIXTURE = '{}'; await h.start('manager');
  const pending = await retry(h); assert.equal(pending.state, 'pending');
  assert.equal((await retry(h)).operation_id, pending.operation_id);
  const result = await waitState(h, 'posted'); assert.equal(comments(f).length, 1); assert.notEqual(result.run_id, failed.run_id);
  assert.equal((await runs(h)).length, 2); assert.equal(journal(h)[1].snapshot, before.snapshot);
});

test('known rejected comment retries its saved text without repeating model generation or Done transition', async t => {
  const { h, f, issue, transition } = await setup(t); f.state.commentFailure = 403;
  await transition(); const failed = await waitState(h, 'failed');
  assert.ok(failed.text); assert.equal(issue.fields.status.statusCategory.key, 'done'); assert.equal(f.state.comments.length, 0);
  const incidents = (await h.manager('/notifications')).filter(row => row.kind === 'jira_result_comment');
  assert.equal(incidents.length, 1); assert.equal(incidents[0].work_item_id, itemId); assert.equal(incidents[0].link_operation_id, linkOperation);
  f.state.commentFailure = null;
  const queued = await retry(h); assert.equal(queued.state, 'ready'); assert.equal((await retry(h)).operation_id, queued.operation_id);
  assert.equal((await h.manager('/notifications')).filter(row => row.kind === 'jira_result_comment').length, 0);
  const result = await waitState(h, 'posted'); assert.equal(result.text, failed.text); assert.equal(result.run_id, failed.run_id);
  assert.equal((await runs(h)).length, 1); assert.equal(f.state.comments.length, 1); assert.equal(comments(f).length, 2);
  assert.equal(f.state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/transitions')).length, 1);
});

test('lost comment response reconciles its exact marker and content; absence never permits blind retry', async t => {
  const { h, f, transition } = await setup(t); f.state.loseComment = true;
  await transition(); const unknown = await waitState(h, 'unknown');
  assert.equal(comments(f).length, 1); assert.equal(f.state.comments.length, 1);
  await assert.rejects(retry(h), error => error.status === 409);
  const saved = f.state.comments; f.state.comments = [];
  assert.equal((await reconcile(h)).state, 'unknown'); assert.equal((await state(h)).state, 'unknown');
  await assert.rejects(retry(h), error => error.status === 409); assert.equal(comments(f).length, 1);
  f.state.comments = saved;
  const result = await reconcile(h); assert.equal(result.state, 'posted'); assert.equal(result.run_id, unknown.run_id);
  assert.equal(result.comment_id, saved[0].id); assert.equal(comments(f).length, 1);
});

test('mismatching marker content stays unknown and never triggers another comment', async t => {
  const { h, f, transition } = await setup(t); f.state.loseComment = true;
  await transition(); await waitState(h, 'unknown');
  f.state.comments[0].properties[0].value.source_digest = 'different-evidence';
  await assert.rejects(reconcile(h), error => error.status === 409);
  assert.equal((await state(h)).state, 'unknown'); assert.equal(comments(f).length, 1);
});

test('a new Done cycle cannot hide an unresolved prior comment while non-Done transitions remain usable', async t => {
  const { h, f, issue, transition } = await setup(t); f.state.loseComment = true;
  await transition(); const unknown = await waitState(h, 'unknown');
  f.setStatus(issue, 'todo');
  assert.equal((await transition('21', 'reopen-progress-result')).state, 'applied');
  await assert.rejects(transition('31', 'duplicate-done-result'), /이전 완료 결과 댓글/);
  assert.equal(issue.fields.status.statusCategory.key, 'indeterminate');
  assert.equal((await state(h)).operation_id, unknown.operation_id); assert.equal((await state(h)).state, 'unknown');
  assert.equal(journal(h).length, 1); assert.equal((await runs(h)).length, 1); assert.equal(comments(f).length, 1);
});

test('an oversized frozen source records summary failure without reversing Done and cannot create futile retries', async t => {
  const { h, f, issue, transition } = await setup(t);
  const events = [];
  for (let index = 0; index < 1001; index++) events.push(...pair('large-result-source', '11:00:00', '11:01:00', `turn-${index}`, { work_item_id: itemId }));
  for (let offset = 0; offset < events.length; offset += 500) await h.ingest(events.slice(offset, offset + 500));
  assert.equal((await transition()).state, 'applied'); const failed = await waitState(h, 'failed');
  assert.equal(issue.fields.status.statusCategory.key, 'done'); assert.equal(failed.run_id, null);
  const saved = journal(h)[0]; assert.equal(JSON.parse(saved.snapshot).input, null);
  await assert.rejects(retry(h), error => error.status === 409 && error.message === JSON.parse(saved.snapshot).admission_error);
  assert.equal(journal(h).length, 1); assert.equal((await runs(h)).length, 0); assert.equal(comments(f).length, 0);
});

test('failed Done transition never generates a result; unknown transition waits for confirmed refreshed state', async t => {
  const { h, f, issue, transition } = await setup(t); f.state.transitionFailure = 403;
  await assert.rejects(transition()); assert.equal((await state(h)).state, 'failed');
  assert.equal((await runs(h)).length, 0); assert.equal(comments(f).length, 0);
  await assert.rejects(retry(h), error => error.status === 409);
  f.state.transitionFailure = null; f.state.loseTransition = true;
  await assert.rejects(transition('31', 'unknown-done-transition'));
  assert.equal((await state(h)).state, 'waiting_transition'); assert.equal(issue.fields.status.statusCategory.key, 'done');
  assert.equal((await runs(h)).length, 0);
  await h.manager(`/jira-links/${linkOperation}/refresh`, post({}));
  await waitState(h, 'posted'); assert.equal(comments(f).length, 1);
});

for (const phase of ['running', 'pending']) test(`manager restart recovers ${phase} generation ownership without another run`, async t => {
  const { h, f, transition } = await setup(t, { scenario: 'slow', delayMs: 2000 });
  await transition(); const running = await waitState(h, 'running');
  await h.stop('manager');
  if (phase === 'pending') {
    const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
    db.prepare("UPDATE jira_result_comments SET state='pending',run_id=NULL WHERE operation_id=?").run(running.operation_id); db.close();
  }
  await h.start('manager');
  const result = await waitState(h, 'posted');
  assert.equal(result.run_id, running.run_id); assert.equal((await runs(h)).length, 1); assert.equal(comments(f).length, 1);
});

for (const fault of ['wrong-input', 'unreadable-artifact']) test(`${fault} in a completed runtime result is terminal and cannot be posted`, async t => {
  const { h, f, transition } = await setup(t, { scenario: 'slow', delayMs: 1500 });
  await transition(); const running = await waitState(h, 'running'); await h.stop('manager');
  const run = await h.finish({ id: running.run_id }); assert.equal(run.status, 'completed');
  if (fault === 'wrong-input') {
    const db = new DatabaseSync(path.join(h.dir, 'runtime.sqlite'));
    const input = JSON.parse(db.prepare('SELECT request FROM runs WHERE id=?').get(run.id).request);
    input.input.description = '다른 입력으로 생성한 결과';
    db.prepare('UPDATE runs SET request=? WHERE id=?').run(JSON.stringify(input), run.id); db.close();
  } else { fs.unlinkSync(run.artifact.file); fs.mkdirSync(run.artifact.file); }
  await h.start('manager'); const failed = await waitState(h, 'failed');
  assert.match(failed.message, fault === 'wrong-input' ? /고정한 입력/ : /EISDIR/);
  assert.equal(comments(f).length, 0);
});

test('restart during comment POST marks the intent unknown and reconciles without resend', async t => {
  const { h, f, transition } = await setup(t); f.state.commentDelay = 1500;
  await transition(); await eventually(() => comments(f), values => values.length === 1, 20000);
  assert.equal((await state(h)).state, 'sending');
  await h.stop('manager'); await h.start('manager');
  assert.equal((await state(h)).state, 'unknown');
  await eventually(() => f.state.comments, values => values.length === 1);
  assert.equal((await reconcile(h)).state, 'posted'); assert.equal(comments(f).length, 1);
});

for (const blocked of ["'posted'", "'posted','unknown'"]) test(`local confirmation failure for ${blocked} never makes an accepted comment retryable`, async t => {
  const { h, f, transition } = await setup(t);
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  db.exec(`CREATE TRIGGER reject_comment_confirmation BEFORE UPDATE OF state ON jira_result_comments
    WHEN NEW.state IN (${blocked}) BEGIN SELECT RAISE(FAIL, 'injected confirmation failure'); END;`);
  db.close();
  await transition();
  await eventually(() => f.state.comments, values => values.length === 1, 20000);
  if (blocked === "'posted'") await waitState(h, 'unknown');
  await assert.rejects(retry(h), error => error.status === 409);
  await h.stop('manager');
  assert.equal(journal(h)[0].state, blocked === "'posted'" ? 'unknown' : 'sending');
  const recovered = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  recovered.exec('DROP TRIGGER reject_comment_confirmation'); recovered.close();
  await h.start('manager'); assert.equal((await state(h)).state, 'unknown');
  assert.equal((await reconcile(h)).state, 'posted');
  assert.equal(comments(f).length, 1); assert.equal(f.state.comments.length, 1);
});

test('a notification exception after posted is durable cannot downgrade it or enable another POST', async t => {
  const { h, transition } = await setup(t);
  await transition(); await waitState(h, 'ready'); await h.stop('manager');
  const store = managerStore(h.dir), integrations = integrationStore(store);
  let accepted = 0, injected = false;
  const client = {
    issueState: async issue => ({ issue: { ...issue, status: { category: 'done' } }, can_write: true }),
    postResultComment: async (issue, input, { beforeSend }) => {
      await beforeSend(); accepted++;
      return { id: 'accepted-before-notification-error' };
    }
  };
  const coordinator = jiraResultComments({ dir: h.dir, store, integrations, client,
    exclusive: (key, action) => action(), notify: () => {
      if (!injected && journal(h)[0].state === 'posted') {
        injected = true; throw new Error('injected notification failure');
      }
    } });
  try {
    await coordinator.tick();
    assert.equal(injected, true); assert.equal(coordinator.view(linkOperation).state, 'posted');
    assert.equal(coordinator.view(linkOperation).comment_id, 'accepted-before-notification-error');
    await assert.rejects(coordinator.retry(linkOperation, { operation_id: 'retry-after-notification' }), error => error.status === 409);
    await coordinator.tick(); assert.equal(accepted, 1);
  } finally { store.db.close(); }
});

for (const action of ['delete-restore', 'merge', 'reopen', 'wrong-link']) test(`${action} during generation prevents stale result publication`, async t => {
  const { h, f, issue, transition } = await setup(t, { scenario: 'slow', delayMs: 1500 });
  await transition(); await waitState(h, 'running');
  if (action === 'delete-restore') {
    await h.manager('/items/delete', post({ ids: [itemId], operation_id: 'delete-result-item' }));
    await h.manager('/items/restore', post({ ids: [itemId], operation_id: 'restore-result-item' }));
  } else if (action === 'merge') {
    await h.ingest(pair('other-result-item', '11:00:00', '11:05:00', 'other', { work_item_id: 'other-result-item' }));
    await h.manager('/merge', post({ ids: [itemId, 'other-result-item'], target: itemId, operation_id: 'merge-result-items' }));
  } else if (action === 'wrong-link') {
    const changed = f.addIssue(), db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
    db.prepare('UPDATE jira_links SET issue=? WHERE operation_id=?').run(JSON.stringify({ id: changed.id, cloud_id: 'cloud-test', key: changed.key }), linkOperation); db.close();
  } else f.setStatus(issue, 'progress');
  const result = await waitState(h, 'failed');
  assert.match(result.message, /삭제|목록 상태|병합|완료 상태|연결이 변경/); assert.equal(comments(f).length, 0);
  await assert.rejects(retry(h), error => error.status === 409);
});
