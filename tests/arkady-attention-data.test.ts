import assert from "node:assert/strict";
import test from "node:test";
import type { LiveOrder, LivePrinting } from "../src/livePrinting";
import { buildArkadyAttention } from "../src/arkadyAttentionData";

const now = Date.parse("2026-11-26T11:00:00Z");
const shipmentId = "RITM-ROLL-71";
const shipmentKey = "shipment:" + shipmentId;
const previous = "2026-11-26T10:00:00.000Z";
const next24h = "2026-11-27T11:00:00.000Z";

function order(values: Partial<LiveOrder> = {}): LiveOrder {
  return {
    uid: "roll:17",
    sourceId: "roll-printing",
    sheetId: 71,
    sheetName: "OZON Ярославль",
    assemblyShipmentId: shipmentId,
    row: 17,
    article: "PT0001.A0277",
    machine: "2-GO",
    quantity: 10,
    plannedArea: 0,
    ...values,
  };
}

function printing(...supplies: LiveOrder[]): LivePrinting {
  return {
    ok: true,
    schemaVersion: 2,
    updatedAt: new Date(now).toISOString(),
    supplies,
    events: [],
    issues: [],
    sheets: [
      ...new Map(
        supplies.map((item) => [
          item.sourceId + ":" + item.sheetId,
          {
            sheetId: item.sheetId,
            name: item.sheetName,
            sourceId: item.sourceId,
            assemblyShipmentId: item.assemblyShipmentId,
          },
        ]),
      ).values(),
    ],
    packing: {
      status: "available",
      source: "RITM Сборка",
      checkedAt: new Date(now).toISOString(),
      eventCount: 0,
      invalidRecords: 0,
    },
  };
}

test("Arkady lists overdue production and packing due within the next 24 hours", () => {
  const roll = order({ printProgress: 5, cutProgress: 0, packed: 2 });
  const box = order({
    uid: "box:25",
    sourceId: "box-printing",
    sheetId: 75,
    row: 25,
    machine: "XEROX",
    quantity: 8,
    sheetsInProduct: 4,
    multiplicity: 2,
    planningPhysicalUnits: true,
    planningPrinted: 16,
    planningCut: 6,
    packed: 1,
  });
  const report = buildArkadyAttention(
    printing(roll, box),
    {
      [shipmentKey]: { readyAt: previous, packingAt: next24h, shipAt: null },
    },
    { now, extraItems: [], extraItemsConfirmed: true },
  );
  assert.equal(report.checked, 1);
  assert.equal(report.unconfirmed, 0);
  assert.deepEqual(
    report.items.map(({ stage, status }) => [stage, status]),
    [
      ["production", "overdue"],
      ["packing", "due-soon"],
    ],
  );
  assert.match(
    report.items[0].detail,
    /Рулонная печать — напечатать 5 шт\., порезать 10 шт\./u,
  );
  assert.match(report.items[0].detail, /Бокс — порезать 5 шт\./u);
  assert.equal(report.items[1].confirmed, 3);
  assert.equal(report.items[1].plan, 18);
});

test("unknown facts, archived positions, unverified shipping and deadlines outside 24 hours never create deadline alerts", () => {
  const unknown = order();
  const archived = order({
    uid: "archived",
    archived: true,
    sheetId: 82,
    assemblyShipmentId: "RITM-ROLL-82",
    printProgress: 0,
    cutProgress: 0,
  });
  const shipping = order({
    uid: "on-truck",
    sheetId: 83,
    assemblyShipmentId: "RITM-ROLL-83",
    printProgress: 0,
    cutProgress: 0,
  });
  const report = buildArkadyAttention(
    printing(unknown, archived, shipping),
    {
      [shipmentKey]: {
        readyAt: previous,
        packingAt: "2026-11-27T11:00:01.000Z",
        shipAt: null,
      },
      "shipment:RITM-ROLL-82": { readyAt: previous, shipAt: null },
      "shipment:RITM-ROLL-83": { readyAt: null, shipAt: previous },
    },
    { now },
  );
  assert.equal(report.checked, 2);
  assert.equal(report.unconfirmed, 1);
  assert.deepEqual(report.items, []);
});

