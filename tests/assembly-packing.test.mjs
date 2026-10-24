import test from "node:test";
import assert from "node:assert/strict";
import {
  attachAssemblyPacking,
  loadAssemblyPacking,
  RITM_ASSEMBLY_WORKLOG,
} from "../agent/assemblyPacking.js";

test("shared supply packaging matches both department positions and does not mix equal raw UIDs", () => {
  const shipment = "RITM-SUPPLY-11111111-1111-4111-8111-111111111111";
  const printing = { sheets: [], supplies: [
    { sourceId: "roll-printing", assemblyShipmentId: shipment, sheetId: 100, rawUid: "same", article: "ROLL" },
    { sourceId: "box-printing", assemblyShipmentId: shipment, sheetId: 200, rawUid: "same", article: "BOX" },
  ] };
  const result = attachAssemblyPacking(printing, { invalid: [], events: [
    { shipmentId: shipment, positionId: shipment + "|uid:same|ROLL", article: "ROLL", quantity: 10, createdAt: "2026-10-20T09:00:00Z" },
    { shipmentId: shipment, positionId: shipment + "|box:200|uid:same|BOX", article: "BOX", quantity: 20, createdAt: "2026-10-20T09:00:00Z" },
  ] }, "2026-10-20T10:00:00Z");
  assert.deepEqual(result.supplies.map(s => s.packed), [10, 20]);
  assert.equal(result.packing.status, "available");
});
import { RITM_ASSEMBLY_WORK_CORRECTIONS_GID } from "../worker/assemblyWorkLog.js";

