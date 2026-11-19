import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { listWarehouseCartonDispatch, listWarehouseDispatchSnapshots, setWarehouseCartonDispatch } from '../worker/cloud/warehouseDispatch.js';
import { validateWarehouseBatch } from '../worker/cloud/warehouseBatch.js';
import { warehouseCartonFingerprint } from '../src/warehouseFingerprint.js';
import { readWarehouseForDispatch } from '../worker/cloud/warehouse.js';
import { legacyCartonComparison, warehouseForSelection } from '../worker/cloud/assemblyV2Warehouse.js';

function dispatchReader({changing=false,hiddenSource=false}={}) {
  const id='WAREHOUSE_TEST_DATABASE_000000000001',sid='RITM-ROLL-100';let grids=0;
  const specs=[{sheetId:1,title:'Cartons',gridProperties:{rowCount:5,columnCount:16}},{sheetId:2,title:'CartonContents',gridProperties:{rowCount:5,columnCount:15}}];
  const headers=[['cartonId','directionId','Направление','Номер','Подтверждённая вместимость, шт','Занято, шт','Статус','createdAt','closedAt','source','shipmentId','Тип короба','cancelledAt','cancelledByWorkEventId','cancellationReason','statusBeforeCancellation'],['allocationId','cartonId','shipmentId','directionId','positionId','Артикул','Количество, шт','createdAt','eventId','action','sourceAllocationId','sourceWorkEventId','reason','employeeId','Сотрудник']];
  const rows=[['c1','ROLL','OZON TEST','1мос1',100,10,'Закрыт','2026-11-13T06:00:00Z','2026-11-13T07:00:00Z','RITM_ASSEMBLY',sid,'M'],['a1','c1',sid,'ROLL','position1','TEST',10,'2026-11-13T06:00:00Z','','ADD']];
  const rollId='ROLL_TEST_DOCUMENT_0000000000001';
  const reader={metadata:async requested=>{if(requested===rollId)return {spreadsheetId:rollId,sheets:[{properties:{sheetId:100,title:'OZON TEST',hidden:hiddenSource}}]};assert.equal(requested,id);return {spreadsheetId:id,sheets:specs.map(properties=>({properties}))};},grid:async requested=>{assert.equal(requested,id);grids++;return {spreadsheetId:id,sheets:specs.map((properties,index)=>({properties,data:[{rowData:[headers[index],rows[index].map((v,column)=>changing&&index===1&&column===6?v+grids:v)].map(row=>({values:row.map(value=>({effectiveValue:typeof value==='number'?{numberValue:value}:{stringValue:value}}))}))}]}))};}};
  const store={snapshot:async kind=>{assert.equal(kind,'printing');return {at:1,value:{ok:true,stale:true,refreshFailed:true,sheets:[{sourceId:'roll-printing',sheetId:100,name:'OZON TEST'}]}};},now:()=>Date.parse('2026-11-13T08:00:00Z')};
  return {reader,store,bindings:{RITM_GOOGLE_ASSEMBLY_DATABASE_ID:id,RITM_GOOGLE_ROLL_PRINTING_ID:rollId},grids:()=>grids};
}

test('dispatch verifies live Assembly twice even when unrelated printing roster refresh is stale',async()=>{
  const f=dispatchReader(),snapshot=await readWarehouseForDispatch(f.bindings,f.store,{reader:f.reader});
  assert.equal(snapshot.stale,false);assert.equal(snapshot.cartons.length,1);assert.equal(snapshot.cartons[0].id,'c1');assert.equal(snapshot.cartons[0].quantity,10);assert.equal(snapshot.cartons[0].status,'closed');assert.equal(f.grids(),2);
});

test('dispatch fails closed when actual Assembly contents are changing or source identities are absent',async()=>{
  const f=dispatchReader({changing:true});
  await assert.rejects(()=>readWarehouseForDispatch(f.bindings,f.store,{reader:f.reader}),{code:'warehouse_changing'});
  await assert.rejects(()=>readWarehouseForDispatch(f.bindings,{...f.store,snapshot:async()=>null},{reader:f.reader}),{code:'warehouse_supply_roster_unavailable'});
});

test('dispatch still excludes a hidden production source using current tab metadata',async()=>{
  const f=dispatchReader({hiddenSource:true});const snapshot=await readWarehouseForDispatch(f.bindings,f.store,{reader:f.reader});
  assert.equal(snapshot.cartons.length,0);assert.equal(snapshot.stale,false);
});

