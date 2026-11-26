import assert from "node:assert/strict";
import test from "node:test";
import { BOX_SHEET_REPORT_LABEL, readBoxSheetReport } from "../agent/boxSheetReport.js";
import { readLiveBoxSheetReport } from "../worker/cloud/boxSheetReport.js";

const label = { userEnteredValue: { stringValue: BOX_SHEET_REPORT_LABEL } };
const documentId = "verified-box-workbook-for-test";
const supply = (sheetId, title, hidden = false) => ({
  properties: { sheetId, title, hidden, gridProperties: { rowCount: 50, columnCount: 35 } },
});
const banner = (tab, input, labels = [{}, {}, label]) => ({
  ...tab,
  data: [{ startRow: 1, rowData: [{ values: labels }, { values: [{}, {}, input] }] }],
});

test("reads manual Box totals by sheet identity, including zero, blanks and invalid input", async () => {
  const tabs = [
    supply(1, "Ozon Ярославль"), supply(2, "WB Д'АЧА"), supply(3, "OZON Москва"),
    supply(4, "OZON Казань"), supply(5, "OZON Ростов"),
    supply(6, "OZON архив", true), supply(7, "Запасы склад"), supply(8, "Cache"),
    supply(9, "OZON СПБ"), supply(10, "WB старый архив", true),
  ];
  const grids = [
    banner(tabs[4], { userEnteredValue: { formulaValue: "=20" }, effectiveValue: { numberValue: 20 } }),
    banner(tabs[0], { userEnteredValue: { numberValue: 123 } }),
    banner(tabs[2], {}),
    banner(tabs[1], { userEnteredValue: { numberValue: 0 } }),
    banner(tabs[3], { userEnteredValue: { numberValue: 5 } }, []),
    banner(tabs[5], { userEnteredValue: { numberValue: 50 } }),
    banner(tabs[8], { userEnteredValue: { numberValue: 4.5 } }),
    banner(tabs[9], {}, []),
  ];
  const calls = [];
  const reader = { async get(id, query) {
    assert.equal(id, documentId);
    calls.push(query);
    return { spreadsheetId: id, sheets: query.ranges ? grids : tabs };
  } };
  const report = await readBoxSheetReport(reader, documentId);
  assert.equal(report.status, "available");
  assert.equal(report.total, 173);
  assert.equal(report.entered, 3);
  assert.deepEqual(report.rows.map(r => [r.sheetId, r.status, r.count]), [
    [1, "entered", 123], [2, "entered", 0], [3, "empty", null],
    [4, "missing", null], [5, "invalid", null], [6, "entered", 50], [9, "invalid", null],
  ]);
  assert.deepEqual(report.rows.filter(r => r.archived).map(r => r.sheetId), [6]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].ranges.length, 8);
  assert.ok(calls[1].ranges.includes("'WB Д''АЧА'!A2:Z3"));
  assert.match(report.rows[0].url, /#gid=1$/);
});

test("rejects a changed or missing tab during a refresh", async () => {
  const reader = { async get(id, { ranges }) {
    return { spreadsheetId: id, sheets: ranges ? [] : [supply(1, "OZON Москва")] };
  } };
  await assert.rejects(readBoxSheetReport(reader, documentId), /changed during refresh/);
});

test("an unfilled report has no sum while an explicitly entered zero does", async () => {
  const tab = supply(1, "WB ДАЧА");
  const read = input => readBoxSheetReport({ async get(id, { ranges }) {
    return { spreadsheetId: id, sheets: ranges ? [banner(tab, input)] : [tab] };
  } }, documentId);
  assert.equal((await read({})).total, null);
  const zero = await read({ userEnteredValue: { numberValue: 0 } });
  assert.equal(zero.total, 0);
  assert.equal(zero.entered, 1);
});

test("Box sheet counts refresh independently from the full printing snapshot and keep the last confirmed total on failure", async () => {
  const first = supply(1, "Ozon Ярославль");
  let now = 100000, count = 5, cached = null, acquisitions = 0, held = false;
  let googleUnavailable = false, reads = 0;
  const store = {
    now: () => now,
    async snapshot(kind) {
      assert.equal(kind, "printing-box-sheet-report");
      return cached;
    },
    async acquire(kind) {
      assert.equal(kind, "printing-box-sheet-report");
      acquisitions++;
      if (held) throw Object.assign(new Error("busy"), { code: "cloud_operation_busy" });
      held = true;
      return kind;
    },
    async saveSnapshot(_kind, value, _lease, at) {
      assert.equal(held, true);
      cached = { value, at };
    },
    async release() { held = false; },
  };
  const reader = { async get(id, { ranges }) {
    reads++;
    if (googleUnavailable) throw new Error("connection failed");
    return { spreadsheetId: id, sheets: ranges ? [banner(first, { userEnteredValue: { numberValue: count } })] : [first] };
  } };
  const read = () => readLiveBoxSheetReport(reader, documentId, store);
  assert.equal((await read()).report.total, 5);
  assert.equal(reads, 2);
  count = 7;
  now += 2000;
  assert.equal((await read()).report.total, 5);
  assert.equal(reads, 2);

  now += 8000;
  held = true;
  const syncing = await read();
  assert.equal(syncing.state, "syncing");
  assert.equal(syncing.report.total, 5);
  assert.equal(reads, 2);
  held = false;
  const updated = await read();
  assert.equal(updated.state, "ready");
  assert.equal(updated.report.total, 7);
  assert.equal(updated.report.rows[0].count, 7);
  assert.equal(reads, 4);

  now += 10000;
  googleUnavailable = true;
  const stale = await read();
  assert.equal(stale.state, "stale");
  assert.equal(stale.report.total, 7);
  assert.equal(stale.checkedAt, updated.checkedAt);
  assert.equal(held, false);
  assert.equal(acquisitions, 4);
});
