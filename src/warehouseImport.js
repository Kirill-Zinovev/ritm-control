import { warehouseNumberKey, warehouseVisualNumberKey } from "./warehouseNumber.js";
export { warehouseNumberKey } from "./warehouseNumber.js";

/** @param {string} text */
export function parseWarehouseNumbers(text) {
  const values = text.split(/[\n\r;,\t]+/).map(x => x.trim()).filter(Boolean);
  if (values.length > 500) throw new Error("Можно загрузить не больше 500 номеров за один раз.");
  if (values.some(x => x.length > 100)) throw new Error("Слишком длинный номер короба. Проверьте список.");
  return values;
}

/** @param {string[]} numbers @param {import('./liveWarehouse').WarehouseCarton[]} cartons */
export function matchWarehouseNumbers(numbers, cartons) {
  const seen = new Set();
  const index = new Map();
  for (const box of cartons) {
    const key = warehouseVisualNumberKey(box.number);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(box);
  }
  return numbers.map(number => {
    const key = warehouseVisualNumberKey(number);
    const matches = index.get(key) || [];
    let status = "ready";
    if (seen.has(key)) status = "duplicate";
    else if (matches.length === 0) status = "missing";
    else if (matches.length > 1) status = "ambiguous";
    else if (matches[0].dispatchStatus === "sent") status = "sent";
    else if (matches[0].status === "open") status = "open";
    else if (matches[0].status !== "closed" || matches[0].dispatchBlocked || matches[0].archivedSourceUnavailable || matches[0].reserved || matches[0].historicalSnapshotMissing) status = "unconfirmed";
    seen.add(key);
    const box = matches.length === 1 ? matches[0] : null;
    return { number, status, box, corrected: !!box && warehouseNumberKey(number) !== warehouseNumberKey(box.number) };
  });
}

/** @param {ArrayBuffer} bytes */
export async function parseWarehouseWorkbook(bytes) {
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("Файл больше 2 МБ.");
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes); } catch { throw new Error("Не удалось прочитать файл. Выберите Excel .xlsx."); }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("В файле нет листов.");
  if (sheet.rowCount > 501 || sheet.columnCount > 100) throw new Error("В файле слишком много строк или столбцов.");
  const first = sheet.getRow(1); let column = 0;
  first.eachCell((cell, index) => {
    if (["номер короба", "номер коробки", "короб", "коробка"].includes(warehouseNumberKey(cell.value))) column = index;
  });
  const hasHeader = column > 0; if (!column) column = 1;
  const values = [];
  for (let n = hasHeader ? 2 : 1; n <= sheet.rowCount; n++) {
    const value = sheet.getRow(n).getCell(column).value;
    if (value && typeof value === "object") throw new Error(`Строка ${n}: используйте текстовый номер без формулы.`);
    if (value != null && String(value).trim()) values.push(String(value).trim());
  }
  return parseWarehouseNumbers(values.join("\n"));
}
