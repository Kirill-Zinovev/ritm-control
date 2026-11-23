import test from "node:test";
import assert from "node:assert/strict";
import { currentShipmentLockSnapshot, recoverPendingShipmentLock } from "../worker/cloud/runtime.js";
import { setShipmentLocks, shipmentLock } from "../worker/cloud/shipmentLocks.js";

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

test("RITM stores the canonical lock and unlock with increasing import revisions", async () => {
  const scope = scopeFixture();
  const now = () => Date.parse("2026-11-19T10:00:00Z");
  const locked = await setShipmentLocks(scope, {shipmentIds:[id], locked:true, requestId:request1, now});
  assert.equal(locked.confirmed, true);
  assert.equal(shipmentLock(scope,id).locked, true);
  const reopened = await setShipmentLocks(scope, {shipmentIds:[id], locked:false, requestId:request2, now});
  assert.equal(reopened.confirmed, true);
  assert.equal(shipmentLock(scope,id).locked, false);
  assert.ok(Date.parse(reopened.locks[0].changedAt) > Date.parse(locked.locks[0].changedAt));
  assert.equal(scope.checkpoints, 2);
});

test("maintenance completes the already saved intent with its original event identity", async () => {
  const scope = scopeFixture();
  scope.putOperation("production-shipment-lock",{id,shipmentId:id,shipmentIds:[id],status:"locking",targetLocked:true,eventId:request1});
  const result=await recoverPendingShipmentLock({}, {withScope:async fn=>fn(scope)});
  assert.equal(result.confirmed,true); assert.equal(result.remaining,0);
  assert.equal(shipmentLock(scope,id).eventId,request1); assert.equal(shipmentLock(scope,id).status,"locked");
});

test("an existing physical lock is inherited until the canonical supply is explicitly opened", async () => {
  const scope=scopeFixture(), shipmentId="RITM-SUPPLY-"+request1;
  scope.putOperation("production-shipment-lock",{id,shipmentId:id,sourceOperationId:request1,status:"locked"});
  assert.equal(shipmentLock(scope,shipmentId).locked,true);
  await setShipmentLocks(scope,{shipmentIds:[shipmentId],locked:false,requestId:request2});
  assert.equal(shipmentLock(scope,shipmentId).locked,false);
});

test("maintenance does not deliver when no lock is pending", async () => {
  const scope=scopeFixture();
  const result=await recoverPendingShipmentLock({}, {withScope:async fn=>fn(scope)}, async()=>{throw new Error("unexpected delivery");});
  assert.deepEqual(result,{attempted:0,confirmed:true,remaining:0});
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
