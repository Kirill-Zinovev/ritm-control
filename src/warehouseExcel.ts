import ExcelJS from "exceljs";
import type { WarehouseCarton } from "./liveWarehouse";
export interface SavedWarehouseExport {
  id: string;
  createdAt: string;
  cartons: WarehouseCarton[];
}
export function exportSnapshot(saved: SavedWarehouseExport): ExportSnapshot {
  return {
    id: saved.id,
    createdAt: saved.createdAt,
    payload: {
      dispatch: { label: "РИТМ · " + saved.id.slice(0, 8) },
      cartons: saved.cartons.map((box) => ({
        id: box.id,
        label: box.number,
        market: box.market,
        store: box.store,
        destination: box.shipment,
        qty: box.quantity,
        closedAt: box.closedAt,
        items: box.contents.map((item) => ({
          sku: item.article,
          name: item.productName,
          barcode: item.barcode || "",
          qty: item.quantity,
          externalSupplyId: item.shipmentId || box.shipmentId,
          externalPositionId: item.positionId,
        })),
      })),
    },
  };
}
interface ExportSnapshot {
  id: string;
  createdAt: string;
  payload: {
    dispatch: { label: string };
    cartons: {
      id: string;
      label: string;
      market: string;
      store: string;
      destination: string;
      qty: number;
      closedAt: string;
      items: {
        sku: string;
        name: string;
        barcode: string;
        qty: number;
        externalSupplyId: string;
        externalPositionId: string;
      }[];
    }[];
  };
}
export interface ExportRow {
  carton: string;
  market: string;
  store: string;
  destination: string;
  sku: string;
  name: string;
  barcode: string;
  qty: number;
  sourceSupply: string;
  sourcePosition: string;
}
export function flatten(snapshot: ExportSnapshot): ExportRow[] {
  const rows = new Map<string, ExportRow>();
  for (const c of snapshot.payload.cartons)
    for (const i of c.items) {
      const key = JSON.stringify([
        c.id,
        i.externalSupplyId,
        i.externalPositionId,
        i.sku,
        i.barcode,
      ]);
      const old = rows.get(key);
      rows.set(key, {
        carton: c.label,
        market: c.market,
        store: c.store,
        destination: c.destination,
        sku: i.sku,
        name: i.name,
        barcode: i.barcode,
        qty: i.qty + (old?.qty ?? 0),
        sourceSupply: i.externalSupplyId,
        sourcePosition: i.externalPositionId,
      });
    }
  return [...rows.values()];
}
function format(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: sheet.rowCount, column: sheet.columnCount },
  };
  sheet.getRow(1).height = 28;
  sheet.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF172E49" },
    };
    c.alignment = { vertical: "middle" };
  });
  sheet.eachRow((row, index) => {
    if (index > 1)
      row.eachCell((cell) => {
        cell.font = { name: "Calibri", size: 11 };
        cell.alignment = { vertical: "top", wrapText: true };
      });
  });
}
export function accountWorkbook(snapshot: ExportSnapshot): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "RITM Сборка";
  workbook.created = new Date(snapshot.createdAt);
  const boxes = workbook.addWorksheet("Короба");
  boxes.columns = [
    { header: "Номер короба", key: "label", width: 18 },
    { header: "Маркетплейс", key: "market", width: 16 },
    { header: "Магазин", key: "store", width: 22 },
    { header: "Склад назначения", key: "destination", width: 25 },
    { header: "Количество, шт.", key: "qty", width: 20 },
    { header: "Вложений", key: "lines", width: 14 },
    { header: "Отгрузка", key: "dispatch", width: 18 },
    { header: "Закрыт", key: "closedAt", width: 26 },
    { header: "ID короба", key: "id", width: 40 },
  ];
  for (const box of snapshot.payload.cartons)
    boxes.addRow({
      ...box,
      lines: box.items.length,
      dispatch: snapshot.payload.dispatch.label,
    });
  const contents = workbook.addWorksheet("Состав");
  contents.columns = [
    { header: "Номер короба", key: "carton", width: 18 },
    { header: "Маркетплейс", key: "market", width: 16 },
    { header: "Магазин", key: "store", width: 22 },
    { header: "Склад назначения", key: "destination", width: 25 },
    { header: "Артикул", key: "sku", width: 22 },
    { header: "Название", key: "name", width: 36 },
    { header: "Штрихкод", key: "barcode", width: 24 },
    { header: "Количество, шт.", key: "qty", width: 20 },
    { header: "ID поставки RITM", key: "sourceSupply", width: 42 },
    { header: "ID позиции RITM", key: "sourcePosition", width: 55 },
  ];
  const rows = flatten(snapshot);
  for (const row of rows) contents.addRow(row);
  contents.getColumn("barcode").numFmt = "@";
  contents.getColumn("sku").numFmt = "@";
  contents.getColumn("sourceSupply").numFmt = "@";
  contents.getColumn("sourcePosition").numFmt = "@";
  const summary = workbook.addWorksheet("Сводка");
  summary.columns = [
    { header: "Маркетплейс", key: "market", width: 16 },
    { header: "Магазин", key: "store", width: 22 },
    { header: "Склад назначения", key: "destination", width: 25 },
    { header: "Артикул", key: "sku", width: 22 },
    { header: "Название", key: "name", width: 36 },
    { header: "Штрихкод", key: "barcode", width: 24 },
    { header: "Количество, шт.", key: "qty", width: 20 },
  ];
  const totals = new Map<string, ExportRow>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.market,
      row.store,
      row.destination,
      row.sku,
      row.barcode,
    ]);
    const old = totals.get(key);
    totals.set(key, { ...row, qty: row.qty + (old?.qty ?? 0) });
  }
  for (const row of totals.values()) summary.addRow(row);
  summary.getColumn("barcode").numFmt = "@";
  summary.getColumn("sku").numFmt = "@";
  for (const sheet of workbook.worksheets) format(sheet);
  return workbook;
}
export type Mapping = Partial<Record<keyof ExportRow, number>>;
export const mappingLabels: Record<keyof ExportRow, string> = {
  carton: "Номер короба в «RITM Сборка»",
  market: "Маркетплейс",
  store: "Магазин",
  destination: "Склад назначения",
  sku: "Артикул",
  name: "Название товара",
  barcode: "Штрихкод товара",
  qty: "Количество",
  sourceSupply: "ID поставки RITM",
  sourcePosition: "ID позиции RITM",
};
export async function readTemplate(
  buffer: ArrayBuffer,
): Promise<ExcelJS.Workbook> {
  if (buffer.byteLength > 10_000_000)
    throw new Error("Размер шаблона должен быть не больше 10 МБ.");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  if (
    book.worksheets.length > 20 ||
    book.worksheets.some((s) => s.rowCount > 10000 || s.columnCount > 200)
  )
    throw new Error(
      "Шаблон слишком большой. Оставьте нужные листы и пустую область данных.",
    );
  return book;
}
export async function templateWorkbook(
  buffer: ArrayBuffer,
  sheetName: string,
  startRow: number,
  mapping: Mapping,
  snapshot: ExportSnapshot,
): Promise<ExcelJS.Workbook> {
  const book = await readTemplate(buffer);
  const sheet = book.getWorksheet(sheetName);
  if (!sheet) throw new Error("Выберите лист шаблона.");
  if (!Number.isInteger(startRow) || startRow < 2 || startRow > 1000)
    throw new Error("Начальная строка должна быть от 2 до 1000.");
  const fields = Object.entries(mapping).filter(
    (entry): entry is [keyof ExportRow, number] => !!entry[1],
  );
  if (!mapping.qty || (!mapping.sku && !mapping.barcode))
    throw new Error("Сопоставьте количество и артикул или штрихкод.");
  if (new Set(fields.map(([, column]) => column)).size !== fields.length)
    throw new Error("Для каждого поля нужна отдельная колонка.");
  if (
    fields.some(
      ([, column]) => !Number.isInteger(column) || column < 1 || column > 200,
    )
  )
    throw new Error("Неверная колонка шаблона.");
  for (let r = startRow; r <= sheet.rowCount; r++)
    for (const [, column] of fields) {
      if (sheet.getCell(r, column).value !== null)
        throw new Error(
          `В области данных есть значение (${sheet.getCell(r, column).address}). Загрузите пустой шаблон или укажите другую начальную строку.`,
        );
    }
  const rows = flatten(snapshot);
  rows.forEach((row, index) => {
    if ((mapping.barcode && !row.barcode) || (mapping.sku && !row.sku))
      throw new Error(
        `Для товара ${row.sku || index + 1} не подтверждено поле шаблона: ${!row.barcode && mapping.barcode ? "штрихкод" : "артикул"}.`,
      );
    for (const [field, column] of fields) {
      const cell = sheet.getCell(startRow + index, column);
      cell.value = row[field];
      if (field !== "qty") cell.numFmt = "@";
    }
  });
  return book;
}
export async function downloadWorkbook(
  book: ExcelJS.Workbook,
  filename: string,
) {
  const bytes = await book.xlsx.writeBuffer();
  const blob = new Blob([new Uint8Array(bytes)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
