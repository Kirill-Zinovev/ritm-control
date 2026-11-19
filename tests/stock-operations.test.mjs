import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {StockOperations} from '../agent/stockOperations.js';

function fixture(){
 const saved=new Map(),writes=[],checkpoints=[];
 const store={get:id=>saved.get(id),put:op=>saved.set(op.id,structuredClone(op)),pending:()=>[...saved.values()].filter(op=>!['verified','not_saved'].includes(op.status))};
 const create=department=>({read:async()=>[],prepare:async(destination,changes)=>({destination,changes,entries:changes.map((change,index)=>({...change,uid:`test-uid-${index}`}))}),write:async plan=>writes.push({department,plan}),verify:async()=>true});
 const adapters={box:create('box'),roll:create('roll')};
 const catalog=async()=>({OZON:[['Артикул','','Станок'],['A','A','XEROX'],['B','B','2-GO']],WB:[['Артикул','Вид станка по умолчанию']],extensions:[['Артикул','Расширение печати'],['B','UF']]});
 const service=new StockOperations({store,adapters,catalog,checkpoint:async()=>checkpoints.push([...saved.values()].map(x=>x.status+':'+x.steps.map(s=>s.status).join(',')))});
 return {service,adapters,writes,checkpoints,saved};
}
test('a Xerox fraction requires approval and only applies the option confirmed for that article', async () => {
  for (const [direction, quantity, newQuantity, sheets] of [['down',18,218,545],['up',20,220,550]]) {
    const f = fixture();
    f.adapters.box.read = async () => [{row:5,article:'A',quantity:200,xerox:{factor:20,multiplicity:8}}];
    const input = {destination:'warehouse',lines:[{article:'A',quantity:19}]};
    const preview = await f.service.preview(input);
    assert.deepEqual(preview.changes[0].rounding.choices,[
      {direction:'down',quantity:18,newQuantity:218,sheets:545},
      {direction:'up',quantity:20,newQuantity:220,sheets:550},
    ]);
    const request = {operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint};
    await assert.rejects(f.service.execute(request), {code:'stock_rounding_required'});
    assert.equal(f.saved.size,0);
    assert.equal(f.writes.length,0);
    const confirmed = {...request,input:{...input,rounding:[{article:'A',direction}]}};
    assert.equal((await f.service.execute(confirmed)).status,'verified');
    const [entry] = f.writes[0].plan.entries;
    assert.equal(entry.quantity,quantity);
    assert.equal(entry.newQuantity,newQuantity);
    assert.equal(entry.xeroxRoundingProof.sheets,sheets);
    assert.equal((await f.service.execute(confirmed)).status,'verified');
    assert.equal(f.writes.length,1);
  }
});
test('changed Xerox norms require a fresh preview and rounding down by one never removes stock', async () => {
  const f = fixture();
  let factor = 20;
  f.adapters.box.read = async () => [{row:5,article:'A',quantity:200,xerox:{factor,multiplicity:8}}];
  const input = {destination:'warehouse',lines:[{article:'A',quantity:1},{article:'B',quantity:10}]};
  const preview = await f.service.preview(input);
  assert.equal(preview.changes[0].rounding.choices[0].quantity,0);
  const request = {operationId:randomUUID(),input:{...input,rounding:[{article:'A',direction:'down'}]},expectedFingerprint:preview.fingerprint};
  factor = 12;
  await assert.rejects(f.service.execute(request), {code:'stock_preview_changed'});
  assert.equal(f.writes.length,0);
  factor = 20;
  assert.equal((await f.service.execute(request)).status,'verified');
  assert.deepEqual(f.writes.map(row=>row.department),['roll']);
});
test('both departments are prepared and journaled before any write, retries do not double count',async()=>{
 const f=fixture(),input={destination:'warehouse',lines:[{article:'A',quantity:5},{article:'B',quantity:6}]};
 const preview=await f.service.preview(input),request={operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint};
 const result=await f.service.execute(request);assert.equal(result.status,'verified');assert.equal(f.writes.length,2);
 assert.ok(f.checkpoints.some(s=>s.some(x=>x.includes('writing'))));
 assert.equal((await f.service.execute(request)).status,'verified');assert.equal(f.writes.length,2);
});
test('a confirmed preflight failure before the first write does not block the next attempt',async()=>{
 const f=fixture(),input={destination:'urgent',lines:[{article:'A',quantity:5}]},preview=await f.service.preview(input);
 f.adapters.box.write=async()=>{throw Object.assign(new Error('changed'),{beforeExternalWrite:true});};
 assert.equal((await f.service.execute({operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint})).status,'not_saved');
 f.adapters.box.write=async()=>f.writes.push('saved');
 assert.equal((await f.service.execute({operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint})).status,'verified');
});
test('changed plans stop before writing; a lost response is never replayed',async()=>{
 const f=fixture(),input={destination:'urgent',lines:[{article:'A',quantity:5}]},preview=await f.service.preview(input);
 await assert.rejects(f.service.execute({operationId:randomUUID(),input,expectedFingerprint:'stale'}),/изменились/);assert.equal(f.writes.length,0);
 f.adapters.box.write=async()=>{f.writes.push('sent');throw new Error('lost response');};
 f.adapters.box.verify=async()=>false;
 const request={operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint};
 assert.equal((await f.service.execute(request)).status,'uncertain');assert.equal((await f.service.execute(request)).status,'uncertain');assert.equal(f.writes.length,1);
 await assert.rejects(f.service.execute({...request,operationId:randomUUID()}),/Предыдущая операция/);assert.equal(f.writes.length,1);
});
test('lost response is reconciled from source without writing again',async()=>{
 const f=fixture(),input={destination:'urgent',lines:[{article:'A',quantity:5}]},preview=await f.service.preview(input);
 f.adapters.box.write=async()=>{f.writes.push('sent');throw new Error('lost response');};
 let checks=0;f.adapters.box.verify=async()=>++checks>1;
 const request={operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint};
 assert.equal((await f.service.execute(request)).status,'uncertain');
 assert.equal((await f.service.execute(request)).status,'verified');assert.equal(f.writes.length,1);
});
test('lost insert reply confirmed immediately without replay or manual verification',async()=>{
 const f=fixture(),input={destination:'urgent',lines:[{article:'A',quantity:5}]},preview=await f.service.preview(input);
 f.adapters.box.write=async()=>{f.writes.push('sent');throw new Error('lost response');};
 assert.equal((await f.service.execute({operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint})).status,'verified');
 assert.equal(f.writes.length,1);
});
test('a new session confirms an older insert before adding an unrelated article',async()=>{
 const f=fixture(),old={destination:'urgent',lines:[{article:'A',quantity:5}]},preview=await f.service.preview(old);
 f.adapters.box.write=async()=>{f.writes.push('sent');throw new Error('lost response');};
 let checks=0;f.adapters.box.verify=async()=>++checks>1;
 assert.equal((await f.service.execute({operationId:randomUUID(),input:old,expectedFingerprint:preview.fingerprint})).status,'uncertain');
 const fresh={destination:'urgent',lines:[{article:'B',quantity:6}]},next=await f.service.preview(fresh);
 assert.equal((await f.service.execute({operationId:randomUUID(),input:fresh,expectedFingerprint:next.fingerprint})).status,'verified');
 assert.deepEqual(f.writes.map(x=>typeof x==='string'?x:x.department),['sent','roll']);
});
test('reconciled insert is not accidentally re-added by a new session',async()=>{
 const f=fixture(),input={destination:'urgent',lines:[{article:'A',quantity:5}]},preview=await f.service.preview(input);
 f.adapters.box.write=async()=>{f.writes.push('sent');throw new Error('lost response');};
 let checks=0;f.adapters.box.verify=async()=>++checks>1;
 await f.service.execute({operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint});
 await assert.rejects(f.service.execute({operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint}),/Предыдущая запись/);
 assert.equal(f.writes.length,1);
});
test('a new session cannot clear an uncertain increase without its original request',async()=>{
 const f=fixture(),input={destination:'urgent',lines:[{article:'A',quantity:5}]};
 f.adapters.box.read=async()=>[{row:5,article:'A',quantity:10}];
 const preview=await f.service.preview(input);
 f.adapters.box.write=async()=>{throw new Error('lost response');};
 await f.service.execute({operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint});
 await assert.rejects(f.service.execute({operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint}),/Предыдущая операция/);
});

