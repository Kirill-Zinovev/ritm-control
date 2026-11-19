import test from "node:test";
import assert from "node:assert/strict";
import { processFact, processGroups, processPercent } from "../src/productionProcessFacts";
import type { ForecastTask } from "../src/productionForecastModel";
import { forecastInput } from "../src/productionForecastData";
import type { LivePrinting, LiveOrder } from "../src/livePrinting";
import type { LiveAssembly } from "../src/liveAssembly";
const task = (v: Partial<ForecastTask> = {}): ForecastTask => ({
  id: "1",
  supplyKey: "s",
  name: "OZON",
  article: "A",
  machine: "2-go",
  department: "roll",
  plan: 100,
  printed: 40,
  cut: 20,
  areaPerPiece: 1,
  sheetsPerPiece: null,
  stock: false,
  urgent: false,
  ...v,
});
test("a nearly finished or partially unknown stage never rounds to 100 percent", () => {
  assert.equal(processPercent(processFact([task({ plan: 2248, printed: 2238 })], "print")), 99);
  assert.equal(processPercent(processFact([task({ plan: 100, printed: 100 })], "print")), 100);
  assert.equal(processPercent(processFact([task({ plan: 100, printed: 100 }), task({ id: "2", plan: 0, printed: null })], "print")), 99);
});
test("fact process remains visible when another position is unknown, without invented zero output", () => {
  const items = [task(), task({ id: "2", plan: 50, printed: null, cut: 0 })],
    before = structuredClone(items);
  const print = processFact(items, "print");
  assert.equal(print.plan, 150);
  assert.equal(print.ready, 40);
  assert.equal(print.remaining, 60);
  assert.equal(print.unknownPlan, 50);
  assert.equal(print.unknownCount, 1);
  const cut = processFact(items, "cut");
  assert.equal(cut.ready, 20);
  assert.equal(cut.remaining, 130);
  assert.equal(cut.unknownCount, 0);
  assert.deepEqual(items, before);
});
test("overproduction of one position does not fulfill another position or give progress above plan", () => {
  const r = processFact(
    [task({ printed: 150 }), task({ id: "2", printed: 0 })],
    "print",
  );
  assert.equal(r.done, 150);
  assert.equal(r.ready, 100);
  assert.equal(r.plan, 200);
  assert.equal(r.remaining, 100);
});
test("process groups preserve printing departments and identify missing facts independently", () => {
  const groups = processGroups([
    task(),
    task({
      id: "2",
      machine: "xerox",
      department: "box",
      printed: 0,
      cut: null,
    }),
    task({ id: "3", machine: "", department: "box" }),
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[1].department, "box");
  assert.equal(groups[1].print.unknownCount, 0);
  assert.equal(groups[1].cut.unknownCount, 1);
  assert.equal(groups[2].machine, "");
});
test("packing facts remain source-position scoped and unknown facts are not treated as zero", () => {
  const result = processFact(
    [task({ packed: 30 }), task({ id: "2", plan: 50, packed: null })],
    "packing",
  );
  assert.equal(result.plan, 150);
  assert.equal(result.ready, 30);
  assert.equal(result.remaining, 70);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.unknownPlan, 50);
});
test("Assembly-only goods enter packing without inflating print or cut plans and deduplicate events", () => {
  const now = Date.parse("2026-11-14T10:00:00+03:00"),
    shipmentId = "RITM-ROLL-7",
    positionId = `${shipmentId}|manual:abc|EXTRA`;
  const order = {
    uid: "u",
    rawUid: "u",
    sheetId: 7,
    sheetName: "OZON Test",
    sourceId: "roll-printing",
    assemblyShipmentId: shipmentId,
    row: 5,
    article: "A",
    machine: "2-GO",
    quantity: 100,
    packed: 20,
    plannedArea: 10,
    printProgress: 0,
    cutProgress: 0,
  } as LiveOrder;
  const live = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    supplies: [order],
    sheets: [{ sheetId: 7, name: order.sheetName, sourceId: "roll-printing" }],
    events: [],
    stockRoll: { status: "available", orders: [] },
    stockBox: { status: "available", orders: [] },
  } as unknown as LivePrinting;
  const event = {
    eventId: "e1",
    shipmentId,
    positionId,
    article: "EXTRA",
    operationId: "packing",
    quantity: 10,
    date: "2026-11-13",
  };
  const assembly = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    sources: { assembly: { status: "available", invalidRecords: 0 } },
    events: [event, event],
  } as unknown as LiveAssembly;
  const item = {
    shipmentId,
    positionId,
    article: "EXTRA",
    quantity: 30,
    status: "active",
    createdAt: "2026-11-13T10:00:00.000Z",
  };
  const stocks = { updatedAt: new Date(now).toISOString(), items: [] };
  const data = forecastInput(live, now, [item], assembly, stocks);
  assert.equal(data.packingIssues?.length, 0);
  assert.equal(processFact(data.tasks, "print").plan, 100);
  assert.equal(processFact(data.tasks, "packing").plan, 130);
  assert.equal(processFact(data.tasks, "packing").ready, 30);
  const conflicted = forecastInput(live, now, [item], {
    ...assembly,
    events: [event, { ...event, quantity: 11 }],
  } as unknown as LiveAssembly);
  assert.equal(processFact(conflicted.tasks, "packing").unknownCount, 1);
  assert.ok(forecastInput(live, now, null, assembly).packingIssues?.length);
  const orphan = {
    ...item,
    shipmentId: "RITM-ROLL-99",
    positionId: "RITM-ROLL-99|manual:abc|EXTRA",
  };
  assert.ok(
    forecastInput(live, now, [orphan], assembly, stocks).packingIssues?.length,
  );
  assert.match(
    forecastInput(live, now, [orphan], assembly, stocks).packingIssues!.join(),
    /EXTRA/,
  );
  assert.match(
    forecastInput(live, now, [], assembly, null, "Нет доступа к запасам.").packingIssues!.join(),
    /Нет доступа к запасам/,
  );
  const finished = {
    ...event,
    shipmentId: orphan.shipmentId,
    positionId: orphan.positionId,
    quantity: orphan.quantity,
  };
  assert.deepEqual(
    forecastInput(
      live,
      now,
      [orphan],
      { ...assembly, events: [finished] } as unknown as LiveAssembly,
      stocks,
    ).packingIssues,
    [],
  );
});
test("warehouse stock uses exact Assembly position identities, including archived unplaced goods", () => {
  const now = Date.parse("2026-11-14T10:00:00+03:00"),
    doc = "stock-document",
    sheetId = 11,
    shipmentId = "RITM-STOCK-WAREHOUSE";
  const pos = (uid: string, article: string) =>
    `${shipmentId}|uid:roll:${doc}:${sheetId}:${uid}|${article}`;
  const order = {
    uid: "s1",
    rawUid: "s1",
    spreadsheetId: doc,
    sheetId,
    sheetName: "Запасы склад",
    sourceId: "roll-printing",
    row: 5,
    article: "A",
    machine: "2-GO",
    quantity: 40,
    plannedArea: 4,
    planningPrinted: 40,
    planningCut: 40,
    planningPhysicalUnits: false,
  } as LiveOrder;
  const live = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    supplies: [],
    sheets: [],
    events: [],
    stockRoll: { status: "available", orders: [order] },
    stockBox: { status: "available", orders: [] },
  } as unknown as LivePrinting;
  const events = [
    {
      eventId: "a",
      shipmentId,
      positionId: pos("s1", "A"),
      article: "A",
      operationId: "packing",
      quantity: 10,
    },
    {
      eventId: "b",
      shipmentId,
      positionId: pos("s2", "B"),
      article: "B",
      operationId: "packing",
      quantity: 5,
    },
  ];
  const assembly = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    sources: { assembly: { status: "available", invalidRecords: 0 } },
    events,
  } as unknown as LiveAssembly;
  const items = [
    {
      department: "roll" as const,
      documentId: doc,
      sheetId,
      uid: "s1",
      article: "A",
      quantity: 40,
      positionId: pos("s1", "A"),
      archivedAt: "",
    },
    {
      department: "roll" as const,
      documentId: doc,
      sheetId,
      uid: "s2",
      article: "B",
      quantity: 30,
      positionId: pos("s2", "B"),
      archivedAt: "2026-11-13T08:00:00.000Z",
    },
  ];
  const data = forecastInput(live, now, [], assembly, {
    updatedAt: new Date(now).toISOString(),
    items,
  });
  assert.deepEqual(data.packingIssues, []);
  assert.equal(processFact(data.tasks, "packing").plan, 70);
  assert.equal(processFact(data.tasks, "packing").ready, 15);
  assert.equal(processFact(data.tasks, "print").plan, 40);
  assert.ok(
    forecastInput(live, now, [], assembly, {
      updatedAt: new Date(now).toISOString(),
      items: [{ ...items[0], quantity: 41 }],
    }).packingIssues?.length,
  );
});
test("invalid or negative quantities are unknown, never negative progress", () => {
  for (const printed of [null, -1, NaN, Infinity]) {
    const r = processFact([task({ printed })], "print");
    assert.equal(r.ready, 0);
    assert.equal(r.unknownCount, 1);
    assert.equal(r.unknownPlan, 100);
  }
});
test("urgent stock outside Assembly is omitted from packing totals only", () => {
  const urgent = task({
    plan: 240,
    stock: true,
    packingExcluded: true,
    printed: 0,
    cut: 0,
    packed: null,
  });
  assert.equal(processFact([urgent], "print").plan, 240);
  assert.equal(processFact([urgent], "cut").plan, 240);
  assert.equal(processFact([urgent], "packing").positions, 0);
});
test("AS0019.A7819 zero physical work needs no Xerox multiplicity; positive sheets still need conversion", () => {
  const now = Date.parse("2026-11-14T10:00:00+03:00");
  const o: LiveOrder = {
    uid: "u",
    rawUid: "u",
    sheetId: 7,
    sheetName: "OZON Москва 13.11.2026 (1 магазин)",
    row: 95,
    article: "AS0019.A7819",
    sourceId: "box-printing",
    machine: "XEROX",
    quantity: 12,
    plannedArea: 0.845,
    areaKnown: true,
    sheetsInProduct: 2,
    multiplicity: null,
    planningPrinted: 0,
    planningCut: 0,
    planningPhysicalUnits: true,
    printProgress: 0,
    cutProgress: 0,
  };
  const live = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    supplies: [o],
    sheets: [{ sheetId: 7, name: o.sheetName, sourceId: "box-printing" }],
    events: [],
    issues: [],
    stockRoll: { status: "available", orders: [] },
    stockBox: { status: "available", orders: [] },
  } as unknown as LivePrinting;
  const [fresh] = forecastInput(live, now).tasks;
  assert.equal(fresh.printed, 0);
  assert.equal(fresh.cut, 0);
  assert.equal(fresh.sheetsPerPiece, null);
  const [unknown] = forecastInput(
    { ...live, supplies: [{ ...o, planningPrinted: 1 }] },
    now,
  ).tasks;
  assert.equal(unknown.printed, null);
  assert.equal(unknown.cut, 0);
});
test("legacy Xerox units cannot become a fabricated surplus; readiness only confirms the plan", () => {
  const now = Date.parse("2026-11-14T10:00:00+03:00");
  const order = {
    uid: "u", rawUid: "u", sheetId: 7, sheetName: "OZON Test", row: 5,
    article: "KS0006.A8368", sourceId: "box-printing", machine: "XEROX",
    quantity: 100, plannedArea: 10, areaKnown: true, sheetsInProduct: 6,
    multiplicity: 4, planningPrinted: 600, planningCut: 600,
    planningPhysicalUnits: true, printProgress: 100, cutProgress: 100,
  } as LiveOrder;
  const live = {
    ok: true, updatedAt: new Date(now).toISOString(), supplies: [order],
    sheets: [{ sheetId: 7, name: order.sheetName, sourceId: "box-printing" }],
    events: [], stockRoll: { status: "available", orders: [] },
    stockBox: { status: "available", orders: [] },
  } as unknown as LivePrinting;
  const [finished] = forecastInput(live, now).tasks;
  assert.equal(finished.printed, 100);
  assert.equal(finished.cut, 100);
  const fact = processFact([finished], "print");
  assert.equal(fact.done, 100);
  assert.equal(fact.unconfirmedExcess, 1);
  const [unconfirmed] = forecastInput({ ...live, supplies: [{ ...order, printProgress: 0 }] }, now).tasks;
  assert.equal(unconfirmed.printed, null);
  assert.equal(processFact([unconfirmed], "print").unknownCount, 1);
  assert.equal(order.planningPrinted, 600);
});
