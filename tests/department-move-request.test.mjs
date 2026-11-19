import test from 'node:test';
import assert from 'node:assert/strict';
import {completeDepartmentMove,restoreDepartmentMove} from '../src/departmentMoveRequest.ts';
import {runDepartmentMove} from '../agent/departmentMove.js';

const input={operationId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',shipmentId:'supply',uid:'position',article:'SYNTHETIC',quantity:20,machine:'XEROX',extension:'X',sourceDepartment:'roll'};
const operation=(status,extra={})=>({id:input.operationId,status,input,...extra});
const ok=op=>Response.json({ok:true,operation:op});
const busy=()=>Response.json({ok:false,error:'cloud_operation_busy',message:'Другая операция ещё выполняется.'},{status:409});
function clock(){let at=0;return {now:()=>at,wait:async ms=>{at+=ms;}};}

test('temporary lease conflicts continue automatically with the same immutable ID',async()=>{
 const calls=[],messages=[];let count=0;
 const result=await completeDepartmentMove(input,{...clock(),onProgress:p=>messages.push(p.message),fetcher:async(url,init)=>{
  calls.push({url,body:init.body});return ++count<=2?busy():ok(operation('verified'));
 }});
 assert.equal(result.status,'verified');assert.equal(calls.length,3);
 assert.ok(calls.every(c=>c.url==='/api/production-moves'&&c.body===JSON.stringify(input)));
 assert.ok(messages.some(m=>m.includes('автоматически')));
});

test('lost successful response checks durable status and does not send a second POST',async()=>{
 const calls=[];
 const result=await completeDepartmentMove(input,{...clock(),fetcher:async(url,init)=>{
  calls.push({url,method:init?.method||'GET'});
  if(calls.length===1)throw new TypeError('Network lost after commit');
  return ok(operation('verified'));
 }});
 assert.equal(result.status,'verified');assert.deepEqual(calls.map(c=>c.method),['POST','GET']);assert.match(calls[1].url,/id=aaaaaaaa/);
});

test('unavailable status after lost response is retried read-only before continuation',async()=>{
 const calls=[];
 const result=await completeDepartmentMove(input,{...clock(),fetcher:async(url,init)=>{
  calls.push(init?.method||'GET');
  if(calls.length<3)throw Error('Offline');
  return ok(operation('verified'));
 }});
 assert.equal(result.status,'verified');assert.deepEqual(calls,['POST','GET','GET']);
});

test('uncertain destination is recovered by the real coordinator without a second copy',async()=>{
 const records=new Map();let copies=0,removed=false,frozen=false,published=false;
 const deps={store:{get:async id=>structuredClone(records.get(id)),put:async op=>records.set(op.id,structuredClone(op))},
  source:{inspect:async()=>({...input,department:'roll',workConfirmed:true,hasWork:false}),verifyUnstarted:async()=>true,remove:async()=>{removed=true;},verifyRemoved:async()=>removed},
  destination:{exists:async()=>false,write:async()=>{copies++;throw Error('Lost Google response after copy');},verify:async()=>copies===1},
  coordinator:{freeze:async()=>{frozen=true;},isFrozen:async()=>frozen,publish:async()=>{published=true;},verifyPublished:async()=>published}};
 const ids=[];
 const result=await completeDepartmentMove(input,{...clock(),fetcher:async(url,init)=>{
  if(init?.method!=='POST')return ok(records.get(input.operationId));
  const received=JSON.parse(init.body);ids.push(received.operationId);return ok(await runDepartmentMove(received,deps));
 }});
 assert.equal(result.status,'verified');assert.equal(copies,1);assert.equal(removed,true);assert.equal(published,true);
 assert.deepEqual(ids,[input.operationId,input.operationId]);
});

test('unconfirmed destination remains protected after bounded automatic reconciliation',async()=>{
 let posts=0;
 const result=await completeDepartmentMove(input,{...clock(),fetcher:async(_,init)=>{
  if(init?.method==='POST')posts++;
  return ok(operation('uncertain',{steps:{destination:'uncertain'},message:'Нет подтверждения записи'}));
 }});
 assert.equal(result.status,'uncertain');assert.equal(posts,3);
});

test('work conflict, authentication failure and changed input are never automatically repeated',async()=>{
 for(const [status,error] of [[409,'production_move_conflict'],[403,'owner_required'],[409,'move_position_changed']]){
  let calls=0;await assert.rejects(completeDepartmentMove(input,{...clock(),fetcher:async()=>{calls++;return Response.json({ok:false,error,message:'Stop'},{status});}}),{code:error});
  assert.equal(calls,1);
 }
 let calls=0;assert.equal((await completeDepartmentMove(input,{...clock(),fetcher:async()=>{calls++;return ok(operation('blocked'));}})).status,'blocked');assert.equal(calls,1);
});

test('busy timeout never overrides the production lease or changes the operation ID',async()=>{
 let calls=0;await assert.rejects(completeDepartmentMove(input,{...clock(),timeoutMs:3500,fetcher:async(_,init)=>{calls++;assert.equal(JSON.parse(init.body).operationId,input.operationId);return busy();}}),{code:'move_wait_timeout'});
 assert.equal(calls,2);
});

test('wrong server operation cannot be used to continue a transfer',async()=>{
 await assert.rejects(completeDepartmentMove(input,{...clock(),fetcher:async()=>ok({...operation('verified'),id:'other'})}),{code:'move_identity_changed'});
});

test('completed or missing browser ID does not block the next article; pending position is restored from server',async()=>{
 for(const previous of [operation('verified',{input:{...input,article:'OLD',uid:'old'}}),operation('cancelled'),null]){
  const urls=[];const found=operation('uncertain');
  const result=await restoreDepartmentMove(input,'old-browser-id',async url=>{urls.push(url);return ok(urls.length===1?previous:found);});
  assert.equal(result.id,input.operationId);assert.equal(urls.length,2);assert.match(urls[1],/article=SYNTHETIC/);
 }
});

test('another unresolved transfer is never adopted for this position',async()=>{
 let calls=0;
 const result=await restoreDepartmentMove(input,'pending',async()=>ok(++calls===1?operation('uncertain',{input:{...input,uid:'other',article:'OTHER'}}):null));
 assert.equal(result,null);assert.equal(calls,2);
 await assert.rejects(restoreDepartmentMove(input,null,async()=>ok(operation('uncertain',{input:{...input,quantity:21}}))),{code:'move_position_changed'});
});