test('a verified receipt resumes only the untouched department of the original mixed request',async()=>{
 const f=fixture(),input={destination:'warehouse',lines:[{article:'A',quantity:5},{article:'B',quantity:6}]};
 f.adapters.roll.read=async()=>[{row:5,article:'B',quantity:10}];
 const preview=await f.service.preview(input),request={operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint};
 f.adapters.roll.write=async(_plan,id)=>{f.writes.push({department:'roll',id});throw new Error('lost reply');};
 f.adapters.roll.inspect=async(_plan,id)=>{assert.equal(id,request.operationId);return {status:'verified'};};
 f.adapters.box.write=async(_plan,id)=>{f.writes.push({department:'box',id});};
 assert.equal((await f.service.execute(request)).status,'uncertain');
 assert.deepEqual(f.writes.map(x=>x.department),['roll']);
 const done=await f.service.execute(request);
 assert.equal(done.status,'verified');assert.deepEqual(done.steps.map(x=>x.status),['verified','verified']);
 assert.deepEqual(f.writes.map(x=>x.department),['roll','box']);
 assert.ok(f.writes.every(x=>x.id===request.operationId));
 assert.equal((await f.service.execute(request)).status,'verified');assert.equal(f.writes.length,2);
});

test('an absent receipt and unchanged preflight can retry the same original ID only',async()=>{
 const f=fixture(),input={destination:'urgent',lines:[{article:'A',quantity:5}]};
 f.adapters.box.read=async()=>[{row:5,article:'A',quantity:10}];
 const preview=await f.service.preview(input),request={operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint};
 let calls=0;f.adapters.box.write=async(_plan,id)=>{f.writes.push(id);if(++calls===1)throw new Error('request not delivered');};
 f.adapters.box.inspect=async(_plan,id)=>{assert.equal(id,request.operationId);return {status:'validated'};};
 assert.equal((await f.service.execute(request)).status,'uncertain');
 assert.equal((await f.service.execute(request)).status,'verified');
 assert.deepEqual(f.writes,[request.operationId,request.operationId]);
});

