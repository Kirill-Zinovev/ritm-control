import test from "node:test";
import assert from "node:assert/strict";
import {
  assemblyAreaTotal,
  assemblyPackingTotal,
  assemblyTransferPositionKey,
  completeTotal,
  observedTotal,
  plannedAreaTotal,
  linkedAssemblyBoxSummary,
  rollCut,
  rollPrinted,
  rollPrintRemaining,
} from "../src/liveSupplyProgress";

test("Assembly supply totals include both departments and keep unknown rows visible", () => {
  const roll = [
    { plannedArea: 449.47, areaKnown: true, packed: 0 },
    { plannedArea: 0, areaKnown: false, packed: 125 },
  ];
  const box = [
    { plannedArea: 343.73, areaKnown: true, packed: null },
    { plannedArea: 0, areaKnown: false, packed: 75 },
  ];
  assert.deepEqual(assemblyAreaTotal([...roll, ...box], 1), {
    total: 793.2,
    observed: 2,
    missing: 3,
  });
  assert.deepEqual(assemblyPackingTotal([...roll, ...box], 1), {
    total: 200,
    observed: 3,
    missing: 2,
  });
});

test("box position keys match both UID and legacy row-based transfer keys", () => {
  assert.equal(
    assemblyTransferPositionKey({ rawUid: "box-7", row: 5, article: "SKU7" }),
    "uid:box-7|SKU7",
  );
  assert.equal(
    assemblyTransferPositionKey({ rawUid: null, row: 6, article: "SKU8" }),
    "row:6|SKU8",
  );
});

test("Assembly area and packing use only transferred box positions and live box quantities", () => {
  const roll = {
    sheet: { sourceId: "roll-printing", sheetId: 100, name: "OZON Москва" },
    orders: [],
  };
  const box = {
    sheet: { sourceId: "box-printing", sheetId: 200, name: "OZON Москва" },
    orders: [
      {
        uid: "200::row:5",
        rawUid: null,
        row: 5,
        sheetId: 200,
        sheetName: "OZON Москва",
        article: "BOX-A",
        quantity: 10,
        plannedArea: 3.5,
        areaKnown: true,
        packed: 4,
      },
      {
        uid: "200::other",
        rawUid: "other",
        row: 6,
        sheetId: 200,
        sheetName: "OZON Москва",
        article: "BOX-OTHER",
        quantity: 999,
        plannedArea: 100,
        areaKnown: true,
        packed: 500,
      },
    ],
  };
  const linked = linkedAssemblyBoxSummary(roll, [roll, box], [
    {
      name: "OZON Москва",
      boxSheetId: 200,
      targetRollSheetId: 100,
      boxRows: 1,
      boxQuantity: 25,
      positionKeys: ["row:5|BOX-A"],
    },
  ]);
  assert.equal(linked?.positions, 1);
  assert.equal(linked?.quantity, 10);
  assert.deepEqual(linked?.orders.map((order) => order.article), ["BOX-A"]);
  assert.equal(assemblyAreaTotal(linked?.orders || []).total, 3.5);
  assert.equal(assemblyPackingTotal(linked?.orders || []).total, 4);

  const unresolved = linkedAssemblyBoxSummary(roll, [roll, box], [
    {
      name: "OZON Москва",
      boxSheetId: 200,
      targetRollSheetId: 100,
      boxRows: 1,
      boxQuantity: 25,
      positionKeys: ["row:99|MISSING"],
    },
  ]);
  assert.equal(unresolved?.quantity, 25);
  assert.equal(unresolved?.missingPositions, 1);
});

test("print progress uses T when present and derives printed pieces from X otherwise", () => {
  const fromX = {
    quantity: 300,
    printProgress: null,
    remainingPrint: 150,
  };
  assert.equal(rollPrinted(fromX), 150);
  assert.equal(rollPrintRemaining(fromX), 150);
  assert.equal(rollPrinted({ ...fromX, printProgress: 120 }), 120);
  assert.equal(rollPrinted({ ...fromX, remainingPrint: 301 }), null);
});

test("totals can show verified print progress without inventing cutting data", () => {
  const orders = [
    {
      quantity: 300,
      printProgress: null,
      cutProgress: null,
      remainingPrint: 150,
    },
    {
      quantity: 170,
      printProgress: null,
      cutProgress: null,
      remainingPrint: 170,
    },
  ];
  assert.equal(completeTotal(orders.map(rollPrinted)), 150);
  assert.equal(completeTotal(orders.map(rollCut)), null);
  assert.equal(completeTotal(orders.map(rollPrintRemaining)), 320);
  assert.deepEqual(observedTotal(orders.map(rollCut)), {
    total: null,
    observed: 0,
    missing: 2,
  });
});

test("partial cutting total shows known rows and missing rows separately", () => {
  assert.deepEqual(observedTotal([150, null, null]), {
    total: 150,
    observed: 1,
    missing: 2,
  });
});

test("partial planned area retains confirmed square metres and identifies missing rows", () => {
  assert.deepEqual(
    plannedAreaTotal([
      { plannedArea: 0.672, areaKnown: true },
      { plannedArea: 32.13, areaKnown: true },
      { plannedArea: 0, areaKnown: false },
    ]),
    { total: 32.802, observed: 2, missing: 1 },
  );
  assert.deepEqual(
    plannedAreaTotal([
      { plannedArea: 0, areaKnown: false },
      { plannedArea: 123, areaKnown: false },
      { plannedArea: NaN },
    ]),
    { total: null, observed: 0, missing: 3 },
  );
  assert.deepEqual(plannedAreaTotal([{ plannedArea: 0, areaKnown: true }]), {
    total: 0,
    observed: 1,
    missing: 0,
  });
  assert.deepEqual(plannedAreaTotal([]), {
    total: null,
    observed: 0,
    missing: 0,
  });
});