const headers = [
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

function workRow({
  id = "event-1",
  at = "2026-10-16T10:00:00.000Z",
  shipment = "RITM-ROLL-119710351",
  direction = "ROLL",
  position = "RITM-ROLL-119710351|uid:uid-1|SKU-1",
  article = "SKU-1",
  employee = "Лукман",
  operation = "packing",
  quantity = 12,
  source = "WEB_APP_RITM",
  idempotencyKey = "work-key-1",
} = {}) {
  return [
    id,
    at,
    shipment,
    direction,
    "Москва",
    position,
    article,
    "employee-1",
    employee,
    operation,
    operation === "packing" ? "Упаковка" : "Порезка",
    quantity,
    10,
    1.2,
    source,
    idempotencyKey,
  ];
}

function grid(records, correctionRecords = []) {
  const asCell = (value) =>
    value === "" || value === null || value === undefined
      ? {}
      : typeof value === "number"
        ? { userEnteredValue: { numberValue: value } }
        : { userEnteredValue: { stringValue: String(value) } };
  return {
    spreadsheetId: RITM_ASSEMBLY_WORKLOG.documentId,
    sheets: [
      {
        properties: {
          sheetId: RITM_ASSEMBLY_WORKLOG.sheetId,
          title: RITM_ASSEMBLY_WORKLOG.sheetName,
        },
        data: [
          {
            rowData: [headers, ...records].map((row) => ({
              values: row.map(asCell),
            })),
          },
        ],
      },
      {
        properties: { sheetId: RITM_ASSEMBLY_WORK_CORRECTIONS_GID, title: "WorkLogCorrections" },
        data: [{ rowData: [["correctionId", "eventId", "action", "createdAt", "actor", "reason"], ...correctionRecords]
          .map((row) => ({ values: row.map(asCell) })) }],
      },
    ],
  };
}

function printingPayload() {
  return {
    ok: true,
    schemaVersion: 2,
    updatedAt: "2026-10-16T10:30:00.000Z",
    events: [{ id: "print-1" }],
    cutEvents: [],
    issues: [],
    sheets: [
      {
        sheetId: 119710351,
        name: "OZON МОСКВА 10_10",
        sourceId: "roll-printing",
      },
    ],
    supplies: [
      {
        uid: "119710351::uid-1",
        rawUid: "uid-1",
        sheetId: 119710351,
        row: 5,
        article: "SKU-1",
        quantity: 100,
        plannedArea: 10,
        sourceId: "roll-printing",
      },
      {
        uid: "119710351::uid-2",
        rawUid: "uid-2",
        sheetId: 119710351,
        row: 6,
        article: "SKU-2",
        quantity: 50,
        plannedArea: 5,
        sourceId: "roll-printing",
      },
    ],
  };
}

function readerFor(workLogGrid, { rowCount = 1000 } = {}) {
  const calls = [];
  return {
    calls,
    async metadata(documentId, signal, priority) {
      calls.push({ method: "metadata", documentId, priority });
      return {
        spreadsheetId: documentId,
        sheets: [
          {
            properties: {
              sheetId: RITM_ASSEMBLY_WORKLOG.sheetId,
              title: RITM_ASSEMBLY_WORKLOG.sheetName,
              gridProperties: { rowCount, columnCount: 16 },
            },
          },
          { properties: {
            sheetId: RITM_ASSEMBLY_WORK_CORRECTIONS_GID,
            title: "WorkLogCorrections",
            gridProperties: { rowCount: 1000, columnCount: 6 },
          } },
        ],
      };
    },
    async grid(documentId, ranges, signal, priority) {
      calls.push({ method: "grid", documentId, ranges, priority });
      return workLogGrid;
    },
  };
}

test("separate cancellation ledger removes only targeted packing facts and deduplicates cancellation rows", async () => {
  const corrections = [
    ["c1", "cancelled-packing", "CANCEL", "2026-10-19T08:54:09Z", "owner", "Wrong work"],
    ["c2", "cancelled-packing", "CANCEL", "2026-10-19T08:55:09Z", "owner", "Retry"],
  ];
  const result = await loadAssemblyPacking(readerFor(grid([
    workRow({ id: "cancelled-packing", quantity: 10, idempotencyKey: "cancel-key" }),
    workRow({ id: "active-packing", quantity: 6, idempotencyKey: "active-key" }),
  ], corrections)), printingPayload());
  assert.equal(result.packing.status, "available");
  assert.equal(result.supplies[0].packed, 6);
  assert.equal(result.supplies[0].packingRecords, 1);
});

test("read-only packing includes shared and standalone box supplies and preserves cancellations", async () => {
  const shipment = "RITM-SUPPLY-df6b8985-eb77-43e6-9d97-311c8cf4ae23";
  const boxShipment = "RITM-BOX-200";
  const rollPosition = `${shipment}|uid:uid-1|SKU-1`;
  const boxPosition = `${boxShipment}|box:200|uid:box-1|BOX-1`;
  const data = printingPayload();
  data.supplies[0].assemblyShipmentId = shipment;
  data.supplies.push({ sourceId: "box-printing", sheetId: 200, rawUid: "box-1", article: "BOX-1", quantity: 100 });
  const result = await loadAssemblyPacking(readerFor(grid([
    workRow({ id: "shared-work", shipment, position: rollPosition, quantity: 70, idempotencyKey: "shared-work" }),
    workRow({ id: "box-work", shipment: boxShipment, position: boxPosition, article: "BOX-1", quantity: 20, idempotencyKey: "box-work" }),
    workRow({ id: "cancelled-shared", shipment, position: rollPosition, quantity: 10, idempotencyKey: "cancelled-shared" }),
  ], [["c1", "cancelled-shared", "CANCEL", "2026-10-20T12:00:00Z", "owner", "Correction"]])), data);
  assert.equal(result.packing.status, "available");
  assert.equal(result.supplies[0].packed, 70);
  assert.equal(result.supplies.at(-1).packed, 20);
});

test("all cancelled packing gives a confirmed zero; an unreadable correction ledger gives unknown", async () => {
  const data = grid([workRow({ id: "cancelled" })], [
    ["c1", "cancelled", "CANCEL", "2026-10-19T08:54:09Z", "owner", "Wrong work"],
  ]);
  const cleared = await loadAssemblyPacking(readerFor(data), printingPayload());
  assert.equal(cleared.packing.status, "available");
  assert.equal(cleared.supplies[0].packed, 0);
  const missing = structuredClone(data);
  missing.sheets.pop();
  const unavailable = await loadAssemblyPacking(readerFor(missing), printingPayload());
  assert.equal(unavailable.packing.status, "unavailable");
  assert.equal(unavailable.supplies[0].packed, null);
  const corrupt = structuredClone(data);
  corrupt.sheets[1].data[0].rowData[1].values[2].userEnteredValue.stringValue = "RESTORE";
  const invalid = await loadAssemblyPacking(readerFor(corrupt), printingPayload());
  assert.equal(invalid.packing.status, "unavailable");
  assert.equal(invalid.supplies[0].packed, null);
});

test("roll-supply packaging comes from linked RITM WorkLog entries only", async () => {
  const reader = readerFor(
    grid([
      workRow({ id: "p1", quantity: 12, idempotencyKey: "key-1" }),
      workRow({
        id: "p2",
        at: "2026-10-16T10:20:00.000Z",
        quantity: 8,
        idempotencyKey: "key-2",
      }),
      workRow({
        id: "p3",
        position: "RITM-ROLL-119710351|uid:uid-2|SKU-2",
        article: "SKU-2",
        quantity: 5,
        idempotencyKey: "key-3",
      }),
      workRow({ id: "demo", quantity: 900, source: "WEB_APP_TEST" }),
      workRow({ id: "cut", operation: "cut", quantity: 300 }),
      workRow({
        id: "other-shipment",
        shipment: "RITM-ROLL-1979062763",
        position: "RITM-ROLL-1979062763|uid:uid-1|SKU-1",
        quantity: 400,
      }),
    ]),
  );
  const result = await loadAssemblyPacking(reader, printingPayload(), {
    checkedAt: "2026-10-16T10:30:00.000Z",
  });

  assert.equal(reader.calls.length, 2);
  assert.deepEqual(reader.calls[1].ranges, ["'WorkLog'!A1:P1000", "'WorkLogCorrections'!A1:F1000"]);
  assert.equal(result.packing.status, "available");
  assert.equal(result.packing.eventCount, 3);
  assert.equal(result.packing.invalidRecords, 0);
  assert.equal(result.packing.sourceUpdatedAt, "2026-10-16T10:20:00.000Z");
  assert.equal(result.supplies[0].packed, 20);
  assert.equal(result.supplies[0].packingRecords, 2);
  assert.equal(result.supplies[1].packed, 5);
  assert.equal(result.supplies[1].packingRecords, 1);
  assert.equal(result.events[0].id, "print-1");
});

test("an empty successful WorkLog read is a confirmed zero, not missing data", async () => {
  const result = await loadAssemblyPacking(
    readerFor(grid([])),
    printingPayload(),
    { checkedAt: "2026-10-16T10:30:00.000Z" },
  );

  assert.equal(result.packing.status, "available");
  assert.equal(result.supplies[0].packed, 0);
  assert.equal(result.supplies[1].packed, 0);
});

test("duplicate WorkLog ids make the affected article unknown instead of double-counted", async () => {
  const result = await loadAssemblyPacking(
    readerFor(
      grid([
        workRow({ id: "duplicate", quantity: 12, idempotencyKey: "same-key" }),
        workRow({ id: "duplicate", quantity: 15, idempotencyKey: "other-key" }),
      ]),
    ),
    printingPayload(),
    { checkedAt: "2026-10-16T10:30:00.000Z" },
  );

  assert.equal(result.packing.status, "partial");
  assert.equal(result.packing.invalidRecords, 1);
  assert.equal(result.supplies[0].packed, null);
  assert.equal(result.supplies[1].packed, 0);
});

test("a missing or inaccessible WorkLog never hides printing data or invents packing zeroes", async () => {
  const reader = {
    async metadata() {
      throw Object.assign(new Error("Google API refused access"), {
        code: "sheets_unavailable",
        status: 403,
      });
    },
  };
  const base = printingPayload();
  const result = await loadAssemblyPacking(reader, base, {
    checkedAt: "2026-10-16T10:30:00.000Z",
  });

  assert.equal(result.packing.status, "unavailable");
  assert.match(result.packing.reason, /временно недоступен/);
  assert.equal(result.events[0].id, "print-1");
  assert.equal(result.supplies[0].packed, null);
  assert.equal(result.supplies[1].packed, null);
});

test("a WorkLog too large for the bounded read stays unavailable instead of truncating facts", async () => {
  const result = await loadAssemblyPacking(
    readerFor(grid([]), { rowCount: RITM_ASSEMBLY_WORKLOG.maxRows + 1 }),
    printingPayload(),
    { checkedAt: "2026-10-16T10:30:00.000Z" },
  );

  assert.equal(result.packing.status, "unavailable");
  assert.equal(result.supplies[0].packed, null);
});
