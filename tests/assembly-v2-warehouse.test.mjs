import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {LocalD1} from './helpers/d1-sqlite.mjs';
import {cloudSchemaStatements} from './helpers/cloud-schema.mjs';
import {CloudStore} from '../worker/cloud/store.js';
import {legacyCartonComparison,mergeAssemblyWarehouses,reconcileArchivedWarehouse,readAssemblyV2Warehouse,warehouseForSelection} from '../worker/cloud/assemblyV2Warehouse.js';
import {prepareWarehouseExport,readWarehouseExports} from '../worker/cloud/warehouseExports.js';
import {warehouseCartonFingerprint} from '../src/warehouseFingerprint.js';
import {drainAssemblyV2} from '../worker/cloud/assemblyV2Delivery.js';
const secret='ab'.repeat(32),origin='https://assembly-v2.zinovevkirill234.chatgpt.site';
const config={RITM_ASSEMBLY_V2_TARGET_URL:origin,RITM_ASSEMBLY_V2_FEED_SECRET:secret,RITM_ASSEMBLY_V2_TARGET_TOKEN:'service'};
const box=(id='av2:one',quantity=50)=>({id,assemblyV2Id:id.replace('av2:',''),sourceSystem:'assembly-v2',sourceKind:'direction',legacyId:null,legacyBaseline:null,modifiedInV2:true,number:'1мос1',shipmentId:'RITM-ROLL-10',shipment:'OZON Москва',directionId:'ASSEMBLY_V2',market:'OZON',store:'1',boxType:'М',status:'closed',createdAt:'2026-11-14T06:00:00Z',closedAt:'2026-11-14T06:01:00Z',quantity,fillPercent:50,ready:true,issues:[],history:[],dispatchStatus:'pending',contents:[{article:'000123',positionId:'RITM-ROLL-10|uid:one|000123',shipmentId:'RITM-ROLL-10',shipment:'OZON Москва',market:'OZON',store:'1',quantity,barcode:'0012345678901',productName:'Товар',photoUrl:''}]});
const legacy=boxes=>({ok:true,schemaVersion:1,checkedAt:new Date().toISOString(),cartons:boxes,stockCartons:[],stale:false,issues:[]});
const modern=boxes=>({cartons:boxes,stockCartons:[],stale:false});
function fixture(t){const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';'));t.after(()=>db.close());return {db,store:new CloudStore(db)};}
function pages(boxes,{assertSignature=false}={}){return async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,origin);assert.equal(init.redirect,'manual');
  if(assertSignature){const h=new Headers(init.headers),message=JSON.stringify([1,'GET',u.pathname+u.search,h.get('x-assembly-v2-at'),h.get('x-assembly-v2-nonce'),createHash('sha256').update('').digest('hex')]);assert.equal(h.get('x-assembly-v2-signature'),createHmac('sha256',secret).update(message).digest('hex'));}
  const kind=u.searchParams.get('kind'),all=kind==='direction'?boxes:[],cursor=u.searchParams.get('cursor'),start=cursor?all.findIndex(b=>b.assemblyV2Id===cursor)+1:0,rows=all.slice(start,start+100);
  return Response.json({ok:true,format:'assembly-v2-warehouse',version:1,kind,revision:5,total:all.length,cartons:rows,nextCursor:start+100<all.length?rows.at(-1).assemblyV2Id:null});
};}
test('перенесённые короба объединяются по исходному ID; собственные короба и склады обеих версий не теряются',()=>{
  const old=box('carton-old'),copy={...old,legacyId:old.id,modifiedInV2:false,legacyBaseline:legacyCartonComparison(old)},native=box('av2:two');native.number='1мос2';
  const merged=mergeAssemblyWarehouses(legacy([old]),modern([copy,native]));assert.equal(merged.cartons.length,2);assert.equal(merged.cartons.find(b=>b.id===old.id).sourceSystem,'assembly-v2');
  const updatedOld={...old,quantity:55,contents:old.contents.map(i=>({...i,quantity:55}))};
  assert.equal(mergeAssemblyWarehouses(legacy([updatedOld]),modern([copy])).cartons[0].quantity,55);
  const conflict=mergeAssemblyWarehouses(legacy([updatedOld]),modern([{...copy,modifiedInV2:true}]));assert.equal(conflict.cartons[0].dispatchBlocked,true);
  const duplicate=mergeAssemblyWarehouses(legacy([old]),modern([native]));native.number=old.number;assert.equal(mergeAssemblyWarehouses(legacy([old]),modern([native])).cartons.filter(b=>b.dispatchBlocked).length,2);
  assert.equal(duplicate.cartons.length,2);
  assert.equal(mergeAssemblyWarehouses(legacy([]),modern([copy])).cartons.length,0,'A migrated pending carton cannot reactivate a deleted legacy source');
  assert.equal(mergeAssemblyWarehouses(legacy([]),modern([{...copy,dispatchStatus:'sent'}])).cartons.length,1,'Departed history remains available');
});
test('archived closed cartons require fresh, matching legacy and v2 identity, contents and dispatch state',()=>{
  const old={...box('carton-old'),sourceSystem:'legacy'}, copy={...old,sourceSystem:'assembly-v2',assemblyV2Id:'legacy:carton-old',legacyId:old.id,modifiedInV2:false,legacyBaseline:legacyCartonComparison(old)};
  const source={...legacy([]),archivedCartons:[old]}, lookup=(one=source,two=modern([copy]),state=new Map())=>reconcileArchivedWarehouse(one,two,state)[0];
  assert.equal(lookup().archivedOrigin,true);assert.equal(lookup().dispatchBlocked,false);assert.equal(lookup().sourceSystem,'assembly-v2');
  assert.equal(lookup({...source,stale:true}).dispatchBlocked,true);
  assert.equal(lookup(source,{...modern([copy]),stale:true}).dispatchBlocked,true);
  assert.equal(lookup(source,modern([])).dispatchBlocked,true);
  assert.equal(lookup(source,modern([{...copy,quantity:51}])).dispatchBlocked,true);
  assert.equal(lookup(source,modern([{...copy,modifiedInV2:true}])).dispatchBlocked,true);
  assert.equal(lookup(source,modern([{...copy,reserved:true}])).dispatchBlocked,true);
  assert.equal(lookup({...source,archivedCartons:[{...old,issues:['Количество в коробе требует сверки']}]},modern([copy])).dispatchBlocked,true);
  const sent=lookup(source,modern([copy]),new Map([[old.id,{shipmentId:old.shipmentId,status:'sent'}]]));assert.equal(sent.dispatchStatus,'sent');assert.equal(sent.dispatchBlocked,true);
  assert.equal(reconcileArchivedWarehouse({...source,cartons:[old]},modern([copy])).length,0,'The same source ID is never added twice');
});
test('выгрузка читает все страницы с одной ревизией; неизвестный/устаревший источник не получает разрешение отправки',async(t)=>{
  const {store}=fixture(t),boxes=Array.from({length:101},(_,i)=>({...box('av2:'+String(i).padStart(3,'0')),number:'1мос'+(i+1)}));
  const result=await readAssemblyV2Warehouse(config,store,{fetcher:pages(boxes,{assertSignature:true}),force:true});assert.equal(result.cartons.length,101);
  const stale=await readAssemblyV2Warehouse(config,store,{force:true,fetcher:async()=>{throw new Error('Offline');}});assert.equal(stale.stale,true);assert.equal(stale.cartons.length,101);
  await assert.rejects(warehouseForSelection([boxes[0].id],config,store,{fetcher:async()=>{throw new Error('Offline');}}),/состав не подтверждён/);
});
test('снимок Excel сохраняется до скачивания и повторяется с тем же ключом без изменения отправки',async(t)=>{
  const {db,store}=fixture(t),b=box(),input={key:crypto.randomUUID(),cartons:[{cartonId:b.id,fingerprint:warehouseCartonFingerprint(b),dispatchStatus:'pending'}]},bindings={...config,DB:db};
  const saved=await prepareWarehouseExport(input,bindings,store,{actor:'owner',fetcher:pages([b])});assert.equal(saved.cartons[0].quantity,50);
  const again=await prepareWarehouseExport(input,bindings,store,{actor:'owner',fetcher:async()=>{throw new Error('No new source read allowed');}});assert.deepEqual(again,saved);
  assert.equal((await readWarehouseExports(db)).length,1);assert.equal((await readWarehouseExports(db,saved.id)).cartons[0].contents[0].barcode,'0012345678901');
  assert.equal((await db.prepare('select count(*) n from ritm_warehouse_carton_dispatch').first()).n,0);
  await assert.rejects(prepareWarehouseExport({...input,cartons:[{...input.cartons[0],dispatchStatus:'sent'}]},bindings,store,{actor:'owner',fetcher:pages([b])}),/другой выгрузки/);
});
test('повторная доставка работ продолжается и без новых поставок; параллельные проверки ограничены одним запросом',async(t)=>{
  const {store}=fixture(t);let calls=0;const fetcher=async(url)=>{assert.equal(new URL(url).pathname,'/api/ritm/deliver');calls++;return Response.json({pending:0});};
  await drainAssemblyV2(config,store,{fetcher});await drainAssemblyV2(config,store,{fetcher});assert.equal(calls,1);
});
