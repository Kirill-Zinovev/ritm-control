import ExcelJS from "exceljs";
import { summarizeOzonProducts, type OzonGroup } from "../../shared/ozon-shipment";
import { isWbCartonCode, validateWbCartonCodes, wbProductBarcodes, type WbCartonCode } from "../../shared/wb-shipment";
import { downloadWorkbook } from "./excel";

const productHeaders = ["Баркод", "Количество"];
const cartonHeaders = ["Баркод товара", "Кол-во товаров", "ШК короба", "Срок годности", "ШК короба для печати в стороннем сервисе"];

function wbRows(group: OzonGroup, boxes: OzonGroup["boxes"]) {
  const barcodes = wbProductBarcodes(group);
  const quantities = new Map<string, number>();
  for (const { sku, qty } of summarizeOzonProducts(boxes)) {
    const barcode = barcodes.get(sku);
    if (!barcode) throw Error("Укажите однозначный баркод WB для артикула " + sku + ".");
    quantities.set(barcode, (quantities.get(barcode) ?? 0) + qty);
  }
  return [...quantities];
}

export function wbWorkbook(group: OzonGroup, kind: "products" | "cargo") {
  if (group.compositionChanged) throw Error("Состав коробов изменился. Подготовьте отгрузку заново.");
  const book = new ExcelJS.Workbook();
  book.creator = "RITM Сборка";
  book.created = new Date(group.dispatch.createdAt);
  const sheet = book.addWorksheet("Sheet1");
  if (kind === "products") {
    sheet.addRow(productHeaders);
    sheet.addRows(wbRows(group, group.boxes));
  } else {
    const labels = group.labels;
    if (labels?.codes.length !== group.boxes.length) throw Error("Сначала сохраните коды коробов.");
    sheet.addRow(cartonHeaders);
    for (const [index, box] of group.boxes.entries())
      for (const [barcode, qty] of wbRows(group, [box]))
        sheet.addRow([barcode, qty, labels.codes[index], null, null]);
    sheet.getColumn(3).width = 41;
    sheet.getColumn(3).numFmt = "@";
    sheet.getColumn(4).width = 20;
    sheet.getColumn(5).width = 43;
  }
  sheet.getColumn(1).width = 23;
  sheet.getColumn(1).numFmt = "@";
  sheet.getColumn(2).width = 18;
  return book;
}

export function downloadWbGroup(group: OzonGroup, kind: "products" | "cargo") {
  const destination = group.cluster.replace(/[<>:"/\\|?*]/gu, " ").trim().slice(0, 100);
  const title = kind === "products" ? "Товары" : "Состав коробов";
  return downloadWorkbook(wbWorkbook(group, kind), `WB — ${title} — ${destination} — магазин ${group.dispatch.store}.xlsx`);
}

const headerKey = (value: string) => value.trim().toLowerCase().replace(/\s+/gu, " ");
const cartonHeader = /^(?:шк|штрихкод) короба$/u;
const printHeader = /^(?:шк|штрихкод) короба для печати в сторонн(?:ем сервисе|их сервисах)$/u;

export async function readWbCartonWorkbook(buffer: ArrayBuffer): Promise<WbCartonCode[]> {
  if (buffer.byteLength > 10_000_000) throw Error("Размер Excel с кодами WB должен быть до 10 МБ.");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const candidates: WbCartonCode[][] = [];
  for (const sheet of book.worksheets.filter(({ state }) => state === "visible")) {
    if (sheet.rowCount > 50_000) throw Error("В файле слишком много строк. Загрузите шаблон одной поставки WB.");
    for (let index = 1; index <= Math.min(sheet.rowCount, 12); index++) {
      const header = sheet.getRow(index);
      let cartonColumn = 0;
      let printColumn = 0;
      header.eachCell((cell, column) => {
        const key = headerKey(cell.text);
        if (cartonHeader.test(key)) cartonColumn = column;
        if (printHeader.test(key)) printColumn = column;
      });
      if (!cartonColumn) continue;
      const codes = new Map<string, WbCartonCode>();
      for (let rowIndex = index + 1; rowIndex <= sheet.rowCount; rowIndex++) {
        const row = sheet.getRow(rowIndex);
        const cell = row.getCell(cartonColumn);
        const value = cell.value;
        const qr = printColumn ? row.getCell(printColumn).value : null;
        if ((value === null || value === "") && (qr === null || qr === "")) continue;
        const code = typeof value === "string" ? value
          : typeof value === "number" && Number.isSafeInteger(value) ? cell.text : "";
        if (!isWbCartonCode(code)) throw Error("Проверьте «ШК короба» в ячейке " + cell.address + ".");
        if (qr !== null && typeof qr !== "string")
          throw Error("Проверьте код для печати в строке " + rowIndex + ".");
        const printCode = qr || null;
        const previous = codes.get(code);
        if (printCode && previous?.printCode && printCode !== previous.printCode)
          throw Error("У короба " + code + " в файле разные QR для печати.");
        codes.set(code, { code, printCode: printCode ?? previous?.printCode ?? null });
      }
      if (codes.size) candidates.push([...codes.values()]);
      break;
    }
  }
  if (!candidates.length) throw Error("В файле WB нужна заполненная колонка «ШК короба».");
  if (candidates.length > 1) throw Error("В файле несколько списков коробов. Загрузите шаблон одной поставки WB.");
  validateWbCartonCodes(candidates[0], candidates[0].length);
  return candidates[0];
}
