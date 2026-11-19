import test from 'node:test';
import assert from 'node:assert/strict';
import {executeProductionMove,cancelProductionMove,lookupProductionMove,reconcileProductionMoveBlocker,productionMoveSummary,finalizeConfirmedProductionMove} from '../worker/cloud/productionMove.js';
import {advanceMoveBatch} from '../worker/cloud/productionMoveBatch.js';
function fixture(failAt='',reverse=false,legacy=false,groupCount=1){
 const from=reverse?'roll':'box',to=reverse?'box':'roll',position=legacy?'ritm-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa-1':'position';
 const operations=new Map(),events=[],manifest={id:'shipment',ready:true,parts:[]};let lock=false,target=false,removed=false,failed=false;
 const manifests={box:legacy?null:structuredClone(manifest),roll:legacy?null:structuredClone(manifest)};
 const cell=x=>({effectiveValue:typeof x==='number'?{numberValue:x}:{stringValue:x},userEnteredValue:typeof x==='number'?{numberValue:x}:{stringValue:x}});
 const h=Array(30).fill(null);h[20]=cell('Дата взятия в работу');h[27]=cell('Напечатано годных');const row=Array(30).fill(null);row[4]=cell('SKU');row[15]=cell(32);row[29]=cell(position);
 const sourceRows=Array.from({length:groupCount},(_,i)=>{const v=structuredClone(row);if(i){v[4]=cell('SKU-'+i);v[15]=cell(32+i);v[29]=cell('position-'+i);}return {values:v};});
 const writers=Object.fromEntries(['box','roll'].map((d,i)=>[d,{documentId:d,layout:{article:5,quantity:16,uid:30,remainingPrint:18},metadata:async()=>[{sheetId:i+1,title:'OZON Test',gridProperties:{rowCount:10}}],manifest:async()=>structuredClone(manifests[d]),grid:async()=>({data:[{rowData:[{},{},{},{values:h},...(d===from&&!removed||d===to&&target?sourceRows:[])]}]}),prepareAppend:async request=>({sheetId:2,startRow:5,lines:request.lines,uids:request.lines.map((_,i)=>({uid:i?'new-'+i:'new'})),formulaRepairs:[]}),execute:async()=>{events.push('copy');target=true;if(failAt==='copy'&&!failed){failed=true;throw Error('lost response');}},verify:async()=>{if(!target)throw Error('absent');return {};},request:async(_,init)=>{const next=init.body.requests[1]?.createDeveloperMetadata.developerMetadata.metadataValue;manifests[d]=next?JSON.parse(next):null;events.push('manifest:'+d+':'+manifests[d]?.ready);if(failAt==='manifest'&&!failed){failed=true;throw Error('lost manifest response');}}}]));
 const values=new Map([['productionSupplies',legacy?[]:[{id:'shipment',name:'OZON Test',parts:[{department:'box',sheetId:1},{department:'roll',sheetId:2}]}]]]);
 const scope={lease:true,operations,checkpoint:async()=>{},putOperation:(kind,op)=>operations.set(kind+':'+op.id,{kind,value:structuredClone(op)}),meta:function(key,value){if(arguments.length>1)values.set(key,value);return values.get(key);}};
 const services={transfer:{links:()=>legacy?[{name:'OZON Test',boxSheetId:1,targetRollSheetId:2}]:[]},production:{writers},guard:async()=>{},reader:{metadata:async id=>({sheets:[{properties:{sheetId:id.includes('ASSEMBLY')?8:7,title:id.includes('ASSEMBLY')?'OZON Test':'Журнал',gridProperties:{rowCount:2}}}]}),grid:async id=>{const v=Array(10).fill(null);v[0]=cell('RITM-ROLL-2');v[3]=cell('RITM-ROLL-2'+(reverse?'':'|box:1')+'|uid:'+position+'|SKU');v[4]=cell('SKU');v[9]=cell(32);return {sheets:[{properties:{sheetId:id.includes('ASSEMBLY')?8:7},data:[{rowData:[{values:[]},...(id.includes('ASSEMBLY')?[{values:v}]:[])]}]}]};}}};
 const bindings={RITM_BOX_MOVE_GATEWAY_URL:'https://script.google.com/macros/s/SYNTHETIC_000000000000000000/exec',RITM_ROLL_MOVE_GATEWAY_URL:'https://script.google.com/macros/s/SYNTHETIC_000000000000000000/exec',RITM_BOX_MOVE_GATEWAY_TOKEN:'x'.repeat(64),RITM_GOOGLE_BOX_JOURNAL_ID:'JOURNAL_SYNTHETIC_00000000000',RITM_GOOGLE_ASSEMBLY_DATABASE_ID:'ASSEMBLY_SYNTHETIC_00000000000'};
 const fetcher=async(_,init)=>{const q=JSON.parse(init.body);if(q.action==='health')return Response.json({ok:true,status:'ready',capabilities:['move-group-v1']});if(q.action==='abort'){lock=false;return Response.json({ok:true,status:'aborted'});}if(q.action==='lock'){events.push('lock');lock=true;return Response.json({ok:true,locked:true});}if(q.action==='remove'){assert.ok(target);events.push('remove');removed=true;lock=false;if(failAt==='remove'&&!failed){failed=true;throw Error('lost response');}return Response.json({ok:true,status:'removed'});}return Response.json({ok:true,status:removed?'removed':lock?'locked':'absent'});};
 const input={operationId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',shipmentId:legacy?'RITM-ROLL-2':'shipment',uid:position,article:'SKU',quantity:32,machine:reverse?'XEROX':'2-GO',extension:'U3',...(reverse?{sourceDepartment:'roll'}:{})};
 return {input,events,args:{scope,services,bindings,fetcher},state:()=>({target,removed,manifests})};
}
test('cloud controller copies then removes and confirms both production manifests',async()=>{const f=fixture();const result=await executeProductionMove(f.input,f.args);assert.equal(result.status,'verified');assert.deepEqual(f.events.filter(x=>['copy','remove'].includes(x)),['copy','remove']);assert.ok(Object.values(f.state().manifests).every(m=>m.ready&&m.revision===f.input.operationId));});
test('normal move uses two gateway requests and invalidates printing exactly when the move commits',async()=>{
 const f=fixture(),fetcher=f.args.fetcher,requests=[];f.args.fetcher=async(url,init)=>{requests.push(JSON.parse(init.body).action);return fetcher(url,init);};
 const grid=f.args.services.reader.grid;f.args.services.reader.grid=async(id,ranges)=>{assert.match(ranges[0],/A1:H2$/);return grid(id,ranges);};
 assert.equal((await executeProductionMove(f.input,f.args)).status,'verified');assert.deepEqual(requests,['lock','remove']);
 assert.equal(f.args.scope.meta('printingMoveRevision'),f.input.operationId);
 await executeProductionMove(f.input,f.args);assert.equal(requests.length,2,'repeat uses the saved verified operation');
});
test('lost removal acknowledgement is reread from the gateway on the next request',async()=>{
 const f=fixture('remove'),fetcher=f.args.fetcher,requests=[];f.args.fetcher=async(url,init)=>{requests.push(JSON.parse(init.body).action);return fetcher(url,init);};
 await executeProductionMove(f.input,f.args);assert.equal(f.args.scope.meta('printingMoveRevision'),f.input.operationId+':pending');
 await executeProductionMove(f.input,f.args);assert.deepEqual(requests,['lock','remove','status']);assert.equal(f.events.filter(e=>e==='copy').length,1);
});
test('atomic removal still refuses changed or started source work despite an acknowledged lock',async()=>{
 const f=fixture(),fetcher=f.args.fetcher;
 f.args.fetcher=async(url,init)=>JSON.parse(init.body).action==='remove'?Response.json({ok:false,message:'По позиции появилась работа.'}):fetcher(url,init);
 const first=await executeProductionMove(f.input,f.args);assert.equal(first.status,'uncertain');assert.match(first.message,/появилась работа/);assert.equal(f.state().removed,false);
 await executeProductionMove(f.input,f.args);assert.equal(f.state().removed,false);assert.equal(f.events.filter(e=>e==='copy').length,1);assert.equal(f.args.scope.meta('printingMoveRevision'),f.input.operationId+':pending');
});
for(const reverse of [false,true])test('receipt-only completion verifies existing destination and removed source, without repeating goods writes '+reverse,async()=>{
 const f=fixture('remove',reverse);await executeProductionMove(f.input,f.args);const before=f.events.filter(e=>['copy','remove'].includes(e));
 const op=await finalizeConfirmedProductionMove(f.input.operationId,f.args);assert.equal(op.status,'verified');
 assert.deepEqual(f.events.filter(e=>['copy','remove'].includes(e)),before);assert.ok(Object.values(f.state().manifests).every(m=>m.ready));
 assert.equal((await finalizeConfirmedProductionMove(f.input.operationId,f.args)).status,'verified');assert.deepEqual(f.events.filter(e=>['copy','remove'].includes(e)),before);
});
test('receipt-only completion refuses earlier copy stage and never creates an unknown operation',async()=>{
 const f=fixture('copy');await executeProductionMove(f.input,f.args);
 await assert.rejects(finalizeConfirmedProductionMove(f.input.operationId,f.args),{code:'move_receipts_required'});
 await assert.rejects(finalizeConfirmedProductionMove(crypto.randomUUID(),f.args),{code:'move_missing'});assert.equal(f.state().removed,false);
});
for(const missing of ['source','destination'])test('receipt-only completion refuses an unconfirmed '+missing+' and performs no goods writes',async()=>{
 const f=fixture('remove');await executeProductionMove(f.input,f.args);const before=[...f.events];
 if(missing==='source')f.args.fetcher=async()=>Response.json({ok:true,status:'locked'});
 else f.args.services.production.writers.roll.verify=async()=>{throw Error('Changed destination');};
 await assert.rejects(finalizeConfirmedProductionMove(f.input.operationId,f.args),{code:'move_receipts_required'});assert.deepEqual(f.events,before);
});
for(const failure of ['copy','remove'])test('blocking old move recovers its original '+failure+' receipt before another article without making a second copy',async()=>{
 const f=fixture(failure);assert.equal((await executeProductionMove(f.input,f.args)).status,'uncertain');
 const next={...f.input,operationId:crypto.randomUUID(),article:'NEXT'};
 const recovered=await reconcileProductionMoveBlocker(next,f.args);assert.equal(recovered.status,'verified');assert.equal(recovered.article,'SKU');
 assert.equal(f.events.filter(e=>e==='copy').length,1);assert.equal(f.state().removed,true);
 assert.equal(await reconcileProductionMoveBlocker(next,f.args),null);
});
test('an unresolved unrelated move without physical linkage is never automatically resumed',async()=>{
 const f=fixture();f.args.scope.putOperation('production-department-move',{id:'other',fingerprint:'original',status:'uncertain',input:{operationId:'other',shipmentId:'other-supply',article:'OTHER'}});
 const result=await reconcileProductionMoveBlocker(f.input,f.args);assert.match(result.message,/связь/);assert.equal(f.events.length,0);
});
test('diagnostics omit saved cell backups, request plans and gateway credentials',async()=>{
 const f=fixture('copy');await executeProductionMove(f.input,f.args);
 const op=f.args.scope.operations.get('production-department-move:'+f.input.operationId).value;
 const summary=productionMoveSummary(op);assert.equal(summary.input.article,'SKU');assert.equal(summary.destination.uids[0].uid,'new');
 assert.equal(summary.steps.destination,'uncertain');assert.ok(!JSON.stringify(summary).includes('userEnteredValue'));assert.ok(!Object.hasOwn(summary,'proof'));
});
for(const reverse of [false,true])test('durable bulk parent uses the real controller in direction '+(reverse?'roll to box':'box to roll')+' and never repeats a completed copy',async()=>{
 const f=fixture('',reverse);const payload={operationId:crypto.randomUUID(),items:[{...f.input,sourceDepartment:reverse?'roll':'box'}]};
 const result=await advanceMoveBatch(payload,f.args);assert.equal(result.status,'complete');assert.equal(result.results[0].quantity,32);
 await advanceMoveBatch(payload,f.args);assert.equal(f.events.filter(e=>e==='copy').length,1);assert.equal(f.state().removed,true);
});
test('destination metadata and grid are reused in preflight but manifests are freshly read after freezing',async()=>{
 const f=fixture(),writer=f.args.services.production.writers.roll,metadata=writer.metadata,grid=writer.grid,prepare=writer.prepareAppend;let metaReads=0,gridReads=0;
 writer.metadata=async function(){metaReads++;return metadata();};writer.grid=async function(...args){gridReads++;return grid(...args);};
 writer.prepareAppend=async function(...args){await this.metadata();await this.grid('OZON Test',504);return prepare(...args);};
 assert.equal((await executeProductionMove(f.input,f.args)).status,'verified');assert.equal(metaReads,1);assert.equal(gridReads,1);
 assert.ok(f.state().manifests.roll.ready);assert.equal(f.state().manifests.roll.revision,f.input.operationId);
});
test('an absent copy is retried after the safety window, without a new operation',async()=>{
 const f=fixture(),writer=f.args.services.production.writers.roll,write=writer.execute;let attempts=0;
 writer.execute=async p=>{if(++attempts===1)throw Error('timeout before accepted');assert.equal(p.recoveryInsert,true);return write(p);};
 writer.verifyAbsentMoveDestination=async()=>true;
 const first=await executeProductionMove(f.input,f.args);assert.equal(first.status,'uncertain');assert.equal(f.state().removed,false);
 const op=f.args.scope.operations.get('production-department-move:'+f.input.operationId).value;op.destinationAttemptAt=Date.now()-300000;
 const recovered=await executeProductionMove(f.input,f.args);assert.equal(recovered.status,'verified');assert.equal(attempts,2);assert.equal(f.events.filter(e=>e==='copy').length,1);assert.equal(f.state().removed,true);
});
test('an unconfirmed copy is never retried while the earlier request may still run',async()=>{
 const f=fixture(),writer=f.args.services.production.writers.roll;let attempts=0;
 writer.execute=async()=>{attempts++;throw Error('timeout');};writer.verifyAbsentMoveDestination=async()=>true;
 await executeProductionMove(f.input,f.args);const op=await executeProductionMove(f.input,f.args);
 assert.equal(op.status,'uncertain');assert.equal(attempts,1);assert.equal(f.state().removed,false);
});
test('changed destination prevents recovery and keeps the source',async()=>{
 const f=fixture(),writer=f.args.services.production.writers.roll;let attempts=0;
 writer.execute=async()=>{attempts++;throw Error('timeout');};writer.verifyAbsentMoveDestination=async()=>{throw Error('Состав листа назначения изменился');};
 await executeProductionMove(f.input,f.args);f.args.scope.operations.get('production-department-move:'+f.input.operationId).value.destinationAttemptAt=Date.now()-300000;
 const op=await executeProductionMove(f.input,f.args);assert.match(op.message,/изменился/);assert.equal(attempts,1);assert.equal(f.state().removed,false);
});
test('legacy uncertain copy recovers only after an old durable audit confirms the request ended',async()=>{
 const f=fixture(),writer=f.args.services.production.writers.roll,write=writer.execute;let attempts=0;
 writer.execute=async p=>{if(++attempts===1)throw Error('timeout');return write(p);};writer.verifyAbsentMoveDestination=async()=>true;
 await executeProductionMove(f.input,f.args);const op=f.args.scope.operations.get('production-department-move:'+f.input.operationId).value;delete op.destinationAttemptAt;
 f.args.scope.store={db:{prepare:sql=>{assert.match(sql,/instr\(message,\?\)/);assert.doesNotMatch(sql,/LIKE/);return {bind:(type,needle)=>{assert.equal(type,'manager_supply_write');assert.equal(needle,'/api/production-moves '+f.input.operationId);return {first:async()=>({last_at:Date.now()-300000})};}};}}};
 assert.equal((await executeProductionMove(f.input,f.args)).status,'verified');assert.equal(attempts,2);assert.equal(f.state().removed,true);
});
test('legacy copy with no durable completion timestamp does not retry',async()=>{
 const f=fixture(),writer=f.args.services.production.writers.roll;let attempts=0;writer.execute=async()=>{attempts++;throw Error('timeout');};writer.verifyAbsentMoveDestination=async()=>true;
 await executeProductionMove(f.input,f.args);delete f.args.scope.operations.get('production-department-move:'+f.input.operationId).value.destinationAttemptAt;
 assert.equal((await executeProductionMove(f.input,f.args)).status,'uncertain');assert.equal(attempts,1);assert.equal(f.state().removed,false);
});
test('changed source stops recovery before copying',async()=>{
 const f=fixture(),writer=f.args.services.production.writers.roll,box=f.args.services.production.writers.box,grid=box.grid;let attempts=0;
 writer.execute=async()=>{attempts++;throw Error('timeout');};writer.verifyAbsentMoveDestination=async()=>true;
 await executeProductionMove(f.input,f.args);f.args.scope.operations.get('production-department-move:'+f.input.operationId).value.destinationAttemptAt=Date.now()-300000;
 box.grid=async(...args)=>{const result=await grid(...args);result.data[0].rowData[4].values[15].userEnteredValue.numberValue=33;return result;};
 const op=await executeProductionMove(f.input,f.args);assert.match(op.message,/Исходная строка изменилась/);assert.equal(attempts,1);assert.equal(f.state().removed,false);
});
for(const point of ['copy','remove'])test('cloud resume after lost '+point+' response never duplicates the destination',async()=>{const f=fixture(point);assert.equal((await executeProductionMove(f.input,f.args)).status,'uncertain');assert.equal((await executeProductionMove(f.input,f.args)).status,'verified');assert.equal(f.events.filter(x=>x==='copy').length,1);});

test('cannot cancel after destination write has begun',async()=>{const f=fixture('copy');await executeProductionMove(f.input,f.args);await assert.rejects(cancelProductionMove(f.input.operationId,f.args),/сверка/);assert.equal(f.state().target,true);});
test('a conflicting input cannot reuse a completed operation ID',async()=>{const f=fixture();await executeProductionMove(f.input,f.args);await assert.rejects(executeProductionMove({...f.input,quantity:64},f.args),/ID/);assert.equal(f.events.filter(e=>e==='copy').length,1);});

for(const point of ['', 'copy','remove'])test('reverse controller transfer recovers '+(point||'normal operation'),async()=>{const f=fixture(point,true);let r=await executeProductionMove(f.input,f.args);if(point)r=await executeProductionMove(f.input,f.args);assert.equal(r.status,'verified');assert.equal(f.events.filter(x=>x==='copy').length,1);assert.equal(f.state().removed,true);});

for(const reverse of [false,true])for(const point of ['', 'copy','remove'])test('legacy transfer preserves identity and registers only after verification '+reverse+' '+point,async()=>{const f=fixture(point,reverse,true);let r=await executeProductionMove(f.input,f.args);if(point)r=await executeProductionMove(f.input,f.args);assert.equal(r.status,'verified');const registered=f.args.scope.meta('productionSupplies');assert.equal(registered[0].id,'RITM-ROLL-2');assert.equal(f.events.filter(x=>x==='copy').length,1);assert.ok(Object.values(f.state().manifests).every(m=>m.ready&&m.id==='RITM-ROLL-2'));});

test('cancelling partially frozen legacy supply removes only introduced manifests',async()=>{const f=fixture('manifest',true,true);const r=await executeProductionMove(f.input,f.args);assert.equal(r.status,'uncertain');assert.equal((await cancelProductionMove(f.input.operationId,f.args)).status,'cancelled');assert.deepEqual(f.state().manifests,{box:null,roll:null});assert.deepEqual(f.args.scope.meta('productionSupplies'),[]);assert.equal(f.events.filter(x=>x==='copy').length,0);});

test('edge redirect recovery after script accepted lock never duplicates destination',async()=>{
 const f=fixture('',true,true),direct=f.args.fetcher;let reply,lose=true;
 f.args.fetcher=async(url,init)=>{
  assert.notEqual(init.redirect,'error','Workers rejects redirect:error');
  if(init.method==='POST'){reply=await direct(url,init);return new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?result=test'}});}
  if(lose){lose=false;throw Error('lost content response');}
  return reply;
 };
 assert.equal((await executeProductionMove(f.input,f.args)).status,'uncertain');
 assert.equal(f.events.filter(x=>x==='copy').length,0);
 assert.equal((await executeProductionMove(f.input,f.args)).status,'verified');
 assert.equal(f.events.filter(x=>x==='copy').length,1);
 assert.equal(f.state().removed,true);
});

test('pending transfer lookup restores exactly one existing operation without writes',()=>{
 const f=fixture(),op={id:f.input.operationId,status:'uncertain',input:f.input};f.args.scope.putOperation('production-department-move',op);
 const q=new URLSearchParams({shipmentId:f.input.shipmentId,uid:f.input.uid,article:'SKU',quantity:'32'});
 assert.equal(lookupProductionMove(f.args.scope,q).id,op.id);q.set('quantity','33');assert.equal(lookupProductionMove(f.args.scope,q),null);
 q.set('quantity','32');f.args.scope.putOperation('production-department-move',{...op,id:'other'});assert.throws(()=>lookupProductionMove(f.args.scope,q),/разные/);
});

test('unresolved transfer in another shipment does not block this shipment',async()=>{
 const f=fixture();
 f.args.scope.putOperation('production-department-move',{id:'other',status:'uncertain',input:{shipmentId:'other-shipment',article:'OTHER'},proof:{plan:{proof:{box:{sheetId:3},roll:{sheetId:4}}}}});
 assert.equal((await executeProductionMove(f.input,f.args)).status,'verified');
 assert.equal(f.events.filter(x=>x==='copy').length,1);
});

test('different shipment IDs sharing a sheet still block',async()=>{
 const f=fixture();f.args.scope.putOperation('production-department-move',{id:'other',status:'uncertain',input:{shipmentId:'alias',article:'OTHER'},proof:{plan:{proof:{box:{sheetId:1},roll:{sheetId:4}}}}});
 await assert.rejects(executeProductionMove(f.input,f.args),/OTHER/);assert.equal(f.events.length,0);
});

test('unresolved transfer in the same or unknown shipment blocks before writes',async()=>{
 for(const shipmentId of ['shipment',undefined]){
  const f=fixture();f.args.scope.putOperation('production-department-move',{id:'other',status:'uncertain',input:{shipmentId,article:'OTHER'}});
  await assert.rejects(executeProductionMove(f.input,f.args),/OTHER/);
  assert.equal(f.events.length,0);
 }
});
for(const reverse of [false,true])test('three-position group uses the actual durable controller with one append and one removal '+reverse,async()=>{
 const f=fixture('',reverse,false,3),calls=[];const fetcher=f.args.fetcher;
 f.args.fetcher=async(url,init)=>{const q=JSON.parse(init.body);calls.push(q);return fetcher(url,init);};
 const input={...f.input,sourceDepartment:reverse?'roll':'box'};input.items=Array.from({length:3},(_,i)=>({...f.input,sourceDepartment:input.sourceDepartment,operationId:i?crypto.randomUUID():input.operationId,uid:i?'position-'+i:input.uid,article:i?'SKU-'+i:input.article,quantity:32+i}));
 const result=await executeProductionMove(input,f.args);assert.equal(result.status,'verified');assert.deepEqual(f.events.filter(e=>['copy','remove'].includes(e)),['copy','remove']);
 assert.deepEqual(calls.map(c=>c.action),['health','lock','remove']);assert.deepEqual(calls[1].positions.map(p=>p.row),[5,6,7]);assert.deepEqual(calls[2].positions.map(p=>p.quantity),[32,33,34]);
 assert.equal(result.proof.plan.destination.lines.length,3);assert.equal(result.proof.plan.audit.positions.length,3);assert.equal(result.proof.plan.sourceRequests.length,15);
 assert.equal(result.proof.plan.destination.formulaRepairs.filter(r=>r.column===4).length,3);
 await executeProductionMove(input,f.args);assert.equal(calls.length,3,'verified group never contacts the gateway or copies again');
});
test('group source lost response resumes all positions with one immutable receipt',async()=>{
 const f=fixture('remove',false,false,3),input={...f.input,sourceDepartment:'box'};input.items=Array.from({length:3},(_,i)=>({...input,operationId:i?crypto.randomUUID():input.operationId,uid:i?'position-'+i:input.uid,article:i?'SKU-'+i:input.article,quantity:32+i}));
 assert.equal((await executeProductionMove(input,f.args)).status,'uncertain');assert.equal((await executeProductionMove(input,f.args)).status,'verified');assert.equal(f.events.filter(e=>e==='copy').length,1);
});
test('missing group capability prevents both source locks and destination writes',async()=>{
 const f=fixture('',false,false,3),input={...f.input,sourceDepartment:'box'};input.items=[{...input},{...input,operationId:crypto.randomUUID(),uid:'position-1',article:'SKU-1',quantity:33}];f.args.fetcher=async()=>Response.json({ok:true,status:'ready'});
 await assert.rejects(executeProductionMove(input,f.args),{code:'move_group_unavailable'});assert.equal(f.events.length,0);assert.equal(f.args.scope.operations.size,0);
});
