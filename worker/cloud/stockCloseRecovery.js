import { readStockSnapshot } from '../../agent/stockSheets.js';

const val = cell => cell?.effectiveValue?.stringValue ?? cell?.effectiveValue?.numberValue ?? cell?.userEnteredValue?.stringValue ?? cell?.userEnteredValue?.numberValue ?? '';

// An archive receipt alone is insufficient: the old UID must also be absent
// from the active sheet, so an interrupted archive cannot be marked complete.
export async function verifyArchivedStockClose(reader, spreadsheetId, operation) {
  const meta = await reader.metadata(spreadsheetId, undefined, 5);
  if (meta?.spreadsheetId !== spreadsheetId) return null;
  const archives = (meta.sheets || []).filter(s => s.properties?.title === '_RITM_STOCK_ARCHIVE');
  const props = archives[0]?.properties;
  const count = props?.gridProperties?.rowCount;
  if (archives.length !== 1 || !Number.isSafeInteger(count) || count < 1 || count > 10000) return null;
  const response = await reader.grid(spreadsheetId, [`'_RITM_STOCK_ARCHIVE'!A1:G${count}`], undefined, 5);
  const sheet = response?.sheets?.find(s => s.properties?.sheetId === props.sheetId && s.properties?.title === '_RITM_STOCK_ARCHIVE');
  const data = sheet?.data?.[0];
  if (response?.spreadsheetId !== spreadsheetId || !data || data.startRow || data.startColumn || !Array.isArray(data.rowData)) return null;
  const rows = data.rowData.map(r => (r.values || []).map(val));
  if (rows[0]?.slice(0,7).join('|') !== 'Операция|Дата|Лист|Строка|UID|Артикул|План') return null;
  const matches = rows.slice(1).filter(r => String(r[0]) === operation.id);
  const expectedName = operation.destination === 'urgent' ? 'Срочные 2 этаж' : operation.destination === 'warehouse' ? 'Запасы склад' : '';
  if (matches.length !== 1 || !expectedName) return null;
  const r = matches[0];
  if (String(r[2]) !== expectedName || Number(r[3]) !== operation.row || String(r[4]) !== operation.uid || String(r[5]) !== operation.article || Number(r[6]) !== operation.quantity || !Number.isFinite(Date.parse(r[1]))) return null;
  const snapshot = await readStockSnapshot(reader, spreadsheetId, operation.destination);
  if (snapshot.sheetId !== operation.sheetId || snapshot.rows.some(row => String(val(snapshot.data[row.row-1]?.values?.[29])).trim() === operation.uid)) return null;
  return {closedAt: String(r[1])};
}
