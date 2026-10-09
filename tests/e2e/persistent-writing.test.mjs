import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execute } from '../../src/executor.mjs';
import { closeWritingProcess } from '../../src/writing-process.mjs';
import { Harness } from '../helpers.mjs';
import { parseTextRewrite, parseWorkReport, parseResultSummary } from '../../src/stored-writing.mjs';

function mockCLI(dir) {
  const file=path.join(dir,'cli.cjs');
  fs.writeFileSync(file, `#!${process.execPath}
const fs=require('node:fs'),rl=require('node:readline');
const args=process.argv.slice(2), codex=args[0]==='app-server';
if(codex && (args.includes('--ignore-user-config') || args.includes('--ephemeral')))process.exit(9);
if(args.includes('--json-schema')||args.includes('--output-schema')) { console.error('structured output is not supported');process.exit(9); }
fs.appendFileSync(${JSON.stringify(path.join(dir,'starts'))},process.pid+'\\n');
let index=0, active=false;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const result=(text,thread)=>{
 if(active){process.exit(10);}active=true;
 if(text==='HANG')return;
 setTimeout(()=>{
  if(text==='CRASH')process.exit(12);
  if(text==='TOOL') { emit(codex?{method:'item/started',params:{threadId:thread,item:{type:'commandExecution'}}}:{type:'assistant',message:{content:[{type:'tool_use',name:'Bash'}]}});return; }
  const value='제목 '+(++index)+'\\n'+text+'\\n그대로 보존할 본문';
  if(codex){
   emit({method:'item/completed',params:{threadId:thread,item:{type:'agentMessage',phase:'commentary',text:'저장하면 안 되는 진행 메시지'}}});
   emit({method:'item/completed',params:{threadId:thread,item:{type:'agentMessage',phase:'final_answer',text:value}}});
   emit({method:'turn/completed',params:{threadId:thread,turn:{status:'completed'}}});
  }else{
   emit({type:'assistant',message:{content:[{type:'text',text:'진행 메시지'}]}});
   emit({type:'result',is_error:text==='FAIL',result:value,session_id:'fixture-session',num_turns:1});
  }
  active=false;
 },60);
};
rl.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 if(!codex){result(msg.message.content);return;}
 if(msg.method==='initialize')emit({id:msg.id,result:{}});
 if(msg.method==='thread/start')emit({id:msg.id,result:{thread:{id:'thread-'+(index+1)}}});
 if(msg.method==='turn/start'){
  if(msg.params.outputSchema)process.exit(9);
  emit({id:msg.id,result:{turn:{id:'turn'}}});result(msg.params.input[0].text,msg.params.threadId);
 }
});
`,{mode:0o755});
  return file;
}
async function setup(t,engine) {
  await closeWritingProcess();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'worklog-persistent-test-')), cli=mockCLI(dir);
  const key=`HARNESS_${engine.toUpperCase()}_BIN`, previous=process.env[key];process.env[key]=cli;
  t.after(async()=>{await closeWritingProcess();if(previous===undefined)delete process.env[key];else process.env[key]=previous;fs.rmSync(dir,{recursive:true,force:true});});
  let index=0;
  const run=(prompt,timeoutMs=3000)=>{
    const attemptDir=path.join(dir,'attempt-'+(++index)),cwd=path.join(attemptDir,'workspace');fs.mkdirSync(cwd,{recursive:true});
    return execute({engine,cwd,attemptDir,stage:'produce',prompt,dataDir:dir,plainText:true,
      parent:{run_id:'run-'+index,task_id:'attempt-'+index},limits:{timeoutMs,maxOutputBytes:100000},
      workerPolicy:{mode:'direct',max_tool_calls:0,max_model_turns:1},
      execution:engine==='codex'?{model:'gpt-5.6-luna',effort:'high'}:{model:'sonnet',effort:'low'}});
  };
  return {dir,run};
}
for(const engine of ['codex','claude']) {
  test(`${engine}: two plain writing requests reuse the same subprocess and preserve final text`,async t=>{
    const {dir,run}=await setup(t,engine);
    const first=await run('첫 대상').promise,second=await run('두 번째 대상').promise;
    assert.equal(first.ok,true,JSON.stringify(first.observation));assert.equal(second.ok,true,JSON.stringify(second.observation));
    assert.equal(first.observation.pid,second.observation.pid);
    assert.equal(fs.readFileSync(path.join(dir,'starts'),'utf8').trim().split('\n').length,1);
    assert.equal(first.result.result.content,'제목 1\n첫 대상\n그대로 보존할 본문');
    assert.equal(second.result.result.content,'제목 2\n두 번째 대상\n그대로 보존할 본문');
    assert.equal(second.observation.termination_confirmed,null);
  });
  test(`${engine}: timeout stops the old process before the next request; tools are rejected`,async t=>{
    const {run}=await setup(t,engine);
    const hung=await run('HANG',200).promise;assert.equal(hung.ok,false);assert.equal(hung.observation.reason,'timeout');
    assert.equal(hung.observation.termination_confirmed,true);
    const next=await run('다음 대상').promise;assert.equal(next.ok,true,JSON.stringify(next.observation));assert.notEqual(next.observation.pid,hung.observation.pid);
    const tool=await run('TOOL').promise;assert.equal(tool.ok,false);assert.equal(tool.observation.reason,'worker_tool_limit');
  });
}
test('plain text storage splits only the title and preserves body and source associations',()=>{
  const text='새 제목\n\n## 본문\n한글 "따옴표"와 {일반 텍스트}\n- 결과';
  assert.deepEqual(parseTextRewrite(text,'work-item-metadata'),{title:'새 제목',description:'\n## 본문\n한글 "따옴표"와 {일반 텍스트}\n- 결과'});
  const report=parseWorkReport(text,{stage:'sessions',sessions:[{id:'original'}]});
  assert.equal(report.body,parseTextRewrite(text).description);assert.deepEqual(report.source_refs,['session:original']);
  assert.deepEqual(parseResultSummary('완료한 결과 그대로'),{text:'완료한 결과 그대로'});
  assert.deepEqual(parseTextRewrite('{"title":"이전","description":"기존 본문"}'),{title:'이전',description:'기존 본문'});
});
test('runtime submits queued summaries serially through one Codex subprocess',async t=>{
  const h=new Harness(),cli=mockCLI(h.dir);h.env={HARNESS_CODEX_BIN:cli};
  t.after(()=>h.close());await h.start('runtime');
  const runs=await Promise.all([1,2,3].map(i=>h.run({task:'session.summarize',engine:'codex',internal:true,
    input:{title:'제목 '+i,events:[{kind:'input',event_at:'2026-10-09T01:00:00Z',text:'대상 '+i}]}})));
  const done=await Promise.all(runs.map(row=>h.finish(row)));
  assert.ok(done.every(row=>row.status==='completed'),JSON.stringify(done.map(row=>row.message)));
  const pids=done.map(row=>row.attempts[0].pid);assert.equal(new Set(pids).size,1);
  assert.equal(fs.readFileSync(path.join(h.dir,'starts'),'utf8').trim().split('\n').length,1);
  for(const row of done){const body=fs.readFileSync(row.artifact.file,'utf8');assert.ok(body.startsWith('제목 '));assert.ok(!body.startsWith('{'));}
});
