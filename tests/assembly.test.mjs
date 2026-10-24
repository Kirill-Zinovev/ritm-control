import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadAssembly,
  parseAssemblyRows,
  summarizeAssembly,
  summarizeAssemblyDays,
  selectAssemblyPeriod,
} from "../worker/assembly.js";
import {
  parseAssemblyArticleCatalog,
  parseAssemblyWorkLog,
  isRitmAssemblyShipmentId,
} from "../worker/assemblyWorkLog.js";
import worker from "../worker/index.js";
import {
  makeFboCurrentGvizFixture,
  parseFboCurrent,
} from "../worker/assemblyFboCurrent.js";
import { reconcileAssemblySources } from "../worker/assemblyReconciliation.js";

const headers = [
  "Дата",
  "Сотрудник",
  "Резка станок",
  "Ручная резка",
  "Порезано всего",
  "Упаковано",
  "Всего",
  "Коэффициент",
  "Порезал по видам",
  "Упаковал по видам",
  "Обновлено",
  "Ключ",
];
function csvCell(value) {
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}
function csv(rows) {
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}
const fixture = csv([
  [
    "2026-10-05",
    "Оля",
    "10",
    "2",
    "12",
    "20",
    "32",
    "0,5",
    "ПВХ — 12",
    "Короб — 20",
    "08.10.2026",
    "1",
  ],
  [
    "2026-10-08",
    "Оля",
    "3",
    "1",
    "4",
    "6",
    "10",
    "0,25",
    "ПВХ — 4",
    "Короб — 6",
    "08.10.2026",
    "2",
  ],
  [
    "2026-10-09",
    "Оля",
    "100",
    "0",
    "100",
    "0",
    "100",
    "1",
    "ПВХ — 100",
    "",
    "08.10.2026",
    "3",
  ],
]);

const workLogHeaders = [
  "eventId",
  "createdAt",
  "shipmentId",
  "directionId",
  "Направление",
  "positionId",
  "Артикул",
  "employeeId",
  "Сотрудник",
  "operationId",
  "Операция",
  "Количество, шт",
  "Норма, шт/чел",
  "Коэффициент",
  "Источник",
  "idempotencyKey",
];
const catalogHeaders = [
  "shipmentId",
  "directionId",
  "Направление",
  "positionId",
  "Артикул",
  "Название товара",
  "Вид товара",
  "Источник",
];
const trustedShipment = "RITM-ROLL-555";
function workEvent({
  id,
  time,
  sku,
  employeeId,
  employee,
  operationId,
  quantity,
  norm,
  coefficient,
  source = "WEB_APP_RITM",
  shipmentId = trustedShipment,
  positionId = `${shipmentId}|uid:${id}|${sku}`,
  key = `idem-${id}`,
}) {
  const labels = {
    assembly: "Ручная резка",
    cut: "Резка на станке",
    packing: "Упаковка",
  };
  return [
    id,
    time,
    shipmentId,
    "ROLL",
    "OZON ТЕСТ",
    positionId,
    sku,
    employeeId,
    employee,
    operationId,
    labels[operationId] || operationId,
    quantity,
    norm,
    coefficient,
    source,
    key,
  ];
}

const mixedFboFixture = csv([
  [
    "2026-10-16",
    "Алексей 8",
    "11",
    "2",
    "13",
    "5",
    "18",
    "0,5",
    "Наклейки А5 — 13",
    "Наклейки А5 — 5",
    "16.10.2026 23:00",
    "fbo-16",
  ],
  [
    "2026-10-17",
    "Алексей 8",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "",
    "",
    "17.10.2026 00:00",
    "fbo-17-zero",
  ],
]);

const liveFboCurrentFixture = makeFboCurrentGvizFixture([
  [
    "Вика 4",
    0,
    0,
    0.48484848484848486,
    0.48484848484848486,
    "● Низкий",
    "Обновляется автоматически\n13:09",
    null,
    0,
    0,
    0,
    400,
    400,
    null,
    "Наклейки А5 3-4 листа — 400",
  ],
]);

