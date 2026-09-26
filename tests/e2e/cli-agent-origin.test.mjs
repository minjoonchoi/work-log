import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT, initRoot, readEndpoint } from '../../src/shared.mjs';
import { Harness, event, eventually } from '../helpers.mjs';

const origin = { engine: 'codex', agent_session_id: 'native-session /?&한글', turn_id: 'native-turn' };
const context = { origin, work_item_id: 'item-native-session' };
const commands = ['run', 'orchestrate'];
const payloadFor = command => command === 'run'
  ? { task: 'prd.create', engine: 'fixture', input: { requirements: '초대 기능의 요구사항을 작성하세요.' } }
  : { prompt: '초대 기능의 PRD를 작성하세요.', engine: 'fixture', steps: [
    { id: 'prd', task: 'prd.create', output_key: 'prd', request_excerpt: 'PRD를 작성하세요.',
      input: { requirements: '초대 기능의 요구사항을 작성하세요.' }, depends_on: [] }
  ] };

async function cli(dir, command, payload, { env = {}, args = [] } = {}) {
  const file = path.join(dir, `${command}-request.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/harness.mjs'), command, '--input', file, ...args], {
    cwd: dir, env: { ...process.env, HARNESS_DATA_DIR: dir, HARNESS_WORKER: '', CODEX_THREAD_ID: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { exit, stdout, stderr };
}

async function endpoint(t, { reply = { status: 200, body: context }, manager = true, itemReplies = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-cli-origin-'));
  const token = initRoot(dir), calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      let raw = ''; for await (const chunk of req) raw += chunk;
      const call = { method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined };
      calls.push(call);
      if (req.url.startsWith('/api/')) {
        const url = new URL(req.url, 'http://127.0.0.1');
        assert.equal(req.method, 'GET');
        let response;
        if (url.pathname === '/api/agent-context') {
          assert.equal(url.searchParams.get('engine'), 'codex');
          assert.equal(url.searchParams.get('session_id'), origin.agent_session_id);
          if (reply.transport === 'reset') { req.socket.destroy(); return; }
          if (reply.transport === 'timeout') return;
          response = reply;
        } else {
          assert.ok(url.pathname.startsWith('/api/items/') && url.pathname.endsWith('/identity'));
          const itemId = decodeURIComponent(url.pathname.slice('/api/items/'.length, -'/identity'.length));
          response = itemReplies[itemId] || { status: 200, body: { id: itemId } };
        }
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response.body));
      } else {
        assert.equal(req.method, 'POST'); assert.ok(['/runs', '/plans'].includes(req.url));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: req.url === '/plans' ? 'plan-origin-test' : 'run-origin-test', status: 'pending', stage: 'produce' }));
      }
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const info = JSON.stringify({ port: server.address().port });
  fs.writeFileSync(path.join(dir, 'runtime.endpoint.json'), info);
  if (manager) fs.writeFileSync(path.join(dir, 'manager.endpoint.json'), info);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, calls };
}

test('CLI leaves standalone requests without a native session environment unchanged', async t => {
  for (const command of commands) await t.test(command, async t => {
    const { dir, calls } = await endpoint(t);
    const payload = payloadFor(command), result = await cli(dir, command, payload);
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(calls, [{ method: 'POST', url: command === 'run' ? '/runs' : '/plans',
      body: { ...payload, workspace: fs.realpathSync(dir) } }]);
  });
});

test('explicit CLI origins take precedence over native environment lookup and preserve item overrides', async t => {
  for (const command of commands) await t.test(command, async t => {
    const { dir, calls } = await endpoint(t, { reply: { status: 500, body: { error: 'must not look up explicit origins' } } });
    const explicit = { engine: 'claude', agent_session_id: 'explicit-session', turn_id: 'explicit-turn' };
    const payload = { ...payloadFor(command), origin: explicit, work_item_id: 'item-payload' };
    const result = await cli(dir, command, payload, { env: { CODEX_THREAD_ID: origin.agent_session_id }, args: ['--item', 'item-explicit'] });
    assert.equal(result.exit, 0, result.stderr); assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST'); assert.deepEqual(calls[0].body.origin, explicit);
    assert.equal(calls[0].body.work_item_id, 'item-explicit');
  });
});

test('CLI attaches the verified active native origin and owning item before submitting runs and plans', async t => {
  for (const command of commands) await t.test(command, async t => {
    const { dir, calls } = await endpoint(t);
    const payload = payloadFor(command);
    const result = await cli(dir, command, payload, { env: { CODEX_THREAD_ID: origin.agent_session_id } });
    assert.equal(result.exit, 0, result.stderr); assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'GET'); assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, command === 'run' ? '/runs' : '/plans');
    assert.deepEqual(calls[1].body, { ...payload, ...context, workspace: fs.realpathSync(dir) });
    assert.equal(calls[1].body.engine, 'fixture', 'native source identity must not replace the selected worker backend');
  });
});

test('registered native sessions without one confirmed active input fail before any runtime submission', async t => {
  for (const command of commands) await t.test(command, async t => {
    const { dir, calls } = await endpoint(t, { reply: { status: 200, body: { ...context, origin: null } } });
    const result = await cli(dir, command, payloadFor(command), { env: { CODEX_THREAD_ID: origin.agent_session_id } });
    assert.equal(result.exit, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /현재 원본 입력을 확인할 수 없습니다/);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
  });
});

test('CLI rejects conflicting payload and flag item IDs but accepts the verified owning item', async t => {
  for (const command of commands) await t.test(command, async t => {
    const { dir, calls } = await endpoint(t);
    for (const variant of [
      { payload: { work_item_id: 'item-other' }, args: [] },
      { payload: { work_item_id: context.work_item_id }, args: ['--item', 'item-other'] }
    ]) {
      const result = await cli(dir, command, { ...payloadFor(command), ...variant.payload },
        { env: { CODEX_THREAD_ID: origin.agent_session_id }, args: variant.args });
      assert.equal(result.exit, 1); assert.equal(result.stdout, '');
      assert.match(result.stderr, /현재 에이전트 세션과 다른 업무/);
    }
    assert.ok(calls.every(call => call.method === 'GET'));
    const accepted = await cli(dir, command, { ...payloadFor(command), work_item_id: context.work_item_id },
      { env: { CODEX_THREAD_ID: origin.agent_session_id }, args: ['--item', context.work_item_id] });
    assert.equal(accepted.exit, 0, accepted.stderr);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.deepEqual(calls.at(-1).body.origin, origin);
  });
});

test('CLI accepts merged item aliases only after confirming their canonical owner', async t => {
  for (const command of commands) await t.test(command, async t => {
    const alias = 'item-alias /?&한글';
    const { dir, calls } = await endpoint(t, { itemReplies: {
      [alias]: { status: 200, body: { id: context.work_item_id } }
    } });
    const payload = { ...payloadFor(command), work_item_id: alias };
    const result = await cli(dir, command, payload, { env: { CODEX_THREAD_ID: origin.agent_session_id } });
    assert.equal(result.exit, 0, result.stderr); assert.equal(calls.length, 3);
    assert.equal(calls[0].method, 'GET');
    assert.deepEqual(calls[1], { method: 'GET', url: `/api/items/${encodeURIComponent(alias)}/identity`, body: undefined });
    assert.equal(calls[2].method, 'POST');
    assert.deepEqual(calls[2].body, { ...payload, ...context, workspace: fs.realpathSync(dir) });
  });
});

test('an unregistered native session stops before any runtime submission', async t => {
  for (const command of commands) await t.test(command, async t => {
    const { dir, calls } = await endpoint(t, { reply: { status: 404, body: { error: 'unregistered session' } } });
    const result = await cli(dir, command, payloadFor(command), { env: { CODEX_THREAD_ID: origin.agent_session_id } });
    assert.equal(result.exit, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /현재 원본 입력을 확인할 수 없습니다/);
    assert.equal(calls.filter(call => call.method === 'GET').length, 1);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  });
});

test('native-session CLI requests stop before runtime submission when the manager cannot be reached', async t => {
  for (const command of commands) for (const state of ['not-running', 'connection-refused', 'reset', 'timeout']) await t.test(`${command}: ${state}`, async t => {
    const connected = ['reset', 'timeout'].includes(state);
    const { dir, calls } = await endpoint(t, { manager: connected, reply: { transport: state } });
    if (state === 'connection-refused') {
      const stopped = http.createServer();
      await new Promise(resolve => stopped.listen(0, '127.0.0.1', resolve));
      const port = stopped.address().port;
      await new Promise(resolve => stopped.close(resolve));
      fs.writeFileSync(path.join(dir, 'manager.endpoint.json'), JSON.stringify({ port }));
    }
    const result = await cli(dir, command, payloadFor(command), { env: { CODEX_THREAD_ID: origin.agent_session_id } });
    assert.equal(result.exit, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /현재 에이전트 세션의 업무 연결 정보를 조회할 수 없습니다/);
    assert.equal(calls.filter(call => call.method === 'GET').length, connected ? 1 : 0);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  });
});

test('manager authorization errors, unexpected failures and invalid native identities never silently create standalone work', async t => {
  for (const reply of [
    { status: 401, body: { error: 'manager authorization failed' } },
    { status: 403, body: { error: 'manager permission denied' } },
    { status: 409, body: { error: 'native session owner was deleted' } },
    { status: 500, body: { error: 'manager failed' } },
    { status: 503, body: { error: 'manager temporarily unavailable' } },
    { status: 200, body: {} },
    { status: 200, body: { ...context, origin: { ...origin, agent_session_id: 'different-session' } } },
    { status: 200, body: { ...context, origin: { ...origin, engine: 'claude' } } }
  ]) await t.test(JSON.stringify(reply), async t => {
    const { dir, calls } = await endpoint(t, { reply });
    const result = await cli(dir, 'run', payloadFor('run'), { env: { CODEX_THREAD_ID: origin.agent_session_id } });
    assert.equal(result.exit, 1); assert.equal(result.stdout, ''); assert.ok(result.stderr.trim());
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
  });
});

test('verified CLI origin survives real manager and runtime plan handoff without duplicate items or synthetic user I/O', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  await h.start('manager');
  await h.ingest([event(origin.agent_session_id, 'input', new Date().toISOString(), origin.turn_id, {
    source: 'system_hook', work_item_id: context.work_item_id, hook_schema: 2,
    source_turn_id: origin.turn_id, turn_source: 'native'
  })]);
  for (const command of commands) {
    const result = await cli(h.dir, command, payloadFor(command), {
      env: { CODEX_THREAD_ID: origin.agent_session_id }, args: ['--wait']
    });
    assert.equal(result.exit, 0, result.stderr);
    const final = JSON.parse(result.stdout); assert.equal(final.status, 'completed');
    assert.deepEqual(final.origin, origin);
    const runId = command === 'run' ? final.id : final.steps[0].run_id;
    const run = await h.runtime(`/runs/${runId}`);
    assert.deepEqual(run.origin, origin);
  }
  const detail = await eventually(() => h.manager(`/items/${context.work_item_id}`), value =>
    value.runs.length === 2 && value.runs.every(run => run.status === 'completed'));
  assert.equal((await h.manager('/items')).length, 1);
  assert.equal(detail.sessions.length, 1);
  assert.ok(detail.runs.every(run => run.work_item_id === context.work_item_id && run.session_id === detail.sessions[0].id));
  const events = detail.events;
  assert.ok(events.length > 0); assert.ok(events.every(event => event.work_item_id === context.work_item_id));
  const userEvents = events.filter(event => event.role === 'user'); assert.ok(userEvents.length > 0);
  assert.ok(userEvents.every(event => event.agent_session_id === origin.agent_session_id));
  assert.equal(userEvents.filter(event => event.kind === 'input').length, 1);
  assert.ok(userEvents.filter(event => event.source === 'runtime').every(event => event.kind === 'run.updated'));
});

test('CLI resolves a freshly spooled hook while periodic collection is waiting for runtime events', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  const endpointFile = path.join(h.dir, 'runtime.endpoint.json'), runtimeEndpoint = fs.readFileSync(endpointFile);
  const token = initRoot(h.dir);
  let waiting, heldResponse;
  const collectionStarted = new Promise(resolve => { waiting = resolve; });
  const gate = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.ok(req.url.startsWith('/events?'));
    heldResponse = res; waiting();
  });
  await new Promise(resolve => gate.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    gate.closeAllConnections();
    await new Promise(resolve => gate.close(resolve));
  });
  fs.writeFileSync(endpointFile, JSON.stringify({ port: gate.address().port }));
  try {
    await h.start('manager');
    await collectionStarted;
  } finally { fs.writeFileSync(endpointFile, runtimeEndpoint); }

  const sessionId = 'fresh-spooled-codex-session', turnId = 'fresh-spooled-turn';
  h.hook('codex', { hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    event_id: 'fresh-input', turn_id: turnId, prompt: '바로 실행할 초대 기능 요구사항' }, { HARNESS_WORKER: '' });
  assert.equal(fs.readdirSync(path.join(h.dir, 'spool')).filter(file => file.endsWith('.json')).length, 1,
    'the hook must still be in the spool before the immediate CLI lookup');
  const result = await cli(h.dir, 'run', payloadFor('run'), { env: { CODEX_THREAD_ID: sessionId } });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(heldResponse.destroyed, false, 'the runtime collection remains pending during context lookup');
  const run = JSON.parse(result.stdout);
  assert.deepEqual(run.origin, { engine: 'codex', agent_session_id: sessionId, turn_id: turnId });
  assert.equal(fs.readdirSync(path.join(h.dir, 'spool')).filter(file => file.endsWith('.json')).length, 0);
  heldResponse.writeHead(200, { 'Content-Type': 'application/json' });
  heldResponse.end(JSON.stringify({ events: [], cursor: 0 }));
  assert.equal((await h.finish(run)).status, 'completed');
  const items = await h.manager('/items'); assert.equal(items.length, 1);
  const detail = await eventually(() => h.manager(`/items/${items[0].id}`), value =>
    value.runs.length === 1 && value.runs[0].status === 'completed');
  assert.equal(detail.sessions.length, 1);
  assert.equal(detail.runs.length, 1);
  const userEvents = detail.events.filter(value => value.role === 'user');
  assert.equal(userEvents.filter(value => value.kind === 'input').length, 1);
  assert.ok(userEvents.every(value => value.agent_session_id === sessionId));
});

test('real manager rejects CLI submissions after a closed turn or with ambiguous hook inputs', async t => {
  for (const state of ['closed', 'ambiguous']) await t.test(state, async t => {
    const h = await new Harness().start('runtime'); t.after(() => h.close());
    await h.start('manager');
    const sessionId = `native-${state}-inputs`;
    h.hook('codex', { hook_event_name: 'UserPromptSubmit', session_id: sessionId,
      event_id: 'input-one', turn_id: 'turn-one', prompt: '첫 요청' }, { HARNESS_WORKER: '' });
    h.hook('codex', state === 'closed'
      ? { hook_event_name: 'Stop', session_id: sessionId, event_id: 'closed-output',
        turn_id: 'turn-one', last_assistant_message: '완료된 요청' }
      : { hook_event_name: 'UserPromptSubmit', session_id: sessionId, event_id: 'input-two',
        turn_id: 'turn-two', prompt: '동시에 열린 다른 요청' }, { HARNESS_WORKER: '' });
    const result = await cli(h.dir, 'run', payloadFor('run'), { env: { CODEX_THREAD_ID: sessionId } });
    assert.equal(result.exit, 1, result.stdout); assert.equal(result.stdout, '');
    assert.match(result.stderr, /현재 원본 입력을 확인할 수 없습니다/);
    assert.deepEqual(await h.runtime('/runs'), []);
    const query = new URLSearchParams({ engine: 'codex', session_id: sessionId });
    const current = await h.manager(`/agent-context?${query}`);
    assert.equal(current.origin, null);
    const items = await h.manager('/items'); assert.equal(items.length, 1);
    assert.equal(current.work_item_id, items[0].id);
  });
});

test('CLI resolves a merged source item flag to the canonical target for a freshly opened native turn', async t => {
  const h = await new Harness().start('runtime'); t.after(() => h.close());
  await h.start('manager');
  const sourceItem = 'item-merged-source', targetItem = 'item-merged-target';
  const sessionId = 'native-merged-source', turnId = 'native-merged-turn';
  const at = new Date(Date.now() - 60000).toISOString();
  await h.ingest([
    event(sessionId, 'input', at, 'source-before-merge', { source: 'system_hook', work_item_id: sourceItem }),
    event(sessionId, 'output', at, 'source-before-merge', { source: 'system_hook', work_item_id: sourceItem }),
    event('native-merged-target', 'input', at, 'target-before-merge', { source: 'system_hook', work_item_id: targetItem }),
    event('native-merged-target', 'output', at, 'target-before-merge', { source: 'system_hook', work_item_id: targetItem })
  ]);
  await h.manager('/merge', { method: 'POST', body: {
    ids: [sourceItem, targetItem], target: targetItem, operation_id: 'merge-cli-origin-alias'
  } });
  assert.equal((await h.manager(`/items/${sourceItem}`)).item.id, targetItem);
  h.hook('codex', { hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    event_id: 'merged-native-input', turn_id: turnId, prompt: '병합한 업무에서 PRD를 작성하세요.' }, { HARNESS_WORKER: '' });

  const result = await cli(h.dir, 'orchestrate', payloadFor('orchestrate'), {
    env: { CODEX_THREAD_ID: sessionId }, args: ['--item', sourceItem, '--wait']
  });
  assert.equal(result.exit, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.status, 'completed'); assert.equal(plan.work_item_id, targetItem);
  assert.deepEqual(plan.origin, { engine: 'codex', agent_session_id: sessionId, turn_id: turnId });
  const detail = await eventually(() => h.manager(`/items/${targetItem}`), value =>
    value.runs.length === 1 && value.runs[0].status === 'completed');
  assert.equal((await h.manager('/items')).length, 1);
  assert.equal(detail.sessions.length, 2);
  const sourceSession = detail.sessions.find(session => session.agent_session_id === sessionId);
  assert.ok(sourceSession);
  assert.equal(detail.runs[0].work_item_id, targetItem);
  assert.equal(detail.runs[0].session_id, sourceSession.id);
  const inputs = detail.events.filter(value => value.role === 'user' && value.kind === 'input');
  assert.equal(inputs.length, 3); assert.ok(inputs.every(input => input.source === 'system_hook'));
});

test('CLI retries after item merges reuse accepted runs and plans without reading changed sources or settings', async t => {
  for (const command of commands) await t.test(command, async t => {
    const h = await new Harness().start('runtime'); t.after(() => h.close()); await h.start('manager');
    const source = `retry-source-${command}`, target = `retry-target-${command}`, final = `retry-final-${command}`, unrelated = `retry-unrelated-${command}`;
    const sessionId = `retry-session-${command}`, turnId = 'accepted-native-turn', at = new Date().toISOString();
    await h.ingest([event(sessionId, 'input', at, turnId, { source: 'system_hook', work_item_id: source }),
      ...[target, final, unrelated].flatMap(item => ['input', 'output'].map(kind =>
        event(`agent-${item}`, kind, at, `turn-${item}`, { source: 'system_hook', work_item_id: item })))]);
    const payload = { ...payloadFor(command), idempotency_key: `merged-cli-${command}` };
    if (command === 'run') payload.input_files = [{ path: 'source.md' }]; else payload.steps[0].input_files = [{ path: 'source.md' }];
    fs.writeFileSync(path.join(h.dir, 'source.md'), 'Accepted source contents.\n');
    const accepted = await cli(h.dir, command, payload, { env: { CODEX_THREAD_ID: sessionId }, args: ['--wait'] });
    assert.equal(accepted.exit, 0, accepted.stderr);
    const first = JSON.parse(accepted.stdout), before = await h.runtime('/runs');
    await h.manager('/merge', { method: 'POST', body: { ids: [source, target], target, operation_id: `retry-merge-one-${command}` } });
    await h.manager('/merge', { method: 'POST', body: { ids: [target, final], target: final, operation_id: `retry-merge-two-${command}` } });
    assert.deepEqual(await h.manager(`/items/${source}/identity`), { id: final });
    assert.deepEqual(await h.manager(`/items/${target}/identity`), { id: final });

    fs.writeFileSync(path.join(h.dir, 'source.md'), 'Source changed after acceptance.\n');
    const settings = await h.runtime('/execution-settings');
    await h.runtime('/execution-settings/prd.create', { method: 'PUT', body: { revision: settings.revision,
      instruction: '# Changed after acceptance\nDo not use for the accepted retry.', backend: 'claude',
      backends: { codex: { model: null, effort: null }, claude: { model: null, effort: null } } } });
    const retried = await cli(h.dir, command, payload, { env: { CODEX_THREAD_ID: sessionId } });
    assert.equal(retried.exit, 0, retried.stderr); assert.equal(JSON.parse(retried.stdout).id, first.id);
    assert.deepEqual(await h.runtime('/runs'), before, 'retry must not prepare, replace or execute the accepted work again');

    const endpoint = command === 'run' ? '/runs' : '/plans';
    const linked = { ...payload, workspace: fs.realpathSync(h.dir), work_item_id: final,
      origin: { engine: 'codex', agent_session_id: sessionId, turn_id: turnId } };
    const simultaneous = await Promise.all(Array.from({ length: 4 }, () => h.runtime(endpoint, { method: 'POST', body: linked })));
    assert.ok(simultaneous.every(value => value.id === first.id));
    const changedInput = command === 'run'
      ? { ...linked, input: { requirements: 'A different requested output.' } }
      : { ...linked, steps: [{ ...linked.steps[0], input: { requirements: 'A different requested output.' } }] };
    const changedTask = command === 'run' ? { ...linked, task: 'document.create' }
      : { ...linked, steps: [{ ...linked.steps[0], task: 'document.create' }] };
    const changedReview = command === 'run' ? { ...linked, review: { required: false, reason: 'Changed review policy.' } }
      : { ...linked, steps: [{ ...linked.steps[0], review: { required: false, reason: 'Changed review policy.' } }] };
    for (const request of [changedInput, changedTask, changedReview, { ...linked, work_item_id: unrelated },
      { ...linked, origin: { ...linked.origin, turn_id: 'another-turn' } },
      { ...linked, origin: { ...linked.origin, agent_session_id: 'another-session' } },
      { ...linked, origin: { ...linked.origin, engine: 'claude' } }])
      await assert.rejects(h.runtime(endpoint, { method: 'POST', body: request }), error => error.status === 409 && /같은.*요청 키/.test(error.message));
    assert.deepEqual(await h.runtime('/runs'), before);

    await h.stop('manager');
    await assert.rejects(h.runtime(endpoint, { method: 'POST', body: linked }), /관리 서비스/);
    assert.deepEqual(await h.runtime('/runs'), before);
    await h.start('manager');
    const resumed = await h.runtime(endpoint, { method: 'POST', body: linked }); assert.equal(resumed.id, first.id);
    await h.manager('/items/delete', { method: 'POST', body: { ids: [final], operation_id: `delete-retry-owner-${command}` } });
    await assert.rejects(h.manager(`/items/${source}/identity`), error => error.status === 404);
    await assert.rejects(h.runtime(endpoint, { method: 'POST', body: linked }), error => error.status === 409);
    assert.deepEqual(await h.runtime('/runs'), before);
  });
});

test('item identity lookup requires authentication and returns only an existing visible canonical ID', async t => {
  const h = new Harness(); t.after(() => h.close()); await h.start('manager');
  const alias = 'item alias /?&한글', target = 'canonical-item';
  await h.ingest([event('identity-alias', 'input', '2026-09-26T00:00:00Z', 'alias', { work_item_id: alias }),
    event('identity-target', 'input', '2026-09-26T00:00:01Z', 'target', { work_item_id: target })]);
  await h.manager('/merge', { method: 'POST', body: { ids: [alias, target], target, operation_id: 'identity-alias-merge' } });
  const route = `/items/${encodeURIComponent(alias)}/identity`;
  assert.deepEqual(await h.manager(route), { id: target });
  const endpoint = readEndpoint(h.dir, 'manager');
  assert.equal((await fetch(`http://127.0.0.1:${endpoint.port}/api${route}`)).status, 401);
  await assert.rejects(h.manager('/items/missing-item/identity'), error => error.status === 404);
  await h.manager('/items/delete', { method: 'POST', body: { ids: [target], operation_id: 'identity-target-delete' } });
  await assert.rejects(h.manager(route), error => error.status === 404);
  await assert.rejects(h.manager(`/items/${target}/identity`), error => error.status === 404);
});
