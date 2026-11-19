import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateStockWatch,formatStockCompletion} from '../worker/cloud/arkadyStockWatch.js';
import {stockNotificationBatches} from '../worker/cloud/stockHistory.js';

const now=Date.parse('2026-11-13T11:00:00Z'),startedAt='2026-11-13T10:00:00Z';
const operation=(id,items=[{article:'A1',quantity:32},{article:'B1',quantity:10}],date='2026-11-13T10:05:00Z')=>({kind:'stock',value:{id,status:'verified',createdAt:date,destination:'urgent',manager:'Кирилл',steps:['roll','box'].flatMap(department=>{
  const entries=items.map((item,i)=>({...item,department:item.department||'box',row:i+5,uid:item.uid||`${id}-u${i}`,newQuantity:item.newQuantity??item.quantity})).filter(item=>item.department===department);
  return entries.length?[{department,status:'verified',plan:{sheetId:department==='box'?7:8,entries}}]:[];
})}});
const batches=(...ops)=>stockNotificationBatches(ops,now);
const history=items=>items.flatMap(batch=>batch.entries.map(entry=>({id:entry.id,article:entry.article,department:entry.department,destination:batch.destination,currentPlan:entry.plannedQuantity,print:'done',cut:'done'})));
const evaluate=(items,rows,extra={})=>evaluateStockWatch({batches:items,history:rows,startedAt,now,...extra});

test('two articles from one upload notify once only after the last print and cut finish',()=>{
  const list=batches(operation('one')),rows=history(list),partial=structuredClone(rows);partial[1].cut='partial';
  const before=evaluate(list,partial);assert.equal(before.events.length,0);
  const ready=evaluate(list,rows,{previous:before.state});assert.equal(ready.events.length,1);assert.equal(ready.events[0].id,'stock-batch:one:complete');
  assert.equal(ready.events[0].quantity,42);assert.deepEqual(ready.events[0].sections[0].entries,[{article:'A1',quantity:32},{article:'B1',quantity:10}]);
  const again=evaluate(list,rows,{previous:ready.state});assert.equal(again.events.length,0);
  const regression=evaluate(list,partial,{previous:again.state});assert.equal(evaluate(list,rows,{previous:regression.state}).events.length,0);
});

