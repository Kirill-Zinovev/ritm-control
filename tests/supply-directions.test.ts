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
