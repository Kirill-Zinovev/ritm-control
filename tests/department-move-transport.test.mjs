import test from 'node:test';
import assert from 'node:assert/strict';
import {createDepartmentMoveGateway} from '../worker/cloud/departmentMoveGateway.js';
const url='https://script.google.com/macros/s/SYNTHETIC_000000000000000000/exec';
const token='x'.repeat(64);
for(const status of [302,303])test('edge gateway follows trusted content response '+status,async()=>{
 const calls=[];const send=createDepartmentMoveGateway({url,token,beforeWrite:async()=>{},fetcher:async(input,init)=>{
  calls.push({input,init});assert.equal(init.redirect,'manual');
  return calls.length===1?new Response(null,{status,headers:{location:'https://script.googleusercontent.com/macros/echo?result=test'}}):Response.json({ok:true,status:'locked'});
 }});
 assert.equal((await send('status',{operationId:'test'})).status,'locked');
 assert.equal(calls[1].init.method,'GET');assert.equal(calls[1].init.body,undefined);assert.equal(calls[1].init.headers,undefined);
});
test('gateway refuses foreign redirect before contacting destination',async()=>{
 let calls=0;const send=createDepartmentMoveGateway({url,token,beforeWrite:async()=>{},fetcher:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://unapproved.test/'}});}});
 await assert.rejects(send('status',{}),/ответ скрипта/);assert.equal(calls,1);
});
test('gateway refuses a second redirect without forwarding credentials',async()=>{
 let calls=0;const send=createDepartmentMoveGateway({url,token,beforeWrite:async()=>{},fetcher:async(_,init)=>{assert.equal(init.redirect,'manual');calls++;return new Response(null,{status:302,headers:{location:calls===1?'https://script.googleusercontent.com/macros/echo':'https://unapproved.test/'}});}});
 await assert.rejects(send('status',{}),{code:'unexpected_redirect'});assert.equal(calls,2);
});
test('script refusal is surfaced instead of unsupported edge redirect error',async()=>{
 let calls=0;const send=createDepartmentMoveGateway({url,token,beforeWrite:async()=>{},fetcher:async()=>++calls===1?new Response(null,{status:303,headers:{location:'https://script.googleusercontent.com/macros/echo'}}):Response.json({ok:false,message:'По артикулу уже начата работа.'})});
 await assert.rejects(send('lock',{}),/уже начата работа/);
});
