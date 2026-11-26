import assert from "node:assert/strict";
import test from "node:test";
import { summarizeArkadySupply } from "../src/arkadySupplySummaryData";
import type { LiveOrder } from "../src/livePrinting";

function position(overrides: Partial<LiveOrder> = {}): LiveOrder {
  return {
    uid: "roll:17",
    sourceId: "roll-printing",
    sheetId: 71,
    sheetName: "OZON Ярославль",
    row: 17,
    article: "PT0001.A0277",
    quantity: 10,
    plannedArea: 0,
    ...overrides,
  };
}

test("summary includes both supply parts and distinguishes confirmed zero from absent facts", () => {
  const roll = position({ printProgress: 10, cutProgress: 0, packed: 0 });
  const box = position({
    uid: "box:20",
    sourceId: "box-printing",
    sheetId: 72,
    row: 20,
    quantity: 8,
    machine: "XEROX",
    planningPrinted: 16,
    planningPhysicalUnits: true,
    sheetsInProduct: 4,
    multiplicity: 2,
    packedConfirmed: 2,
  });
  const summary = summarizeArkadySupply([roll, box]);
  assert.equal(summary.positions, 2);
  assert.equal(summary.plan, 18);
  assert.deepEqual(
    summary.stages.map(({ stage, confirmed, observed, exact, complete }) => [
      stage,
      confirmed,
      observed,
      exact,
      complete,
    ]),
    [
      ["print", 18, 2, 2, true],
      ["cut", 0, 1, 1, false],
      ["packing", 2, 2, 1, false],
    ],
  );
  assert.equal(summarizeArkadySupply([position()]).stages[0].confirmed, null);
});

test("unknown linked quantities and missing positions never produce a shipment total or completion", () => {
  const verified = position({ printProgress: 10, cutProgress: 10, packed: 10 });
  const partial = summarizeArkadySupply([verified], { missingPositions: 2 });
  assert.equal(partial.positions, 3);
  assert.equal(partial.plan, null);
  assert.equal(partial.observedPlan, 10);
  assert.equal(partial.stages[0].confirmed, 10);
  assert.equal(partial.stages[0].complete, false);
  const knownPlan = summarizeArkadySupply([verified], {
    missingPositions: 2,
    plan: 30,
  });
  assert.equal(knownPlan.plan, 30);
  assert.equal(knownPlan.stages[0].complete, false);
  assert.equal(summarizeArkadySupply([verified], { plan: 5 }).plan, null);
});

test("excess output cannot complete another position and stale stages stay unconfirmed", () => {
  const over = position({ printProgress: 30, cutProgress: 10, packed: 10 });
  const short = position({ uid: "roll:18", row: 18, printProgress: 1 });
  const [print] = summarizeArkadySupply([over, short]).stages;
  assert.equal(print.plan, 20);
  assert.equal(print.recorded, 31);
  assert.equal(print.confirmed, 11);
  assert.equal(print.complete, false);
  const stale = summarizeArkadySupply([over], { snapshotStale: true });
  assert.equal(stale.stages[0].confirmed, 10);
  assert.equal(stale.stages[0].complete, false);
  const unavailable = summarizeArkadySupply([over], {
    packingAvailable: false,
  });
  assert.equal(unavailable.stages[2].confirmed, null);
  assert.equal(unavailable.stages[2].exact, 0);
});
