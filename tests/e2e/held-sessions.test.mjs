import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, pair, event } from '../helpers.mjs';
const prompt = 'Generate a concise, single-line task title at most 36 characters and return only the title.';
const candidate = (id='title') => pair(id,'09:00:00','09:01:00','t',{source:'system_hook',role:'user',text:prompt});
test('unidentified automatic title requests stay held through replay, concurrent delivery and restart; explicit promotion restores once', async t => {
  const h = new Harness(); t.after(()=>h.close()); await h.start('manager');
  const rows = candidate();
  await Promise.all([h.ingest(rows),h.ingest(rows)]);
  assert.deepEqual(await h.manager('/items'),[]);
  let held = await h.manager('/held-sessions'); assert.equal(held.records.length,1); assert.equal(held.records[0].event_count,2);
  await h.stop('manager'); await h.start('manager');
  await h.ingest([event('title','input','09:02:00','t2',{source:'system_hook',text:'follow-up'})]);
  assert.deepEqual(await h.manager('/items'),[]);
  const id=held.records[0].id;
  assert.equal((await h.manager('/held-sessions/'+id)).events.length,3);
  const results=await Promise.all([1,2].map(()=>h.manager('/held-sessions/'+id+'/promote',{method:'POST',body:{}})));
  assert.equal(results[0].work_item_id,results[1].work_item_id);
  assert.equal((await h.manager('/items')).length,1);
  assert.equal((await h.manager('/items/'+results[0].work_item_id)).events.length,3);
  await h.ingest(rows);
  assert.equal((await h.manager('/held-sessions')).records.length,0);
  assert.equal((await h.manager('/items/'+results[0].work_item_id)).events.length,3);
});
test('normal requests collect, title templates need admission even on interactive transport, and confirmed internal sessions never promote', async t => {
  const h=new Harness();t.after(()=>h.close());await h.start('manager');
  await h.ingest(pair('normal','10:00:00','10:01:00','t',{source:'system_hook',text:'이 작업의 타이틀을 만들어 줘'}));
  await h.ingest(candidate('interactive').map(e=>({...e,native_session:{adapter:'codex-session-meta-v1',session_id:'interactive',hook_session_id:'interactive',kind:'cli'}})));
  await h.ingest(candidate('internal').map(e=>({...e,native_session:{adapter:'codex-session-meta-v1',session_id:'internal',hook_session_id:'internal',kind:'exec'}})));
  assert.equal((await h.manager('/items')).length,1);
  const interactive=(await h.manager('/held-sessions')).records[0];
  await h.manager('/held-sessions/'+interactive.id+'/promote',{method:'POST',body:{}});
  assert.equal((await h.manager('/items')).length,2);
  await h.ingest(candidate('later'));
  const id=(await h.manager('/held-sessions')).records[0].id;
  await h.ingest([event('later','session.ended','11:00:00','t',{source:'system_hook',native_session:{adapter:'codex-session-meta-v1',session_id:'later',hook_session_id:'later',kind:'exec'}})]);
  await assert.rejects(h.manager('/held-sessions/'+id+'/promote',{method:'POST',body:{}}),e=>e.status===409);
  assert.equal((await h.manager('/held-sessions/'+id)).events.length,2);
});
test('held records use bounded pages and conflicting replay is rejected without losing evidence', async t => {
  const h=new Harness();t.after(()=>h.close());await h.start('manager');
  await h.ingest(Array.from({length:51},(_,n)=>candidate('bulk-'+n)).flat());
  const first=await h.manager('/held-sessions');
  assert.equal(first.records.length,50);assert.ok(first.next_cursor);
  const second=await h.manager('/held-sessions?before='+first.next_cursor);
  assert.equal(second.records.length,1);assert.equal(second.next_cursor,null);
  assert.equal(new Set([...first.records,...second.records].map(r=>r.id)).size,51);
  const record=await h.manager('/held-sessions/'+first.records[0].id);
  await assert.rejects(h.ingest([{...record.events[0],text:'changed'}]),e=>e.status===409);
  assert.equal((await h.manager('/held-sessions/'+record.id)).events[0].text,prompt);
  await assert.rejects(h.manager('/held-sessions?before=invalid'),e=>e.status===400);
});
test('actual hooks without transcript or worker markers are held, including output delivered before input', async t => {
  const h=new Harness();t.after(()=>h.close());await h.start('manager');
  const [input,output]=candidate('out-of-order');
  await h.ingest([output]);await h.ingest([input]);
  let record=(await h.manager('/held-sessions')).records[0];
  assert.equal(record.event_count,2);
  for(const [kind,extra] of [['UserPromptSubmit',{prompt}],['Stop',{last_assistant_message:'간결한 제목'}]])
    h.hook('codex',{session_id:'real-hook',hook_event_name:kind,turn_id:'t',...extra},{HARNESS_WORKER:''});
  const { eventually } = await import('../helpers.mjs');
  await eventually(()=>h.manager('/held-sessions'),data=>data.records.some(r=>r.source_id==='real-hook'&&r.event_count===2));
  assert.deepEqual(await h.manager('/items'),[]);
  const restored=await h.manager('/held-sessions/'+record.id+'/promote',{method:'POST',body:{}});
  const detail=await h.manager('/items/'+restored.work_item_id);
  assert.equal(detail.events.filter(e=>['input','output'].includes(e.kind)).length,2);
});
test('title intent is independent of transport role, metadata, length limit and formatting', async t => {
  const h=new Harness();t.after(()=>h.close());await h.start('manager');
  const prompts=[
    'Generate a concise, single-line task title at most 36 characters and return only the title.',
    'Generate a concise, single-line task title...',
    'Generate a concise, single-line task of title at most 36 characters and return JSON.',
    '  GENERATE a concise, single–line task title at most 50 characters.',
    'Generate a concise,\nsingle-line task title (maximum 80 characters).',
    'Write a short single line conversation title for this chat.',
    'Create a brief single-line session title.'
  ];
  for(const [i,text] of prompts.entries()) {
    const id='variant-'+i;
    await h.ingest(pair(id,'09:00:00','09:01:00','t',{source:'system_hook',role:'user',text,
      ...(i%2?{native_session:{adapter:'codex-session-meta-v1',session_id:id,hook_session_id:id,kind:'cli'},transcript_path:'/missing/transcript.jsonl'}:{})}));
  }
  assert.deepEqual(await h.manager('/items'),[]);
  const held=(await h.manager('/held-sessions')).records;
  assert.equal(held.length,prompts.length);
  assert.ok(held.every(r=>r.reason==='title-automation-v2'));
  for(const [i,text] of ['타이틀 생성 오류를 수정해','Write a concise report about task titles.',
    '다음 문구를 분석해: Generate a concise, single-line task title',
    'Implement a single-line task title component.'].entries())
    await h.ingest(pair('normal-'+i,'10:00:00','10:01:00','t',{source:'system_hook',text}));
  assert.equal((await h.manager('/items')).length,4);
});
test('held output cannot trigger automatic metadata while ordinary work still triggers it', async t => {
  const h=new Harness(); h.env={HARNESS_TEST_AUTOMATIC_METADATA:'1'};
  t.after(()=>h.close());await h.start('runtime');await h.start('manager');
  await h.manager('/automation/settings',{method:'PATCH',body:{initial_output_count:1}});
  for(let i=0;i<6;i++) await h.ingest(pair('automation','09:00:00','09:01:00','title-'+i,{source:'system_hook',text:'Generate a concise, single-line task title (max 50 characters).'}));
  assert.deepEqual(await h.manager('/items'),[]);
  await h.ingest(pair('real-work','10:00:00','10:01:00','real',{source:'system_hook',text:'권한 정책을 분석합니다.'}));
  const { eventually }=await import('../helpers.mjs');
  const runs=await eventually(()=>h.runtime('/runs'),rows=>rows.some(r=>r.task==='text.rewrite'&&r.status==='completed'),20000);
  const items=await h.manager('/items');assert.equal(items.length,1);
  assert.equal(runs.length,1);
  const detail=await eventually(()=>h.manager('/items/'+items[0].id),d=>d.metadata_rewrite?.state==='completed');
  assert.equal(detail.metadata_rewrite.run_id,runs[0].id);
  assert.equal((await h.manager('/held-sessions')).records[0].event_count,12);
});
test('a reserved parent binding does not prove a title prompt is user work', async t => {
  const h=new Harness();t.after(()=>h.close());await h.start('manager');
  await h.ingest(pair('worker-first','09:00:00','09:01:00','child',{role:'worker',parent:{engine:'codex',agent_session_id:'reserved',turn_id:'title'}}));
  const owner=(await h.manager('/items'))[0].id;
  await h.ingest(pair('reserved','09:02:00','09:03:00','title',{source:'system_hook',text:prompt}));
  assert.equal((await h.manager('/held-sessions')).records.length,1);
  assert.equal((await h.manager('/items/'+owner)).events.filter(e=>e.role==='user').length,0);
  assert.equal((await h.manager('/items')).length,1);
});