test('archived carton is selectable only after both current sources agree, and cannot bypass duplicate or sent checks',async()=>{
  const mf = new Miniflare({ modules:true, script:'export default {fetch(){return new Response("ok")}}', compatibilityDate:'2026-08-06', d1Databases:['DB'] });
  try {
    const db=await mf.getD1Database('DB'), f=dispatchReader({hiddenSource:true});
    const legacy=await readWarehouseForDispatch(f.bindings,f.store,{reader:f.reader});
    assert.equal(legacy.cartons.length,0);assert.equal(legacy.archivedCartons.length,1);
    const old=legacy.archivedCartons[0];
    const copy={...old,assemblyV2Id:'legacy:c1',sourceSystem:'assembly-v2',sourceKind:'direction',legacyId:old.id,legacyBaseline:legacyCartonComparison(old),modifiedInV2:false,store:'1',issues:[],ready:true,dispatchStatus:'pending'};
    const config={...f.bindings,DB:db,RITM_ASSEMBLY_V2_TARGET_URL:'https://assembly-v2.zinovevkirill234.chatgpt.site',RITM_ASSEMBLY_V2_FEED_SECRET:'ab'.repeat(32),RITM_ASSEMBLY_V2_TARGET_TOKEN:'service'};
    const store={...f.store,snapshot:async kind=>kind==='warehouse-v2'?null:f.store.snapshot(kind),acquire:async()=>({}),saveSnapshot:async()=>{},release:async()=>{}};
    const feed=items=>async url=>{const kind=new URL(url).searchParams.get('kind'),cartons=kind==='direction'?items:[];return Response.json({ok:true,format:'assembly-v2-warehouse',version:1,kind,revision:1,total:cartons.length,cartons,nextCursor:null});};
    const snapshot=await warehouseForSelection(['c1'],config,store,{reader:f.reader,fetcher:feed([copy])});
    const box=snapshot.cartons.find(item=>item.id==='c1');assert.equal(box.archivedOrigin,true);assert.equal(box.sourceSystem,'assembly-v2');
    const row={cartonId:box.id,shipmentId:box.shipmentId,fingerprint:warehouseCartonFingerprint(box)};
    assert.equal(validateWarehouseBatch([row],snapshot.cartons).get('c1').id,'c1');
    const changed={...copy,quantity:11,contents:copy.contents.map(item=>({...item,quantity:11}))};
    await assert.rejects(()=>warehouseForSelection(['c1'],config,store,{reader:f.reader,fetcher:feed([changed])}),{code:'warehouse_carton_unconfirmed'});
    const duplicate={...copy,id:'av2:other',assemblyV2Id:'other',legacyId:null,modifiedInV2:true,number:'1moc1'};
    await assert.rejects(()=>warehouseForSelection(['c1'],config,store,{reader:f.reader,fetcher:feed([copy,duplicate])}),{code:'warehouse_carton_unconfirmed'});
    await setWarehouseCartonDispatch(db,{cartonId:'c1',shipmentId:box.shipmentId,status:'sent',changedBy:'test',cartonSnapshot:old,now:1000});
    await assert.rejects(()=>warehouseForSelection(['c1'],config,store,{reader:f.reader,fetcher:feed([copy])}),{code:'warehouse_carton_unconfirmed'});
  } finally { await mf.dispose(); }
});

test('batch rejects changed, open, duplicate, missing or wrong-supply boxes before any write', () => {
  const box = {id:'b1',shipmentId:'s1',number:'1',status:'closed',quantity:10,boxType:'M',contents:[{article:'A',positionId:'p1',quantity:10}]};
  const row = {cartonId:box.id,shipmentId:box.shipmentId,fingerprint:warehouseCartonFingerprint(box)};
  assert.equal(validateWarehouseBatch([row],[box]).get('b1'),box);
  assert.throws(() => validateWarehouseBatch([row,row],[box]), {code:'warehouse_dispatch_duplicate'});
  assert.throws(() => validateWarehouseBatch([row],[]), {code:'warehouse_carton_changed'});
  assert.throws(() => validateWarehouseBatch([row],[{...box,status:'open'}]), {code:'warehouse_carton_changed'});
  assert.throws(() => validateWarehouseBatch([row],[{...box,shipmentId:'s2'}]), {code:'warehouse_carton_changed'});
  assert.throws(() => validateWarehouseBatch([row],[{...box,contents:[{...box.contents[0],quantity:9}]}]), {code:'warehouse_carton_changed'});
});

test('dispatch saves a durable carton snapshot, retries without changing it, and can be reversed', async () => {
  const mf = new Miniflare({ modules:true, script:'export default {fetch(){return new Response("ok")}}', compatibilityDate:'2026-08-06', d1Databases:['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    const carton = {id:'c1',shipmentId:'s1',number:'1мос1',contents:[{article:'A',quantity:10}]};
    const send = (overrides = {}) => setWarehouseCartonDispatch(db,{cartonId:'c1',shipmentId:'s1',status:'sent',changedBy:'Manager',cartonSnapshot:carton,now:1000,...overrides});
    assert.equal((await send()).status,'sent');
    await send({now:2000,cartonSnapshot:{...carton,contents:[{article:'A',quantity:99}]}});
    assert.equal((await listWarehouseDispatchSnapshots(db)).get('c1').contents[0].quantity,10);
    assert.equal((await listWarehouseCartonDispatch(db)).get('c1').sentAt,new Date(1000).toISOString());
    await send({status:'pending',now:3000});
    assert.equal((await listWarehouseCartonDispatch(db)).get('c1').status,'pending');
    await send({now:4000,cartonSnapshot:{...carton,contents:[{article:'A',quantity:12}]}});
    assert.equal((await listWarehouseDispatchSnapshots(db)).get('c1').contents[0].quantity,12);
    assert.equal((await listWarehouseCartonDispatch(db)).get('c1').sentAt,new Date(4000).toISOString());
    await assert.rejects(() => send({shipmentId:'foreign',now:5000}), /другой поставкой/);
    assert.equal((await listWarehouseDispatchSnapshots(db)).get('c1').contents[0].quantity,12);
  } finally { await mf.dispose(); }
});
