import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudStore} from '../worker/cloud/store.js';
import {maintenance} from '../worker/cloud/runtime.js';
import {assemblyV2Feed,feedSignature} from '../worker/cloud/assemblyV2Feed.js';
import {LocalD1} from './helpers/d1-sqlite.mjs';
import {cloudSchemaStatements} from './helpers/cloud-schema.mjs';
import {bindings} from './cloud-env.mjs';

async function fixture() {
  const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));
  const store=new CloudStore(db);
  const env={...bindings,RITM_CLOUD_WRITES_ENABLED:'true',RITM_CLOUD_CUTOVER_ID:'outbox-test',RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64),RITM_ASSEMBLY_V2_FEED_SECRET:'b'.repeat(64)};
  await store.withScope(async scope=>{
    scope.meta('migrationReady',true);
    scope.meta('cloudCutover',{id:'outbox-test',localWriterDisabled:true});
  });
  const refresh=await store.acquire('refresh:printing');
  await store.saveSnapshot('printing',{ok:true,quality:{status:'valid'},issues:[],supplies:[],sheets:[]},refresh);
  await store.release(refresh);
  const request=()=>{
    const at=String(store.now()),nonce=crypto.randomUUID(),path='/api/assembly-v2/feed';
    return new Request('https://ritm.test'+path,{headers:{'x-assembly-v2-at':at,'x-assembly-v2-nonce':nonce,'x-assembly-v2-signature':feedSignature(env.RITM_ASSEMBLY_V2_FEED_SECRET,{path,at,nonce})}});
  };
  return {db,store,env,request};
}

test('cloud maintenance never sends a pending legacy supply delivery',async()=>{
  const {db,store,env,request}=await fixture(), eventId=crypto.randomUUID();
  try{
    await store.withScope(async scope=>scope.saveSyncEvent({id:eventId,action:'create',created_at:Date.now(),next_attempt_at:0,attempts:0}));
    const before=db.db.prepare('SELECT * FROM cloud_sync_events WHERE id=?').get(eventId);
    await maintenance(env,store,{refresh:false,fetcher:async()=>assert.fail("Unexpected network delivery")});
    assert.deepEqual(db.db.prepare('SELECT * FROM cloud_sync_events WHERE id=?').get(eventId),before);
    assert.equal(await store.leaseIsActive('production'),false);
    assert.equal((await assemblyV2Feed(request(),env,store)).status,200);
  }finally{db.close();}
});

test('missing, mismatched and malformed delivery contexts never authorize an active writer snapshot',async()=>{
  const {db,store,env,request}=await fixture(),lease=await store.acquire();
  try{
    assert.equal(await store.productionSnapshotReadAllowed(),false);
    const scope=await store.scope(lease);
    for(const context of [
      {version:1,owner:'another-owner',fence:lease.fence,sourceWrites:false},
      {version:1,owner:lease.owner,fence:lease.fence-1,sourceWrites:false},
      {version:1,owner:lease.owner,fence:lease.fence,sourceWrites:true},
    ]){
      scope.meta('assemblyOutboxReadLease',context);await scope.checkpoint();
      assert.equal(await store.productionSnapshotReadAllowed(),false);
      await assert.rejects(assemblyV2Feed(request(),env,store),{code:'assembly_v2_source_busy'});
    }
    db.db.prepare("UPDATE cloud_state SET value='broken' WHERE key='assemblyOutboxReadLease'").run();
    assert.equal(await store.productionSnapshotReadAllowed(),false);
  }finally{await store.release(lease);db.close();}
});

test('an exact delivery context cannot hide an unresolved production operation',async()=>{
  const {db,store,env,request}=await fixture(),lease=await store.acquire();
  try{
    const scope=await store.scope(lease);
    scope.meta('assemblyOutboxReadLease',{version:1,owner:lease.owner,fence:lease.fence,sourceWrites:false});
    scope.saveProductionSupplyOperation({id:crypto.randomUUID(),status:'partial',steps:[],createdAt:new Date().toISOString()});
    await scope.checkpoint();
    assert.equal(await store.productionSnapshotReadAllowed(),true);
    await assert.rejects(assemblyV2Feed(request(),env,store),{code:'assembly_v2_source_busy'});
  }finally{await store.release(lease);db.close();}
});
