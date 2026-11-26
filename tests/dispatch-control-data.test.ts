import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDispatchPositions,
  buildDispatchRows,
  dispatchSupplyIds,
  type DispatchFact,
  type DispatchPosition,
} from "../src/dispatchControlData";
import type { LivePrinting } from "../src/livePrinting";

const position: DispatchPosition = {
  supplyId: "RITM-SUPPLY-ONE",
  supplyName: "OZON Москва 26.11",
  positionId: "RITM-SUPPLY-ONE|uid:11|AB0001.A0042",
  market: "OZON",
  store: "1",
  department: "roll",
  article: "AB0001.A0042",
  plan: 120,
  printed: 120,
  cut: 85,
};
const fact: DispatchFact = {
  supplyId: position.supplyId,
  positionId: position.positionId,
  sku: position.article,
  department: "roll",
  market: "OZON",
  store: "1",
  destination: "Москва",
  plan: 120,
  packed: 70,
  sent: 50,
  cartons: [],
};

test("deducts sent units only, keeping partially cut, packed and boxed units in the dispatch balance", () => {
  const [row] = buildDispatchRows(
    [position],
    [
      {
        ...fact,
        cartons: [
          {
            id: "b1",
            label: "К-024",
            qty: 15,
            state: "closed",
            prepared: true,
          },
          { id: "b2", label: "К-031", qty: 5, state: "open", prepared: false },
        ],
      },
    ],
  );
  assert.equal(row.sent, 50);
  assert.equal(row.remaining, 70);
  assert.equal(row.stage, "cut");
  assert.equal(row.readyQty, 15);
  assert.equal(row.workQty, 55);
  assert.match(row.location, /Рулонная печать/);
  assert.match(row.location, /К-024, К-031/);
  assert.equal(row.cutQty, 35);
  assert.equal(row.packQty, 20);
  assert.equal(row.direction, "Москва");
});

test("keeps known closed cartons ready and removes positions entirely sent", () => {
  const [row] = buildDispatchRows(
    [position],
    [
      {
        ...fact,
        sent: 75,
        cartons: [
          {
            id: "b1",
            label: "К-024",
            qty: 45,
            state: "closed",
            prepared: false,
          },
        ],
      },
    ],
  );
  assert.equal(row.remaining, 45);
  assert.equal(row.readyQty, 45);
  assert.equal(row.stage, "ready");
  assert.deepEqual(buildDispatchRows([position], [{ ...fact, sent: 125 }]), []);
});

test("missing history and conflicting scopes yield a visible unknown instead of a zero", () => {
  for (const data of [
    [],
    [{ ...fact, sent: null }],
    [{ ...fact, store: "2" }],
    [{ ...fact, market: "WB" as const }],
  ]) {
    const [row] = buildDispatchRows([position], data);
    assert.equal(row.remaining, null);
    assert.equal(row.sent, null);
    assert.equal(row.stage, "cut");
  }
  const [differentPlan] = buildDispatchRows(
    [position],
    [{ ...fact, plan: 121, sent: 120 }],
  );
  assert.equal(differentPlan.remaining, null);
});

test("uses only lifecycle steps as production marks advance and removes a fully dispatched row", () => {
  const unsent = { ...fact, sent: 0, packed: 0 };
  const [planned] = buildDispatchRows(
    [{ ...position, printed: 0, cut: null }],
    [unsent],
  );
  assert.equal(planned.stage, "planned");
  assert.equal(planned.plannedQty, 120);
  const [printing] = buildDispatchRows(
    [{ ...position, printed: 20, cut: null }],
    [unsent],
  );
  assert.equal(printing.stage, "print");
  assert.equal(printing.printQty, 100);
  assert.equal(printing.cutQty, 20);
  const [cutting] = buildDispatchRows(
    [{ ...position, printed: 120, cut: null }],
    [unsent],
  );
  assert.equal(cutting.stage, "cut");
  assert.equal(cutting.cutQty, 120);
  const [packing] = buildDispatchRows(
    [{ ...position, printed: 120, cut: 120 }],
    [unsent],
  );
  assert.equal(packing.stage, "pack");
  assert.equal(packing.packQty, 120);
  const [ready] = buildDispatchRows(
    [{ ...position, printed: 120, cut: 120 }],
    [
      {
        ...unsent,
        cartons: [
          {
            id: "box",
            label: "К-024",
            qty: 120,
            state: "closed",
            prepared: true,
          },
        ],
      },
    ],
  );
  assert.equal(ready.stage, "ready");
  assert.equal(ready.remaining, 120);
  assert.deepEqual(
    buildDispatchRows([position], [{ ...unsent, sent: 120 }]),
    [],
  );
});

