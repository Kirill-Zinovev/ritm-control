import { doctorColumnIndex } from "./doctorRegistry.js";
export function measureGrid(document, spreadsheet) {
  let returnedCells = 0,
    populatedCells = 0,
    formulasRead = 0,
    requestedCells = 0;
  const sheetMetrics = [];
  for (const schema of document.sheets) {
    const sheet = spreadsheet.sheets.find(
      (s) => s.properties.sheetId === schema.gid,
    );
    if (!sheet) continue;
    let cells = 0,
      formulas = 0;
    for (const grid of sheet.data || [])
      for (const row of grid.rowData || [])
        for (const cell of row.values || []) {
          cells++;
          if (cell.userEnteredValue?.formulaValue) formulas++;
          if (cell.userEnteredValue || cell.effectiveValue) populatedCells++;
        }
    returnedCells += cells;
    formulasRead += formulas;
    const area =
      Math.min(schema.maxRows, sheet.properties.gridProperties.rowCount) *
      (doctorColumnIndex(schema.lastColumn) + 1);
    requestedCells += area;
    sheetMetrics.push({
      gid: schema.gid,
      name: sheet.properties.title,
      requestedCells: area,
      returnedCells: cells,
      formulasRead: formulas,
    });
  }
  return {
    returnedCells,
    populatedCells,
    requestedCells,
    formulasRead,
    sheetMetrics,
  };
}
export function metricDelta(before, after) {
  if (!before || !after) return null;
  const statuses = Object.fromEntries(
    Object.entries(after.statuses)
      .map(([code, count]) => [code, count - (before.statuses[code] || 0)])
      .filter(([, count]) => count > 0),
  );
  return {
    readRequests: after.readRequests - before.readRequests,
    oauthRequests: after.oauthRequests - before.oauthRequests,
    retries: after.retries - before.retries,
    responseBytes: after.responseBytes - before.responseBytes,
    statuses,
  };
}
export function accessMessage(error) {
  if (error.status === 403)
    return "HTTP 403: чтение запрещено; проверьте роль Читатель и включение Sheets API";
  if (error.status === 429)
    return "HTTP 429: исчерпана квота; выполнены ограниченные повторы";
  if (error.status >= 500)
    return (
      "HTTP " +
      error.status +
      ": временная ошибка Google; выполнены ограниченные повторы"
    );
  if (error.status === 401 || error.code === "authorization_failed")
    return "Ошибка авторизации Google; проверьте ключ, аккаунт и время системы";
  if (
    [
      "credentials_unreadable",
      "invalid_service_account",
      "invalid_private_key",
      "credentials_must_be_outside_repository",
    ].includes(error.code)
  )
    return "Учётные данные Google недоступны или не прошли безопасную проверку";
  return "Чтение Google Sheets недоступно; проверьте сеть и настройки";
}