test('one upload across box and roll waits for both departments and includes both exact sheet links',()=>{
  const list=batches(operation('mixed',[{article:'ROLL001',quantity:20,department:'roll'},{article:'BOX001',quantity:32}])),rows=history(list);
  const partial=structuredClone(rows);partial[0].print='done';partial[0].cut='not_started';assert.equal(evaluate(list,partial).events.length,0);
  const [event]=evaluate(list,rows).events;assert.equal(event.sections.length,2);
  const body=formatStockCompletion(event,{documentIds:{box:'stock-box',roll:'stock-roll'},joke:'Молодцы!'});
  assert.match(body,/ПЕЧАТЬ И ПОРЕЗКА ЗАВЕРШЕНЫ/);assert.match(body,/Весь список готов/);assert.match(body,/ROLL001[\s\S]*20 шт\./);assert.match(body,/BOX001[\s\S]*32 шт\./);
  assert.match(body,/stock-roll\/edit#gid=8/);assert.match(body,/stock-box\/edit#gid=7/);assert.match(body,/Кирилл|Молодцы/);
});

test('independent uploads on the same destination sheet finish independently',()=>{
  const list=batches(operation('one'),operation('two',[{article:'C1',quantity:4}])),rows=history(list);rows[2].cut='not_started';
  const one=evaluate(list,rows);assert.deepEqual(one.events.map(event=>event.batchId),['one']);
  rows[2].cut='done';const two=evaluate(list,rows,{previous:one.state});assert.deepEqual(two.events.map(event=>event.batchId),['two']);
});

test('a missing or unknown member blocks the whole upload and never becomes a smaller ready list',()=>{
  const list=batches(operation('one')),rows=history(list),unknown=structuredClone(rows);unknown[1].print='unknown';
  assert.equal(evaluate(list,rows.slice(0,1)).events.length,0);const waiting=evaluate(list,unknown);assert.equal(waiting.events.length,0);
  assert.equal(evaluate(list,rows,{previous:waiting.state}).events.length,1);
  const foreign=structuredClone(rows);foreign[1].destination='warehouse';assert.equal(evaluate(list,foreign).events.length,0);
});

test('history page truncation never truncates the committed notification membership',()=>{
  const list=batches(operation('long',Array.from({length:60},(_,i)=>({article:`A${i}`,quantity:1}))));
  assert.equal(list[0].entries.length,60);assert.equal(evaluate(list,history(list).slice(0,40)).events.length,0);
});

test('unknown or malformed upload membership stays unconfirmed',()=>{
  const op=operation('one');op.value.steps[0].plan.entries[1].uid=null;const invalid=batches(op);
  assert.equal(invalid[0].valid,false);assert.equal(evaluate(invalid,history(invalid)).events.length,0);
  op.value.status='uncertain';assert.equal(batches(op).length,0);
});

test('already finished historical uploads are silent but newly added ready uploads are not missed',()=>{
  const list=batches(operation('one'));
  const baseline=evaluate(list,history(list),{startedAt:null});assert.equal(baseline.events.length,0);
  assert.equal(evaluate(list,history(list),{previous:baseline.state,startedAt:baseline.startedAt}).events.length,0);
  assert.equal(evaluate(list,history(list)).events.length,1);
  const unknown=history(list).map(row=>({...row,print:'unknown',cut:'unknown'}));const old=evaluate(list,unknown,{startedAt:null});
  assert.equal(evaluate(list,history(list),{previous:old.state,startedAt:old.startedAt}).events.length,0);
});

test('existing unfinished upload continues tracking after migration and after a source outage',()=>{
  const list=batches(operation('one')),rows=history(list);rows[1].print='not_started';
  const baseline=evaluate(list,rows,{startedAt:null});assert.equal(baseline.events.length,0);
  const outage=evaluate(list,[],{previous:baseline.state,startedAt:baseline.startedAt});assert.equal(outage.events.length,0);
  assert.equal(evaluate(list,history(list),{previous:outage.state,startedAt:baseline.startedAt}).events.length,1);
});

test('archived completed members remain part of an unfinished upload',()=>{
  const list=batches(operation('one')),rows=history(list);rows[0]={...rows[0],status:'closed',currentPlan:null};rows[1].cut='partial';
  const waiting=evaluate(list,rows);assert.equal(waiting.events.length,0);rows[1].cut='done';
  assert.equal(evaluate(list,rows,{previous:waiting.state}).events.length,1);
});

test('overlapping additions use separate upload IDs and report added quantities, not the aggregate position plan',()=>{
  const list=batches(operation('one',[{article:'A1',quantity:30,uid:'shared'}]),operation('two',[{article:'A1',quantity:15,uid:'shared',newQuantity:45}]));
  const rows=history(list).map(row=>({...row,currentPlan:45}));const ready=evaluate(list,rows);
  assert.deepEqual(ready.events.map(event=>event.quantity),[30,15]);assert.equal(evaluate(list,rows,{previous:ready.state}).events.length,0);
  const stale=structuredClone(rows);stale[1].currentPlan=30;assert.deepEqual(evaluate(list,stale).events.map(event=>event.batchId),['one']);
});

test('reusing a committed batch ID with changed membership cannot announce completion',()=>{
  const list=batches(operation('one')),rows=history(list);rows[1].cut='partial';const waiting=evaluate(list,rows);
  const changed=batches(operation('one',[{article:'A1',quantity:32}]));assert.equal(evaluate(changed,history(changed),{previous:waiting.state}).events.length,0);
});

test('the specific historical KS0013.A7986 assignment stays silent; later uploads remain eligible',()=>{
  const old=batches(operation('old',[{article:'KS0013.A7986',quantity:300}],'2026-11-06T13:28:00Z'));
  assert.equal(evaluate(old,history(old),{startedAt:'2026-11-01T00:00:00Z'}).events.length,0);
  const next=batches(operation('new',[{article:'KS0013.A7986',quantity:300}]));assert.equal(evaluate(next,history(next)).events.length,1);
});
