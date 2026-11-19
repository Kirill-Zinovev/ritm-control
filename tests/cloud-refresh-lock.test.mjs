import assert from "node:assert/strict";
import test from "node:test";
import { readSnapshot,refreshSnapshot } from "../worker/cloud/runtime.js";
import { bindings } from "./cloud-env.mjs";
import { LocalD1 } from "./helpers/d1-sqlite.mjs";
import { cloudSchemaStatements } from "./helpers/cloud-schema.mjs";

test('a confirmed new supply invalidates a young snapshot and schedules an automatic retry during another refresh',async t=>{
 const now=Date.now();let refreshes=0;
 const store=snapshotStore(t,{now:()=>now,snapshot:async()=>({at:now-100,value:{ok:true,productionSupplyRevision:now-100}}),readMeta:async key=>key==='productionSupplyRevision'?now:null,acquire:async()=>{refreshes++;throw Object.assign(Error('busy'),{code:'cloud_operation_busy'});}});
 const result=await readSnapshot('printing',new URL('https://ritm.test/api/printing'),bindings,store,{});
 assert.equal(refreshes,1);assert.equal(result.stale,true);assert.equal(result.refreshInProgress,true);assert.match(result.staleReason,/Новая поставка/);assert.equal(result.refreshRetryAfterMs,1500);
});

function snapshotStore(t, state) {
  // readSnapshot also overlays the real v2 work table; these tests isolate
  // refresh/freshness behavior with an empty but valid work database.
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(';\n'));
  t.after(() => db.close());
  return {db, ...state};
}

test("competing refresh keeps a still-fresh verified snapshot writable", async t => {
  const now = Date.now();
  const store = snapshotStore(t, {
    now: () => now,
    snapshot: async () => ({ at: now - 60_000, value: { ok: true, updatedAt: new Date(now - 60_000).toISOString() } }),
    acquire: async () => { throw Object.assign(new Error("busy"), { code: "cloud_operation_busy" }); },
  });
  const result = await readSnapshot("printing", new URL("https://ritm.test/api/printing?refresh=1"), bindings, store, {});
  assert.equal(result.stale, false);
  assert.equal(result.refreshFailed, false);
  assert.equal(result.refreshInProgress, true);
});

test("competing refresh keeps an expired snapshot stale and blocks writes", async t => {
  const now = Date.now();
  const store = snapshotStore(t, {
    now: () => now,
    snapshot: async () => ({ at: now - 6 * 60_000, value: { ok: true, updatedAt: new Date(now - 6 * 60_000).toISOString() } }),
    acquire: async () => { throw Object.assign(new Error("busy"), { code: "cloud_operation_busy" }); },
  });
  const result = await readSnapshot("printing", new URL("https://ritm.test/api/printing?refresh=1"), bindings, store, {});
  assert.equal(result.stale, true);
  assert.equal(result.refreshFailed, false);
  assert.equal(result.refreshInProgress, true);
});

test('completed move invalidates even a seconds-old snapshot without a forced refresh',async t=>{
 const now=Date.now();let refreshes=0;
 const store=snapshotStore(t,{now:()=>now,snapshot:async()=>({at:now-100,value:{ok:true,productionMoveRevision:'old'}}),readMeta:async key=>key==='printingMoveRevision'?'new':null,acquire:async()=>{refreshes++;throw Object.assign(Error('busy'),{code:'cloud_operation_busy'});}});
 const result=await readSnapshot('printing',new URL('https://ritm.test/api/printing'),bindings,store,{});
 assert.equal(refreshes,1);assert.equal(result.stale,true);assert.equal(result.refreshInProgress,true);assert.equal(result.refreshRetryAfterMs,1500);assert.match(result.staleReason,/Перенос завершён/);
});

test('snapshot with the committed move revision stays cached and does not scan every source',async t=>{
 const now=Date.now();const store=snapshotStore(t,{now:()=>now,snapshot:async()=>({at:now,value:{ok:true,productionMoveRevision:'current',supplies:[{article:'MOVED',sourceId:'roll-printing'}]}}),readMeta:async key=>key==='printingMoveRevision'?'current':null,acquire:async()=>{throw Error('Unnecessary source scan');}});
 const result=await readSnapshot('printing',new URL('https://ritm.test/api/printing'),bindings,store,{});
 assert.equal(result.stale,false);assert.equal(result.supplies[0].sourceId,'roll-printing');
});

test('refresh never publishes a half-copied active transfer as a complete composition',async()=>{
 const now=Date.now();let released=false,reads=0;
 const store={now:()=>now,snapshot:async()=>({at:now-100,value:{ok:true,productionMoveRevision:'old'}}),acquire:async()=>({name:'refresh:printing'}),release:async()=>{released=true;},scope:async()=>({meta:key=>key==='migrationReady'?true:'moving:pending',operations:new Map([['move',{kind:'production-department-move',value:{status:'uncertain'}}]])}),saveSnapshot:async()=>{throw Error('Partial composition must not be saved');}};
 const result=await refreshSnapshot('printing',bindings,store,{fetcher:async()=>{reads++;throw Error('No Google traffic while moving');}});
 assert.equal(result.stale,true);assert.equal(result.refreshInProgress,false);assert.equal(result.refreshFailed,true);assert.equal(result.refreshRetryAfterMs,60000);assert.equal(reads,0);assert.equal(released,true);
 assert.equal(result.refreshFailure.code,'printing_move_needs_review');assert.match(result.staleReason,/требует проверки/);
});

test('uncertain group names its articles and never claims it is merely refreshing',async()=>{
 const value={ok:true,events:[{id:'saved-work',area:42}],supplies:[{article:'saved-composition'}]},before=structuredClone(value),now=Date.now();let reads=0;
 const store={now:()=>now,snapshot:async()=>({at:now-100,value}),acquire:async()=>({}),release:async()=>{},scope:async()=>({meta:()=>true,operations:new Map([['move',{kind:'production-department-move',value:{status:'uncertain',input:{items:[{article:'NT0039.A8009'},{article:'NS0004.A8048'}]}}}]])}),saveSnapshot:async()=>{throw Error('Must preserve the snapshot');}};
 const result=await refreshSnapshot('printing',bindings,store,{fetcher:async()=>{reads++;throw Error('No Google read');}});
 assert.match(result.staleReason,/NT0039.A8009, NS0004.A8048.*требует проверки/);assert.equal(result.refreshInProgress,false);assert.equal(reads,0);assert.deepEqual(value,before);assert.deepEqual(result.events,value.events);
});

test('running transfer keeps the automatic short refresh retry',async()=>{
 const now=Date.now(),store={now:()=>now,snapshot:async()=>({at:now,value:{ok:true}}),acquire:async()=>({}),release:async()=>{},scope:async()=>({meta:()=>true,operations:new Map([['move',{kind:'production-department-move',value:{status:'running',input:{article:'SKU'}}}]])})};
 const result=await refreshSnapshot('printing',bindings,store,{});
 assert.equal(result.refreshInProgress,true);assert.equal(result.refreshFailed,false);assert.equal(result.refreshRetryAfterMs,1500);
});
