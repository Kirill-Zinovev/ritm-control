import test from 'node:test';
import assert from 'node:assert/strict';
import {runDepartmentMove} from '../agent/departmentMove.js';
const input={operationId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',shipmentId:'supply',uid:'position',article:'SKU',quantity:32};
function fixture(){
 const records=new Map(), calls=[], state={frozen:false,target:false,removed:false,reconciled:false,published:false,work:false};
 const step=(name,field)=>async()=>{calls.push(name);state[field]=true;};
 const deps={store:{get:async id=>structuredClone(records.get(id)),put:async op=>records.set(op.id,structuredClone(op))},source:{inspect:async()=>({...input,department:'box',workConfirmed:true,hasWork:state.work,assemblyConfirmed:true,assemblyHasWork:false}),verifyUnstarted:async()=>!state.work,remove:step('remove','removed'),verifyRemoved:async()=>state.removed},destination:{exists:async()=>state.target,write:step('write','target'),verify:async()=>state.target},coordinator:{freeze:step('freeze','frozen'),isFrozen:async()=>state.frozen,reconcile:step('reconcile','reconciled'),verify:async()=>state.reconciled,publish:step('publish','published'),verifyPublished:async()=>state.published}};
 return {deps,calls,state};
}
test('moves once in safe order and repeated request does not write',async()=>{const f=fixture();assert.equal((await runDepartmentMove(input,f.deps)).status,'verified');await runDepartmentMove(input,f.deps);assert.deepEqual(f.calls,['freeze','write','remove','publish']);});
test('started work and duplicate destination stop before writes',async()=>{for(const property of ['work','target']){const f=fixture();f.state[property]=true;await assert.rejects(runDepartmentMove(input,f.deps));assert.deepEqual(f.calls,[]);}});
test('lost target response is reconciled without duplicate insertion',async()=>{const f=fixture();f.deps.destination.write=async()=>{f.calls.push('write');f.state.target=true;throw Error('response lost');};assert.equal((await runDepartmentMove(input,f.deps)).status,'uncertain');assert.equal((await runDepartmentMove(input,f.deps)).status,'verified');assert.equal(f.calls.filter(x=>x==='write').length,1);});
test('unconfirmed target never removes the source',async()=>{const f=fixture();f.deps.destination.write=async()=>{throw Error('timeout');};await runDepartmentMove(input,f.deps);await runDepartmentMove(input,f.deps);assert.equal(f.state.removed,false);assert.equal(f.state.published,false);});
test('a definitely rejected copy retries under the same operation without deleting the source first',async()=>{
 const f=fixture();let attempts=0;const write=f.deps.destination.write;
 f.deps.destination.write=async()=>{if(++attempts===1)throw Object.assign(Error('Google отклонил запись'),{code:'roll_supply_api_rejected',uncertain:false});await write();};
 const first=await runDepartmentMove(input,f.deps);assert.equal(first.steps.destination,'pending');assert.equal(f.state.removed,false);
 assert.equal((await runDepartmentMove(input,f.deps)).status,'verified');assert.equal(attempts,2);assert.deepEqual(f.calls,['freeze','write','remove','publish']);
});
test('a failed readback after an accepted write never triggers another copy',async()=>{
 const f=fixture();let checks=0;f.deps.destination.verify=async()=>{checks++;throw Object.assign(Error('read failed'),{code:'roll_supply_api_rejected',uncertain:false});};
 assert.equal((await runDepartmentMove(input,f.deps)).steps.destination,'uncertain');
 await runDepartmentMove(input,f.deps);assert.equal(f.calls.filter(x=>x==='write').length,1);assert.equal(f.state.removed,false);assert.ok(checks>=2);
});
test('the original copy failure remains visible when a later check cannot prove the result',async()=>{
 const f=fixture();f.deps.destination.write=async()=>{throw Error('Google не ответил');};
 await runDepartmentMove(input,f.deps);const op=await runDepartmentMove(input,f.deps);
 assert.equal(op.message,'Google не ответил');assert.equal(op.steps.destination,'uncertain');assert.equal(f.state.removed,false);
});
test('work appearing during freeze stops copying',async()=>{const f=fixture();f.deps.coordinator.freeze=async()=>{f.state.frozen=true;f.state.work=true;};assert.equal((await runDepartmentMove(input,f.deps)).status,'blocked');assert.equal(f.state.target,false);});
test('operation identity cannot be reused with another quantity',async()=>{const f=fixture();await runDepartmentMove(input,f.deps);await assert.rejects(runDepartmentMove({...input,quantity:64},f.deps));});

test('work recorded after copy blocks source removal and publication',async()=>{const f=fixture();const write=f.deps.destination.write;f.deps.destination.write=async()=>{await write();f.state.work=true;};const op=await runDepartmentMove(input,f.deps);assert.equal(op.status,'blocked');assert.equal(f.state.target,true);assert.equal(f.state.removed,false);assert.equal(f.state.published,false);});
test('idempotent coordinator recovers a partial freeze before copying',async()=>{const f=fixture();let attempts=0;f.deps.coordinator.freeze=async()=>{attempts++;throw Error('second manifest failed');};f.deps.coordinator.recoverFreeze=async()=>{f.state.frozen=true;};assert.equal((await runDepartmentMove(input,f.deps)).status,'uncertain');assert.equal(f.state.target,false);assert.equal((await runDepartmentMove(input,f.deps)).status,'verified');assert.equal(attempts,1);});
test('partial publication is recovered without replaying target or source',async()=>{const f=fixture();f.deps.coordinator.publish=async()=>{throw Error('reply lost');};f.deps.coordinator.recoverPublish=async()=>{f.state.published=true;};assert.equal((await runDepartmentMove(input,f.deps)).status,'uncertain');assert.equal((await runDepartmentMove(input,f.deps)).status,'verified');assert.equal(f.calls.filter(x=>x==='write').length,1);assert.equal(f.calls.filter(x=>x==='remove').length,1);});
test('unknown source removal is recovered through its idempotent receipt',async()=>{const f=fixture();f.deps.source.remove=async()=>{throw Error('timeout');};f.deps.source.recoverRemove=async()=>{f.state.removed=true;};assert.equal((await runDepartmentMove(input,f.deps)).status,'uncertain');assert.equal((await runDepartmentMove(input,f.deps)).status,'verified');assert.equal(f.calls.filter(x=>x==='write').length,1);});

test('recovery replaces stale redirect failure with the current source refusal',async()=>{
 const f=fixture();f.deps.coordinator.freeze=async()=>{throw Error('Invalid redirect value');};
 assert.equal((await runDepartmentMove(input,f.deps)).message,'Invalid redirect value');
 f.deps.coordinator.recoverFreeze=async()=>{throw Error('По артикулу есть рулон д25, 10 шт.');};
 const op=await runDepartmentMove(input,f.deps);
 assert.equal(op.message,'По артикулу есть рулон д25, 10 шт.');assert.equal(op.failedStep,'freeze');
 assert.equal(f.state.target,false);assert.equal(f.state.removed,false);
});
test('successful recovery clears a previous error instead of retaining it in verified history',async()=>{
 const f=fixture();f.deps.coordinator.freeze=async()=>{throw Error('old failure');};
 await runDepartmentMove(input,f.deps);f.deps.coordinator.recoverFreeze=async()=>{f.state.frozen=true;};
 const op=await runDepartmentMove(input,f.deps);assert.equal(op.status,'verified');assert.equal(op.message,undefined);assert.equal(op.failedStep,undefined);
});
