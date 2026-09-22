import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Harness, pair, event, eventually } from '../helpers.mjs';

const post = body => ({ method: 'POST', body });
const patch = body => ({ method: 'PATCH', body });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = minute => new Date(Date.parse('2026-09-17T09:00:00Z') + minute * 60000).toISOString();
const turn = (agent, minute, name, extra = {}) => pair(agent, stamp(minute), stamp(minute + 1), name,
  { source: 'system_hook', text: `${name} 작업 기록`, ...extra });
const detail = (h, item) => h.manager(`/items/${typeof item === 'string' ? item : item.id}`);
async function metadataRuns(h) {
  const runs = (await h.runtime('/runs')).filter(run => run.task === 'text.rewrite');
  const full = await Promise.all(runs.map(run => h.runtime(`/runs/${run.id}`)));
  return full.filter(run => run.request.input.format === 'work-item-metadata');
}
const rewrite = (h, item, operation) => h.manager(`/items/${item.id}/metadata/regenerate`, post({ operation_id: operation, version: item.version }));
const summarize = (h, session, operation) => h.manager(`/sessions/${session}/summary/regenerate`, post({ operation_id: operation }));
const finished = (h, operation) => eventually(() => h.manager(`/writing/${operation}`), row => !['pending', 'running'].includes(row.state), 20000);
async function setup(t, fixture = {}, summaries = true) {
  const h = new Harness();
  h.env = { HARNESS_TEST_AUTOMATIC_METADATA: '1', HARNESS_TEST_SESSION_SUMMARIES: summaries ? '1' : '0', HARNESS_TEST_WRITING_FIXTURE: JSON.stringify(fixture) };
  t.after(() => h.close()); await h.start('runtime'); await h.start('manager'); return h;
}
async function applied(h, item, count) {
  await eventually(() => metadataRuns(h), rows => rows.length === count && rows.every(row => row.status === 'completed'), 20000);
  return eventually(() => detail(h, item), value => value.metadata_rewrite?.state === 'completed', 15000);
}
async function stableCount(h, count) {
  await pause(1250); assert.equal((await metadataRuns(h)).length, count);
}
async function closedAccepted(h, item, count) {
  return eventually(() => detail(h, item), value => value.sessions.filter(session => session.closed && session.summary?.current && session.summary.state === 'completed').length === count, 20000);
}

test('the fifth real user Stop creates one format-checked automatic metadata run; hook replay, workers and restart do not repeat it', async t => {
  const h = await setup(t);
  assert.deepEqual(await h.manager('/automation/settings'), { initial_output_count: 5, summary_interval: 5 });
  h.hook('codex', { hook_event_name: 'SessionStart', session_id: 'automatic-hook', event_id: 'initial-session-start' });
  const temporary = (await eventually(() => h.manager('/items'), rows => rows.length === 1))[0];
  assert.equal(temporary.title, '새 작업'); assert.equal((await detail(h, temporary)).metadata_rewrite, null);
  const hookTurn = index => {
    h.hook('codex', { hook_event_name: 'UserPromptSubmit', session_id: 'automatic-hook', event_id: `input-${index}`, turn_id: `turn-${index}`, prompt: `권한 정책 ${index}번째 요청` });
    h.hook('codex', { hook_event_name: 'Stop', session_id: 'automatic-hook', event_id: `output-${index}`, turn_id: `turn-${index}`, last_assistant_message: `${index}번째 응답` });
  };
  for (let index = 1; index <= 4; index++) hookTurn(index);
  const item = (await eventually(() => h.manager('/items'), rows => rows.length === 1))[0];
  await eventually(() => detail(h, item), value => value.events.filter(row => row.role === 'user' && row.kind === 'output').length === 4);
  await h.ingest(Array.from({ length: 6 }, (_, index) => event('internal-count-exclusion', 'output', stamp(index), `worker-${index}`, { role: 'worker', work_item_id: item.id })));
  await stableCount(h, 0); hookTurn(5);
  const accepted = await applied(h, item, 1), run = (await metadataRuns(h))[0];
  assert.equal(accepted.metadata_rewrite.source, 'automatic'); assert.equal(Boolean(accepted.item.metadata_protected), false);
  assert.equal(run.internal, true); assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
  assert.equal(run.artifact.validation_scope, 'format');
  assert.equal(run.request.input.sessions.flatMap(session => session.events).filter(row => row.kind === 'output').length, 5);
  assert.deepEqual([...accepted.item.description.matchAll(/^h2\. (.+)$/gm)].map(match => match[1]), ['배경', '목표', '요구사항', '작업 범위', '참고사항']);
  hookTurn(5); hookTurn(6);
  await h.stop('manager'); await h.start('manager'); await stableCount(h, 1);
  assert.equal((await detail(h, item)).metadata_rewrite.run_id, run.id);
  assert.equal((await h.manager('/health')).quarantined, 0);
  assert.equal((await h.manager('/items')).length, 1);
});