test("stale production and stale assembly data fail closed independently", () => {
  const live = printing(
    order({ printProgress: 10, cutProgress: 10, packed: 0 }),
  );
  const deadlines = {
    [shipmentKey]: { readyAt: previous, packingAt: previous, shipAt: null },
  };
  const staleAssembly: LivePrinting = {
    ...live,
    packing: { ...live.packing!, checkedAt: "2026-11-26T10:40:00Z" },
  };
  const report = buildArkadyAttention(staleAssembly, deadlines, { now });
  assert.equal(report.unconfirmed, 1);
  assert.deepEqual(report.items, []);
  assert.equal(
    buildArkadyAttention(
      {
        ...live,
        snapshotAt: "2026-11-26T10:40:00Z",
      },
      deadlines,
      { now },
    ).state,
    "stale",
  );
  assert.equal(
    buildArkadyAttention({ ...live, refreshFailed: true }, deadlines, { now })
      .state,
    "stale",
  );
  assert.equal(buildArkadyAttention(live, null, { now }).state, "unavailable");
});

test("the same audited cut confirmation suppresses an otherwise overdue ready deadline", () => {
  const live = printing(order({ printProgress: 10, cutProgress: 0 }));
  const deadlines = { [shipmentKey]: { readyAt: previous, shipAt: null } };
  assert.equal(buildArkadyAttention(live, deadlines, { now }).items.length, 1);
  assert.deepEqual(
    buildArkadyAttention(live, deadlines, {
      now,
      cutConfirmations: [
        {
          taskId: "roll-printing:71:roll:17",
          article: "PT0001.A0277",
          quantity: 10,
          sourcePlan: 10,
          recordedAt: previous,
          recordedBy: "Руководитель",
        },
      ],
    }).items,
    [],
  );
});

test("unknown Assembly-only packing keeps totals partial and never invents a deficit", () => {
  const deadlines = {
    [shipmentKey]: { readyAt: null, packingAt: previous, shipAt: null },
  };
  const extra = {
    shipmentId,
    status: "active",
    positionId: shipmentId + "|manual:extra",
    article: "EX0001.A0001",
    quantity: 5,
    createdAt: previous,
  };
  const done = printing(
    order({ printProgress: 10, cutProgress: 10, packed: 10 }),
  );
  const withExtra = buildArkadyAttention(done, deadlines, {
    now,
    extraItems: [extra],
    extraItemsConfirmed: true,
  });
  assert.deepEqual(withExtra.items, []);
  assert.equal(withExtra.unconfirmed, 1);
  const pending = printing(
    order({ printProgress: 10, cutProgress: 10, packed: 3 }),
  );
  const [item] = buildArkadyAttention(pending, deadlines, {
    now,
    extraItems: [extra],
    extraItemsConfirmed: true,
  }).items;
  assert.equal(item.stage, "packing");
  assert.equal(item.plan, null);
  assert.equal(item.confirmed, null);
  assert.match(item.detail, /не менее 7 шт\./u);
  assert.equal(buildArkadyAttention(done, deadlines, { now }).unconfirmed, 1);
  const [unrelated] = buildArkadyAttention(pending, deadlines, {
    now,
    extraItems: [{ ...extra, shipmentId: "RITM-ROLL-99" }],
    extraItemsConfirmed: true,
  }).items;
  assert.equal(unrelated.plan, 10);
  assert.equal(unrelated.confirmed, 3);
});

test("confirmed machine issue is scoped to its real box row and unaffected sheets remain available", () => {
  const roll = order({ printProgress: 10, cutProgress: 10 });
  const box = order({
    uid: "box:25",
    sourceId: "box-printing",
    sheetId: 75,
    sheetName: "OZON · бокс",
    row: 25,
    printProgress: 0,
    machineIssue: "В каталоге указаны разные станки",
  });
  const live = printing(roll, box);
  const [item] = buildArkadyAttention(live, {}, { now }).items;
  assert.equal(item.stage, "catalog");
  assert.equal(item.sourceId, "box-printing");
  assert.equal(item.sheetId, 75);
  assert.equal(item.article, box.article);
  assert.equal(item.deadline, null);
  const affected: LivePrinting = {
    ...live,
    quality: { status: "partial", invalidRecords: 1 },
    issues: [{ source: box.sheetName, row: box.row, message: "Нет данных" }],
  };
  assert.deepEqual(buildArkadyAttention(affected, {}, { now }).items, []);
  assert.deepEqual(
    buildArkadyAttention(
      printing(roll, { ...box, printProgress: null }),
      {},
      { now },
    ).items,
    [],
  );
});
