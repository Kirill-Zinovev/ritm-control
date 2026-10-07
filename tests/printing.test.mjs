import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  indexOrders,
  reconcilePrinting,
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
const roll = (printed = true) => [
  o.uid,
  "д1",
  1,
  printed,
  false,
  "",
  "",
  100,
  "r1",
  "07.10.2026",
  "Дмитрий",
  17.6004,
  "",
];
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
const calc = (rs, js) => reconcilePrinting(ix, rs, js);
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
test("partial output is counted before completion", () =>
  assert.equal(total(calc([roll(false)], [log()])), 7.04));
test("partial and completed remainder preserve employee and date attribution", () => {
  const r = calc([roll()], [log()]);
  assert.equal(r.events.length, 2);
  assert.ok(Math.abs(total(r) - 17.6004) < 1e-9);
  assert.equal(r.events[0].employee, "Павел");
  assert.equal(r.events[0].date, "2026-10-06");
  assert.equal(r.events[1].quantity, 60);
});
test("automatic completion counted once preserves original area precision", () => {
  const r = calc(
    [roll()],
    [log(100, 17.6, "Дмитрий", "AUTO_PRINT_r1", "07.10.2026")],
  );
  assert.equal(r.events.length, 1);
  assert.equal(total(r), 17.6004);
});
test("duplicate journal IDs excluded and reported", () => {
  const r = calc([roll()], [log(), log()]);
  assert.equal(r.events.length, 0);
  assert.equal(r.issues.length, 2);
});
test("duplicate physical rolls cannot create duplicate KPI", () => {
  const r = calc([roll(), roll()], []);
  assert.equal(r.events.length, 0);
  assert.equal(r.issues.length, 2);
});
test("unknown employee and invalid date require review", () => {
  const r = calc([roll()], [log(40, 7.04, "н1", "j1", "31.02.2026")]);
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
  assert.equal(reconcilePrinting(index, [], [j]).events[0].uid, other.uid);
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
  assert.equal(reconcilePrinting(index, [], []).events.length, 0);
});
test("source failure cannot appear as empty KPI", async () =>
  assert.rejects(() =>
    loadPrinting(async () => new Response("denied", { status: 403 })),
  ));
