import test from 'node:test';
import assert from 'node:assert/strict';
import {createMoveReadSession} from '../worker/cloud/productionMoveReads.js';

test('duplicate preflight reads share one request and return independent snapshots',async()=>{
  let reads=0;const session=createMoveReadSession({box:{metadata:async()=>{reads++;return [{title:'source'}];}}});
  const [a,b]=await Promise.all([session.writers.box.metadata(),session.writers.box.metadata()]);a[0].title='changed';
  assert.equal(reads,1);assert.equal(b[0].title,'source');
});
for(const mutation of ['request','execute','gateway'])test('all reads are fresh after the first '+mutation+' mutation, including the other department',async()=>{
  let current=1,reads=0;
  const writer={metadata:async()=>{reads++;return current;},request:async()=>{current++;},execute:async()=>{current++;}};
  const session=createMoveReadSession({box:writer,roll:{metadata:writer.metadata}}),box=session.writers.box;
  await box.metadata();await session.writers.roll.metadata();
  if(mutation==='gateway'){session.stop();current++;}else if(mutation==='request')await box.request('synthetic',{method:'POST',write:true});else await box.execute({});
  assert.equal(await box.metadata(),2);assert.equal(await session.writers.roll.metadata(),2);current=3;
  assert.equal(await box.metadata(),3);assert.equal(reads,5);
});
test('failed read is evicted and a new request is attempted',async()=>{
  let reads=0;const session=createMoveReadSession({box:{grid:async()=>{if(++reads===1)throw Error('unavailable');return reads;}}});
  await assert.rejects(session.writers.box.grid('s',504),/unavailable/);assert.equal(await session.writers.box.grid('s',504),2);
});
test('nested prepareAppend metadata and grid reuse the same preflight reads',async()=>{
  let calls=0;const writer={metadata:async()=>{calls++;return [];},grid:async()=>{calls++;return {};},prepareAppend:async function(){await this.metadata();await this.grid('s',504);}};
  const box=createMoveReadSession({box:writer}).writers.box;await box.metadata();await box.grid('s',504);await box.prepareAppend();assert.equal(calls,2);
});