const mixedWorkLogFixture = [
  workLogHeaders,
  workEvent({
    id: "evt-manual",
    time: "2026-10-17T06:02:55.514Z",
    sku: "KS0002.A4983",
    employeeId: "emp-016",
    employee: "Алексей",
    operationId: "assembly",
    quantity: 70,
    norm: 450,
    coefficient: "0,1555555556",
  }),
  workEvent({
    id: "evt-machine",
    time: "2026-10-17T06:03:43.859Z",
    sku: "TT0009.A6079",
    employeeId: "emp-016",
    employee: "Алексей",
    operationId: "cut",
    quantity: 70,
    norm: "1166,666667",
    coefficient: "0,06",
  }),
  workEvent({
    id: "evt-liza",
    time: "2026-10-17T06:04:07.687Z",
    sku: "TT0009.A6079",
    employeeId: "emp-014",
    employee: "Лиза",
    operationId: "packing",
    quantity: 70,
    norm: 775,
    coefficient: "0,09032258065",
  }),
  workEvent({
    id: "evt-david",
    time: "2026-10-17T06:07:31.023Z",
    sku: "NT0033.A5425",
    employeeId: "emp-004",
    employee: "Давид",
    operationId: "packing",
    quantity: 20,
    norm: 575,
    coefficient: "0,0347826087",
  }),
  workEvent({
    id: "evt-olyazh",
    time: "2026-10-17T08:07:56.374Z",
    sku: "KT0072.A0094",
    employeeId: "emp-006",
    employee: "ОляЖ",
    operationId: "packing",
    quantity: 100,
    norm: 875,
    coefficient: "0,1142857143",
  }),
  workEvent({
    id: "evt-arina",
    time: "2026-10-17T10:08:02.468Z",
    sku: "TT0009.A5954",
    employeeId: "emp-009",
    employee: "Арина",
    operationId: "packing",
    quantity: 50,
    norm: 775,
    coefficient: "0,06451612903",
  }),
  workEvent({
    id: "old-worklog-event",
    time: "2026-10-16T12:00:00Z",
    sku: "OLD.SKU",
    employeeId: "emp-016",
    employee: "Алексей",
    operationId: "packing",
    quantity: 999,
    norm: 1,
    coefficient: 999,
  }),
  workEvent({
    id: "seed-demo",
    time: "2026-10-17T08:30:00Z",
    sku: "DM0001.A1001(OZ)",
    employeeId: "emp-001",
    employee: "Оля",
    operationId: "packing",
    quantity: 777,
    norm: 10,
    coefficient: 77.7,
    source: "SNAPSHOT_MOSCOW_15",
    shipmentId: "DEMO-MSK-15",
  }),
  workEvent({
    id: "web-test",
    time: "2026-10-17T08:30:00Z",
    sku: "DM0001.A1001(OZ)",
    employeeId: "emp-001",
    employee: "Оля",
    operationId: "packing",
    quantity: 888,
    norm: 10,
    coefficient: 88.8,
    source: "WEB_APP_TEST",
    shipmentId: "DEMO-MSK-15",
  }),
]
  .map((row) => row.map(csvCell).join(","))
  .join("\r\n");

const mixedCatalogFixture = [
  catalogHeaders,
  [
    trustedShipment,
    "ROLL",
    "OZON ТЕСТ",
    `${trustedShipment}|uid:evt-manual|KS0002.A4983`,
    "KS0002.A4983",
    "Товар A",
    "Наклейки А5",
    "RITM_ROLL_PRINTING",
  ],
  [
    trustedShipment,
    "ROLL",
    "OZON ТЕСТ",
    `${trustedShipment}|uid:evt-machine|TT0009.A6079`,
    "TT0009.A6079",
    "Товар B",
    "Наклейки А5",
    "RITM_ROLL_PRINTING",
  ],
  [
    trustedShipment,
    "ROLL",
    "OZON ТЕСТ",
    `${trustedShipment}|uid:evt-liza|TT0009.A6079`,
    "TT0009.A6079",
    "Товар B",
    "Наклейки А5",
    "RITM_ROLL_PRINTING",
  ],
  [
    trustedShipment,
    "ROLL",
    "OZON ТЕСТ",
    `${trustedShipment}|uid:evt-david|NT0033.A5425`,
    "NT0033.A5425",
    "Товар C",
    "Тубусные наклейки",
    "RITM_ROLL_PRINTING",
  ],
  [
    trustedShipment,
    "ROLL",
    "OZON ТЕСТ",
    `${trustedShipment}|uid:evt-olyazh|KT0072.A0094`,
    "KT0072.A0094",
    "Товар D",
    "Наклейки А4",
    "RITM_ROLL_PRINTING",
  ],
  [
    trustedShipment,
    "ROLL",
    "OZON ТЕСТ",
    `${trustedShipment}|uid:evt-arina|TT0009.A5954`,
    "TT0009.A5954",
    "Товар E",
    "Наклейки А5",
    "RITM_ROLL_PRINTING",
  ],
]
  .map((row) => row.map(csvCell).join(","))
  .join("\r\n");

