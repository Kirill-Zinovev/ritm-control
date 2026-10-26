export type SupplyImportLine = { article: string; quantity: number };
const MAX_SUPPLY_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_SUPPLY_IMPORT_ROWS = 500;
const normalizedHeader = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ");

export async function parseSupplyWorkbook(
  bytes: ArrayBuffer,
): Promise<SupplyImportLine[]> {
  if (bytes.byteLength > MAX_SUPPLY_IMPORT_BYTES)
    throw new Error(
      "Файл больше 2 МБ. Разделите список на несколько загрузок.",
    );
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as never);
  } catch {
    throw new Error(
      "Не удалось прочитать Excel. Сохраните файл в формате .xlsx и попробуйте ещё раз.",
    );
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("В Excel-файле нет листа со списком товаров.");
  if (sheet.rowCount > MAX_SUPPLY_IMPORT_ROWS + 1)
    throw new Error(`В файле больше ${MAX_SUPPLY_IMPORT_ROWS} строк.`);
  const headers = sheet.getRow(1);
  let articleColumn = 0;
  let quantityColumn = 0;
  headers.eachCell((cell, column) => {
    const header = normalizedHeader(cell.value);
    if (["артикул", "article", "sku"].includes(header)) articleColumn = column;
    if (
      ["количество", "количество шт", "кол во", "qty", "quantity"].includes(
        header,
      )
    )
      quantityColumn = column;
  });
  if (!articleColumn || !quantityColumn || articleColumn === quantityColumn)
    throw new Error(
      "В первой строке нужны заголовки «Артикул» и «Количество, шт.». Используйте шаблон RITM.",
    );
  const lines: SupplyImportLine[] = [];
  const seen = new Set<string>();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const articleCell = sheet.getRow(rowNumber).getCell(articleColumn);
    const quantityCell = sheet.getRow(rowNumber).getCell(quantityColumn);
    if (
      typeof articleCell.value === "object" &&
      articleCell.value !== null &&
      ("formula" in articleCell.value || "sharedFormula" in articleCell.value)
    )
      throw new Error(
        `В строке ${rowNumber} артикул задан формулой. Вставьте значение.`,
      );
    if (
      typeof quantityCell.value === "object" &&
      quantityCell.value !== null &&
      ("formula" in quantityCell.value || "sharedFormula" in quantityCell.value)
    )
      throw new Error(
        `В строке ${rowNumber} количество задано формулой. Вставьте значение.`,
      );
    const article = String(articleCell.text || articleCell.value || "").trim();
    const rawQuantity = quantityCell.value;
    const quantity =
      typeof rawQuantity === "number"
        ? rawQuantity
        : Number(
            String(quantityCell.text || rawQuantity || "")
              .replace(/[\s\u00a0]/g, "")
              .replace(",", "."),
          );
    if (!article && !String(rawQuantity ?? "").trim()) continue;
    if (!article || !Number.isSafeInteger(quantity) || quantity <= 0)
      throw new Error(
        `Проверьте строку ${rowNumber}: заполните артикул и целое положительное количество.`,
      );
    const key = article.toLocaleUpperCase("ru-RU");
    if (seen.has(key))
      throw new Error(
        `Артикул «${article}» повторяется в строке ${rowNumber}.`,
      );
    seen.add(key);
    lines.push({ article, quantity });
  }
  if (!lines.length)
    throw new Error(
      "В файле нет заполненных строк с артикулами и количеством.",
    );
  if (lines.length > MAX_SUPPLY_IMPORT_ROWS)
    throw new Error(
      `В одной поставке можно загрузить не больше ${MAX_SUPPLY_IMPORT_ROWS} товаров.`,
    );
  return lines;
}

export async function createSupplyTemplate(): Promise<Uint8Array> {
  return createSupplyWorkbook([]);
}

export async function createSupplyWorkbook(
  lines: SupplyImportLine[],
): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "RITM";
  workbook.subject = "Артикулы и количество для поставки";
  const sheet = workbook.addWorksheet("Товары", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "Артикул", key: "article", width: 30 },
    { header: "Количество, шт.", key: "quantity", width: 20 },
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF142638" },
  };
  if (lines.length) {
    for (const line of lines) sheet.addRow([line.article, line.quantity]);
  } else {
    for (let row = 0; row < 20; row++) sheet.addRow(["", ""]);
  }
  sheet.autoFilter = `A1:B${Math.max(21, lines.length + 1)}`;
  const result = await workbook.xlsx.writeBuffer();
  return new Uint8Array(result as ArrayBuffer);
}

function downloadWorkbook(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const safeName = filename
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  anchor.download = `${safeName || "Поставка_RITM"}.xlsx`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function saveSupplyTemplate(bytes: Uint8Array) {
  downloadWorkbook(bytes, "Шаблон_поставки_RITM");
}

export function saveSupplyWorkbook(bytes: Uint8Array, filename: string) {
  downloadWorkbook(bytes, filename);
}
