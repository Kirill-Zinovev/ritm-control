import assert from "node:assert/strict";
import test from "node:test";
import { evaluateArkadyCutWatch } from "../worker/cloud/arkadyCutWatch.js";
import { overlayPrintingV2 } from "../worker/cloud/assemblyV2Events.js";
import { indexOrders } from "../worker/printing.js";

const now = Date.parse("2026-11-26T12:00:00Z");
const checkedAt = new Date(now).toISOString();
const shipmentId = "RITM-SUPPLY-8bccc1a2-a162-4ba5-b63d-bb54eac2f5e1";
const roll = { sourceId: "roll-printing", sheetId: 401, name: "OZON Ярославль · Рулонная", assemblyShipmentId: shipmentId, spreadsheetId: "roll-doc" };
const box = { sourceId: "box-printing", sheetId: 402, name: "OZON Ярославль · Бокс", assemblyShipmentId: shipmentId, spreadsheetId: "box-doc" };
const supplies = [{ id: shipmentId, name: "OZON Ярославль · Магазин 1" }];
const watchKey = `${shipmentId}:roll:401`;
const order = (sheet, uid, article, override = {}) => ({
  sourceId: sheet.sourceId, sheetId: sheet.sheetId, spreadsheetId: sheet.spreadsheetId,
  assemblyShipmentId: sheet.assemblyShipmentId, uid, rawUid: uid, article, quantity: 25,
  printProgress: 25, cutProgress: 0, packed: 0, packingRecords: 0, ...override,
});
const started = { packed: 4, packingRecords: 1 };
const evaluate = (rows, options = {}) => evaluateArkadyCutWatch({
  now, supplies, excludedShipmentIds: options.excludedShipmentIds,
  printing: {
    ok: true, quality: { status: "valid" }, snapshotAt: checkedAt,
    packing: { status: "available", checkedAt }, sheets: [roll, box], supplies: rows,
    ...options.printing,
  },
});

test("groups verified discrepancies by physical section and only includes packed article positions", () => {
  const result = evaluate([
    order(roll, "r1", "QA0003.A0788", started),
    order(roll, "r2", "QA0003.A0788", { ...started, cutProgress: null, cutMarkMissing: true }),
    order(roll, "r3", "NO-PACKING"),
    order(roll, "r4", "NO-CUT-DATA", { ...started, cutProgress: null }),
    order(roll, "r5", "FINISHED", { ...started, cutProgress: 25 }),
    order(box, "b1", "BOX-ARTICLE", started),
  ]);
  assert.deepEqual(result.events, [
    { key: watchKey, supplyId: shipmentId, name: supplies[0].name, department: "roll", sheetId: 401, articles: ["QA0003.A0788"], positions: 2, url: "" },
    { key: `${shipmentId}:box:402`, supplyId: shipmentId, name: supplies[0].name, department: "box", sheetId: 402, articles: ["BOX-ARTICLE"], positions: 1, url: "" },
  ]);
  assert.deepEqual(result.resolvedKeys, []);
});

test("requires full section printing and same-row evidence of both work and incomplete marks", () => {
  for (const printProgress of [24, null]) {
    const rows = [order(roll, "r1", "PACKED", started), order(roll, "r2", "UNPRINTED", { printProgress })];
    assert.deepEqual(evaluate(rows), { events: [], resolvedKeys: [] });
  }
  const rows = [
    order(roll, "r1", "SAME-SKU"),
    order(box, "b1", "SAME-SKU", { ...started, cutProgress: 25 }),
    order(roll, "r2", "UNVERIFIED-PACKING", { packed: null, packedConfirmed: 4 }),
  ];
  assert.deepEqual(evaluate(rows).events, []);
});

