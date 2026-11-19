import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingStockDetails,inspectStockReceipts} from '../worker/cloud/stockDiagnostics.js';
import {mcp} from '../worker/cloud/mcp.js';
import {cloudApi} from '../worker/cloud/runtime.js';
import {bridgeSignature} from '../worker/cloud/bridge.js';
import {LocalD1} from './helpers/d1-sqlite.mjs';
import {cloudSchemaStatements} from './helpers/cloud-schema.mjs';
import {bindings} from './cloud-env.mjs';
import {randomUUID} from 'node:crypto';

const pending={kind:'stock',value:{id:'operation-id',status:'uncertain',destination:'warehouse',createdAt:'2026-11-16T08:00:00Z',steps:[{department:'roll',status:'uncertain',plan:{destination:'warehouse',spreadsheetId:'book',sheetId:7,entries:[{article:'TEST.1',action:'increase',quantity:10,previousQuantity:20,newQuantity:30,row:5,uid:'id'}]}},{department:'box',status:'prepared',plan:{destination:'warehouse',sheetId:8,entries:[{article:'TEST.2',action:'insert',quantity:5,newQuantity:5,row:6,uid:'new'}]}}]}};

test('diagnostic view selects the entire original request by exact article, with no mutations',()=>{
 const before=JSON.stringify(pending);
 const result=pendingStockDetails([pending,{kind:'other',value:pending.value}],'test.1');
 assert.equal(result.length,1);assert.equal(result[0].steps[0].plan.entries[0].previousQuantity,20);
 assert.equal(result[0].steps[1].status,'prepared');assert.equal(JSON.stringify(pending),before);
 assert.equal(pendingStockDetails([pending],'TEST').length,0);
 assert.throws(()=>pendingStockDetails([pending],''),/артикул/);
});

test('pending stock diagnostic is owner-only and does not write to D1',async()=>{
 let writes=0;
 const db={prepare:()=>({bind(){return this;},run(){writes++;throw new Error('no writes');}}),batch:async()=>[{results:[]},{results:[{kind:'stock',id:'operation-id',payload:JSON.stringify(pending.value),ordinal:1,created_at:pending.value.createdAt}]},{results:[]},{results:[]}]};
 const env={DB:db,RITM_OWNER_USER_IDS:'owner'};
 const call=id=>new Request('https://example.test/mcp',{method:'POST',headers:{'content-type':'application/json',...(id?{'oai-authenticated-user-id':id}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ritm_stock_pending_status',arguments:{article:'TEST.1'}}})});
 assert.equal((await mcp(call('other'),env)).status,403);
 const response=await mcp(call('owner'),env);assert.equal(response.status,200);
 const body=await response.json(),content=JSON.parse(body.result.content[0].text);
 assert.equal(content.operations[0].id,'operation-id');assert.equal(content.operations[0].steps.length,2);assert.equal(writes,0);
});

test('signed local stock diagnostic reads the original operation without a lease, background delivery or outbound traffic',async()=>{
 const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));
 const secret='ab'.repeat(32),path='/api/stocks/pending-status?article=TEST.1';
 const env={...bindings,DB:db,RITM_OWNER_USER_IDS:'owner',RITM_GOOGLE_READER_JSON:'{}',RITM_LOCAL_BRIDGE_ID:'local-test',RITM_LOCAL_BRIDGE_SECRET:secret};
 let outbound=0,background=0;
 const request=(method='GET')=>{const timestamp=String(Date.now()),nonce=randomUUID();return new Request('https://ritm.test'+path,{method,headers:{'x-ritm-bridge-id':'local-test','x-ritm-bridge-at':timestamp,'x-ritm-bridge-nonce':nonce,'x-ritm-bridge-signature':bridgeSignature(secret,{method,path,timestamp,nonce,body:''})}});};
 try{
  await db.prepare('INSERT INTO cloud_operations(kind,id,payload,created_at,ordinal) VALUES(?,?,?,?,?)').bind('stock',pending.value.id,JSON.stringify(pending.value),pending.value.createdAt,1).run();
  const options={fetcher:async()=>{outbound++;throw new Error('network must not be called');}},ctx={waitUntil:()=>{background++;}};
  const response=await cloudApi(request(),env,ctx,options);assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.operations[0].id,pending.value.id);
  assert.equal(body.operations[0].steps[0].plan.entries[0].newQuantity,30);
  assert.equal((await cloudApi(request('POST'),env,ctx,options)).status,403);
  assert.equal((await cloudApi(new Request('https://ritm.test'+path),env,ctx,options)).status,401);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cloud_leases').first()).n,0);
  assert.equal((await db.prepare('SELECT payload FROM cloud_operations').first()).payload,JSON.stringify(pending.value));
  assert.equal(outbound,0);assert.equal(background,0);
 }finally{db.close();}
});

test('receipt diagnostic sends only dryRun to a known deployment and never discloses the secret',async()=>{
 const token='SYNTHETIC_SECRET_00000000000000000000000000',operations=pendingStockDetails([pending],'TEST.1'),calls=[];
 const env={RITM_STOCK_ROLL_GATEWAY_URL:'https://script.google.com/macros/s/AKfycbyR9BY0_SUzNiGPsK-E-Y7tF7bX3z1JSzp1lnaV1sOycmUtj8Cmf25Ak9ERO6msmCni/exec',RITM_STOCK_ROLL_GATEWAY_TOKEN:token};
 const result=await inspectStockReceipts(operations,env,{fetcher:async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,status:'verified'});}});
 assert.equal(calls.length,1);assert.equal(calls[0].dryRun,true);assert.equal(calls[0].operationId,pending.value.id);assert.equal(result[0].steps[0].receipt.status,'verified');assert.ok(!JSON.stringify(result).includes(token));
 const unknown=await inspectStockReceipts(operations,{...env,RITM_STOCK_ROLL_GATEWAY_URL:'https://script.google.com/macros/s/UNKNOWN_DEPLOYMENT_00000000/exec'},{fetcher:async()=>assert.fail('unknown gateway must not be called')});
 assert.equal(unknown[0].steps[0].receipt.status,'unsupported');
});