test('automatic metadata refreshes at five and ten accepted closed sessions, not repeated summaries or an open summary', async t => {
  const h = await setup(t), agent = 'automatic-cadence';
  await h.ingest(Array.from({ length: 5 }, (_, index) => turn(agent, index * 2, `initial-${index}`)).flat());
  const item = (await h.manager('/items'))[0]; await applied(h, item, 1);
  await h.ingest([30, 60, 90, 120].flatMap((minute, index) => turn(agent, minute, `closed-${index}`)));
  let current = await closedAccepted(h, item, 4); await stableCount(h, 1);
  await summarize(h, current.sessions[0].id, 'repeat-counted-closed-summary');
  assert.equal((await finished(h, 'repeat-counted-closed-summary')).state, 'completed');
  await summarize(h, current.sessions.at(-1).id, 'summarize-open-not-counted');
  assert.equal((await finished(h, 'summarize-open-not-counted')).state, 'completed');
  await stableCount(h, 1);
  await h.ingest(turn(agent, 150, 'fifth-closed'));
  await closedAccepted(h, item, 5); current = await applied(h, item, 2);
  const second = await h.runtime(`/runs/${current.metadata_rewrite.run_id}`);
  assert.equal(second.request.input.sessions.filter(session => session.summary).length, 5);
  await h.ingest([180, 210, 240, 270].flatMap((minute, index) => turn(agent, minute, `next-${index}`)));
  await closedAccepted(h, item, 9); await stableCount(h, 2);
  await h.ingest(turn(agent, 300, 'tenth-closed'));
  await closedAccepted(h, item, 10); await applied(h, item, 3);
  await h.stop('manager'); await h.start('manager'); await stableCount(h, 3);
  assert.ok((await metadataRuns(h)).every(run => run.internal && run.attempts.length === 1));
});

test('only distinct matched user turns with nonempty system-hook outputs advance the initial threshold', async t => {
  const h = await setup(t, {}, false);
  await h.manager('/automation/settings', patch({ initial_output_count: 2 }));
  const agent = 'count-evidence', common = { work_item_id: 'counted-item', source: 'system_hook' };
  await h.ingest([
    ...turn(agent, 0, 'valid-first', common),
    event(agent, 'output', stamp(2), 'valid-first', { ...common, text: '같은 턴의 별도 Stop 이벤트' }),
    event(agent, 'input', stamp(3), 'missing-body', common),
    event(agent, 'output', stamp(4), 'missing-body', { ...common, text: null }),
    event(agent, 'input', stamp(5), 'blank-body', common),
    event(agent, 'output', stamp(6), 'blank-body', { ...common, text: '   ' }),
    event(agent, 'output', stamp(7), 'unmatched', { ...common, text: '연결할 입력이 없는 응답' }),
    ...turn(agent, 8, 'runtime-origin', { ...common, source: 'runtime' }),
    ...turn('count-excluded-worker', 10, 'worker', { ...common, role: 'worker' })
  ]);
  await stableCount(h, 0);
  await h.ingest(turn(agent, 12, 'valid-second', common));
  const accepted = await applied(h, 'counted-item', 1);
  assert.equal(accepted.metadata_rewrite.source, 'automatic');
  await stableCount(h, 1);
});