test('an ambiguous increase cannot advance or write the next department',async()=>{
 const f=fixture(),input={destination:'warehouse',lines:[{article:'A',quantity:5},{article:'B',quantity:6}]};
 f.adapters.roll.read=async()=>[{row:5,article:'B',quantity:10}];
 const preview=await f.service.preview(input),request={operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint};
 f.adapters.roll.write=async()=>{f.writes.push('roll');throw new Error('lost reply');};
 f.adapters.roll.inspect=async()=>({status:'uncertain'});
 let checks=0;f.adapters.roll.verify=async()=>{checks++;return true;};
 assert.equal((await f.service.execute(request)).status,'uncertain');
 assert.equal((await f.service.execute(request)).status,'uncertain');
 assert.equal(checks,0);assert.deepEqual(f.writes,['roll']);
});

test('failed retry preflight after an uncertain dispatch never clears the original request',async()=>{
 const f=fixture(),input={destination:'urgent',lines:[{article:'A',quantity:5}]};
 f.adapters.box.read=async()=>[{row:5,article:'A',quantity:10}];
 const preview=await f.service.preview(input),request={operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint};
 let calls=0;f.adapters.box.write=async()=>{if(++calls===1)throw new Error('request may still be in flight');throw Object.assign(new Error('changed'),{beforeExternalWrite:true});};
 f.adapters.box.inspect=async()=>({status:'validated'});
 assert.equal((await f.service.execute(request)).status,'uncertain');
 const retry=await f.service.execute(request);
 assert.equal(retry.status,'uncertain');assert.equal(retry.steps[0].status,'uncertain');
 await assert.rejects(f.service.execute({...request,operationId:randomUUID()}),/Предыдущая операция/);
});

test('a preflight failure after a verified department never frees the whole batch',async()=>{
 const f=fixture(),input={destination:'warehouse',lines:[{article:'A',quantity:5},{article:'B',quantity:6}]};
 const preview=await f.service.preview(input),request={operationId:randomUUID(),input,expectedFingerprint:preview.fingerprint};
 f.adapters.box.write=async()=>{throw Object.assign(new Error('changed'),{beforeExternalWrite:true});};
 const partial=await f.service.execute(request);
 assert.equal(partial.status,'uncertain');assert.deepEqual(partial.steps.map(s=>s.status),['verified','prepared']);
 assert.equal((await f.service.execute(request)).status,'uncertain');
 assert.equal(f.writes.length,1,'the verified roll part is never sent again');
 await assert.rejects(f.service.execute({...request,operationId:randomUUID()}),/Предыдущая операция/);
});
