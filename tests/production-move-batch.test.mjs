import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceMoveBatch,cancelMoveBatch,lookupMoveBatch,MOVE_BATCH_KIND} from '../worker/cloud/productionMoveBatch.js';
import {CloudStore} from '../worker/cloud/store.js';
import {LocalD1} from './helpers/d1-sqlite.mjs';
import {cloudSchemaStatements} from './helpers/cloud-schema.mjs';

const input = (sourceDepartment='box') => ({operationId:crypto.randomUUID(),items:['SKU-1','SKU-2','SKU-3'].map((article,i) => ({
  operationId:crypto.randomUUID(),shipmentId:'synthetic',uid:'position-'+i,article,quantity:10+i,
  machine:sourceDepartment==='box'?'2-GO':'XEROX',extension:'X',sourceDepartment,
}))});
function fixture(){const operations=new Map();return {scope:{lease:true,operations,checkpoint:async()=>{},putOperation:(kind,value)=>operations.set(kind+':'+value.id,{kind,value:structuredClone(value)})}};}
function executor(context,calls,status='verified') {return async item => {
  assert.ok(context.scope.operations.has(MOVE_BATCH_KIND+':'+context.batchId),'parent persisted before writes');
  calls.push(item.operationId);
  const child={id:item.operationId,status,input:item};
  context.scope.putOperation('production-department-move',child);return child;
};}

