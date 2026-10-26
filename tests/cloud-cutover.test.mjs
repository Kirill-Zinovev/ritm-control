import assert from 'node:assert/strict';
import test from 'node:test';
import {LocalD1} from './helpers/d1-sqlite.mjs';
import {cloudSchemaStatements} from './helpers/cloud-schema.mjs';
import {bindings} from './cloud-env.mjs';
import {CloudStore} from '../worker/cloud/store.js';
import {recordCutover} from '../worker/cloud/cutover.js';
import {cloudApi,maintenance} from '../worker/cloud/runtime.js';
import {mcp} from '../worker/cloud/mcp.js';
import {exportCloud} from '../worker/cloud/export.js';
import {validateMigration} from '../worker/cloud/migration.js';
test('cloud recovery export keeps post-cutover operations and saved receipts without secrets',async()=>{
 const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));const store=new CloudStore(db),env={...bindings,DB:db,RITM_GOOGLE_WRITER_JSON:'secret-must-not-export'};
 try{
  await assert.rejects(exportCloud(env,store),{code:'migration_not_imported'});
  await store.withScope(async s=>{s.meta('migrationReady',true);s.putOperation('roll',{id:crypto.randomUUID(),status:'verified',createdAt:new Date().toISOString(),result:{verifiedQuantity:17}});});
  const value=await exportCloud(env,store);assert.equal(value.payload.rollOperations.length,1);assert.equal(value.payload.rollOperations[0].result.verifiedQuantity,17);assert.ok(!JSON.stringify(value).includes('secret-must-not-export'));await validateMigration(value,env);
 }finally{db.close();}
});
test('cutover needs matching import, explicit disabled local writer and settled operations',async()=>{
 const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));const store=new CloudStore(db);
 const env={...bindings,DB:db,RITM_CLOUD_IMPORT_ENABLED:'true',RITM_CLOUD_WRITES_ENABLED:'false',RITM_CLOUD_CUTOVER_ID:'test-cutover'};
 const input={explicitCutoverApproval:true,localWriterDisabled:true,migrationDigest:'a'.repeat(64)};
 try{
  await assert.rejects(recordCutover(input,env,store),{code:'cutover_not_ready'});
  await db.prepare('INSERT INTO cloud_imports(id,source_digest,imported_at,manifest) VALUES(?,?,?,?)').bind('test',input.migrationDigest,Date.now(),'{}').run();
  await store.withScope(async s=>{s.meta('migrationReady',true);s.meta('productionSupplyOperations',[{id:'unfinished',status:'partial'}]);});
  await assert.rejects(recordCutover(input,env,store),{code:'cutover_not_ready'});
  await store.withScope(async s=>s.meta('productionSupplyOperations',[{id:'unfinished',status:'verified'}]));
  await assert.rejects(recordCutover({...input,localWriterDisabled:false},env,store),{code:'cutover_not_ready'});
  const first=await recordCutover(input,env,store),again=await recordCutover(input,env,store);assert.deepEqual(first.cutover,again.cutover);assert.equal(first.writesEnabled,false);
  await assert.rejects(recordCutover(input,{...env,RITM_CLOUD_WRITES_ENABLED:'true'},store),{code:'cutover_not_ready'});
 }finally{db.close();}
});
test('maintenance token cannot import; migration service closes when flag disabled',async()=>{
 const token='migration-test-'.repeat(4),env={...bindings,RITM_OWNER_USER_IDS:'owner',RITM_GOOGLE_READER_JSON:'{}',RITM_CLOUD_IMPORT_ENABLED:'true',RITM_MIGRATION_TOKEN:token,RITM_MAINTENANCE_TOKEN:'other-token-'.repeat(4),DB:{}};
 const req=()=>new Request('https://ritm.test/api/cloud/state',{headers:{authorization:'Bearer '+token,'content-type':'application/json'}});
 assert.equal((await cloudApi(req(),{...env,RITM_CLOUD_IMPORT_ENABLED:'false'})).status,403);
 assert.equal((await cloudApi(req(),{...env,RITM_MIGRATION_TOKEN:'different-token-'.repeat(4)})).status,403);
});
test('MCP refresh requires trusted allowed owner and fixed arguments; read-only maintenance never drains outbox',async()=>{
 const env={...bindings,RITM_OWNER_USER_IDS:'owner'};
 const request=(name,args={},headers={})=>new Request('https://ritm.test/mcp',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
 assert.equal((await mcp(request('ritm_refresh'),env)).status,401);
 assert.equal((await mcp(request('ritm_refresh',{}, {'oai-authenticated-user-id':'stranger'}),env)).status,403);
 assert.equal((await mcp(request('ritm_refresh',{createSupply:true},{'oai-authenticated-user-id':'owner'}),env)).status,400);
 const result=await maintenance(env,{withScope(){throw new Error('No writer allowed');}},{refresh:false});assert.equal(result.deliverySkipped,true);
});