test('automation settings validate, persist and coalesce an already fulfilled lower threshold without replaying consumed buckets', async t => {
  const h = await setup(t);
  for (const body of [{}, { initial_output_count: 0 }, { summary_interval: 1001 }, { initial_output_count: 1.5 }, { summary_interval: '3' }, { unknown: 5 }]) {
    await assert.rejects(h.manager('/automation/settings', patch(body)));
  }
  assert.deepEqual(await h.manager('/automation/settings', patch({ initial_output_count: 1000, summary_interval: 1000 })), { initial_output_count: 1000, summary_interval: 1000 });
  await h.ingest([0, 30, 60, 90, 120, 150, 180].flatMap((minute, index) => turn('settings-cadence', minute, `window-${index}`)));
  const item = (await h.manager('/items'))[0], before = await closedAccepted(h, item, 6); await stableCount(h, 0);
  await summarize(h, before.sessions.at(-1).id, 'open-summary-before-automatic');
  assert.equal((await finished(h, 'open-summary-before-automatic')).state, 'completed');
  await h.stop('manager'); await h.start('manager');
  assert.deepEqual(await h.manager('/automation/settings'), { initial_output_count: 1000, summary_interval: 1000 });
  await h.manager('/automation/settings', patch({ initial_output_count: 3, summary_interval: 5 }));
  const value = await applied(h, item, 1); assert.equal(value.metadata_rewrite.source, 'automatic');
  const initial = await h.runtime(`/runs/${value.metadata_rewrite.run_id}`);
  assert.equal(initial.request.input.sessions.filter(session => session.summary && session.events.length === 0).length, 6);
  const open = initial.request.input.sessions.find(session => session.id === before.sessions.at(-1).id);
  assert.equal(open.summary, null); assert.equal(open.events.length, 2);
  await h.manager('/automation/settings', patch({ summary_interval: 1 })); await stableCount(h, 1);
  await h.ingest(turn('settings-cadence', 210, 'new-counted-window'));
  await closedAccepted(h, item, 7); await applied(h, item, 2);
  await h.stop('manager'); await h.start('manager'); await stableCount(h, 2);
  assert.deepEqual(await h.manager('/automation/settings'), { initial_output_count: 3, summary_interval: 1 });
});

test('closed summaries cannot bypass the initial output threshold; explicit metadata generation starts the later summary cadence', async t => {
  const h = await setup(t);
  await h.manager('/automation/settings', patch({ initial_output_count: 100, summary_interval: 1 }));
  await h.ingest([0, 30, 60].flatMap((minute, index) => turn('initial-stage-gate', minute, `window-${index}`)));
  const item = (await h.manager('/items'))[0]; await closedAccepted(h, item, 2); await stableCount(h, 0);
  await rewrite(h, (await detail(h, item)).item, 'manual-initial-stage');
  assert.equal((await finished(h, 'manual-initial-stage')).state, 'completed'); await stableCount(h, 1);
  await h.stop('manager'); await h.start('manager'); await stableCount(h, 1);
  await h.ingest(turn('initial-stage-gate', 90, 'new-after-explicit-initial'));
  await closedAccepted(h, item, 3); const refreshed = await applied(h, item, 2);
  assert.equal(refreshed.metadata_rewrite.source, 'automatic');
});

test('appended user dialogue and a manager restart preserve one frozen automatic generation instead of a model-call loop', async t => {
  const h = await setup(t, { delayMs: 1500 }, false);
  await h.manager('/automation/settings', patch({ initial_output_count: 1 }));
  await h.ingest(turn('append-auto', 0, 'captured'));
  const item = (await h.manager('/items'))[0];
  const started = await eventually(() => detail(h, item), value => value.metadata_rewrite?.state === 'running');
  const operation = started.metadata_rewrite.operation_id, runId = started.metadata_rewrite.run_id;
  await h.ingest(turn('append-auto', 2, 'appended-after-capture'));
  await h.stop('manager'); await h.start('manager');
  const current = await applied(h, item, 1);
  assert.equal(current.metadata_rewrite.operation_id, operation); assert.equal(current.metadata_rewrite.run_id, runId);
  const run = await h.runtime(`/runs/${runId}`);
  assert.deepEqual(run.request.input.sessions.flatMap(session => session.events).map(row => row.text), ['captured 작업 기록', 'captured 작업 기록']);
  assert.equal(current.events.filter(row => row.role === 'user' && ['input', 'output'].includes(row.kind)).length, 4);
  await stableCount(h, 1);
});

test('human metadata edits defeat in-flight automation and remain protected after further thresholds and deliberate regeneration', async t => {
  const h = await setup(t, { delayMs: 1000 });
  await h.manager('/automation/settings', patch({ initial_output_count: 1, summary_interval: 1 }));
  await h.ingest(turn('manual-protection', 0, 'first'));
  const item = (await h.manager('/items'))[0];
  const started = await eventually(() => detail(h, item), value => value.metadata_rewrite?.state === 'running');
  await h.manager(`/items/${item.id}`, patch({ version: started.item.version, title: '사람이 확정한 제목', description: '직접 편집한 설명' }));
  assert.equal((await finished(h, started.metadata_rewrite.operation_id)).state, 'superseded');
  await h.ingest(turn('manual-protection', 30, 'second')); await closedAccepted(h, item, 1); await stableCount(h, 1);
  let current = await detail(h, item); assert.equal(current.item.title, '사람이 확정한 제목'); assert.equal(current.item.description, '직접 편집한 설명');
  await rewrite(h, current.item, 'deliberate-protected-regeneration');
  assert.equal((await finished(h, 'deliberate-protected-regeneration')).state, 'completed');
  current = await detail(h, item); const regenerated = { title: current.item.title, description: current.item.description };
  assert.equal(current.metadata_rewrite.source, 'manual');
  await h.ingest(turn('manual-protection', 60, 'third')); await closedAccepted(h, item, 2); await stableCount(h, 2);
  current = await detail(h, item); assert.deepEqual({ title: current.item.title, description: current.item.description }, regenerated);
});

