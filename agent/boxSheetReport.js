export const BOX_SHEET_REPORT_LABEL = "Фактически листов";
const fbsHeaders = [
  "Дата",
  "Сотрудник",
  "Акрил прозрачный",
  "Акрил молочный",
  "ПЭТ",
  "ПВХ",
  "Лазер",
];
const sheetEpoch = Date.UTC(1899, 11, 30);
const lastDateSerial = 2958465;

function isBoxSupply({ properties }) {
  return /^(OZON|WB)\s+\S/iu.test(properties?.title?.trim() ?? "");
}

export function isVisibleBoxSupply(sheet) {
  return !sheet.properties?.hidden && isBoxSupply(sheet);
}

function readCount(grid) {
  const [labels, counts] = grid?.rowData ?? [];
  const columns = (labels?.values ?? []).flatMap((cell, index) =>
    cell.userEnteredValue?.stringValue === BOX_SHEET_REPORT_LABEL ? [index] : [],
  );
  if (columns.length !== 1)
    return { status: columns.length ? "invalid" : "missing", count: null };
  const cell = counts?.values?.[columns[0]];
  const entered = cell?.userEnteredValue;
  if (!entered) return { status: "empty", count: null };
  const count = entered.numberValue;
  if (!Number.isSafeInteger(count) || count < 0)
    return { status: "invalid", count: null };
  return { status: "entered", count };
}

async function readFbsSheet(reader, spreadsheetId, tab, signal) {
  if (!tab) return { status: "missing", rows: [], invalidRows: [] };
  const { sheetId, gridProperties } = tab.properties;
  const url = "https://docs.google.com/spreadsheets/d/" + spreadsheetId + "/edit#gid=" + sheetId;
  try {
    const rowCount = gridProperties?.rowCount;
    if (!Number.isSafeInteger(rowCount) || rowCount < 1 || gridProperties.columnCount < fbsHeaders.length)
      throw new Error("FBS table grid unavailable");
    const response = await reader.get(spreadsheetId, {
      ranges: ["'FBS'!A1:G" + rowCount],
      fields: "spreadsheetId,sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredValue))))",
    }, signal);
    const sheet = response.sheets?.find(({ properties }) => properties?.sheetId === sheetId);
    const grid = sheet?.data?.[0];
    const [header, ...contents] = grid?.rowData ?? [];
    if (response.spreadsheetId !== spreadsheetId || sheet?.properties?.title !== "FBS" ||
        (grid?.startRow ?? 0) !== 0 || (grid?.startColumn ?? 0) !== 0 ||
        !fbsHeaders.every((label, i) => header?.values?.[i]?.userEnteredValue?.stringValue === label))
      throw new Error("FBS table headers changed");

    const entries = new Map();
    const invalidRows = [];
    for (const [i, { values }] of contents.entries()) {
      const row = i + 2;
      const [day, person, ...cells] = Array.from({ length: fbsHeaders.length },
        (_, column) => values?.[column]?.userEnteredValue);
      if (!day && !person && cells.every(cell => !cell)) continue;
      const serial = day?.numberValue;
      const employee = person?.stringValue?.trim().replace(/\s+/gu, " ").normalize("NFC");
      const counts = cells.map(cell => cell ? cell.numberValue : 0);
      const print = counts.slice(0, 4).reduce((sum, count) => sum + count, 0);
      if (!Number.isSafeInteger(serial) || serial < 1 || serial > lastDateSerial || !employee ||
          !counts.every(count => Number.isSafeInteger(count) && count >= 0) || !Number.isSafeInteger(print)) {
        invalidRows.push(row);
        continue;
      }
      if (cells.every(cell => !cell)) continue;
      const date = new Date(sheetEpoch + serial * 86400000).toISOString().slice(0, 10);
      const key = date + "|" + employee.toLocaleLowerCase("ru-RU");
      const group = entries.get(key) ?? [];
      group.push({ row, entry: { date, employee, print, cut: counts[4] } });
      entries.set(key, group);
    }
    const rows = [];
    for (const group of entries.values()) {
      if (group.length === 1) rows.push(group[0].entry);
      else invalidRows.push(...group.map(({ row }) => row));
    }
    invalidRows.sort((a, b) => a - b);
    return { status: "available", rows, invalidRows, url };
  } catch {
    return { status: "stale", rows: [], invalidRows: [], url };
  }
}

export async function readBoxSheetReport(reader, spreadsheetId, signal) {
  const metadata = await reader.get(spreadsheetId, {
    fields: "spreadsheetId,sheets(properties(sheetId,title,hidden,gridProperties(columnCount,rowCount)))",
  }, signal);
  const fbs = readFbsSheet(reader, spreadsheetId,
    metadata.sheets.find(({ properties }) => properties?.title === "FBS"), signal);
  const supplies = metadata.sheets.filter(isBoxSupply);
  const rows = [];

  for (let offset = 0; offset < supplies.length; offset += 30) {
    const group = supplies.slice(offset, offset + 30);
    const ranges = group.map(({ properties: { title, gridProperties } }) => {
      const lastColumn = Math.min(gridProperties?.columnCount ?? 0, 26);
      if (lastColumn < 1 || gridProperties.rowCount < 3)
        throw new Error("Box supply header unavailable");
      return "'" + title.replaceAll("'", "''") + "'!A2:" + String.fromCharCode(64 + lastColumn) + "3";
    });
    const response = await reader.get(spreadsheetId, {
      ranges,
      fields: "spreadsheetId,sheets(properties(sheetId,title,hidden),data(startRow,startColumn,rowData(values(userEnteredValue))))",
    }, signal);
    const byId = new Map(response.sheets.map(sheet => [sheet.properties.sheetId, sheet]));
    for (const { properties: { title, sheetId } } of group) {
      const sheet = byId.get(sheetId), grid = sheet?.data?.[0];
      if (sheet?.properties?.title !== title || (grid && (grid.startRow !== 1 || (grid.startColumn ?? 0) !== 0)))
        throw new Error("Box supply header changed during refresh");
      const result = readCount(grid);
      const archived = sheet.properties.hidden === true;
      if (archived && result.status !== "entered") continue;
      rows.push({
        sheetId,
        name: title,
        url: "https://docs.google.com/spreadsheets/d/" + spreadsheetId + "/edit#gid=" + sheetId,
        archived,
        ...result,
      });
    }
  }

  const entered = rows.filter(row => row.status === "entered");
  const total = entered.reduce((sum, row) => sum + row.count, 0);
  if (!Number.isSafeInteger(total)) throw new Error("Box sheet total exceeds supported precision");
  return { status: "available", rows, entered: entered.length, total: entered.length ? total : null, fbs: await fbs };
}
