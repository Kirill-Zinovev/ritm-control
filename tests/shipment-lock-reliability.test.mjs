import test from "node:test";
import assert from "node:assert/strict";
import { currentShipmentLockSnapshot } from "../worker/cloud/runtime.js";
import { deliverShipmentLockEvent, setShipmentLocks, shipmentLock } from "../worker/cloud/shipmentLocks.js";

const id = "RITM-ROLL-123";
const request1 = "11111111-1111-4111-8111-111111111111";
const request2 = "22222222-2222-4222-8222-222222222222";
function scopeFixture() {
  return {
    lease: {}, operations: new Map(), checkpoints: 0,
    putOperation(kind, value) { this.operations.set(`${kind}:${value.id}`, {kind, value: structuredClone(value)}); },
    async checkpoint() { this.checkpoints++; },
  };
}

test("lock and unlock become visible only after Assembly confirms", async () => {
  const scope = scopeFixture();
  const delivered = [];
  const deliver = async event => { delivered.push(event); return true; };
  const closed = await setShipmentLocks(scope, {shipmentIds:[id], locked:true, requestId:request1, deliver});
  assert.equal(closed.confirmed, true);
  assert.equal(shipmentLock(scope,id).status, "locked");
  const opened = await setShipmentLocks(scope, {shipmentIds:[id], locked:false, requestId:request2, deliver});
  assert.equal(opened.confirmed, true);
  assert.equal(shipmentLock(scope,id).status, "unlocked");
  assert.deepEqual(delivered.map(event => event.locked), [true, false]);
});

test("unconfirmed delivery remains pending and retries the same event", async () => {
  const scope = scopeFixture();
  const pending = await setShipmentLocks(scope, {shipmentIds:[id], locked:true, requestId:request1, deliver:async()=>false});
  assert.equal(pending.confirmed, false);
  assert.equal(shipmentLock(scope,id).status, "locking");
  assert.equal(shipmentLock(scope,id).locked, true);
  let retried;
  const confirmed = await setShipmentLocks(scope, {shipmentIds:[id], locked:true, requestId:request1, deliver:async event=>{retried=event; return true;}});
  assert.equal(retried.eventId, request1);
  assert.equal(confirmed.confirmed, true);
  assert.equal(shipmentLock(scope,id).status, "locked");
});

test("Assembly receipt works with Workers redirect rules", async () => {
  const bindings = {RITM_ASSEMBLY_WEB_APP_URL:`https://script.google.com/macros/s/${"a".repeat(30)}/exec`, RITM_ASSEMBLY_SYNC_SECRET:"a".repeat(64)};
  const event = {v:1,eventId:request1,action:"shipment-lock",issuedAt:Date.now(),shipmentIds:[id],locked:true};
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({url,method:init.method,redirect:init.redirect});
    if (init.redirect === "error") throw new TypeError("unsupported redirect mode");
    if (calls.length === 1) return new Response(null,{status:302,headers:{location:"https://script.googleusercontent.com/receipt"}});
    return Response.json({ok:true,status:"synced",eventId:request1});
  };
  assert.equal(await deliverShipmentLockEvent(bindings,event,fetcher),true);
  assert.deepEqual(calls.map(call=>[call.method,call.redirect]),[["POST","manual"],["GET","manual"]]);
});

test("Assembly receipt refuses an unexpected second redirect", async () => {
  const bindings = {RITM_ASSEMBLY_WEB_APP_URL:`https://script.google.com/macros/s/${"a".repeat(30)}/exec`, RITM_ASSEMBLY_SYNC_SECRET:"a".repeat(64)};
  const event = {v:1,eventId:request1,action:"shipment-lock",issuedAt:Date.now(),shipmentIds:[id],locked:true};
  let calls=0;
  const fetcher=async()=>++calls===1 ? new Response(null,{status:302,headers:{location:"https://script.googleusercontent.com/receipt"}}) : new Response(null,{status:302,headers:{location:"https://untrusted.example/"}});
  assert.equal(await deliverShipmentLockEvent(bindings,event,fetcher),false);
  assert.equal(calls,2);
});

test("stale shipment snapshot refreshes before lock is allowed", async () => {
  let snapshot = {at:0, value:{sheets:[]}};
  const store = {now:()=>1000000, snapshot:async()=>snapshot};
  const result = await currentShipmentLockSnapshot({}, store, {refresh:async()=>{snapshot={at:1000000,value:{sheets:[]}};return {stale:false};}});
  assert.equal(result.at, 1000000);
});

test("unavailable source does not permit changing the lock", async () => {
  const store = {now:()=>1000000, snapshot:async()=>({at:0,value:{sheets:[]}})};
  await assert.rejects(currentShipmentLockSnapshot({}, store, {refresh:async()=>({stale:true,refreshFailed:true})}), error=>error.code === "shipment_lock_snapshot_stale");
});

test("a simultaneous refresh can finish before the lock is checked", async () => {
  let snapshot = {at:0,value:{sheets:[]}};
  const store = {now:()=>1000000,snapshot:async()=>snapshot};
  const result = await currentShipmentLockSnapshot({}, store, {refresh:async()=>{throw Object.assign(new Error("busy"),{code:"cloud_operation_busy"});},wait:async()=>{snapshot={at:1000000,value:{sheets:[]}};}});
  assert.equal(result.at,1000000);
});