test("FBO parser reads decimal coefficients and product types", () => {
  const [row] = parseAssemblyRows(fixture);
  assert.equal(row.employee, "Оля");
  assert.equal(row.coefficient, 0.5);
  assert.deepEqual(row.cutTypes, [{ name: "ПВХ", quantity: 12 }]);
  assert.deepEqual(row.packTypes, [{ name: "Короб", quantity: 20 }]);
});

test("WorkLog accepts only real RITM events and retains identity, norm and event coefficient", () => {
  const result = parseAssemblyWorkLog(mixedWorkLogFixture);
  assert.equal(result.events.length, 7);
  assert.equal(result.invalid.length, 0);
  assert.equal(result.audit.supportsCorrections, false);
  assert.ok(result.events.every((event) => event.source === "WEB_APP_RITM"));
  assert.ok(
    result.events.every((event) => event.shipmentId.startsWith("RITM-ROLL-")),
  );
  assert.equal(
    result.events.some((event) => event.eventId === "seed-demo"),
    false,
  );
  assert.equal(
    result.events.some((event) => event.eventId === "web-test"),
    false,
  );
  const alexManual = result.events.find(
    (event) => event.eventId === "evt-manual",
  );
  assert.equal(alexManual.employeeId, "emp-016");
  assert.equal(
    alexManual.positionId,
    `${trustedShipment}|uid:evt-manual|KS0002.A4983`,
  );
  assert.equal(alexManual.operation, "Ручная резка");
  assert.equal(alexManual.norm, 450);
  assert.equal(alexManual.coefficient, 0.1555555556);
});

test("WorkLog recognizes shared and box supply identities without admitting demo data", () => {
  const common = "RITM-SUPPLY-df6b8985-eb77-43e6-9d97-311c8cf4ae23";
  const box = "RITM-BOX-122063726";
  const records = [common, box, "RITM-SUPPLY-demo"].map((shipmentId, i) => workEvent({
    id: `shared-${i}`, time: "2026-10-20T10:00:00Z", sku: `SKU-${i}`,
    employeeId: "emp-1", employee: "Сборщик", operationId: "packing",
    quantity: 70, norm: 700, coefficient: "0,1", shipmentId,
  }));
  const result = parseAssemblyWorkLog([workLogHeaders, ...records].map(row => row.map(csvCell).join(",")).join("\n"));
  assert.deepEqual(result.events.map(event => event.shipmentId), [common, box]);
  assert.equal(result.invalid.length, 1);
  assert.deepEqual(result.invalid[0].errors, ["untrusted_shipment"]);
  assert.equal(result.events.reduce((sum, event) => sum + event.quantity, 0), 140);
  const cancelled = parseAssemblyWorkLog(
    [workLogHeaders, ...records.slice(0, 2)].map(row => row.map(csvCell).join(",")).join("\n"),
    [["correctionId", "eventId", "action", "createdAt", "actor", "reason"],
      ["shared-cancel", "shared-0", "CANCEL", "2026-10-20T12:00:00Z", "owner", "Wrong work"],
    ].map(row => row.map(csvCell).join(",")).join("\n"),
  );
  assert.equal(cancelled.invalid.length, 0);
  assert.deepEqual(cancelled.events.map(event => event.shipmentId), [box]);
  assert.equal(cancelled.audit.cancellationsApplied, 1);
  assert.equal(isRitmAssemblyShipmentId("RITM-SUPPLY-11111111----------------------------"), false);
  assert.equal(isRitmAssemblyShipmentId("DEMO-1"), false);
  const products = parseAssemblyArticleCatalog([catalogHeaders,
    [common, "ROLL", "Общая", `${common}|uid:shared-0|SKU-0`, "SKU-0", "Товар", "Наклейки", "RITM_ROLL_PRINTING"],
    [box, "ROLL", "Бокс", `${box}|box:122063726|uid:shared-1|SKU-1`, "SKU-1", "Товар", "Стикербуки", "RITM_BOX_PRINTING"],
  ].map(row => row.map(csvCell).join(",")).join("\n"));
  assert.equal(products.size, 2);
});

