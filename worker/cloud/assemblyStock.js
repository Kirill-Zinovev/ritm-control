import { createHash } from 'node:crypto';
import { readStockSnapshot } from '../../agent/stockSheets.js';
import { CloudError } from './access.js';

export const ASSEMBLY_STOCK_ID = 'RITM-STOCK-WAREHOUSE';
const value = cell => cell?.effectiveValue?.stringValue ?? cell?.effectiveValue?.numberValue ?? cell?.effectiveValue?.boolValue ?? cell?.userEnteredValue?.stringValue ?? cell?.userEnteredValue?.numberValue ?? cell?.userEnteredValue?.boolValue ?? '';
const entered = cell => cell?.userEnteredValue?.stringValue ?? cell?.userEnteredValue?.numberValue ?? '';
const invalid = message => { throw new CloudError('assembly_stock_unavailable', 'Запасы для сборки: ' + message, 503); };

function stockItem(department, documentId, sheetId, row, values, archivedAt = '') {
  const article = String(values[4] ?? '').trim(), uid = String(values[29] ?? '').trim(), quantity = Number(values[15]);
  if (!article || article.startsWith('#') || article.length > 120 || !uid || uid.length > 240 || !Number.isSafeInteger(quantity) || quantity <= 0) invalid('не подтверждены артикул, план или UID в строке ' + row + '.');
  const physicalPlan = department === 'box' && /^(xerox|ксерокс|x|х)$/i.test(String(values[3]).trim())
    ? quantity / Number(values[13]) * Number(values[6]) : quantity;
  const state = input => input === true || /^(?:готов|готово|true)$/i.test(String(input).trim()) ? 'done' : input === false || input === '' ? 'not_started' : 'unknown';
  let print = archivedAt ? 'done' : state(values[18]), cut = archivedAt ? 'done' : state(values[19]);
  // New box columns store partial facts in physical-sheet equivalents for Xerox.
  if (!archivedAt && department === 'box' && Number.isFinite(physicalPlan) && physicalPlan > 0) {
    for (const [column, assign] of [[27, v => { print = v; }], [28, v => { cut = v; }]]) {
      const actual = Number(values[column]);
      if (values[column] !== '' && Number.isFinite(actual) && actual >= 0) assign(actual >= physicalPlan ? 'done' : actual > 0 ? 'partial' : 'not_started');
    }
  }
  return { department, documentId, sheetId, row, uid, article, quantity, print, cut, archivedAt,
    positionId: `${ASSEMBLY_STOCK_ID}|uid:${department}:${documentId}:${sheetId}:${uid}|${article}` };
}

// Read-only projection of the two configured warehouse queues. No production
// sheet, Assembly mirror, work event or carton is created by this endpoint.
export async function readAssemblyStocks({ reader, boxId, rollId, signal }) {
  if (!boxId || !rollId || boxId === rollId) invalid('обе производственные таблицы должны быть подключены.');
  const parts = await Promise.all([['box',boxId],['roll',rollId]].map(async ([department,documentId]) => {
    const snapshot = await readStockSnapshot(reader,documentId,'warehouse',signal);
    const items = snapshot.rows.map(row => stockItem(department,documentId,snapshot.sheetId,row.row,
      Array.from({length:30}, (_,i) => i === 29 ? entered(snapshot.data[row.row-1]?.values?.[i]) : value(snapshot.data[row.row-1]?.values?.[i]))));
    const meta = snapshot.metadata;
    const archives = (meta.sheets || []).filter(s => s.properties?.title === '_RITM_STOCK_ARCHIVE');
    if (archives.length > 1) invalid('повторяется лист архива.');
    if (archives.length) {
      const props = archives[0].properties, count = props.gridProperties?.rowCount;
      if (!Number.isSafeInteger(count) || count < 1 || count > 6000) invalid('не подтверждён размер архива.');
      const grid = await reader.grid(documentId,[`'_RITM_STOCK_ARCHIVE'!A1:H${count}`],signal);
      const matches = grid.sheets?.filter(s => s.properties?.sheetId === props.sheetId) || [];
      const block = matches[0]?.data?.[0], rows = block?.rowData;
      const headers = ['Операция','Дата','Лист','Строка','UID','Артикул','План','Данные строки'];
      if (grid.spreadsheetId !== documentId || matches.length !== 1 || matches[0].data.length !== 1 || (block.startRow || 0) !== 0 || (block.startColumn || 0) !== 0 || !rows || headers.some((h,i) => value(rows[0]?.values?.[i]) !== h)) invalid('изменился формат архива.');
      const archivedUids = new Set();
      for (const record of rows.slice(1)) {
        const cells = (record.values || []).map(value);
        if (cells[2] !== 'Запасы склад') continue;
        let data; try { data = JSON.parse(cells[7]); } catch { invalid('не прочитана архивная позиция.'); }
        if (!Number.isFinite(Date.parse(cells[1])) || !Array.isArray(data.values) || String(data.values[29]) !== String(cells[4]) || String(data.values[4]) !== String(cells[5]) || Number(data.values[15]) !== Number(cells[6])) invalid('архивная позиция не совпадает с сохранённым составом.');
        const item = stockItem(department,documentId,snapshot.sheetId,Number(cells[3]),data.values,String(cells[1]));
        if (archivedUids.has(item.uid)) invalid('повторяется UID в архиве.');
        archivedUids.add(item.uid);
        const prior = items.find(i => i.uid === item.uid);
        if (prior) {
          if (prior.article !== item.article || prior.quantity !== item.quantity) invalid('конфликт текущего плана и архива.');
          continue; // Closing can briefly expose the same UID in both places.
        }
        items.push(item);
      }
    }
    const seen = new Set();
    for (const item of items) { if (seen.has(item.uid)) invalid('повторяется UID позиции.'); seen.add(item.uid); }
    return items;
  }));
  const items = parts.flat();
  if (items.length > 1500) invalid('слишком много позиций; требуется проверка архива.');
  return {ok:true,shipmentId:ASSEMBLY_STOCK_ID,destination:'warehouse',marketplace:'OZON',items,
    revision:createHash('sha256').update(JSON.stringify(items)).digest('hex'),updatedAt:new Date().toISOString()};
}

export async function forecastStocks(store, load, background, force) {
  const kind = "forecast-stocks";
  const cached = await store.snapshot(kind);
  const age = cached ? store.now() - Date.parse(cached.value.updatedAt) : Infinity;
  if (!force && age >= 0 && age < 60000) return cached.value;
  const refresh = async () => {
    const lease = await store.acquire("refresh:"+kind,60000);
    try {
      const value = await load();
      await store.saveSnapshot(kind,value,lease);
      return value;
    } finally { await store.release(lease); }
  };
  if (!force && background && age >= 0 && age < 240000) {
    background(refresh().catch(() => {}));
    return cached.value;
  }
  try { return await refresh(); }
  catch (error) {
    if (error?.code !== "cloud_operation_busy") throw error;
    // Another request already owns the Sheets read. Its snapshot can satisfy
    // this request only after it has actually finished.
    for (let n=0;n<20;n++) {
      await new Promise(resolve=>setTimeout(resolve,1000));
      const info = await store.snapshotInfo(kind);
      if (info && info.at > (cached?.at || 0)) return (await store.snapshot(kind)).value;
    }
    throw error;
  }
}
