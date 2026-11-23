import assert from "node:assert/strict";
import test from "node:test";
import { projectD1PrintingWork, readD1PrintingWork } from "../worker/cloud/printingD1Work.js";

const key = "d".repeat(64);
const roll = { id: "work-a:0", receiptId: "work-a", supplyId: "sample-rolling-printing-123:21",
  supplyName: "Поставка", rowId: "position-a", article: "SKU-1", at: "2026-11-29T22:01:00.000Z",
  department: "roll", operation: "cut", employee: "лукман", pieces: 4, area: 0.31, sheets: null };
const box = { ...roll, id: "work-b:0", receiptId: "work-b", article: "SKU-2", operation: "print",
  department: "box", employee: "Печатник", sheets: 0.5, pieces: 1, area: null };
const correction = { ...box, id: "work-c:0", receiptId: "work-c", correction: true, pieces: -1, employee: null };

test("recorded area and employee follow each operation, and corrections do not earn output", () => {
  const work = projectD1PrintingWork([roll, roll, box, correction]);
  assert.deepEqual(work.rollCut.map(({ employee, date, quantity, area }) => ({ employee, date, quantity, area })),
    [{ employee: "Лукман", date: "2026-11-30", quantity: 4, area: 0.31 }]);
  assert.deepEqual(work.boxPrint.map(({ employee, quantity, area, sheets }) => ({ employee, quantity, area, sheets })),
    [{ employee: "Печатник", quantity: 1, area: null, sheets: 0.5 }]);
  assert.equal(work.corrections, 1);
});

test("month snapshots resume a verified cursor and retain confirmed data after an invalid response", async () => {
  let time = Date.parse("2026-11-30T12:00:00Z");
  const snapshots = new Map();
  const store = { now: () => time, snapshot: async key => snapshots.get(key),
    acquire: async name => ({ name }), release: async () => {},
    saveSnapshot: async (name, value, lease, at) => {
      assert.equal(name, lease.name);
      snapshots.set(name, { value, at });
    } };
  const bindings = { RITM_PRINTING_D1_WORK_KEY: key };
  const end = "3:" + Number.MAX_SAFE_INTEGER;
  const fetcher = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/api/reporting/printing-work");
    assert.equal(url.searchParams.get("month"), "2026-11");
    assert.equal(options.headers.Authorization, "Bearer " + key);
    if (url.searchParams.get("after") === "0:0")
      return Response.json({ schemaVersion: 1, through: 3, next: "1:0", complete: false, work: [roll] });
    assert.equal(url.searchParams.get("after"), "1:0");
    assert.equal(url.searchParams.get("through"), "3");
    return Response.json({ schemaVersion: 1, through: 3, next: end, complete: true, work: [box, correction] });
  };
  const result = await readD1PrintingWork(bindings, store, "2026-11", fetcher);
  assert.equal(result.state, "ready");
  assert.equal(result.rollCut[0].area, 0.31);
  assert.equal(result.boxPrint.length, 1);
  time += 9_000;
  const stale = await readD1PrintingWork(bindings, store, "2026-11", async input => {
    assert.equal(new URL(input).searchParams.get("after"), end);
    return Response.json({ schemaVersion: 1, through: 0, next: "0:0", complete: true, work: [] });
  });
  assert.equal(stale.state, "stale");
  assert.deepEqual(stale.rollCut, result.rollCut);
  assert.equal(stale.checkedAt, result.checkedAt);
});