test("separate WorkLogCorrections cancel by event ID while other work from the same employee remains", () => {
  const corrections = "correctionId,eventId,action,createdAt,actor,reason\n" +
    "c1,evt-manual,CANCEL,2026-10-19T08:00:00Z,owner,Wrong operation\n" +
    "c2,evt-manual,CANCEL,2026-10-19T08:01:00Z,owner,Retry";
  const result = parseAssemblyWorkLog(mixedWorkLogFixture, corrections);
  assert.equal(result.audit.supportsCorrections, true);
  assert.equal(result.audit.cancellationsApplied, 1);
  assert.equal(result.events.some((event) => event.eventId === "evt-manual"), false);
  assert.equal(result.events.some((event) => event.eventId === "evt-machine"), true);
  assert.equal(result.events.some((event) => event.eventId === "old-worklog-event"), true);
  assert.throws(() => parseAssemblyWorkLog(mixedWorkLogFixture, "eventId,action"), /corrections_schema/);
});

test("WorkLog keeps an unknown norm unknown instead of displaying a zero coefficient", () => {
  const fixture = [
    workLogHeaders,
    workEvent({
      id: "no-norm",
      time: "2026-10-17T09:00:00Z",
      sku: "SKU.NO.NORM",
      employeeId: "emp-1",
      employee: "Сотрудник",
      operationId: "packing",
      quantity: 10,
      norm: "",
      coefficient: "",
    }),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const [event] = parseAssemblyWorkLog(fixture).events;
  assert.equal(event.norm, null);
  assert.equal(event.coefficient, null);
});

test("WorkLog correction and cancellation links supersede prior event facts", () => {
  const headers = [
    ...workLogHeaders,
    "eventStatus",
    "supersedesEventId",
    "cancelledEventId",
  ];
  const old = [
    ...workEvent({
      id: "evt-old",
      time: "2026-10-17T09:00:00Z",
      sku: "SKU.1",
      employeeId: "emp-1",
      employee: "Сотрудник",
      operationId: "packing",
      quantity: 10,
      norm: 100,
      coefficient: 0.1,
    }),
    "",
    "",
    "",
  ];
  const corrected = [
    ...workEvent({
      id: "evt-corrected",
      time: "2026-10-17T09:01:00Z",
      sku: "SKU.1",
      employeeId: "emp-1",
      employee: "Сотрудник",
      operationId: "packing",
      quantity: 12,
      norm: 100,
      coefficient: 0.12,
    }),
    "",
    "evt-old",
    "",
  ];
  const cancellation = [
    ...Array(workLogHeaders.length).fill(""),
    "cancelled",
    "",
    "evt-corrected",
  ];
  cancellation[0] = "cancel-row";
  cancellation[1] = "2026-10-17T09:02:00Z";
  cancellation[2] = trustedShipment;
  cancellation[14] = "WEB_APP_RITM";
  cancellation[15] = "cancel-key";
  const fixture = [headers, old, corrected, cancellation]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const result = parseAssemblyWorkLog(fixture);
  assert.equal(result.events.length, 0);
  assert.equal(result.audit.supportsCorrections, true);
  assert.equal(result.audit.correctionsApplied, 1);
  assert.equal(result.audit.cancellationsApplied, 1);
});

test("current FBO and Assembly are read together, with live FBO values overriding same-day zero history", async () => {
  const norms = '"Вид","Норма"\r\n"Наклейки Упаковка","750"';
  const fetcher = async (url) => {
    const value = String(url);
    if (value.includes("gviz/tq"))
      return new Response(liveFboCurrentFixture, { status: 200 });
    if (value.includes("gid=2070043218"))
      return new Response(mixedFboFixture, { status: 200 });
    if (value.includes("gid=130670756"))
      return new Response(norms, { status: 200 });
    if (value.includes("gid=1587688746"))
      return new Response(mixedWorkLogFixture, { status: 200 });
    if (value.includes("gid=1151154937"))
      return new Response("correctionId,eventId,action,createdAt,actor,reason");
    if (value.includes("gid=651303867"))
      return new Response(mixedCatalogFixture, { status: 200 });
    throw new Error("Unexpected spreadsheet source: " + value);
  };

  const today = await loadAssembly("2026-10-17", "day", fetcher, {
    today: "2026-10-17",
  });
  assert.deepEqual(today.sourcePolicy, {
    mode: "simultaneous",
    cutover: null,
    overlap: true,
  });
  assert.equal(today.sources.assembly.status, "available");
  assert.equal(today.sources.assembly.eventCount, 6);
  assert.equal(today.sources.catalog.missingRecords, 0);
  assert.equal(
    today.events.filter((event) => event.date === "2026-10-17").length,
    6,
  );
  assert.equal(today.sources.fbo.sheet, "Все коэффициенты");
  assert.equal(today.sources.fbo.currentSheetUpdateTime, "13:09");
  assert.equal(today.reconciliation.status, "needs_review");
  assert.equal(today.reconciliation.approvedTotals, null);
  assert.deepEqual(today.reconciliation.pendingMappings.fboNames, ["Вика 4"]);
  assert.equal(today.reconciliation.sourceTotals.fbo.packed, 400);
  assert.equal(
    today.reconciliation.sourceTotals.fbo.coefficient,
    0.48484848484848486,
  );
  assert.equal(today.reconciliation.sourceTotals.assembly.packed, 240);
  assert.equal(today.reconciliation.sourceTotals.assembly.machineCut, 70);
  assert.equal(today.reconciliation.sourceTotals.assembly.manualCut, 70);
  assert.equal(today.reconciliation.sourceTotals.assembly.total, 380);
  assert.equal(
    today.reconciliation.sourceTotals.assembly.coefficient,
    0.51946258828,
  );
  const fboToday = today.history.find(
    (row) => row.date === "2026-10-17" && row.sourceKind === "fbo",
  );
  assert.equal(fboToday.employee, "Вика 4");
  assert.equal(fboToday.packed, 400);
  assert.equal(fboToday.coefficient, null);
  assert.equal(
    fboToday.sourceContributions[0].coefficient,
    0.48484848484848486,
  );
  assert.equal(
    today.rows.reduce((sum, row) => sum + row.machineCut, 0),
    70,
  );
  assert.equal(
    today.rows.reduce((sum, row) => sum + row.manualCut, 0),
    70,
  );
  assert.equal(
    today.rows.reduce((sum, row) => sum + row.packed, 0),
    640,
  );
  assert.equal(
    today.rows.reduce((sum, row) => sum + row.total, 0),
    780,
  );
  const alex = today.history.find(
    (row) => row.employeeId === "emp-016" && row.date === "2026-10-17",
  );
  assert.equal(alex.employee, "Алексей");
  assert.equal(alex.events?.length, 2);
  assert.deepEqual(
    alex.events.map((event) => event.article),
    ["KS0002.A4983", "TT0009.A6079"],
  );

  const week = await loadAssembly("2026-10-17", "week", fetcher, {
    today: "2026-10-17",
  });
  const alexRows = week.rows.filter((row) => /Алексей/.test(row.employee));
  assert.deepEqual(alexRows.map((row) => row.identityKey), ["assembly:emp-016"]);
  assert.equal(alexRows[0].employee, "Алексей");
  assert.deepEqual(alexRows[0].sourceKinds, ["fbo", "assembly"]);
  assert.equal(alexRows[0].sourceContributions.length, 2);
  assert.equal(
    week.history.some(
      (row) =>
        row.date === "2026-10-17" &&
        row.employee === "Вика 4" &&
        row.sourceKind === "fbo",
    ),
    true,
  );
});

test("cancelled Assembly events disappear from all local periods while FBO and uncancelled history remain", async () => {
  const ids = ["evt-manual", "evt-machine", "evt-liza", "evt-david", "evt-olyazh", "evt-arina"];
  const corrections = "correctionId,eventId,action,createdAt,actor,reason\n" +
    ids.map((id, index) => `c${index},${id},CANCEL,2026-10-19T08:00:00Z,owner,Wrong work`).join("\n");
  const fetcher = async (url) => {
    const value = String(url);
    if (value.includes("gviz/tq")) return new Response(liveFboCurrentFixture);
    if (value.includes("gid=2070043218")) return new Response(mixedFboFixture);
    if (value.includes("gid=130670756")) return new Response('Вид,Норма\nНаклейки Упаковка,750');
    if (value.includes("gid=1587688746")) return new Response(mixedWorkLogFixture);
    if (value.includes("gid=1151154937")) return new Response(corrections);
    if (value.includes("gid=651303867")) return new Response(mixedCatalogFixture);
    throw new Error("Unexpected source");
  };
  const snapshot = await loadAssembly("2026-10-17", "day", fetcher, { today: "2026-10-17", includeHistory: true });
  assert.equal(snapshot.sources.assembly.status, "available");
  assert.equal(snapshot.sources.assembly.cancellationsApplied, 6);
  assert.equal(snapshot.reconciliation.sourceTotals.assembly.total, 0);
  assert.equal(snapshot.reconciliation.sourceTotals.fbo.packed, 400);
  for (const period of ["day", "week", "month"]) {
    const selected = selectAssemblyPeriod(snapshot, "2026-10-17", period);
    assert.ok(selected.events.every(event => !ids.includes(event.eventId)));
  }
  const week = selectAssemblyPeriod(snapshot, "2026-10-17", "week");
  assert.equal(week.reconciliation.sourceTotals.assembly.packed, 999, 'uncancelled earlier work stays in the week');
  const unavailable = await loadAssembly("2026-10-17", "day", async url =>
    String(url).includes("gid=1151154937") ? new Response("denied", { status: 403 }) : fetcher(url),
    { today: "2026-10-17" });
  assert.equal(unavailable.sources.assembly.status, "unavailable");
  assert.equal(unavailable.sources.assembly.lastSuccessAt, null);
  assert.equal(unavailable.sources.fbo.status, "available");
  assert.match(unavailable.sources.assembly.message, /WorkLogCorrections/);
  assert.equal(unavailable.events.length, 0, 'failure cannot resurrect unfiltered cancelled events');
});

test("an unavailable WorkLog leaves live FBO results visible and marks the combined KPI unknown", async () => {
  const norms = '"Вид","Норма"\r\n"Наклейки Упаковка","750"';
  const fetcher = async (url) => {
    const value = String(url);
    if (value.includes("gviz/tq"))
      return new Response(liveFboCurrentFixture, { status: 200 });
    if (value.includes("gid=2070043218"))
      return new Response(mixedFboFixture, { status: 200 });
    if (value.includes("gid=130670756"))
      return new Response(norms, { status: 200 });
    if (value.includes("gid=1587688746"))
      return new Response("Not available", { status: 403 });
    if (value.includes("gid=1151154937"))
      return new Response("correctionId,eventId,action,createdAt,actor,reason");
    if (value.includes("gid=651303867"))
      return new Response(mixedCatalogFixture, { status: 200 });
    throw new Error("Unexpected spreadsheet source: " + value);
  };

  const result = await loadAssembly("2026-10-17", "day", fetcher, {
    today: "2026-10-17",
  });
  assert.equal(result.stale, true);
  assert.equal(result.sources.assembly.status, "unavailable");
  assert.equal(result.sources.fbo.status, "available");
  assert.equal(result.events.length, 0);
  assert.equal(
    result.rows.find((row) => row.employee === "Вика 4")?.packed,
    400,
  );
  assert.equal(result.reconciliation.status, "unknown");
  assert.equal(result.reconciliation.approvedTotals, null);
});

test("an unavailable FBO source leaves Assembly results visible", async () => {
  const norms = '"Вид","Норма"\r\n"Наклейки Упаковка","750"';
  const fetcher = async (url) => {
    const value = String(url);
    if (value.includes("gviz/tq"))
      return new Response("unavailable", { status: 403 });
    if (value.includes("gid=130670756"))
      return new Response(norms, { status: 200 });
    if (value.includes("gid=1587688746"))
      return new Response(mixedWorkLogFixture, { status: 200 });
    if (value.includes("gid=1151154937"))
      return new Response("correctionId,eventId,action,createdAt,actor,reason");
    if (value.includes("gid=651303867"))
      return new Response(mixedCatalogFixture, { status: 200 });
    throw new Error("Unexpected spreadsheet source: " + value);
  };
  const result = await loadAssembly("2026-10-17", "day", fetcher, {
    today: "2026-10-17",
  });
  assert.equal(result.sources.fbo.status, "unavailable");
  assert.equal(result.sources.assembly.status, "available");
  assert.equal(result.reconciliation.sourceTotals.assembly.total, 380);
  assert.equal(result.reconciliation.approvedTotals, null);
  assert.equal(
    result.rows.reduce((sum, row) => sum + row.total, 0),
    380,
  );
});

test("confirmed employee mapping flags same-grain FBO and Assembly overlap without subtracting either source", () => {
  const [fbo] = parseFboCurrent(liveFboCurrentFixture, "2026-10-17").records;
  const assembly = {
    id: "event-duplicate-candidate",
    sourceKind: "assembly",
    employeeId: "emp-016",
    employee: "Алексей",
    identityKey: "assembly:emp-016",
    date: "2026-10-17",
    coefficient: 0.25,
    machineCut: 0,
    manualCut: 0,
    cut: 0,
    packed: 400,
    total: 400,
    days: 1,
    cutTypes: [],
    packTypes: [{ name: "Наклейки А5 3-4 листа", quantity: 400 }],
    events: [
      {
        eventId: "event-duplicate-candidate",
        operationId: "packing",
        productType: "Наклейки А5 3-4 листа",
        quantity: 400,
      },
    ],
  };
  const conflict = reconcileAssemblySources({
    fboRecords: [fbo],
    assemblyRecords: [assembly],
    fboStatus: "available",
    assemblyStatus: "available",
    crosswalk: [{ fboName: "Вика 4", employeeId: "emp-016" }],
    startDate: "2026-10-17",
    endDate: "2026-10-17",
  });
  assert.equal(conflict.status, "needs_review");
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.sourceTotals.fbo.packed, 400);
  assert.equal(conflict.sourceTotals.assembly.packed, 400);
  assert.equal(conflict.approvedTotals, null);

  const separateWork = {
    ...assembly,
    events: [{ ...assembly.events[0], productType: "Тубусные наклейки" }],
    packTypes: [{ name: "Тубусные наклейки", quantity: 400 }],
  };
  const separate = reconcileAssemblySources({
    fboRecords: [fbo],
    assemblyRecords: [separateWork],
    fboStatus: "available",
    assemblyStatus: "available",
    crosswalk: [{ fboName: "Вика 4", employeeId: "emp-016" }],
    startDate: "2026-10-17",
    endDate: "2026-10-17",
  });
  assert.equal(separate.status, "clear");
  assert.equal(separate.approvedTotals.total, 800);
});

