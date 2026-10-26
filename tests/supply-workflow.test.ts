import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  createSupplyWorkbook,
  createSupplyTemplate,
  parseSupplyWorkbook,
} from "../src/supplySpreadsheet";
import { validateSupply } from "../src/model";

async function workbookBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Товары");
  rows.forEach((row) => sheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer instanceof Uint8Array
    ? buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      )
    : (buffer as ArrayBuffer);
}

test("supply template is a real xlsx with the required Russian columns", async () => {
  const bytes = await createSupplyTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as never,
  );
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell("A1").value, "Артикул");
  assert.equal(sheet.getCell("B1").value, "Количество, шт.");
  assert.equal(sheet.views[0]?.state, "frozen");
  assert.equal(sheet.rowCount, 21);
});

test("xlsx import reads article and quantity and skips blank template rows", async () => {
  const bytes = await workbookBuffer([
    ["Артикул", "Количество, шт."],
    ["ST0021.A7447", 500],
    ["ST0043.A2180", 300],
    ["", ""],
  ]);
  assert.deepEqual(await parseSupplyWorkbook(bytes), [
    { article: "ST0021.A7447", quantity: 500 },
    { article: "ST0043.A2180", quantity: 300 },
  ]);
});

test("xlsx-imported rows stay valid after filling the create-supply form", async () => {
  const bytes = await workbookBuffer([
    ["Артикул", "Количество, шт."],
    ["JA0037.A0225", 170],
    ["NT0006.A4692", 60],
    ["KS0002.A7665", 300],
    ["KT0072.A0094", 200],
  ]);
  const imported = await parseSupplyWorkbook(bytes);
  const text = imported
    .map((line) => `${line.article}; ${line.quantity}`)
    .join("\n");
  const parsed = validateSupply(
    "OZON Волгоград",
    "2026-10-14",
    "2026-10-13",
    text,
  );

  assert.deepEqual(parsed.errors, {});
  assert.deepEqual(
    parsed.lines.map(({ article, plan }) => [article, plan]),
    [
      ["JA0037.A0225", 170],
      ["NT0006.A4692", 60],
      ["KS0002.A7665", 300],
      ["KT0072.A0094", 200],
    ],
  );
});

test("xlsx export downloads the current article and quantity list as a real workbook", async () => {
  const bytes = await createSupplyWorkbook([
    { article: "ST0021.A7447", quantity: 500 },
    { article: "ST0043.A2180", quantity: 300 },
  ]);
  assert.deepEqual(
    await parseSupplyWorkbook(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ),
    [
      { article: "ST0021.A7447", quantity: 500 },
      { article: "ST0043.A2180", quantity: 300 },
    ],
  );
});

test("xlsx import validates headers, positive integers and duplicate articles", async () => {
  await assert.rejects(
    parseSupplyWorkbook(
      await workbookBuffer([
        ["SKU", "Штук"],
        ["A", 2],
      ]),
    ),
    /заголовки/,
  );
  await assert.rejects(
    parseSupplyWorkbook(
      await workbookBuffer([
        ["Артикул", "Количество"],
        ["A", 2],
        ["a", 3],
      ]),
    ),
    /повторяется/,
  );
  await assert.rejects(
    parseSupplyWorkbook(
      await workbookBuffer([
        ["Артикул", "Количество"],
        ["A", 0],
      ]),
    ),
    /целое положительное количество/,
  );
});

test("xlsx import rejects formulas and oversized workbooks", async () => {
  const formula = await workbookBuffer([
    ["Артикул", "Количество"],
    ["A", { formula: "1+1", result: 2 }],
  ]);
  await assert.rejects(parseSupplyWorkbook(formula), /формулой/);
  await assert.rejects(
    parseSupplyWorkbook(new ArrayBuffer(2 * 1024 * 1024 + 1)),
    /2 МБ/,
  );
});
