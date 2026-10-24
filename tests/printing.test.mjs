import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  indexOrders,
  collectJournalPrinting,
  collectJournalCutting,
  SUPPLY_SHEETS,
  ROLL_PRINTING_SHEET,
  ROLL_PRINTING_SHEET_ID,
  BOX_PRINTING_SHEET_ID,
  PRINTING_SOURCES,
  loadPrinting,
} from "../worker/printing.js";

test("box jobs load without an invented production journal or printer KPI", async () => {
  const csv = rows => rows.map(row => row.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
  const requested = [];
  const result = await loadPrinting(async url => {
    const parsed = new URL(url), documentId = parsed.pathname.split('/')[3], gid = Number(parsed.searchParams.get('gid'));
    requested.push({ documentId, gid });
    const source = PRINTING_SOURCES.find(s => s.spreadsheetId === documentId);
    if (source && gid === source.journal.gid) {
      const headers = Array(15).fill('');
      for (const [column, header] of Object.entries(source.journal.expectedHeaders)) headers[column] = header;
      return new Response(csv([headers]));
    }
    const rows = Array.from({ length: 4 }, () => Array(29).fill(''));
    const descriptor = source?.supplies.find(s => s.gid === gid);
    const headerRow = descriptor?.headerRow || (documentId === BOX_PRINTING_SHEET_ID ? 4 : 3);
    rows[0][28] = 'UID'; rows[headerRow - 1][4] = 'Артикул'; rows[headerRow - 1][14] = 'Кол-во';
    if (documentId === BOX_PRINTING_SHEET_ID) {
      const row = Array(29).fill(''); row[4] = 'BOX'; row[14] = 25; row[17] = 'TRUE'; row[18] = 'FALSE'; row[28] = 'box-id'; rows.push(row);
    }
    return new Response(csv(rows));
  }, { productionSupplies: [{ id: 'common', name: 'OZON Общая', parts: [{ department: 'box', documentId: BOX_PRINTING_SHEET_ID, sheetId: 700 }] }] });
  assert.equal(result.supplies.length, 1);
  assert.equal(result.supplies[0].sourceId, 'box-printing');
  assert.equal(result.supplies[0].assemblyShipmentId, 'common');
  assert.equal(result.events.length, 0);
  assert.equal(requested.filter(r => r.documentId === BOX_PRINTING_SHEET_ID).length, 1);
});

test("Assembly-linked box sheets load with row-based identity and share the roll shipment", async () => {
  const csv = rows => rows.map(row => row.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
  const requested = [];
  const rollSheetId = 900001;
  const boxSheetId = 900002;
  const result = await loadPrinting(async url => {
    const parsed = new URL(url);
    const documentId = parsed.pathname.split('/')[3];
    const gid = Number(parsed.searchParams.get('gid'));
    requested.push({ documentId, gid });
    const source = PRINTING_SOURCES.find(s => s.spreadsheetId === documentId);
    if (source?.journal?.gid === gid) {
      const headers = Array(15).fill('');
      for (const [column, header] of Object.entries(source.journal.expectedHeaders)) headers[column] = header;
      return new Response(csv([headers]));
    }
    const box = documentId === BOX_PRINTING_SHEET_ID && gid === boxSheetId;
    const descriptor = source?.supplies.find(sheet => sheet.gid === gid) ||
      (documentId === ROLL_PRINTING_SHEET_ID && gid === rollSheetId ? ROLL_PRINTING_SHEET : null);
    const rows = Array.from({ length: box ? 4 : 4 }, () => Array(29).fill(''));
    if (!box) rows[0][28] = 'UID';
    const headerRow = box ? 4 : descriptor?.headerRow || 3;
    rows[headerRow - 1][4] = 'Артикул';
    rows[headerRow - 1][14] = 'Кол-во';
    if (box) {
      const order = Array(29).fill('');
      order[4] = 'BOX-SKU';
      order[9] = '12.5';
      order[14] = '25';
      rows.push(order);
    }
    return new Response(csv(rows));
  }, {
    additionalSheets: [{ gid: rollSheetId, name: 'OZON linked roll' }],
    productionSupplies: [{
      id: 'shared-shipment',
      name: 'OZON linked roll',
      parts: [{ department: 'roll', documentId: ROLL_PRINTING_SHEET_ID, sheetId: rollSheetId }],
    }],
    assemblyBoxLinks: [{
      name: 'OZON linked roll',
      boxSheetId,
      targetRollSheetId: rollSheetId,
      boxRows: 1,
      boxQuantity: 25,
      positionKeys: ['row:5|BOX-SKU'],
    }],
  });
  const boxOrder = result.supplies.find(order => order.sourceId === 'box-printing');
  assert.ok(requested.some(request => request.documentId === BOX_PRINTING_SHEET_ID && request.gid === boxSheetId));
  assert.equal(boxOrder?.article, 'BOX-SKU');
  assert.equal(boxOrder?.uid, `${boxSheetId}::row:5`);
  assert.equal(boxOrder?.rawUid, null);
  assert.equal(boxOrder?.assemblyShipmentId, 'shared-shipment');
  assert.equal(boxOrder?.plannedArea, 12.5);
  assert.equal(boxOrder?.areaKnown, true);
  assert.equal(result.issues.some(issue => issue.source === 'OZON linked roll' && issue.code === 'missing_uid'), false);
});
const o = {
  uid: "NY-0001",
  rawUid: "NY-0001",
  sheetId: 437912546,
  sheetName: "OZON НОВЫЙ ГОД",
  article: "ART",
};
const ix = {
  orders: [o],
  byUid: { [o.uid]: o },
  byRaw: { [o.uid]: [o] },
  issues: [],
};
const log = (
  qty = 40,
  area = 7.04,
  name = "Павел",
  id = "j1",
  date = "06.10.2026",
) => [
  id,
  date,
  name,
  "Печать",
  o.sheetName,
  4,
  o.article,
  o.uid,
  "д1",
  qty,
  0.176,
  area,
  "",
  "",
  "r1",
];
const total = (r) => r.events.reduce((n, e) => n + e.area, 0);
const calc = (js) => collectJournalPrinting(ix, js);
test("CSV preserves multiline cells, quotes, decimal commas and Russian", () =>
  assert.deepEqual(
    parseCsv('a,b\r\n"первый\nлист","10,56"\r\n"с ""кавычками""",0'),
    [
      ["a", "b"],
      ["первый\nлист", "10,56"],
      ['с "кавычками"', "0"],
    ],
  ));
test("CSV rejects HTML login pages and incomplete data", () => {
  assert.throws(() => parseCsv("<html>login"));
  assert.throws(() => parseCsv('"incomplete'));
});
test("partial output is counted directly from the journal", () =>
  assert.equal(total(calc([log()])), 7.04));
test("production date B is used instead of the record timestamp M", () => {
  const j = log();
  j[12] = "07.10.2026 16:00:00";
  const r = calc([j]);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].employee, "Павел");
  assert.equal(r.events[0].date, "2026-10-06");
});
test("journal output area L is retained without roll precision adjustments", () => {
  const r = calc([log(100, 17.6, "Дмитрий", "AUTO_PRINT_r1", "07.10.2026")]);
  assert.equal(r.events.length, 1);
  assert.equal(total(r), 17.6);
});
test("duplicate journal IDs excluded and reported", () => {
  const r = calc([log(), log()]);
  assert.equal(r.events.length, 0);
  assert.equal(r.issues.length, 2);
});
test("cutting does not enter printing KPI", () => {
  const j = log();
  j[3] = "Резка";
  assert.equal(calc([j]).events.length, 0);
  const cut = collectJournalCutting(ix, [j], { eventIdPrefix: "cut:" });
  assert.equal(cut.events.length, 1);
  assert.equal(cut.events[0].id, "cut:j1");
  assert.equal(cut.events[0].quantity, 40);
  assert.equal(cut.events[0].area, 7.04);
});
test("cutting progress uses its quantity and does not require output area", () => {
  const j = log(25, 0);
  j[3] = "Резка";
  const cut = collectJournalCutting(ix, [j]);
  assert.equal(cut.events.length, 1);
  assert.equal(cut.events[0].quantity, 25);
  assert.equal(cut.events[0].area, 0);
  assert.equal(cut.issues.length, 0);
});
test("Lukman is recognized as a cutter and remains invalid as a printer", () => {
  const j = log(150, 15.84, "Лукман", "AUTO_CUT_13277008", "13.10.2026");
  j[3] = "Резка";
  const cut = collectJournalCutting(ix, [j]);
  assert.equal(cut.issues.length, 0);
  assert.equal(cut.events.length, 1);
  assert.equal(cut.events[0].employee, "Лукман");
  assert.equal(cut.events[0].quantity, 150);
  assert.equal(cut.events[0].area, 15.84);

  j[3] = "Печать";
  const print = collectJournalPrinting(ix, [j]);
  assert.equal(print.events.length, 0);
  assert.equal(print.issues[0].message, "Неизвестный сотрудник");
});
test("multiple partial records of the same physical roll count separately", () => {
  const r = calc([log(40, 7.04), log(60, 10.56, "Павел", "j2")]);
  assert.equal(r.events.length, 2);
  assert.ok(Math.abs(total(r) - 17.6) < 1e-9);
});
test("restored journal records resolve a unique UID without source sheet", () => {
  const j = log();
  j[4] = "";
  j[14] = "";
  assert.equal(calc([j]).events[0].uid, o.uid);
});
test("unknown employee and invalid date require review", () => {
  const r = calc([log(40, 7.04, "н1", "j1", "31.02.2026")]);
  assert.equal(r.events.length, 0);
  assert.equal(r.issues.length, 1);
});
test("raw UID resolved by source sheet", () => {
  const other = {
    ...o,
    uid: "123::NY-0001",
    sheetName: "Другая поставка",
    sheetId: 123,
  };
  const index = {
    ...ix,
    byUid: { ...ix.byUid, [other.uid]: other },
    byRaw: { [o.uid]: [o, other] },
  };
  const j = log();
  j[4] = other.sheetName;
  assert.equal(collectJournalPrinting(index, [j]).events[0].uid, other.uid);
});
test("all orders indexed with independent UID per sheet and no invented facts", () => {
  const rows = [Array(32).fill(""), [], Array(32).fill("")];
  rows[0][31] = "UID";
  rows[2][4] = "Артикул";
  rows[2][14] = "Кол-во";
  const row = Array(32).fill("");
  row[4] = "ART";
  row[5] = "2";
  row[7] = "0,22";
  row[8] = "0,16";
  row[9] = "2,112";
  row[14] = "30";
  row[31] = "same";
  rows.push(row);
  const index = indexOrders([
    { gid: 1, name: "Первая поставка", rows },
    { gid: 2, name: "Вторая поставка", rows },
  ]);
  assert.equal(index.orders.length, 2);
  assert.notEqual(index.orders[0].uid, index.orders[1].uid);
  assert.ok(Math.abs(index.orders[0].plannedArea - 2.112) < 1e-9);
  assert.equal(collectJournalPrinting(index, []).events.length, 0);
});
test("roll supply progress uses T/U/X values and ignores rows without article E", () => {
  const rows = [
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
  ];
  rows[0][29] = "UID";
  rows[3][4] = "Артикул";
  rows[3][14] = "Кол-во";
  const inactive = Array(33).fill("");
  inactive[19] = "999";
  inactive[20] = "999";
  inactive[23] = "999";
  inactive[29] = "inactive";
  const active = Array(33).fill("");
  active[4] = "ROLL-ART";
  active[14] = "100";
  active[19] = "83";
  active[20] = "45";
  active[23] = "17";
  active[29] = "roll-001";
  const index = indexOrders([
    {
      gid: ROLL_PRINTING_SHEET.gid,
      name: ROLL_PRINTING_SHEET.name,
      rows: [...rows, inactive, active],
      headerRow: 4,
      dataStartRow: 5,
      uidHeaderRow: 1,
      sourceId: "roll-printing",
    },
  ]);
  assert.equal(index.orders.length, 1);
  assert.equal(index.orders[0].printProgress, 83);
  assert.equal(index.orders[0].cutProgress, 45);
  assert.equal(index.orders[0].remainingPrint, 17);
});
test("X shows half the print run when T is empty; cutting stays unknown without U", () => {
  const rows = [
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
  ];
  rows[0][28] = "UID";
  rows[3][4] = "Артикул";
  rows[3][14] = "Кол-во";
  const active = Array(33).fill("");
  active[4] = "ROLL-EMPTY-PROGRESS";
  active[14] = "100";
  active[23] = "50";
  active[28] = "roll-empty-progress";
  const index = indexOrders([
    {
      gid: ROLL_PRINTING_SHEET.gid,
      name: ROLL_PRINTING_SHEET.name,
      rows: [...rows, active],
      headerRow: 4,
      dataStartRow: 5,
      uidHeaderRow: 1,
      sourceId: "roll-printing",
    },
  ]);
  assert.equal(index.orders[0].printProgress, 50);
  assert.equal(index.orders[0].cutProgress, null);
  assert.equal(index.orders[0].remainingPrint, 50);
});