test("uniquely matching FBO numbered names join the Assembly employee while ambiguous names stay separate", () => {
  const [fbo] = parseFboCurrent(liveFboCurrentFixture, "2026-10-17").records;
  const assembly = {
    id: "event-vika",
    sourceKind: "assembly",
    employeeId: "emp-016",
    employee: "Вика",
    identityKey: "assembly:emp-016",
    date: "2026-10-17",
    coefficient: 0.25,
    machineCut: 0,
    manualCut: 0,
    cut: 0,
    packed: 10,
    total: 10,
    days: 1,
    cutTypes: [],
    packTypes: [{ name: "Тубусные наклейки", quantity: 10 }],
    events: [],
  };
  const matched = reconcileAssemblySources({
    fboRecords: [fbo],
    assemblyRecords: [assembly],
    fboStatus: "available",
    assemblyStatus: "available",
    startDate: "2026-10-17",
    endDate: "2026-10-17",
  });
  assert.equal(matched.fboRecords[0].identityKey, "assembly:emp-016");
  assert.equal(matched.assemblyRecords[0].identityKey, "assembly:emp-016");
  assert.deepEqual(matched.pendingMappings.fboNames, []);

  const ambiguous = reconcileAssemblySources({
    fboRecords: [fbo],
    assemblyRecords: [
      assembly,
      { ...assembly, employeeId: "emp-017", identityKey: "assembly:emp-017" },
    ],
    fboStatus: "available",
    assemblyStatus: "available",
    startDate: "2026-10-17",
    endDate: "2026-10-17",
  });
  assert.equal(ambiguous.fboRecords[0].identityKey, "fbo:Вика 4");
  assert.deepEqual(ambiguous.pendingMappings.fboNames, ["Вика 4"]);
});