for(const direction of ['box','roll'])test('batch '+direction+' advances once per request, persists quantities and returns per-row results',async()=>{
  const f=fixture(),payload=input(direction),calls=[];f.batchId=payload.operationId;
  const execute=executor(f,calls);let result;
  for(let i=0;i<3;i++){result=await advanceMoveBatch(payload,f,execute);assert.equal(calls.length,i+1);assert.equal(result.results.filter(r=>r.status==='verified').length,i+1);}
  assert.equal(result.status,'complete');assert.deepEqual(result.results.map(r=>r.quantity),[10,11,12]);
  await advanceMoveBatch(payload,f,execute);assert.equal(calls.length,3,'completed batch is never replayed');
});
test('preflight rejection skips only that position and proceeds to the next article',async()=>{
  const f=fixture(),payload=input(),calls=[];f.batchId=payload.operationId;
  let result=await advanceMoveBatch(payload,f,async()=>{throw Object.assign(Error('Работа начата'),{code:'production_move_conflict'});});
  assert.equal(result.results[0].status,'skipped');assert.match(result.results[0].message,/Работа/);
  result=await advanceMoveBatch(payload,f,executor(f,calls));assert.equal(calls[0],payload.items[1].operationId);assert.equal(result.results[1].status,'verified');
});
test('uncertain child stops later articles, then resumes using the exact same operation ID',async()=>{
  const f=fixture(),payload=input(),calls=[];f.batchId=payload.operationId;
  let result=await advanceMoveBatch(payload,f,executor(f,calls,'uncertain'));
  assert.equal(result.status,'checking');assert.equal(result.results[1].status,'pending');
  result=await advanceMoveBatch(payload,f,executor(f,calls));
  assert.deepEqual(calls,[payload.items[0].operationId,payload.items[0].operationId]);
  assert.equal(result.results[0].status,'verified');assert.equal(result.results[1].status,'pending');
});
test('a conflict after a durable child exists is never skipped',async()=>{
  const f=fixture(),payload=input();f.batchId=payload.operationId;
  await advanceMoveBatch(payload,f,executor(f,[],'blocked'));
  const result=await advanceMoveBatch(payload,f,async()=>{throw Object.assign(Error('Нужна сверка'),{code:'production_move_conflict'});});
  assert.equal(result.status,'checking');assert.equal(result.results[0].status,'checking');
});
test('unknown preflight outage remains resumable instead of falsely reporting a skipped position',async()=>{
  const f=fixture(),payload=input();const result=await advanceMoveBatch(payload,f,async()=>{throw Error('Google unavailable');});
  assert.equal(result.status,'checking');assert.equal(result.results[0].status,'checking');
});
test('an old pending move is reconciled before the selected list, without marking its first article as started',async()=>{
  const f=fixture(),payload=input();f.batchId=payload.operationId;const calls=[];
  let checks=0;const old={id:crypto.randomUUID(),article:'OLD-SKU',status:'verified',message:null};
  const reconcile=async()=>++checks===1?old:null;
  let result=await advanceMoveBatch(payload,f,executor(f,calls),reconcile);
  assert.equal(calls.length,0);assert.equal(result.blocker.article,'OLD-SKU');assert.equal(result.results[0].status,'pending');assert.equal(result.status,'running');
  result=await advanceMoveBatch(payload,f,executor(f,calls),reconcile);
  assert.equal(result.blocker,null);assert.equal(result.results[0].status,'verified');assert.equal(calls.length,1);
});
test('unconfirmed old move never executes a new selected article',async()=>{
  const f=fixture(),payload=input();
  const result=await advanceMoveBatch(payload,f,()=>assert.fail('new article must wait'),async()=>({id:'old',article:'OLD-SKU',status:'uncertain',message:'Receipt unavailable'}));
  assert.equal(result.status,'checking');assert.equal(result.results[0].status,'pending');assert.equal(result.blocker.message,'Receipt unavailable');
});
test('immutable batch, duplicates, mixed supplies and mixed directions are rejected before writes',async()=>{
  const f=fixture(),payload=input();f.batchId=payload.operationId;
  await advanceMoveBatch(payload,f,executor(f,[]));
  await assert.rejects(advanceMoveBatch({...payload,items:payload.items.slice(1)},f),{code:'move_batch_conflict'});
  for(const mutate of [p=>p.items.push(p.items[0]),p=>p.items[1].shipmentId='other',p=>p.items[1].sourceDepartment='roll',p=>p.items[0].quantity=0,p=>p.items[0].extra='ignored',p=>p.items[0].operationId=p.operationId]){
    const changed=input();mutate(changed);await assert.rejects(advanceMoveBatch(changed,fixture(),()=>assert.fail('must not execute')),{code:'move_batch_invalid'});
  }
});
test('another batch for the same source is restored, never silently replaced',async()=>{
  const f=fixture(),payload=input();f.batchId=payload.operationId;
  await advanceMoveBatch(payload,f,executor(f,[]));
  assert.equal(lookupMoveBatch(f.scope,new URLSearchParams({shipmentId:'synthetic',sourceDepartment:'box'})).id,payload.operationId);
  await assert.rejects(advanceMoveBatch(input(),f),{code:'move_batch_pending'});
});
test('a child operation ID cannot be adopted from another request',async()=>{
  const f=fixture(),payload=input();f.scope.putOperation('production-department-move',{id:payload.items[0].operationId,status:'verified'});
  await assert.rejects(advanceMoveBatch(payload,f),{code:'move_batch_conflict'});
});
test('cancelling remaining positions preserves completed children and does not create writes for pending ones',async()=>{
  const f=fixture(),payload=input();f.batchId=payload.operationId;await advanceMoveBatch(payload,f,executor(f,[]));
  const result=await cancelMoveBatch(payload.operationId,f,()=>assert.fail('no pending child to cancel'));
  assert.equal(result.status,'complete');assert.deepEqual(result.results.map(r=>r.status),['verified','cancelled','cancelled']);
});
test('ambiguous child cannot be discarded by cancelling the queue',async()=>{
  const f=fixture(),payload=input();f.batchId=payload.operationId;await advanceMoveBatch(payload,f,executor(f,[],'uncertain'));
  await assert.rejects(cancelMoveBatch(payload.operationId,f,async()=>{throw Error('До записи требуется сверка');}),/сверка/);
  assert.equal(lookupMoveBatch(f.scope,new URLSearchParams({id:payload.operationId})).status,'checking');
});
test('completed child survives a failed parent checkpoint and is not copied twice',async()=>{
  const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));const store=new CloudStore(db);const payload=input();let copies=0;
  const execute=async(item,{scope})=>{
    const previous=scope.operations.get('production-department-move:'+item.operationId)?.value;if(previous)return previous;
    copies++;const child={id:item.operationId,input:item,status:'verified'};scope.putOperation('production-department-move',child);await scope.checkpoint();
    const checkpoint=scope.checkpoint.bind(scope);scope.checkpoint=async()=>{throw Error('lost parent commit');};
    return child;
  };
  try {
    // A terminated request: release the lease without the normal finally checkpoint.
    const lease=await store.acquire(),scope=await store.scope(lease);
    await assert.rejects(advanceMoveBatch(payload,{scope},execute),/lost parent commit/);await store.release(lease);
    const result=await store.withScope(scope=>advanceMoveBatch(payload,{scope},execute));
    assert.equal(result.results[0].status,'verified');assert.equal(copies,1);
  }finally{db.close();}
});
for(const direction of ['box','roll'])test('bounded groups transfer all selected members in one guarded request '+direction,async()=>{
 const f=fixture(),payload=input(direction),calls=[];f.groupSize=10;f.batchId=payload.operationId;
 const result=await advanceMoveBatch(payload,f,async request=>{const saved=f.scope.operations.get(MOVE_BATCH_KIND+':'+payload.operationId).value;assert.equal(saved.group.ids.length,3);assert.deepEqual(request.items,payload.items);return executor(f,calls)(request);});
 assert.equal(calls.length,1);assert.equal(result.status,'complete');assert.ok(result.results.every(r=>r.status==='verified'));assert.deepEqual(result.results.map(r=>r.quantity),[10,11,12]);
 await advanceMoveBatch(payload,f,()=>assert.fail('no replay'));
});
test('group preflight rejection identifies only the failed member and leaves the rest pending',async()=>{
 const f=fixture(),payload=input();f.groupSize=10;f.batchId=payload.operationId;
 let result=await advanceMoveBatch(payload,f,async()=>{throw Object.assign(Error('Second already started'),{code:'production_move_conflict',itemOperationId:payload.items[1].operationId});});
 assert.deepEqual(result.results.map(r=>r.status),['pending','skipped','pending']);
 result=await advanceMoveBatch(payload,f,async request=>{assert.deepEqual(request.items.map(p=>p.article),['SKU-1','SKU-3']);return executor(f,[])(request);});
 assert.equal(result.status,'complete');assert.deepEqual(result.results.map(r=>r.status),['verified','skipped','verified']);
});
test('uncertain group retains its members and ID even when grouping is subsequently disabled',async()=>{
 const f=fixture(),payload=input(),calls=[];f.groupSize=10;f.batchId=payload.operationId;
 await advanceMoveBatch(payload,f,executor(f,calls,'uncertain'));f.groupSize=1;
 const result=await advanceMoveBatch(payload,f,async request=>{assert.equal(request.items.length,3);return executor(f,calls)(request);});assert.equal(result.status,'complete');assert.deepEqual(calls,[payload.items[0].operationId,payload.items[0].operationId]);
});
test('completed group survives a lost parent checkpoint and neither replays nor cancels remaining members',async()=>{
 for(const action of ['resume','cancel']){
 const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));const store=new CloudStore(db),payload=input();let copies=0;
 const execute=async(request,{scope})=>{copies++;assert.equal(request.items.length,3);const child={id:request.operationId,input:request,status:'verified'};scope.putOperation('production-department-move',child);await scope.checkpoint();scope.checkpoint=async()=>{throw Error('lost parent commit');};return child;};
 try{const lease=await store.acquire(),scope=await store.scope(lease);await assert.rejects(advanceMoveBatch(payload,{scope,groupSize:10},execute),/lost parent/);await store.release(lease);
 const result=await store.withScope(scope=>action==='resume'?advanceMoveBatch(payload,{scope,groupSize:10},()=>assert.fail('no copy')):cancelMoveBatch(payload.operationId,{scope},()=>assert.fail('no cancel')));
 assert.equal(result.status,'complete');assert.ok(result.results.every(r=>r.status==='verified'));assert.equal(copies,1);
 }finally{db.close();}
 }
});
