import test from 'node:test';
import assert from 'node:assert/strict';
import {createStockGateway} from '../worker/cloud/stockGateway.js';

const url='https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz123456/exec',token='x'.repeat(40);
test('stock gateway sends once and follows only the confirmed Google response',async()=>{
 const calls=[];let guards=0;
 const gateway=createStockGateway({url,token,beforeWrite:async()=>guards++,fetcher:async(input,init)=>{calls.push({input,init});return calls.length===1?new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/result'}}):new Response(JSON.stringify({ok:true,status:'verified'}),{status:200});}});
 await gateway.applyStockPlan({operationId:'id',sheetId:7,entries:[]});
 assert.equal(guards,1);assert.equal(calls.length,2);assert.equal(calls[0].init.method,'POST');assert.equal(calls[1].init.method,'GET');assert.equal(JSON.parse(calls[0].init.body).token,token);
 assert.equal(calls[1].init.redirect,'manual','Google response hop is compatible with the Workers runtime');
 assert.equal(calls[1].init.body,undefined,'credentials are never sent on the response hop');
});
test('stock gateway never follows another redirect from the Google response',async()=>{
 let calls=0;const gateway=createStockGateway({url,token,beforeWrite:async()=>{},fetcher:async(_,init)=>{
  calls++;assert.equal(init.redirect,'manual');
  return new Response(null,{status:302,headers:{location:calls===1?'https://script.googleusercontent.com/result':'https://example.com/untrusted'}});
 }});
 await assert.rejects(gateway.health(),/Google не подтвердил/);assert.equal(calls,2);
});
test('stock gateway rejects untrusted redirects without sending credentials to them',async()=>{
 let calls=0;const gateway=createStockGateway({url,token,beforeWrite:async()=>{},fetcher:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://example.com/stolen'}});}});
 await assert.rejects(gateway.applyStockPlan({}),/Не подтверждён/);assert.equal(calls,1);
});
test('health is a protected read action and cannot weaken write acknowledgements',async()=>{
 const calls=[],gateway=createStockGateway({url,token,beforeWrite:async()=>{},fetcher:async(_,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,status:'ready',panelCheck:[]});}});
 assert.equal((await gateway.health()).status,'ready');assert.equal(calls[0].action,'health');assert.equal(calls[0].entries,undefined);
 await assert.rejects(gateway.applyStockPlan({entries:[]}),/сверки/);
});

test('receipt inspection enforces dry run and accepts only known protected statuses',async()=>{
 const sent=[];let answer={ok:true,status:'verified'};
 const gateway=createStockGateway({url,token,dryRunSupported:true,beforeWrite:async()=>{},fetcher:async(_,init)=>{sent.push(JSON.parse(init.body));return Response.json(answer);}});
 const plan={operationId:'op',sheetId:7,entries:[{article:'A'}],action:'close',dryRun:false};
 assert.equal((await gateway.inspectStockPlan(plan)).status,'verified');
 assert.equal(sent[0].dryRun,true);assert.equal(sent[0].action,undefined);
 answer={ok:true,status:'validated'};assert.equal((await gateway.inspectStockPlan(plan)).status,'validated');
 answer={ok:false,status:'uncertain',message:'pending'};assert.equal((await gateway.inspectStockPlan(plan)).status,'uncertain');
 answer={ok:true,status:'other'};await assert.rejects(gateway.inspectStockPlan(plan),/сверки/);
 answer={ok:false,status:'uncertain'};await assert.rejects(gateway.applyStockPlan(plan),/сверки/);
});
test('an unknown gateway is never probed as a dry run',()=>{
 let calls=0;const gateway=createStockGateway({url,token,beforeWrite:async()=>{},fetcher:async()=>{calls++;assert.fail('unknown gateway must not be contacted');}});
 assert.throws(()=>gateway.inspectStockPlan({operationId:'op',sheetId:7,entries:[]}),/не подтверждена/);assert.equal(calls,0);
});
