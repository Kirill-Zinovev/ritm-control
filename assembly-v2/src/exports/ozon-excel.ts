import ExcelJS from "exceljs";
import {
  isOzonCargoCode, ozonArticle, ozonProductBarcodes, readOzonCargoCodes, summarizeOzonProducts,
  type OzonBatch, type OzonGroup,
} from "../../shared/ozon-shipment";
import { downloadWorkbook } from "./excel";

const productHeaders = ["артикул", "имя (необязательно)", "количество"];
const cargoHeaders = [
  "ШК товара", "Артикул товара", "Кол-во товаров", "Зона размещения",
  "Срок годности ДО в формате YYYY-MM-DD (не более 1 СГ на 1 SKU в 1 ГМ)",
  "ШК ГМ", "Тип ГМ (не обязательно)",
];
const sortZone = "Сортируемый товар";
const cargoType = "Коробка";

function workbook(createdAt: string) {
  const book = new ExcelJS.Workbook();
  book.creator = "RITM Сборка";
  book.created = new Date(createdAt);
  return book;
}
export function ozonProductsWorkbook(group: OzonGroup) {
  const book = workbook(group.dispatch.createdAt);
  const sheet = book.addWorksheet("Sheet1");
  sheet.addRow(productHeaders);
  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 50;
  sheet.getColumn(3).width = 15;
  for (const { sku, name, qty } of summarizeOzonProducts(group.boxes, ozonArticle)) sheet.addRow([sku, name, qty]);
  return book;
}

export function ozonCargoWorkbook(group: OzonGroup) {
  const labels = group.labels;
  if (!labels || labels.codes.length !== group.boxes.length)
    throw Error("Сначала сохраните пары коробов и штрихкодов.");
  const productCodes = ozonProductBarcodes(labels);
  const book = workbook(group.dispatch.createdAt);
  const sheet = book.addWorksheet("Состав ГМ поставки");
  sheet.addRow(cargoHeaders);
  const widths = [21, 25, 17, 24, 47, 24, 22];
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.getCell("E1").alignment = { wrapText: true };
  sheet.getRow(1).height = 32;
  for (const [index, box] of group.boxes.entries()) {
    for (const { sku, qty } of summarizeOzonProducts([box], ozonArticle)) {
      const barcode = productCodes.get(sku);
      if (barcode === null) throw Error("Укажите однозначный ШК товара " + sku + ".");
      if (!barcode) throw Error("Укажите ШК товара " + sku + ".");
      sheet.addRow([barcode, sku, qty, sortZone, null, labels.codes[index], cargoType]);
    }
  }
  const instructions = book.addWorksheet("Инструкция");
  instructions.getColumn(2).width = 94;
  instructions.addRows([
    [1, "Добавьте ГМ и укажите их тип для поставки в личном кабинете"],
    [2, "Скачайте файл с штрихкодами грузовых мест, или заполняйте колонку ШК ГМ вручную"],
    [3, "Состав грузовых мест указывается в формате - одна строка, один SKU, один ШК ГМ"],
    [4, "Состав грузовых мест должен в сумме совпадать с составом заявки на поставку"],
    [5, "Если у SKU есть обязательный срок годности, укажите дату истечения срока годности по SKU на уровне грузового места"],
    [6, 'Указывается срок годности "ДО", в формате YYYY-MM-DD'],
  ]);
  instructions.getColumn(2).alignment = { wrapText: true };
  return book;
}

