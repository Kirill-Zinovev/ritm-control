import test from "node:test";
import assert from "node:assert/strict";
import {
  availableOperations,
  boxCapacity,
  boxingBlockedReason,
  isFinished,
  readiness,
} from "../shared/assembly";
import type { Position, Supply } from "../shared/model";

test("по позиции без магазина подсказка различает заполненный справочник и отсутствующие данные", () => {
  const held = { ready: false, sourceActive: false, storeNeedsReview: true, unitsPerBox: null,
    catalog: { store: "2", unitsPerBox: 108 } } as Position;
  const supply = { market: "OZON", store: "Не подтверждён", sourceActive: true } as Supply;
  const guidance = boxingBlockedReason(held, supply);
  assert.match(guidance, /уже указан магазин 2, 108 шт./);
  assert.match(guidance, /подтвердить магазин прямо в карточке позиции/);
  assert.match(boxingBlockedReason({ ...held, catalog: null }, supply), /поле «Магазин»/);
  assert.match(boxingBlockedReason(held, { ...supply, sourceLocked: true }), /откройте её замок в РИТМ/);
  assert.match(boxingBlockedReason({ ...held, sourceActive: true, ready: true, storeNeedsReview: false },
    { ...supply, store: "2" }), /укажите тип и вместимость короба/);
});

test("full mixed cartons are not suggested because of floating point residue", () => {
  assert.equal(boxCapacity(0.9999999999999999, 100), 0);
  assert.equal(boxCapacity(1, 100), 0);
  assert.equal(boxCapacity(0.95, 10), 0);
  assert.equal(boxCapacity(0.1 + 0.2, 100), 70);
  assert.equal(boxCapacity(0, null), 0);
});

test("old Assembly completion keeps unallocated surplus in work", () => {
  assert.equal(isFinished({ plan: 100, packing: 120, boxed: 100 }), false);
  assert.equal(isFinished({ plan: 100, packing: 120, boxed: 120 }), true);
  assert.equal(isFinished({ plan: 0, packing: 120, boxed: 120 }), false);
  assert.equal(isFinished({ plan: 100, packing: 80, boxed: 80 }), false);
});
test("readiness retains both finishing stages and original rounding", () => {
  assert.equal(readiness([{ plan: 100, packing: 100, boxed: 0 }]), 50);
  assert.equal(readiness([{ plan: 100, packing: 100, boxed: 100 }]), 100);
  assert.equal(readiness([{ plan: 100, packing: 75, boxed: 0 }]), 37);
  assert.equal(readiness([{ plan: 100, packing: 101, boxed: 100 }]), 101);
  assert.equal(readiness([{ plan: 0, packing: 100, boxed: 100 }]), 0);
});
test("manual cutting remains available alongside the required machine cutting", () => {
  const position = {
    plan: 100,
    cutOperation: "cut",
    cut: 0,
    assembly: 0,
    packing: 0,
  } as Position;
  assert.deepEqual(availableOperations(position), ["cut", "assembly", "packing"]);
  assert.deepEqual(availableOperations({ ...position, assembly: 1 }), [
    "cut",
    "assembly",
    "packing",
  ]);
  assert.deepEqual(availableOperations({ ...position, plan: 0 }), ["assembly", "packing"]);
});