test('failed automatic metadata retains the previous content and consumes its trigger until an explicit retry', async t => {
  const h = await setup(t, { scenario: 'rewrite-blank' }, false);
  await h.manager('/automation/settings', patch({ initial_output_count: 1 }));
  await h.ingest(turn('failed-auto', 0, 'preserved'));
  const item = (await h.manager('/items'))[0];
  const failed = await eventually(() => detail(h, item), value => value.metadata_rewrite?.state === 'failed', 15000);
  assert.equal(failed.item.title, item.title); assert.equal(failed.item.description, item.description);
  assert.equal(failed.metadata_rewrite.source, 'automatic');
  const run = (await metadataRuns(h))[0]; assert.equal(run.status, 'failed'); assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['produce']);
  await h.stop('manager'); h.env.HARNESS_TEST_WRITING_FIXTURE = '{}'; await h.start('manager');
  await h.ingest(turn('failed-auto', 2, 'another-output')); await stableCount(h, 1);
  const fresh = await detail(h, item); await rewrite(h, fresh.item, 'manual-retry-failed-automatic');
  assert.equal((await finished(h, 'manual-retry-failed-automatic')).state, 'completed');
  await stableCount(h, 2);
});

test('a merge during automatic generation preserves the representative item and its complete original session history', async t => {
  const h = await setup(t, { delayMs: 1300 }, false);
  await h.manager('/automation/settings', patch({ initial_output_count: 1 }));
  await h.ingest([event('merge-representative', 'input', stamp(60), 'target', { work_item_id: 'merge-target', source: 'system_hook', text: '대표 업무 원문' })]);
  const target = await detail(h, 'merge-target');
  await h.manager('/items/merge-target', patch({ version: target.item.version, title: '유지할 대표 업무', description: '대표 업무 설명' }));
  await h.ingest(turn('merge-auto-source', 0, 'source', { work_item_id: 'merge-source' }));
  const started = await eventually(() => detail(h, 'merge-source'), value => value.metadata_rewrite?.state === 'running');
  await h.manager('/merge', post({ ids: ['merge-source', 'merge-target'], target: 'merge-target', operation_id: 'merge-automatic-in-flight' }));
  assert.equal((await finished(h, started.metadata_rewrite.operation_id)).state, 'superseded');
  await h.finish({ id: started.metadata_rewrite.run_id }); await stableCount(h, 1);
  const merged = await detail(h, 'merge-target');
  assert.equal(merged.item.title, '유지할 대표 업무'); assert.equal(merged.item.description, '대표 업무 설명');
  assert.equal(merged.sessions.length, 2); assert.equal(merged.events.filter(row => row.role === 'user').length, 3);
  assert.equal((await h.manager('/items')).length, 1);
});

test('merging two agent histories crosses the output threshold once under the canonical work item', async t => {
  const h = await setup(t, {}, false);
  await h.ingest([
    ...[0, 2].flatMap((minute, index) => turn('merge-count-codex', minute, `codex-${index}`, { work_item_id: 'threshold-a' })),
    ...[60, 62, 64].flatMap((minute, index) => turn('merge-count-claude', minute, `claude-${index}`, { work_item_id: 'threshold-b', engine: 'claude' }))
  ]);
  await stableCount(h, 0);
  await h.manager('/merge', post({ ids: ['threshold-a', 'threshold-b'], target: 'threshold-a', operation_id: 'merge-crosses-five-outputs' }));
  const accepted = await applied(h, 'threshold-a', 1), run = (await metadataRuns(h))[0];
  assert.equal(accepted.item.id, 'threshold-a'); assert.equal(accepted.metadata_rewrite.source, 'automatic');
  assert.equal(run.request.input.sessions.length, 2);
  assert.deepEqual(new Set(run.request.input.sessions.map(session => session.engine)), new Set(['codex', 'claude']));
  assert.equal(run.request.input.sessions.flatMap(session => session.events).filter(row => row.kind === 'output').length, 5);
  assert.equal(accepted.sessions.length, 2); assert.equal((await h.manager('/items')).length, 1);
  await h.stop('manager'); await h.start('manager'); await stableCount(h, 1);
});

