import { test } from "node:test";
import assert from "node:assert/strict";
import { demoDataset } from "../src/demo";
import {
  ANCHOR,
  coefficient,
  employeeResult,
  emptyDataset,
  freeStock,
  inPeriod,
  lineTotals,
  reserveSupply,
  validateSupply,
} from "../src/model";
import { importRows } from "../src/importer";
import CSV from "../src/csv";
test("mixed operations yield 1.24 and six employees reach daily goal", () => {
  const d = demoDataset();
  assert.ok(
    Math.abs(employeeResult(d, "e0", ANCHOR, "day").total - 1.24) < 1e-9,
  );
  assert.equal(
    d.employees.filter((e) => {
      const r = employeeResult(d, e.id, ANCHOR, "day");
      return r.value !== null && r.value >= 1;
    }).length,
    6,
  );
});
test("missing data differs from confirmed zero, weekends and future days are excluded", () => {
  const d = demoDataset();
  assert.equal(employeeResult(d, "e0", "2026-10-08", "day").value, null);
  assert.equal(employeeResult(d, "e0", "2026-10-03", "day").value, null);
  d.shifts.push({
    employee: "e0",
    date: "2026-09-30",
    working: true,
    closed: true,
  });
  assert.equal(employeeResult(d, "e0", "2026-09-30", "day").value, 0);
  assert.equal(inPeriod("2026-10-08", ANCHOR, "week"), false);
});
test("stock totals multiple cells, reserve does not duplicate or change packing", () => {
  const d = demoDataset();
  assert.equal(freeStock(d, "ST0021.A7447"), 300);
  const next = reserveSupply(d, "П-0124");
  assert.equal(freeStock(next, "ST0021.A7447"), 0);
  assert.deepEqual(reserveSupply(next, "П-0124"), next);
  assert.equal(lineTotals(next.supplies[0]).packed, 4000);
  assert.equal(lineTotals(next.supplies[0]).reserved, 600);
  const third = reserveSupply(next, "П-0125");
  assert.equal(lineTotals(third.supplies[1]).reserved, 0);
});
test("demo completed roll area sums exactly to 284.6", () => {
  const d = demoDataset();
  const sum = d.rolls
    .filter((r) => r.date === ANCHOR)
    .reduce((s, r) => s + r.area, 0);
  assert.ok(Math.abs(sum - 284.6) < 1e-9);
  assert.equal(new Set(d.rolls.map((r) => r.id)).size, d.rolls.length);
});
const mapping = {
  id: "id",
  employee: "employee",
  date: "date",
  article: "article",
  operation: "operation",
  quantity: "quantity",
  norm: "norm",
};
const row = {
  id: "one",
  employee: "Сотрудник",
  date: ANCHOR,
  article: "ABC",
  operation: "Упаковка",
  quantity: "150",
  norm: "250",
};
test("import replaces a source snapshot without double counting and freezes row norm", () => {
  const first = importRows(emptyDataset(), "assembly", [row], mapping);
  const next = importRows(first, "assembly", [row], mapping);
  assert.equal(next.work.length, 1);
  assert.equal(coefficient(next.work[0]), 0.6);
  assert.equal(
    employeeResult(next, next.employees[0].id, ANCHOR, "month").value,
    null,
  );
});
test("invalid imports remain atomic and reject duplicate IDs, zero norm and impossible date", () => {
  const base = emptyDataset();
  assert.throws(
    () => importRows(base, "assembly", [row, row], mapping),
    /повторяется/,
  );
  assert.throws(
    () => importRows(base, "assembly", [{ ...row, norm: "0" }], mapping),
    /больше нуля/,
  );
  assert.throws(
    () =>
      importRows(base, "assembly", [{ ...row, date: "31.02.2026" }], mapping),
    /дата/,
  );
  assert.deepEqual(base, emptyDataset());
});
test("supply validation rejects duplicates, nonpositive quantity and inverted dates", () => {
  assert.ok(
    validateSupply("Test", "2026-10-14", "2026-10-15", "ABC;1").errors.ready,
  );
  assert.ok(
    validateSupply("Test", "2026-10-14", "2026-10-13", "ABC;1\nABC;2").errors
      .lines,
  );
  assert.ok(
    validateSupply("Test", "2026-10-14", "2026-10-13", "ABC;0").errors.lines,
  );
  assert.equal(
    validateSupply("Test", "2026-10-14", "2026-10-13", "ABC;100\nDEF;200").lines
      .length,
    2,
  );
});
test("CSV parser supports quotes, decimal comma, multiline cells and rejects damaged input", () => {
  const parsed = CSV.parse('id;area;note\r\na;"18,6";"first\nsecond"\r\n');
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.data[0].area, "18,6");
  assert.equal(parsed.data[0].note, "first\nsecond");
  assert.ok(CSV.parse("id;id\na;b").errors.length);
  assert.ok(CSV.parse('id;area\na;"bad').errors.length);
});
