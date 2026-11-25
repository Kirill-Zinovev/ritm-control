import { readStockSnapshot } from '../../agent/stockSheets.js';

const val = cell => cell?.effectiveValue?.stringValue ?? cell?.effectiveValue?.numberValue ?? cell?.userEnteredValue?.stringValue ?? cell?.userEnteredValue?.numberValue ?? '';

// An archive receipt alone is insufficient: the old UID must also be absent
// from the active sheet, so an interrupted archive cannot be marked complete.
export async function verifyArchivedStockClose(reader, spreadsheetId, operation) {
  return (await verifyArchivedStockCloses(reader,spreadsheetId,[operation])).get(operation.id)||null;
}

export async function verifyArchivedStockCloses(reader, spreadsheetId, operations) {
  const verified=new Map();
  if(!operations.length)return verified;
  const meta = await reader.metadata(spreadsheetId, undefined, 5);
  if (meta?.spreadsheetId !== spreadsheetId) return verified;
  const archives = (meta.sheets || []).filter(s => s.properties?.title === '_RITM_STOCK_ARCHIVE');
  const props = archives[0]?.properties;
  const count = props?.gridProperties?.rowCount;
  if (archives.length !== 1 || !Number.isSafeInteger(count) || count < 1 || count > 10000) return verified;
  const response = await reader.grid(spreadsheetId, [`'_RITM_STOCK_ARCHIVE'!A1:G${count}`], undefined, 5);
  const sheet = response?.sheets?.find(s => s.properties?.sheetId === props.sheetId && s.properties?.title === '_RITM_STOCK_ARCHIVE');
  const data = sheet?.data?.[0];
  if (response?.spreadsheetId !== spreadsheetId || !data || data.startRow || data.startColumn || !Array.isArray(data.rowData)) return verified;
  const rows = data.rowData.map(r => (r.values || []).map(val));
  if (rows[0]?.slice(0,7).join('|') !== 'Операция|Дата|Лист|Строка|UID|Артикул|План') return verified;
  const receipts=new Map();
  for(const row of rows.slice(1)) {
    const id=String(row[0]);
    receipts.set(id,receipts.has(id)?null:row);
  }
  const candidates=operations.filter(operation=>{
    const r=receipts.get(operation.id);
    const name=operation.destination==='urgent'?'Срочные 2 этаж':operation.destination==='warehouse'?'Запасы склад':null;
    return r && name && String(r[2])===name && Number(r[3])===operation.row && String(r[4])===operation.uid &&
      String(r[5])===operation.article && Number(r[6])===operation.quantity && Number.isFinite(Date.parse(r[1]));
  });
  const snapshots=new Map(await Promise.all([...new Set(candidates.map(item=>item.destination))].map(async destination=>
    [destination,await readStockSnapshot(reader,spreadsheetId,destination).catch(()=>null)])));
  for(const operation of candidates) {
    const snapshot=snapshots.get(operation.destination);
    if(snapshot?.sheetId===operation.sheetId &&
      !snapshot.rows.some(row=>String(val(snapshot.data[row.row-1]?.values?.[29])).trim()===operation.uid))
      verified.set(operation.id,{closedAt:String(receipts.get(operation.id)[1])});
  }
  return verified;
}