test("an unrelated unmapped employee does not block a verified non-overlapping employee pair", () => {
  const [fbo] = parseFboCurrent(liveFboCurrentFixture, "2026-10-17").records;
  const knownAssembly = {
    id: "event-vika",
    sourceKind: "assembly",
    employeeId: "emp-016",
    employee: "Вика",
    identityKey: "assembly:emp-016",
    date: "2026-10-17",
    coefficient: 0.25,
    machineCut: 0,
    manualCut: 0,
    cut: 0,
    packed: 10,
    total: 10,
    days: 1,
    cutTypes: [],
    packTypes: [{ name: "Тубусные наклейки", quantity: 10 }],
    events: [],
  };
  const unknownFbo = { ...fbo, employee: "Лиза 7", identityKey: "fbo:Лиза 7" };
  const unknownAssembly = {
    ...knownAssembly,
    employee: "Михаил",
    employeeId: "emp-099",
    identityKey: "assembly:emp-099",
  };
  const result = reconcileAssemblySources({
    fboRecords: [fbo, unknownFbo],
    assemblyRecords: [knownAssembly, unknownAssembly],
    fboStatus: "available",
    assemblyStatus: "available",
    startDate: "2026-10-17",
    endDate: "2026-10-17",
  });
  assert.equal(result.fboRecords[0].reconciliationStatus, "clear");
  assert.equal(result.assemblyRecords[0].reconciliationStatus, "clear");
  assert.equal(result.fboRecords[1].reconciliationStatus, "needs_review");
  assert.equal(result.assemblyRecords[1].reconciliationStatus, "needs_review");
  assert.equal(result.approvedTotals.total, 410);
});

