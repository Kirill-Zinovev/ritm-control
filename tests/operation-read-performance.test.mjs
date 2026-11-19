import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudStore} from '../worker/cloud/store.js';
import {LocalD1} from './helpers/d1-sqlite.mjs';
import {cloudSchemaStatements} from './helpers/cloud-schema.mjs';
import {createServices} from '../worker/cloud/services.js';
import {bindings} from './cloud-env.mjs';

function setup(t){const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));t.after(()=>db.close());return new CloudStore(db);}
test('status reads select only the requested operation kind and identity without historical plans',async t=>{
 const store=setup(t);
 await store.withScope(async s=>{for(const kind of ['production','production-department-move','production-department-move-batch'])for(const id of ['a','b'])s.putOperation(kind,{id,status:'uncertain',input:{uid:id},proof:{receipt:id}});});
 const scope=await store.operationReadScope('production-department-move','a');
 assert.equal(scope.operations.size,1);assert.equal(scope.operations.get('production-department-move:a').value.proof.receipt,'a');
 assert.equal((await store.operationReadScope('production-department-move')).operations.size,2);
 assert.equal((await store.operationReadScope('production-department-move','missing')).operations.size,0);
 await assert.rejects(scope.checkpoint(),{code:'lease_required'});
});
test('each production write has exactly one durable guard; rejected guard never reaches Google',async t=>{
 const store=setup(t), lease=await store.acquire(),scope=await store.scope(lease);
 scope.meta('migrationReady',true);scope.meta('cloudCutover',{id:'test',localWriterDisabled:true});
 const env={...bindings,RITM_CLOUD_WRITES_ENABLED:'true',RITM_CLOUD_CUTOVER_ID:'test',RITM_GOOGLE_READER_JSON:'{}',RITM_GOOGLE_WRITER_JSON:'{}'};
 let checkpoints=0,writes=0,blocked=false;
 scope.checkpoint=async()=>{checkpoints++;if(blocked)throw Error('lease lost');};
 const services=await createServices(env,scope,{fetcher:async()=>{writes++;return Response.json({});}});
 const writer=services.production.writers.box;
 writer.credentials.cached={token:'synthetic',expires:Date.now()+3600000};
 const url='https://sheets.googleapis.com/v4/spreadsheets/'+writer.documentId+':batchUpdate';
 await writer.request(url,{method:'POST',write:true,body:{requests:[]}});
 assert.equal(checkpoints,1);assert.equal(writes,1);
 blocked=true;
 await assert.rejects(writer.request(url,{method:'POST',write:true,body:{requests:[]}}),e=>e.beforeExternalWrite===true);
 assert.equal(checkpoints,2);assert.equal(writes,1);
});

