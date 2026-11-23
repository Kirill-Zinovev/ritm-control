import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudStore} from '../worker/cloud/store.js';
import {refreshSnapshot} from '../worker/cloud/runtime.js';
import {AssemblyTransferService} from '../agent/assemblyTransfer.js';
import {LocalD1} from './helpers/d1-sqlite.mjs';
import {cloudSchemaStatements} from './helpers/cloud-schema.mjs';
import {bindings} from './cloud-env.mjs';

test('feed context preserves guards and identities while excluding unrelated history and write plans',async t=>{
 const {store}=await fixture(t);
 await store.withScope(async s=>{
  s.putOperation('production-shipment-lock',{id:'supply',shipmentId:'supply',eventId:'lock-test',status:'locked',changedAt:new Date().toISOString()});
  s.putOperation('assembly-only-item',{id:'extra',status:'active',quantity:5});
  s.putOperation('unrelated',{id:'history',secret:'not part of feed'});
 });
 const full=await store.scope(),lean=await store.assemblyFeedContext();
 assert.deepEqual(lean.meta('productionSupplies'),full.meta('productionSupplies'));
 for(const [key,row]of lean.operations){
  const original=full.operations.get(key).value;
  if(['production','production-department-move'].includes(row.kind)){
   assert.equal(row.value.status,original.status);assert.equal(row.value.updatedAt ?? null,original.updatedAt ?? null);assert.equal(row.value.steps,undefined);
  }else assert.deepEqual(row.value,original);
 }
 assert.equal(lean.operations.has('unrelated:history'),false);
 assert.equal(lean.meta('unrelatedHistory'),undefined);
 assert.deepEqual(lean.syncEvents(),full.syncEvents());
 await assert.rejects(lean.checkpoint(),{code:'lease_required'});
});

async function fixture(t) {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(';\n'));
  t.after(() => db.close());
  const store = new CloudStore(db);
  const env = {...bindings, RITM_CLOUD_WRITES_ENABLED:'true', RITM_CLOUD_CUTOVER_ID:'memory', RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)};
  await store.withScope(async s => {
    s.meta('migrationReady', true);
    s.meta('cloudCutover', {id:'memory', localWriterDisabled:true});
    s.meta('productionSupplies', [{id:'supply', parts:[]}]);
    s.meta('rollPrintingAdditionalSheets', [{gid:5,name:'OZON ТЕСТ'}]);
    s.meta('printingMoveRevision', 'revision');
    s.meta('unrelatedHistory', {payload:'not needed for a snapshot'});
    s.saveProductionSupplyOperation({id:crypto.randomUUID(),status:'verified',action:'create',steps:[{plan:{payload:'history '.repeat(150000)}}]});
    s.putOperation('production-department-move', {id:'move',status:'uncertain',input:{article:'PENDING-SKU'}});
    s.saveTransferPreview('preview',Date.now()+60000,JSON.stringify({items:[{department:'box',uid:'u',sku:'A',quantity:7}]}));
    s.saveSyncEvent({id:'transfer',action:'transfer',outcome:'synced',created_at:Date.now(),next_attempt_at:0,delivered_at:Date.now(),payload:JSON.stringify({previewId:'preview',transfer:{department:'box',sheetId:7,name:'OZON ТЕСТ',keys:['uid:u|A']}})});
  });
  return {db,store,env};
}

test('snapshot context preserves move guards and explicit transfer quantities without historical write plans', async t => {
  const {store} = await fixture(t);
  const full = await store.scope(), context = await store.snapshotContext();
  assert.equal(context.meta('migrationReady'), true);
  assert.equal(context.meta('printingMoveRevision'), 'revision');
  assert.deepEqual(context.meta('productionSupplies'), full.meta('productionSupplies'));
  assert.deepEqual(context.meta('rollPrintingAdditionalSheets'), full.meta('rollPrintingAdditionalSheets'));
  assert.equal(context.meta('unrelatedHistory'), undefined);
  assert.equal(context.operations.size, 1);
  assert.equal(context.operations.get('production-department-move:move').value.input.article, 'PENDING-SKU');
  assert.deepEqual(new AssemblyTransferService(context,{backfill:false}).links(),new AssemblyTransferService(full,{backfill:false}).links());
  await assert.rejects(context.checkpoint(), {code:'lease_required'});
});

test('a lean refresh still refuses an unresolved move and keeps the last confirmed snapshot', async t => {
  const {store,env} = await fixture(t);
  const lease = await store.acquire('refresh:printing');
  await store.saveSnapshot('printing',{ok:true,events:[{id:'saved-fact'}]},lease);
  await store.release(lease);
  store.scope = async () => {throw Error('Do not load the complete write history for a report');};
  let requests = 0;
  const result = await refreshSnapshot('printing',env,store,{fetcher:async()=>{requests++;throw Error('No Google call while a move is unresolved');}});
  assert.equal(requests,0);
  assert.equal(result.refreshFailure.code,'printing_move_needs_review');
  assert.match(result.staleReason,/PENDING-SKU/);
  assert.deepEqual(result.events,[{id:'saved-fact'}]);
  assert.equal(await store.leaseIsActive('refresh:printing'),false);
});
