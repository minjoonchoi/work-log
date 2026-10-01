import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sessionResume } from '../../src/session-resume.mjs';
import { Harness, pair } from '../helpers.mjs';
const id = '12345678-1234-1234-1234-123456789abc';
const observation = { source: 'system_hook', role: 'user', cwd: '/tmp/project' };

test('resume commands preserve exact working directories and arguments without shell expansion', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "user's project $(echo injected); `echo injected`"); fs.mkdirSync(cwd);
  for (const engine of ['codex', 'claude']) {
    fs.writeFileSync(path.join(root, engine), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n', { mode: 0o755 });
    const resume = sessionResume({ engine, agent_session_id: id }, { ...observation, cwd });
    const result = spawnSync('/bin/sh', ['-c', resume.command], { encoding: 'utf8', env: { ...process.env, PATH: root } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [cwd, engine === 'codex' ? 'resume' : '--resume', id]);
  }
});

test('missing identity, working directory and internal sessions do not produce misleading resume commands', () => {
  for (const agent_session_id of ['', '--last', '$(echo bad)', 'local-turn-123']) assert.equal(sessionResume({ engine: 'codex', agent_session_id }, observation), null);
  for (const extra of [{ cwd: undefined }, { cwd: 'relative' }, { cwd: '/tmp/\ncommand' }, { role: 'worker' }, { source: 'fixture' }, { native_session: { kind: 'subagent' } }]) {
    assert.equal(sessionResume({ engine: 'codex', agent_session_id: id }, { ...observation, ...extra }), null);
  }
});

test('item detail exposes native resume commands and resumed input remains attached to the original item', async t => {
  const h = await new Harness().start('manager'); t.after(() => h.close());
  await h.ingest(pair(id, '09:00:00', '09:01:00', 'first', { ...observation, work_item_id: 'resume-item' }));
  let detail = await h.manager('/items/resume-item');
  assert.equal(detail.sessions[0].resume.command, `cd -- '/tmp/project' && codex resume '${id}'`);
  await h.ingest(pair(id, '10:00:00', '10:01:00', 'resumed', { ...observation, work_item_id: 'different-requested-item' }));
  detail = await h.manager('/items/resume-item');
  assert.equal((await h.manager('/items')).length, 1);
  assert.equal(detail.sessions.length, 2);
  assert.ok(detail.sessions.every(session => session.resume.session_id === id));
});
