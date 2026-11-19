import test from 'node:test';
import assert from 'node:assert/strict';
import {completeMoveBatch,restoreMoveBatch} from '../src/departmentMoveBatchRequest.ts';
const input={operationId:'batch',items:[{operationId:'one'},{operationId:'two'}]};
const batch=(status='running',results=[])=>({id:input.operationId,input,status,results});
const ok=value=>Response.json({ok:true,batch:value});
test('successful children proceed immediately with no polling or supply refresh between them',async()=>{
  const calls=[];const result=await completeMoveBatch(input,{fetcher:async(url,init)=>{calls.push({url,init});return ok(batch(calls.length===2?'complete':'running'));}});
  assert.equal(result.status,'complete');assert.equal(calls.length,2);assert.ok(calls.every(c=>c.init.method==='POST'&&c.init.body===JSON.stringify(input)));
});
test('lost response reconciles the same durable batch with GET before any continuation',async()=>{
  const calls=[];const result=await completeMoveBatch(input,{wait:async()=>{},fetcher:async(url,init)=>{calls.push(init?.method||'GET');if(calls.length===1)throw Error('lost after commit');return ok(batch('complete'));}});
  assert.equal(result.status,'complete');assert.deepEqual(calls,['POST','GET']);
});
test('a read failure during reconciliation never sends another write first',async()=>{
  const calls=[];await completeMoveBatch(input,{wait:async()=>{},fetcher:async(url,init)=>{calls.push(init?.method||'GET');if(calls.length<=2)throw Error('network');return ok(batch('complete'));}});
  assert.deepEqual(calls,['POST','GET','GET']);
});
test('busy lease retries with the same ID without polling or a new input',async()=>{
  let calls=0;await completeMoveBatch(input,{wait:async()=>{},fetcher:async(url,init)=>{assert.equal(init.body,JSON.stringify(input));return ++calls===1?Response.json({ok:false,error:'cloud_operation_busy'},{status:409}):ok(batch('complete'));}});assert.equal(calls,2);
});
test('unconfirmed child retries a bounded number of times and leaves the queue resumable',async()=>{
  let calls=0;const result=await completeMoveBatch(input,{wait:async()=>{},fetcher:async()=>{calls++;return ok(batch('checking'));}});assert.equal(result.status,'checking');assert.equal(calls,3);
});
test('pause waits for the current response and does not start another child',async()=>{
  let calls=0;const result=await completeMoveBatch(input,{shouldPause:()=>true,fetcher:async()=>{calls++;return ok(batch());}});assert.equal(result.status,'running');assert.equal(calls,1);
});
test('different server identity and denied access stop immediately',async()=>{
  await assert.rejects(completeMoveBatch(input,{fetcher:async()=>ok({...batch(),id:'different'})}),/отличается/);
  let calls=0;await assert.rejects(completeMoveBatch(input,{fetcher:async()=>{calls++;return Response.json({ok:false,error:'manager_required',message:'Denied'},{status:403});}}),/Denied/);assert.equal(calls,1);
});
test('restore finds an unfinished batch by shipment and source without writes',async()=>{
  const result=await restoreMoveBatch('test shipment','roll',async(url,init)=>{assert.ok(!init.method);assert.equal(new URL(url,'https://local').searchParams.get('sourceDepartment'),'roll');return ok(batch());});assert.equal(result.id,input.operationId);
});