test("box progress uses confirmed R/S flags and preserves unknown manual print area", () => {
  const rows = Array.from({ length: 4 }, () => Array(29).fill(""));
  rows[0][28] = "UID"; rows[3][4] = "Артикул"; rows[3][14] = "Кол-во";
  const row = Array(29).fill("");
  row[4] = "BOX-SKU"; row[14] = "25"; row[17] = "TRUE"; row[18] = "FALSE";
  row[23] = "999"; row[28] = "box-uid";
  const index = indexOrders([{ gid: 700, name: "OZON Общая", sourceId: "box-printing", assemblyShipmentId: "common", headerRow: 4, dataStartRow: 5, rows: [...rows, row] }]);
  const order = index.orders[0];
  assert.equal(order.printProgress, 25);
  assert.equal(order.cutProgress, 0);
  assert.equal(order.remainingPrint, 0, "box extras in X cannot become a print remainder");
  assert.equal(order.assemblyShipmentId, "common");
  assert.equal(order.areaKnown, false);
});

test("supply area trusts valid J, preserves missing areas, and never invents manual dimensions", () => {
  const headers = Array.from({ length: 4 }, () => Array(29).fill(""));
  headers[0][28] = "UID";
  headers[3][4] = "Артикул";
  headers[3][14] = "Кол-во";
  const values = ["12,45", "#N/A", "", "0", "0,0003"];
  const rows = values.map((area, i) => {
    const row = Array(29).fill("");
    row[4] = `AREA-${i}`; row[9] = area; row[14] = "10"; row[28] = `area-${i}`;
    return row;
  });
  const index = indexOrders([{ gid: 700, name: "OZON Площадь", sourceId: "roll-printing", headerRow: 4, dataStartRow: 5, rows: [...headers, ...rows] }]);
  assert.equal(index.orders[0].plannedArea, 12.45);
  assert.equal(index.orders[0].areaKnown, true, "J is a valid source independently of manual dimensions");
  assert.equal(index.orders[1].areaKnown, false);
  assert.equal(index.orders[1].areaIssue, "J6: #N/A");
  assert.equal(index.orders[2].areaKnown, false);
  assert.equal(index.orders[2].areaIssue, "J7: площадь не заполнена");
  assert.equal(index.orders[3].areaKnown, false, "zero from blank dimensions must remain unknown");
  assert.equal(index.orders[4].plannedArea, 0.0003, "small valid manual area is not rounded down by absent dimensions");
  assert.equal(index.orders[4].areaKnown, true);
});
test("percentage progress is converted to pieces and respects a zero percent value", () => {
  const rows = [
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
  ];
  rows[0][28] = "UID";
  rows[3][4] = "Артикул";
  rows[3][14] = "Кол-во";
  const active = Array(33).fill("");
  active[4] = "ROLL-PERCENT";
  active[14] = "300";
  active[19] = "50%";
  active[20] = "0%";
  active[23] = "150";
  active[28] = "roll-percent";
  const index = indexOrders([
    {
      gid: ROLL_PRINTING_SHEET.gid,
      name: ROLL_PRINTING_SHEET.name,
      rows: [...rows, active],
      headerRow: 4,
      dataStartRow: 5,
      uidHeaderRow: 1,
      sourceId: "roll-printing",
    },
  ]);

  assert.equal(index.orders[0].printProgress, 150);
  assert.equal(index.orders[0].cutProgress, 0);
  assert.equal(index.orders[0].remainingPrint, 150);
});
test("displayed block progress bars in CSV are read as T and U percentages", () => {
  const rows = [
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
  ];
  rows[0][28] = "UID";
  rows[3][4] = "Артикул";
  rows[3][14] = "Кол-во";
  const active = Array(33).fill("");
  active[4] = "KS0002.A7665";
  active[14] = "300";
  active[19] = "█████░░░░░ 50%";
  active[20] = "█████░░░░░ 50%";
  active[23] = "150";
  active[28] = "roll-progress-bar";
  const index = indexOrders([
    {
      gid: ROLL_PRINTING_SHEET.gid,
      name: ROLL_PRINTING_SHEET.name,
      rows: [...rows, active],
      headerRow: 4,
      dataStartRow: 5,
      uidHeaderRow: 1,
      sourceId: "roll-printing",
    },
  ]);
  assert.equal(index.orders[0].printProgress, 150);
  assert.equal(index.orders[0].cutProgress, 150);
});
test("source failure cannot appear as empty KPI", async () =>
  assert.rejects(() =>
    loadPrinting(async () => new Response("denied", { status: 403 })),
  ));

