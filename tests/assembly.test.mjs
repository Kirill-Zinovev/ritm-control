import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAssembly, parseAssemblyRows, summarizeAssembly, summarizeAssemblyDays } from "../worker/assembly.js";
import worker from "../worker/index.js";

const headers = [
  "Дата", "Сотрудник", "Резка станок", "Ручная резка", "Порезано всего",
  "Упаковано", "Всего", "Коэффициент", "Порезал по видам",
  "Упаковал по видам", "Обновлено", "Ключ",
];
function csvCell(value) {
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}
function csv(rows) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
const fixture = csv([
  ["2026-10-05", "Оля", "10", "2", "12", "20", "32", "0,5", "ПВХ — 12", "Короб — 20", "08.10.2026", "1"],
  ["2026-10-08", "Оля", "3", "1", "4", "6", "10", "0,25", "ПВХ — 4", "Короб — 6", "08.10.2026", "2"],
  ["2026-10-09", "Оля", "100", "0", "100", "0", "100", "1", "ПВХ — 100", "", "08.10.2026", "3"],
]);

test("FBO parser reads decimal coefficients and product types", () => {
  const [row] = parseAssemblyRows(fixture);
  assert.equal(row.employee, "Оля");
  assert.equal(row.coefficient, 0.5);
  assert.deepEqual(row.cutTypes, [{ name: "ПВХ", quantity: 12 }]);
  assert.deepEqual(row.packTypes, [{ name: "Короб", quantity: 20 }]);
});

test("weekly assembly totals include dates in the selected week through selected day", () => {
  const result = summarizeAssembly(parseAssemblyRows(fixture), "2026-10-08", "week");
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
  const duplicate = { ...sourceDay, id: "same-day-row", cut: 2, packed: 3, total: 5, coefficient: 0.1 };
  const history = summarizeAssemblyDays([...records, duplicate]);
  assert.equal(history.length, 3);
  const selected = history.find((row) => row.date === "2026-10-08");
  assert.equal(selected.cut, 6);
  assert.equal(selected.packed, 9);
  assert.equal(selected.total, 15);
  assert.equal(selected.coefficient, 0.35);
});

test("FBO endpoint is read-only and serves the selected period", async () => {
  const denied = await worker.fetch(
    new Request("https://ritm.test/api/assembly", { method: "POST" }),
    {},
  );
  assert.equal(denied.status, 405);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /gid=2070043218/);
    return new Response(fixture, { status: 200 });
  };
  try {
    const response = await worker.fetch(
      new Request("https://ritm.test/api/assembly?date=2026-10-08&period=week"),
      {},
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.rows[0].coefficient, 0.75);
    assert.equal(result.period, "week");
    assert.equal(result.history.length, 3);
    assert.equal(result.history.find((row) => row.date === "2026-10-08").total, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
