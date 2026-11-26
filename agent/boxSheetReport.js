export const BOX_SHEET_REPORT_LABEL = "Фактически листов";

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

export async function readBoxSheetReport(reader, spreadsheetId, signal) {
  const metadata = await reader.get(spreadsheetId, {
    fields: "spreadsheetId,sheets(properties(sheetId,title,hidden,gridProperties(columnCount,rowCount)))",
  }, signal);
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
  return { status: "available", rows, entered: entered.length, total: entered.length ? total : null };
}
