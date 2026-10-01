import test from 'node:test';
import assert from 'node:assert/strict';
import { workStatistics } from '../../src/work-statistics.mjs';
const items = [{ id: 'a', title: '첫 업무' }, { id: 'b', title: '둘째 업무' }];
const local = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const session = (id, start, end) => ({ work_item_id: id, start_at: start, end_at: end });
test('daily and weekly time unions overlaps, clips midnight and excludes other weeks and deleted items', () => {
 const result = workStatistics(items, [session('a', local(1,23,30),local(2,0,30)), session('b',local(2,0),local(2,1)), session('a',local(2,0,10),local(2,0,20)),session('deleted',local(2,0),local(2,2)),session('a',local(20,0),local(20,1))], new Date(2026,9,2,2));
 assert.equal(result.today.seconds,3600); assert.equal(result.today.item_count,2); assert.equal(result.today.session_count,3);
 assert.equal(result.week.seconds,5400); assert.equal(result.today.items.find(i=>i.id==='a').seconds,1800);
 assert.equal(result.days.length,7); assert.equal(result.days.filter(d=>d.today).length,1);
});
test('empty and pending input-only sessions do not invent elapsed time', () => {
 const result = workStatistics(items,[session('a',local(2,0),local(2,0))],new Date(2026,9,2,10));
 assert.equal(result.today.seconds,0); assert.equal(result.today.item_count,1);
 assert.equal(workStatistics(items,[],new Date(2026,9,2)).week.seconds,0);
});
