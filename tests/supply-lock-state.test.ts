import { test } from "node:test";
import { strict as assert } from "node:assert";
import { supplyLockState, type SupplyLockRecord } from "../src/supplyLockState";

const locked: SupplyLockRecord = { shipmentId: "roll", locked: true, pending: false, status: "locked" };
const box: SupplyLockRecord = { ...locked, shipmentId: "box" };

test("closed only when all linked sections are locked", () => {
  assert.equal(supplyLockState(["roll", "box"], [locked, box]), "closed");
  assert.equal(supplyLockState(["roll", "roll"], [locked]), "closed");
  assert.equal(supplyLockState(["roll", "box"], [locked]), "partial");
  assert.equal(supplyLockState(["box"], [locked]), "open");
});

test("unknown and changing states do not appear as confirmed", () => {
  assert.equal(supplyLockState(["roll"], null), "unknown");
  assert.equal(supplyLockState([], []), "unknown");
  assert.equal(supplyLockState(["roll"], [{ ...locked, status: "unlocking", pending: true }]), "pending");
  assert.equal(supplyLockState(["roll"], [{ ...locked, locked: false }]), "unknown");
});