test("live loader combines both printing sources without double-counting summaries", async () => {
  const seen = [];
  const sheetIds = [];
  const csv = (rows) =>
    rows
      .map((r) =>
        r
          .map((v) => '"' + String(v ?? "").replaceAll('"', '""') + '"')
          .join(","),
      )
      .join("\n");
  const headers = Array(15).fill("");
  Object.assign(headers, {
    0: "ID записи",
    1: "Дата",
    2: "Сотрудник",
    3: "Операция",
    7: "UID заказа",
    9: "Сделано, шт.",
    11: "Выпуск, м²",
  });
  const journal = [
    headers,
    ...["д74", "д75", "д76"].map((name) => {
      const j = log(60, 10.56, "Дмитрий", "AUTO_PRINT_" + name, "07.10.2026");
      j[8] = name;
      return j;
    }),
  ];
  const rollJournalHeaders = [...headers];
  rollJournalHeaders[9] = "Сделано";
  rollJournalHeaders[11] = "Выпуск м²";
  const rollJournalRow = log(
    100,
    17.6,
    "Дмитрий",
    "AUTO_PRINT_roll-001",
    "07.10.2026",
  );
  rollJournalRow[4] = "OZON МОСКВА";
  rollJournalRow[7] = "roll-001";
  rollJournalRow[12] = "07.10.2026 17:30:00";
  const historicalRow = log(20, 2, "Дмитрий", "R2_LEGACY_PRINT_old", "29.07.2026");
  historicalRow[4] = "OZON МОСКВА";
  historicalRow[6] = "HIST-ART";
  historicalRow[7] = "closed-order-uid";
  const incompleteRow = log(0, 0, "Дмитрий", "AUTO_PRINT_incomplete", "12.10.2026");
  incompleteRow[4] = "OZON МОСКВА";
  incompleteRow[6] = "INCOMPLETE-ART";
  incompleteRow[7] = "incomplete-uid";
  const rollCutRow = log(25, 0, "Дмитрий", "AUTO_CUT_roll-001", "07.10.2026");
  rollCutRow[3] = "Резка";
  rollCutRow[4] = "OZON МОСКВА";
  rollCutRow[7] = "roll-001";
  const rollJournal = [rollJournalHeaders, rollJournalRow, historicalRow, incompleteRow, rollCutRow];
  const makeOldSupply = (gid) => {
    const rows = [Array(32).fill(""), [], Array(32).fill("")];
    rows[0][31] = "UID";
    rows[2][4] = "Артикул";
    rows[2][14] = "Кол-во";
    if (gid === o.sheetId) {
      const row = Array(32).fill("");
      row[4] = o.article;
      row[14] = "100";
      row[31] = o.uid;
      rows.push(row);
    }
    return rows;
  };
  const makeRollSupply = () => {
    const rows = [Array(32).fill(""), Array(32).fill(""), Array(32).fill(""), Array(32).fill("")];
    rows[0][28] = "UID";
    rows[3][4] = "Артикул";
    rows[3][14] = "Кол-во";
    const row = Array(32).fill("");
    row[4] = "ROLL-ART";
    row[5] = "0.22";
    row[7] = "0.4";
    row[8] = "2";
    row[9] = "17.6";
    row[14] = "100";
    row[19] = "83";
    row[20] = "45";
    row[23] = "17";
    row[28] = "roll-001";
    rows.push(row);
    return rows;
  };
  const r = await loadPrinting(async (url) => {
    const gid = Number(new URL(url).searchParams.get("gid"));
    const spreadsheetId = new URL(url).pathname.split("/")[3];
    seen.push(gid);
    sheetIds.push(spreadsheetId);
    if (spreadsheetId === ROLL_PRINTING_SHEET_ID && gid === 126956215)
      return new Response(csv(rollJournal));
    if (spreadsheetId === ROLL_PRINTING_SHEET_ID && gid === ROLL_PRINTING_SHEET.gid)
      return new Response(csv(makeRollSupply()));
    if (spreadsheetId === ROLL_PRINTING_SHEET_ID && gid === 99887766)
      return new Response(csv(makeRollSupply()));
    if (spreadsheetId !== ROLL_PRINTING_SHEET_ID && gid === 725126844)
      return new Response(csv(journal));
    const supply = SUPPLY_SHEETS.find(([id]) => id === gid);
    assert.ok(
      supply,
      "No source outside supplies and journal may contribute to KPI",
    );
    return new Response(csv(makeOldSupply(gid)));
  }, { additionalSheets: [{ gid: 99887766, name: "Рулонная поставка тест" }] });
  assert.equal(seen.length, SUPPLY_SHEETS.length + 4);
  assert.equal(new Set(sheetIds).size, 2);
  assert.ok(!seen.includes(86586324));
  assert.ok(!seen.includes(2053830156), "Derived daily summary must not be counted");
  assert.equal(r.events.length, 5);
  assert.equal(r.cutEvents.length, 1);
  assert.equal(r.cutEvents[0].quantity, 25);
  assert.equal(r.cutEvents[0].area, 0);
  assert.equal(Number(total(r).toFixed(3)), 51.28);
  assert.deepEqual(r.events.slice(0, 3).map((e) => e.roll), ["д74", "д75", "д76"]);
  const rollEvent = r.events[3];
  assert.equal(rollEvent.sourceId, "roll-printing");
  assert.equal(rollEvent.site, "OZON РУЛОННАЯ ПЕЧАТЬ");
  assert.equal(rollEvent.uid, `${ROLL_PRINTING_SHEET.gid}::roll-001`);
  assert.equal(rollEvent.sourceUrl, `https://docs.google.com/spreadsheets/d/${ROLL_PRINTING_SHEET_ID}/edit#gid=${ROLL_PRINTING_SHEET.gid}`);
  assert.equal(r.supplies.length, 3);
  const rollOrder = r.supplies.find((order) => order.sourceId === "roll-printing");
  assert.equal(rollOrder.printProgress, 83);
  assert.equal(rollOrder.cutProgress, 45);
  assert.equal(rollOrder.remainingPrint, 17);
  assert.equal(r.sheets.length, SUPPLY_SHEETS.length + 2);
  assert.ok(r.sheets.some((sheet) => sheet.sheetId === 99887766));
  assert.equal(r.sources.length, PRINTING_SOURCES.length);
  const historicEvent = r.events[4];
  assert.equal(historicEvent.article, "HIST-ART");
  assert.equal(historicEvent.uid, "closed-order-uid");
  assert.equal(historicEvent.sheetId, ROLL_PRINTING_SHEET.gid);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].code, "invalid_record");
  assert.match(r.issues[0].message, /Нет количества или площади/);
});
