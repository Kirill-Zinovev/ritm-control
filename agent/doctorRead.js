import { doctorColumnIndex } from "./doctorRegistry.js";
// Reads every registered row with bounded, paced requests. No parallel Google fan-out.
export async function readDoctorSheet(
  reader,
  documentId,
  schema,
  existing,
  signal,
  { fullGrid = false } = {},
) {
  const started = performance.now();
  const rows = fullGrid
    ? existing.properties.gridProperties.rowCount
    : Math.min(schema.maxRows, existing.properties.gridProperties.rowCount);
  const columns = fullGrid
    ? existing.properties.gridProperties.columnCount
    : doctorColumnIndex(schema.lastColumn) + 1;
  if (
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    !Number.isSafeInteger(columns) ||
    columns < 1 ||
    columns > 18278
  )
    throw new Error("Invalid grid boundaries");
  let lastColumn = "";
  for (let n = columns; n; n = Math.floor((n - 1) / 26))
    lastColumn = String.fromCharCode(65 + ((n - 1) % 26)) + lastColumn;
  const title = existing.properties.title.replaceAll("'", "''");
  const chunkRows = Math.max(
    1,
    Math.min(schema.chunkRows || rows, Math.floor(100000 / columns)),
  );
  const data = [];
  let properties;
  for (let first = 1; first <= rows; first += chunkRows) {
    const last = Math.min(rows, first + chunkRows - 1);
    const payload = await reader.grid(
      documentId,
      ["'" + title + "'!A" + first + ":" + lastColumn + last],
      signal,
    );
    const sheet = payload.sheets.find(
      (s) => s.properties.sheetId === schema.gid,
    );
    if (!sheet) throw new Error("Missing grid response");
    properties = sheet.properties;
    data.push(...(sheet.data || []));
  }
  return {
    properties,
    data,
    readBounds: { rows, columns, fullGrid },
    readAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
  };
}
