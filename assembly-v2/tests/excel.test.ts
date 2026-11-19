import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { accountWorkbook, templateWorkbook } from "../src/exports/excel";
import type { ExportSnapshot } from "../shared/model";
const snapshot = {
  id: "export",
  dispatchId: "dispatch",
  kind: "account",
  createdAt: "2026-11-13T08:00:00Z",
  payload: {
    dispatch: { label: "ОТ-1" },
    cartons: [
      {
        id: "box",
        label: "К-1",
        market: "OZON",
        store: "1",
        destination: "Москва",
        qty: 12,
        items: [
          {
            sku: "000123",
            name: "Товар",
            barcode: "0012345678901",
            qty: 12,
            externalSupplyId: "SOURCE-1",
            externalPositionId: "POS-1",
          },
        ],
      },
    ],
  },
} as unknown as ExportSnapshot;
test("учёт Excel сохраняет ведущие нули, происхождение и три листа", async () => {
  const book = accountWorkbook(snapshot);
  const bytes = await book.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(bytes);
  assert.deepEqual(
    loaded.worksheets.map((s) => s.name),
    ["Короба", "Состав", "Сводка"],
  );
  assert.equal(
    loaded.getWorksheet("Состав")!.getCell("G2").value,
    "0012345678901",
  );
  assert.equal(loaded.getWorksheet("Состав")!.getCell("I2").value, "SOURCE-1");
  assert.equal(loaded.getWorksheet("Сводка")!.getCell("G2").value, 12);
});
test("шаблон заполняется по сопоставлению, заголовки и другие листы сохраняются", async () => {
  const input = new ExcelJS.Workbook();
  const sheet = input.addWorksheet("Загрузка");
  sheet.addRow(["ШК", "Количество", "Короб"]);
  input.addWorksheet("Инструкция").getCell("A1").value = "Не изменять";
  const buffer = await input.xlsx.writeBuffer();
  const book = await templateWorkbook(
    buffer as ArrayBuffer,
    "Загрузка",
    2,
    { barcode: 1, qty: 2, carton: 3 },
    snapshot,
  );
  assert.equal(book.getWorksheet("Загрузка")!.getCell("A1").value, "ШК");
  assert.equal(
    book.getWorksheet("Загрузка")!.getCell("A2").value,
    "0012345678901",
  );
  assert.equal(
    book.getWorksheet("Инструкция")!.getCell("A1").value,
    "Не изменять",
  );
});
test("шаблон с существующими данными не перезаписывается", async () => {
  const input = new ExcelJS.Workbook();
  const sheet = input.addWorksheet("Загрузка");
  sheet.addRow(["ШК", "Количество"]);
  sheet.addRow(["Существующий товар", 8]);
  const buffer = await input.xlsx.writeBuffer();
  await assert.rejects(
    templateWorkbook(
      buffer as ArrayBuffer,
      "Загрузка",
      2,
      { barcode: 1, qty: 2 },
      snapshot,
    ),
    /есть значение/,
  );
});

test("повторные вложения одной исходной позиции объединяются в строку состава", () => {
  const data = structuredClone(snapshot);
  data.payload.cartons[0].items.push({
    ...data.payload.cartons[0].items[0],
    qty: 3,
  });
  const book = accountWorkbook(data);
  assert.equal(book.getWorksheet("Состав")!.rowCount, 2);
  assert.equal(book.getWorksheet("Состав")!.getCell("H2").value, 15);
});