test("weekly assembly totals include dates in the selected week through selected day", () => {
  const result = summarizeAssembly(
    parseAssemblyRows(fixture),
    "2026-10-08",
    "week",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].coefficient, 0.75);
  assert.equal(result[0].cut, 16);
  assert.equal(result[0].packed, 26);
  assert.equal(result[0].total, 42);
  assert.deepEqual(result[0].cutTypes, [{ name: "ПВХ", quantity: 16 }]);
});

test("daily history groups production by employee and date", () => {
  const records = parseAssemblyRows(fixture);
  const sourceDay = records.find((row) => row.date === "2026-10-08");
  const duplicate = {
    ...sourceDay,
    id: "same-day-row",
    cut: 2,
    packed: 3,
    total: 5,
    coefficient: 0.1,
  };
  const history = summarizeAssemblyDays([...records, duplicate]);
  assert.equal(history.length, 3);
  const selected = history.find((row) => row.date === "2026-10-08");
  assert.equal(selected.cut, 6);
  assert.equal(selected.packed, 9);
  assert.equal(selected.total, 15);
  assert.equal(selected.coefficient, 0.35);
  assert.deepEqual(selected.sourceIds, ["2", "same-day-row"]);
  assert.equal(selected.lastUpdatedAt, "2026-10-07T21:00:00.000Z");
});

