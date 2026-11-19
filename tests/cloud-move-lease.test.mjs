import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudStore} from '../worker/cloud/store.js';
import {LocalD1} from './helpers/d1-sqlite.mjs';
import {cloudSchemaStatements} from './helpers/cloud-schema.mjs';

function fixture(){const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));let now=Date.now();const store=new CloudStore(db,{now:()=>now});return {db,store,advance:ms=>{now+=ms;}};}

test('move waits for a competing writer and executes its callback exactly once',async()=>{
 const f=fixture();try{
  const first=await f.store.acquire();let polls=0,writes=0;
  const result=await f.store.withScope(async scope=>{writes++;scope.meta('testResult','saved');return 'verified';},{waitMs:5000,wait:async ms=>{f.advance(ms);if(++polls===2)await f.store.release(first);}});
  assert.equal(result,'verified');assert.equal(writes,1);assert.equal(polls,2);assert.equal((await f.store.scope()).meta('testResult'),'saved');assert.equal(await f.store.leaseIsActive(),false);
 }finally{f.db.close();}
});

test('move does not steal or clear an active lease when bounded wait expires',async()=>{
 const f=fixture();try{
  await f.store.acquire();let writes=0;
  await assert.rejects(f.store.withScope(async()=>{writes++;},{waitMs:1500,wait:async ms=>f.advance(ms)}),{code:'cloud_operation_busy'});
  assert.equal(writes,0);assert.equal(await f.store.leaseIsActive(),true);
 }finally{f.db.close();}
});

test('callback failure never retries production writes and always releases owned lease',async()=>{
 const f=fixture();try{
  let writes=0;await assert.rejects(f.store.withScope(async()=>{writes++;throw Object.assign(Error('busy after external write'),{code:'cloud_operation_busy'});},{waitMs:5000,wait:async()=>assert.fail('must not retry callback')}),{code:'cloud_operation_busy'});
  assert.equal(writes,1);assert.equal(await f.store.leaseIsActive(),false);
 }finally{f.db.close();}
});
