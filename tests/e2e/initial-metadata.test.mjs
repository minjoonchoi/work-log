import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, event, eventually } from '../helpers.mjs';

test('first prompt bootstraps locally; structured rewriting starts only at the configured output threshold', async t => {
  const h=new Harness();h.env={HARNESS_TEST_AUTOMATIC_METADATA:'1'};t.after(()=>h.close());
  await h.start('runtime');await h.start('manager');
  await h.manager('/automation/settings',{method:'PATCH',body:{initial_output_count:2}});
  const first=event('initial','input','09:00:00','t1',{source:'system_hook',text:'  권한 정책\n  분석을 진행해 주세요.  '});
  await h.ingest([first]);
  let item=(await h.manager('/items'))[0];
  assert.equal(item.title,'권한 정책 분석을 진행해 주세요.');
  assert.equal(item.description,'권한 정책\n  분석을 진행해 주세요.');
  await new Promise(resolve=>setTimeout(resolve,1250));
  assert.equal((await h.runtime('/runs')).length,0);
  await h.ingest([event('initial','output','09:01:00','t1',{source:'system_hook',text:'첫 응답'})]);
  await new Promise(resolve=>setTimeout(resolve,1250));
  assert.equal((await h.runtime('/runs')).length,0);
  await h.ingest([event('initial','input','09:02:00','t2',{source:'system_hook',text:'구체적인 정책을 확인해 주세요.'})]);
  assert.equal((await h.manager('/items'))[0].description,item.description);
  await h.ingest([event('initial','output','09:03:00','t2',{source:'system_hook',text:'두 번째 응답'})]);
  const detail=await eventually(()=>h.manager('/items/'+item.id),d=>d.metadata_rewrite?.state==='completed',20000);
  assert.match(detail.item.description,/h2\. 배경/);
  assert.equal((await h.runtime('/runs')).length,1);
});

test('a first prompt equal to the placeholder is initialized only once across later inputs and restart', async t => {
  const h=new Harness();t.after(()=>h.close());await h.start('manager');
  const first=event('placeholder','input','09:00:00','t1',{source:'system_hook',text:'새 작업'});
  await h.ingest([first]);await h.stop('manager');await h.start('manager');
  await h.ingest([first,event('placeholder','input','09:01:00','t2',{source:'system_hook',text:'나중 입력으로 초기 설명을 덮어쓰지 않기'})]);
  const item=(await h.manager('/items'))[0];
  assert.equal(item.title,'새 작업');assert.equal(item.description,'새 작업');assert.equal(item.version,2);
});