test("uses exact current Assembly position identity and ignores canceled packing", () => {
  const row = order(roll, "r1", "PACKED-SKU");
  const raw = {
    ok: true, quality: { status: "valid" }, snapshotAt: checkedAt,
    _assemblyStages: { checkedAt, packing: { events: [], invalid: [] } },
    sheets: [roll], supplies: [row],
  };
  const pack = {
    kind: "work", operation: "packing", eventId: "synthetic-pack", shipmentId,
    positionId: `${shipmentId}|uid:r1|PACKED-SKU`, sku: "PACKED-SKU", qty: 4, createdAt: checkedAt,
  };
  assert.equal(evaluateArkadyCutWatch({ printing: overlayPrintingV2(raw, [pack]), now }).events.length, 1);
  assert.deepEqual(evaluateArkadyCutWatch({ printing: overlayPrintingV2(raw, [pack, { kind: "cancel", eventId: pack.eventId }]), now }),
    { events: [], resolvedKeys: [watchKey] });
  const differentPosition = { ...pack, positionId: `${shipmentId}|uid:another-row|PACKED-SKU` };
  assert.deepEqual(evaluateArkadyCutWatch({ printing: overlayPrintingV2(raw, [differentPosition]), now }),
    { events: [], resolvedKeys: [] });
});

test("skips stale or incomplete sources without resolving pending reminders", () => {
  const rows = [order(roll, "r1", "PACKED", started)];
  for (const printing of [
    { stale: true }, { refreshFailed: true }, { refreshInProgress: true },
    { snapshotAt: "2026-11-26T10:00:00Z" },
    { packing: { status: "unavailable", checkedAt } },
    { packing: { status: "available", checkedAt: "2026-11-26T10:00:00Z" } },
    { assemblyV2: { pendingRefresh: true } },
    { quality: { status: "partial" }, issues: [{ source: roll.name }] },
    { quality: { status: "partial" }, issues: [{}] },
    { sheets: [{ ...roll, assemblyShipmentId: "RITM-ROLL-200" }] },
  ]) assert.deepEqual(evaluate(rows, { printing }), { events: [], resolvedKeys: [] });
  assert.equal(evaluate(rows, { printing: { quality: { status: "partial" }, issues: [{ source: "Другой лист" }] } }).events.length, 1);
});

test("allows an explicit resolved result from complete marks, confirmed cancellation, or exclusion", () => {
  const rows = [order(roll, "r1", "PACKED", started)];
  assert.deepEqual(evaluate([{ ...rows[0], cutProgress: 25 }]), { events: [], resolvedKeys: [watchKey] });
  assert.deepEqual(evaluate([{ ...rows[0], packed: 0, packingRecords: 0 }]), { events: [], resolvedKeys: [watchKey] });
  assert.deepEqual(evaluate([{ ...rows[0], archived: true }]), { events: [], resolvedKeys: [watchKey] });
  assert.deepEqual(evaluate(rows, { excludedShipmentIds: new Set([shipmentId]) }), {
    events: [], resolvedKeys: [watchKey, `${shipmentId}:box:402`],
  });
});

test("sheet parser distinguishes truly blank cutting marks from errors and missing headers", () => {
  const readRow = (department, progress, status = "", date = "", hasHeader = true) => {
    const top = Array(30).fill("");
    top[29] = "UID";
    const headers = Array(30).fill("");
    headers[4] = "Артикул";
    headers[15] = "Кол-во";
    if (department === "roll-printing") {
      headers[19] = "Порезка";
      if (hasHeader) headers[21] = "Прогресс порезки";
      headers[23] = "Дата готовности порезки";
    } else if (hasHeader) headers[21] = "Готовность порезки";
    const row = Array(30).fill("");
    row[4] = "SYNTHETIC-SKU";
    row[15] = "15";
    row[19] = status;
    row[21] = progress;
    row[23] = date;
    row[29] = "synthetic-uid";
    return indexOrders([{
      gid: 400, name: "OZON Пример", sourceId: department,
      rows: [top, [], [], headers, row], headerRow: 4, dataStartRow: 5,
    }]).orders[0];
  };
  for (const department of ["roll-printing", "box-printing"]) {
    const blank = readRow(department, "");
    assert.equal(blank.cutProgress, null);
    assert.equal(blank.cutMarkMissing, true);
    assert.equal(readRow(department, "#N/A").cutMarkMissing, undefined);
    assert.equal(readRow(department, "", "", "", false).cutMarkMissing, undefined);
  }
  assert.equal(readRow("roll-printing", "", "Готов").cutMarkMissing, undefined);
  assert.equal(readRow("roll-printing", "", "", "26.11.2026").cutMarkMissing, undefined);
  assert.equal(readRow("roll-printing", "█░░░░░░░░░ 10%", "В работе").cutProgress, 1.5);
  assert.equal(readRow("box-printing", "FALSE").cutProgress, 0);
});
