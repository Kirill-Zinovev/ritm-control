import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSupplyDirections,
  directionProgress,
  directionJobReady,
  orderStore,
} from "../src/supplyDirectionData";
import type { DirectionJob } from "../src/supplyDirectionData";
import type { LiveOrder } from "../src/livePrinting";
const order = (extra: Partial<LiveOrder> = {}): LiveOrder => ({
  uid: "u",
  row: 5,
  sheetId: 1,
  sheetName: "job",
  article: "SKU",
  quantity: 10,
  plannedArea: 1,
  shop: "1",
  shopCatalogStatus: "matched",
  packed: 10,
  ...extra,
});
const job = (
  id: string,
  name: string,
  orders: LiveOrder[] = [order()],
): DirectionJob => ({ id, name, orders, missingPositions: 0, lock: "open" });
test("directions normalize known cities but preserve every original job, store and marketplace", () => {
  const jobs = [
    job("a", "OZON СПБ Xerox"),
    job("b", "OZON Санкт-Петербург 2-GO", [order({ shop: "2" })]),
    job("c", "WB СПБ"),
    job("d", "OZON НЕИЗВЕСТНО"),
    job("e", "OZON НЕИЗВЕСТНО"),
    job("f", "OZON Москва СПБ"),
  ];
  const groups = buildSupplyDirections([...jobs, jobs[0]]);
  assert.equal(groups.length, 5);
  assert.deepEqual(
    groups[0].jobs.map((j) => j.id),
    ["a", "b"],
  );
  assert.equal(groups[0].jobs.flatMap((j) => j.orders).length, 2);
  assert.equal(
    orderStore(order({ shopCatalogStatus: "ambiguous", shop: "1" })),
    "",
  );
});
test("progress caps each position and never masks missing facts or counts another stage", () => {
  const orders = [
    order({
      quantity: 10,
      packed: 15,
      assemblyMachineCut: 4,
      assemblyManualCut: 6,
    }),
    order({
      uid: "v",
      quantity: 30,
      packed: null,
      assemblyMachineCut: 0,
      assemblyManualCut: 30,
    }),
  ];
  assert.equal(directionProgress(orders, "packed").percent, null);
  assert.equal(directionProgress(orders, "packed").done, 10);
  assert.equal(directionProgress(orders, "assemblyMachineCut").done, 4);
  assert.equal(directionProgress(orders, "assemblyManualCut").percent, 90);
  assert.equal(directionJobReady(job("a", "OZON Москва", orders)), false);
  assert.equal(
    directionJobReady({ ...job("a", "OZON Москва"), missingPositions: 1 }),
    false,
  );
  assert.equal(directionJobReady(job("a", "OZON Москва")), true);
});

test("an incomplete city shows a rounded-down packing bound without declaring readiness", () => {
  const orders = [
    order({ quantity: 10, packed: null, packedConfirmed: 4 }),
    order({ uid: "b", quantity: 7, packed: 3 }),
  ];
  const progress = directionProgress(orders, "packed");
  assert.equal(progress.done, 7);
  assert.equal(progress.percent, null);
  assert.equal(progress.lowerPercent, 41);
  assert.equal(directionJobReady(job("a", "OZON Москва", orders)), false);
});

test("direction printing sums both departments and remains independent of assembly work", () => {
  const orders = [
    order({ sourceId: "roll-printing", quantity: 900, remainingPrint: 40, packed: 0, assemblyMachineCut: 0 }),
    order({ uid: "box", sourceId: "box-printing", quantity: 1040, printProgress: 1040, packed: 0, assemblyMachineCut: 0 }),
  ];
  const printed = directionProgress(orders, "printed");
  assert.equal(printed.plan, 1940);
  assert.equal(printed.done, 1900);
  assert.equal(printed.percent, 98);
  assert.equal(directionProgress(orders, "assemblyMachineCut").done, 0);
  assert.equal(directionJobReady(job("wb", "WB ДАЧА", orders)), false);
});

test("missing print facts stay unknown and a print run below plan cannot show 100 percent", () => {
  const orders = [
    order({ quantity: 1000, printProgress: 999 }),
    order({ uid: "unknown", quantity: 10, printProgress: null, packed: 10 }),
  ];
  const printed = directionProgress(orders, "printed");
  assert.equal(printed.done, 999);
  assert.equal(printed.known, 1);
  assert.equal(printed.percent, null);
  assert.equal(printed.lowerPercent, 98);
  assert.equal(directionProgress([orders[0]], "printed").percent, 99);
});