test("keeps the remaining quantity visible even when no stage is recorded for it", () => {
  const [row] = buildDispatchRows(
    [{ ...position, printed: null, cut: null }],
    [{ ...fact, packed: 50 }],
  );
  assert.equal(row.remaining, 70);
  assert.equal(row.stage, null);
  assert.equal(row.workQty + row.readyQty, 0);
});

test("groups duplicate SKU positions only within the exact supply and store", () => {
  const other = {
    ...position,
    positionId: "RITM-SUPPLY-ONE|uid:12|AB0001.A0042",
    printed: 120,
    cut: 120,
  };
  const third = {
    ...position,
    supplyId: "RITM-SUPPLY-TWO",
    positionId: "RITM-SUPPLY-TWO|uid:13|AB0001.A0042",
  };
  const rows = buildDispatchRows(
    [position, other, third],
    [
      { ...fact, sent: 120 },
      { ...fact, positionId: other.positionId, sent: 119, cartons: [] },
    ],
  );
  assert.equal(rows.length, 2);
  const joined = rows.find((row) => row.supplyId === position.supplyId);
  assert.equal(joined?.plan, 240);
  assert.equal(joined?.sent, 239);
  assert.equal(joined?.remaining, 1);
  assert.equal(
    rows.find((row) => row.supplyId === third.supplyId)?.remaining,
    null,
  );
});

test("includes a manual Assembly position linked to the same supply", () => {
  const [row] = buildDispatchRows(
    [position],
    [
      { ...fact, sent: 120 },
      {
        ...fact,
        sku: "EX0001.A0001",
        positionId: "RITM-SUPPLY-ONE|manual:123|EX0001.A0001",
        plan: 15,
        packed: 0,
        sent: 0,
      },
    ],
  );
  assert.equal(row.article, "EX0001.A0001");
  assert.equal(row.plan, 15);
  assert.equal(row.remaining, 15);
  assert.equal(row.stage, "pack");
});

test("builds the source-feed identity for roll and standalone box legacy positions", () => {
  const live: LivePrinting = {
    ok: true,
    schemaVersion: 2,
    updatedAt: "2026-11-26T11:00:00Z",
    issues: [],
    events: [],
    sheets: [
      { sheetId: 42, name: "OZON Москва рулон", sourceId: "roll-printing" },
      { sheetId: 55, name: "OZON Москва Бокс", sourceId: "box-printing" },
    ],
    supplies: [
      {
        uid: "generated",
        rawUid: "real",
        article: "AB0001.A0042",
        sheetId: 42,
        sheetName: "OZON Москва рулон",
        row: 7,
        quantity: 12,
        plannedArea: 0,
        sourceId: "roll-printing",
      },
      {
        uid: "generated2",
        article: "AB0001.A0042",
        sheetId: 55,
        sheetName: "OZON Москва Бокс",
        row: 8,
        quantity: 12,
        plannedArea: 0,
        sourceId: "box-printing",
      },
    ],
  };
  const positions = buildDispatchPositions(live);
  assert.deepEqual(dispatchSupplyIds(positions), [
    "RITM-BOX-55",
    "RITM-ROLL-42",
  ]);
  assert.deepEqual(
    positions.map((pos) => pos.positionId),
    [
      "RITM-ROLL-42|uid:real|AB0001.A0042",
      "RITM-BOX-55|box:55|row:8|AB0001.A0042",
    ],
  );
});
