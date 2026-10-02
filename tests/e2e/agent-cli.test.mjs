import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentCLI } from '../../src/agent-cli.mjs';

test('GUI PATH discovers nvm Codex and supplies its Node interpreter without shell startup', t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'worklog-cli-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const bin=path.join(home,'.nvm/versions/node/v22.17.0/bin');fs.mkdirSync(bin,{recursive:true});
  fs.symlinkSync(process.execPath,path.join(bin,'node'));
  fs.writeFileSync(path.join(bin,'codex'),'#!/usr/bin/env node\nconsole.log("fixture-cli");\n',{mode:0o755});
  const env={HOME:home,PATH:'/usr/bin:/bin'};
  const result=agentCLI('codex',{env,home});assert.equal(result.command,path.join(bin,'codex'));
  const run=spawnSync(result.command,[],{env:{...env,PATH:result.path},encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),'fixture-cli');
  assert.equal(env.PATH,'/usr/bin:/bin');
});
test('PATH executables and explicit overrides take precedence over discovered installations',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'worklog-cli-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const bin=path.join(home,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  assert.equal(agentCLI('codex',{home,env:{PATH:bin}}).command,path.join(bin,'codex'));
  const explicit=path.join(home,'missing-explicit');
  assert.equal(agentCLI('codex',{home,env:{PATH:bin,HARNESS_CODEX_BIN:explicit}}).command,explicit);
});

test('another home and custom nvm directory discover installed versions numerically', t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'worklog-other-user-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const nvm=path.join(home,'Custom Node Install');
  for(const version of ['v9.9.0','v22.17.0','v24.1.0']) {
    const bin=path.join(nvm,'versions/node',version,'bin');fs.mkdirSync(bin,{recursive:true});
    fs.writeFileSync(path.join(bin,'worklog-cli-fixture'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  }
  const selected=agentCLI('worklog-cli-fixture',{home,env:{PATH:'/usr/bin:/bin',NVM_DIR:nvm}});
  assert.equal(selected.command,path.join(nvm,'versions/node/v24.1.0/bin/worklog-cli-fixture'));
});

test('native user CLI installs are found in a different home without nvm', t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'worklog-local-cli-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const bin=path.join(home,'.local/bin');fs.mkdirSync(bin,{recursive:true});
  fs.writeFileSync(path.join(bin,'claude'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  assert.equal(agentCLI('claude',{home,env:{PATH:'/usr/bin:/bin'}}).command,path.join(bin,'claude'));
});
