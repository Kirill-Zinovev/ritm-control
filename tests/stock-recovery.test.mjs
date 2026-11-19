import test from 'node:test';
import assert from 'node:assert/strict';
import {runStockRequest} from '../src/stockRecovery.js';

test('recovers a lost response using only the original operation ID',async()=>{
 const payload={operationId:'same-id',input:{lines:[{article:'A',quantity:10}]}},seen=[];
 const result=await runStockRequest(async value=>{seen.push(value);if(seen.length===1)throw new Error('connection');return {operation:{status:'verified'}};},payload,{wait:async()=>{}});
 assert.equal(result.operation.status,'verified');assert.equal(seen.length,2);assert.ok(seen.every(item=>item===payload));
});
test('uncertainty is bounded and remains visible if source cannot confirm',async()=>{
 let count=0;await assert.rejects(runStockRequest(async()=>{count++;return {operation:{status:'uncertain',message:'Не подтверждено'}};},{operationId:'same'},{wait:async()=>{}}),/Не подтверждено/);assert.equal(count,3);
});
test('a confirmed failure is not resent',async()=>{
 let count=0;const result=await runStockRequest(async()=>{count++;return {notSaved:true,message:'Нет записи'};},{operationId:'same'},{wait:async()=>{}});assert.equal(result.notSaved,true);assert.equal(count,1);
});
test('partial results are exposed to the screen without changing the saved request',async()=>{
 const payload={operationId:'same',input:{lines:[{article:'A',quantity:10}]}},observed=[];
 await assert.rejects(runStockRequest(async value=>{assert.equal(value,payload);return {operation:{status:'uncertain',message:'Сверка',steps:[{department:'roll',status:'verified'},{department:'box',status:'prepared'}]}};},payload,{attempts:1,onResult:result=>observed.push(result)}),/Сверка/);
 assert.deepEqual(observed[0].operation.steps.map(step=>step.status),['verified','prepared']);
});