function safeName(value: string) {
  return value.replace(/[\\/:?*[\]<>"]/g, " ").replace(/\s+/g, " ").trim();
}
export function ozonControlWorkbook(batch: OzonBatch) {
  const book = workbook(batch.groups[0].dispatch.createdAt);
  for (const group of batch.groups) {
    const store = " — магазин " + group.dispatch.store;
    const city = safeName(group.city || group.cluster);
    let sheetName = city.slice(0, 31 - store.length).trimEnd() + store;
    let suffix = 1;
    while (book.getWorksheet(sheetName)) {
      const next = " (" + ++suffix + ")";
      sheetName = city.slice(0, 31 - store.length - next.length).trimEnd() + store + next;
    }
    const sheet = book.addWorksheet(sheetName);
    [26, 23, 46, 23, 44, 15].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    sheet.addRow(["Кластер Ozon", group.cluster, "Отгрузка", group.dispatch.label]).font = { bold: true };
    sheet.addRow(["Артикул", "Количество, шт.", "Название"]).font = { bold: true };
    for (const product of summarizeOzonProducts(group.boxes, ozonArticle)) sheet.addRow([product.sku, product.qty, product.name]);
    sheet.addRow([]);
    sheet.addRow(["Короб RITM", "ШК ГМ Ozon", "Артикул", "ШК товара", "Название", "Количество, шт."]).font = { bold: true };
    const productCodes = ozonProductBarcodes(group.labels);
    for (const [index, box] of group.boxes.entries()) for (const item of box.products) {
      const sku = ozonArticle(item.sku);
      sheet.addRow([box.label, group.labels?.codes[index] ?? "", sku, productCodes.get(sku) ?? "", item.name, item.qty]);
    }
  }
  return book;
}
export function downloadOzonGroup(group: OzonGroup, kind: "products" | "cargo") {
  const title = kind === "products" ? "Товары" : "Состав грузомест";
  const label = safeName(group.cluster).slice(0, 100) + " — магазин " + group.dispatch.store;
  return downloadWorkbook(
    kind === "products" ? ozonProductsWorkbook(group) : ozonCargoWorkbook(group),
    "Ozon — " + title + " — " + label + " — " + group.dispatch.label + ".xlsx",
  );
}
export function downloadOzonControl(batch: OzonBatch) {
  return downloadWorkbook(ozonControlWorkbook(batch), "Ozon — короба — " + batch.groups[0].dispatch.label + ".xlsx");
}

const headerKey = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replace(/[\s._-]+/gu, " ");
const cargoHeader = /^(?:шк|штрихкод) (?:гм|грузоместа?|грузового места|грузовых мест|короба)(?:$|[\s(:,/])/u;
function candidateCode(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (typeof value === "string") return value.trim();
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
}

export async function readOzonBarcodeWorkbook(buffer: ArrayBuffer, cluster?: string): Promise<string[]> {
  if (buffer.byteLength > 10_000_000) throw Error("Размер файла со штрихкодами должен быть до 10 МБ.");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheets = book.worksheets.filter((sheet) => sheet.state === "visible");
  if (sheets.some((sheet) => sheet.rowCount > 50_000))
    throw Error("В файле слишком много строк. Загрузите список штрихкодов этой поставки.");
  const candidates: string[][] = [];
  for (const sheet of sheets) {
    for (let rowIndex = 1; rowIndex <= Math.min(sheet.rowCount, 12); rowIndex++) {
      const headers = new Map<string, number>();
      sheet.getRow(rowIndex).eachCell((cell, column) => headers.set(headerKey(cell.text), column));
      const codeColumn = [...headers].find(([key]) => cargoHeader.test(key))?.[1];
      if (!codeColumn) continue;
      const clusterColumn = headers.get("кластер") ?? headers.get("кластер назначения");
      const detailSheet = headers.has("артикул товара") && headers.has("кол во товаров");
      const codes: string[] = [];
      for (let index = rowIndex + 1; index <= sheet.rowCount; index++) {
        const row = sheet.getRow(index);
        if (cluster && clusterColumn && headerKey(row.getCell(clusterColumn).text) !== headerKey(cluster)) continue;
        const cell = row.getCell(codeColumn);
        if (cell.value === null || cell.value === "") continue;
        const code = candidateCode(cell);
        if (!isOzonCargoCode(code)) throw Error("Проверьте штрихкод в " + sheet.name + " · " + cell.address + ".");
        codes.push(code);
      }
      if (codes.length) candidates.push(detailSheet ? [...new Set(codes)] : codes);
      break;
    }
  }
  if (candidates.length === 1) return readOzonCargoCodes(candidates[0].join("\n"));
  if (candidates.length > 1)
    throw Error("В файле несколько списков грузомест. Вставьте ШК для нужного кластера.");

  // A workbook containing only the codes in column A is also supported.
  if (sheets.length === 1 && sheets[0].columnCount === 1) {
    const codes: string[] = [];
    sheets[0].eachRow((row) => {
      const code = candidateCode(row.getCell(1));
      if (isOzonCargoCode(code)) codes.push(code);
      else if (row.number > 1) throw Error("Проверьте штрихкод в строке " + row.number + ".");
    });
    if (codes.length) return readOzonCargoCodes(codes.join("\n"));
  }
  throw Error("Нужна колонка «ШК ГМ» для этой поставки Ozon. Можно вставить штрихкоды вручную.");
}