test('deleting and restoring while an automatic worker runs cannot apply an obsolete result or repeat its consumed trigger', async t => {
  const h = await setup(t, { delayMs: 1300 }, false);
  await h.manager('/automation/settings', patch({ initial_output_count: 1 }));
  await h.ingest(turn('delete-restore-auto', 0, 'original'));
  const item = (await h.manager('/items'))[0];
  const started = await eventually(() => detail(h, item), value => value.metadata_rewrite?.state === 'running');
  await h.manager('/items/delete', post({ ids: [item.id], versions: { [item.id]: started.item.version }, operation_id: 'delete-automatic-in-flight' }));
  const deleted = (await h.manager('/items?trash=true'))[0];
  await h.manager('/items/restore', post({ ids: [item.id], versions: { [item.id]: deleted.version }, operation_id: 'restore-automatic-in-flight' }));
  assert.equal((await finished(h, started.metadata_rewrite.operation_id)).state, 'superseded');
  await h.finish({ id: started.metadata_rewrite.run_id });
  await h.stop('manager'); await h.start('manager'); await stableCount(h, 1);
  const restored = await detail(h, item);
  assert.equal(restored.item.title, item.title); assert.equal(restored.item.description, item.description);
  assert.equal(restored.events.filter(row => row.role === 'user').length, 2);
});

test('late output that retires a captured session invalidates the automatic snapshot without repeating its consumed trigger', async t => {
  const h = await setup(t, { delayMs: 1300 }, false);
  await h.manager('/automation/settings', patch({ initial_output_count: 2 }));
  await h.ingest([...turn('retired-auto-window', 0, 'first'), ...turn('retired-auto-window', 30, 'second')]);
  const item = (await h.manager('/items'))[0];
  const started = await eventually(() => detail(h, item), value => value.metadata_rewrite?.state === 'running');
  assert.equal(started.sessions.length, 2);
  await h.ingest([event('retired-auto-window', 'output', stamp(15), 'first', { source: 'system_hook', text: '늦게 수집되어 두 작업 구간을 합치는 출력' })]);
  assert.equal((await finished(h, started.metadata_rewrite.operation_id)).state, 'superseded');
  await h.finish({ id: started.metadata_rewrite.run_id }); await stableCount(h, 1);
  const changed = await detail(h, item);
  assert.equal(changed.sessions.length, 1); assert.equal(changed.item.title, item.title); assert.equal(changed.item.description, item.description);
  assert.equal(changed.events.filter(row => row.role === 'user').length, 5);
});

test('legacy migration unlocks proven generated metadata while preserving identical human edits and values without generation evidence', async t => {
  const h = await setup(t, {}, false);
  for (const [index, id] of ['legacy-generated', 'legacy-edited', 'legacy-manual'].entries()) {
    await h.ingest(turn(id, index * 30, id, { work_item_id: id }));
  }
  for (const id of ['legacy-generated', 'legacy-edited']) {
    const current = await detail(h, id); await rewrite(h, current.item, `write-${id}`);
    assert.equal((await finished(h, `write-${id}`)).state, 'completed');
  }
  for (const id of ['legacy-edited', 'legacy-manual']) {
    const current = await detail(h, id);
    // Even an explicit edit that keeps exactly the generated text must remain protected.
    await h.manager(`/items/${id}`, patch({ version: current.item.version, title: current.item.title, description: current.item.description }));
  }
  await h.stop('manager');
  const db = new DatabaseSync(path.join(h.dir, 'memory.sqlite'));
  db.exec(`ALTER TABLE work_items DROP COLUMN metadata_protected;
    ALTER TABLE writing_requests DROP COLUMN source;
    DROP TABLE metadata_automation_state;
    DROP TABLE metadata_automation_settings;`); db.close();
  await h.start('manager');
  assert.equal(Boolean((await detail(h, 'legacy-generated')).item.metadata_protected), false);
  assert.equal(Boolean((await detail(h, 'legacy-edited')).item.metadata_protected), true);
  assert.equal(Boolean((await detail(h, 'legacy-manual')).item.metadata_protected), true);
  await h.manager('/automation/settings', patch({ initial_output_count: 1 }));
  const generated = await applied(h, 'legacy-generated', 3); assert.equal(generated.metadata_rewrite.source, 'automatic');
  await h.stop('manager'); await h.start('manager'); await stableCount(h, 3);
  assert.equal((await detail(h, 'legacy-edited')).metadata_rewrite.source, 'manual');
  assert.equal((await detail(h, 'legacy-manual')).metadata_rewrite, null);
});