test("FBO endpoint is read-only and serves the selected period", async () => {
  const denied = await worker.fetch(
    new Request("https://ritm.test/api/assembly", { method: "POST" }),
    {},
  );
  assert.equal(denied.status, 405);

  const originalFetch = globalThis.fetch;
  const norms =
    '"Вид","Норма"\r\n"Наклейки Резка на станке Л","6500"\r\n"Наклейки Упаковка","750"\r\n"Наклейки Резка вручную","650"';
  globalThis.fetch = async (url) => {
    if (String(url).includes("gid=2070043218"))
      return new Response(fixture, { status: 200 });
    if (String(url).includes("gid=130670756"))
      return new Response(norms, { status: 200 });
    throw new Error("Unexpected FBO sheet request");
  };
  try {
    const response = await worker.fetch(
      new Request("https://ritm.test/api/assembly?date=2026-10-08&period=week"),
      {},
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.rows[0].coefficient, null);
    assert.equal(result.rows[0].sourceContributions[0].coefficient, 0.75);
    assert.equal(result.period, "week");
    assert.equal(result.history.length, 2);
    assert.equal(
      result.history.find((row) => row.date === "2026-10-08").total,
      10,
    );
    assert.equal(result.norms.status, "available");
    assert.deepEqual(result.norms.rows[0], {
      productType: "Наклейки Л",
      operation: "Резка на станке",
      norm: 6500,
      unit: "листов/смену",
      sourceLabel: "Наклейки Резка на станке Л",
    });
    assert.equal(result.norms.rows[1].unit, "шт./смену");
    assert.deepEqual(result.norms.rows[2], {
      productType: "Наклейки",
      operation: "Ручная резка",
      norm: 650,
      unit: "листов/смену",
      sourceLabel: "Наклейки Резка вручную",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unavailable norms do not hide confirmed FBO work history", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes("gid=2070043218")
      ? new Response(fixture, { status: 200 })
      : new Response("not available", { status: 403 });
  try {
    const response = await worker.fetch(
      new Request("https://ritm.test/api/assembly?date=2026-10-08&period=week"),
      {},
    );
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.history.length, 2);
    assert.equal(result.norms.status, "unavailable");
    assert.match(result.norms.message, /недоступен/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
