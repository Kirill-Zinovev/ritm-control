import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  indexOrders,
  collectJournalPrinting,
  SUPPLY_SHEETS,
  loadPrinting,
} from "../worker/printing.js";
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
test("source failure cannot appear as empty KPI", async () =>
  assert.rejects(() =>
    loadPrinting(async () => new Response("denied", { status: 403 })),
  ));

test("live loader reads the journal and all supplies without adding system rolls", async () => {
  const seen = [];
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
  const r = await loadPrinting(async (url) => {
    const gid = Number(new URL(url).searchParams.get("gid"));
    seen.push(gid);
    if (gid === 725126844) return new Response(csv(journal));
    const supply = SUPPLY_SHEETS.find(([id]) => id === gid);
    assert.ok(
      supply,
      "No source outside supplies and journal may contribute to KPI",
    );
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
    return new Response(csv(rows));
  });
  assert.equal(seen.length, SUPPLY_SHEETS.length + 1);
  assert.ok(!seen.includes(86586324));
  assert.equal(r.events.length, 3);
  assert.equal(Number(total(r).toFixed(3)), 31.68);
  assert.deepEqual(
    r.events.map((e) => e.roll),
    ["д74", "д75", "д76"],
  );
  assert.deepEqual(r.issues, []);
});
