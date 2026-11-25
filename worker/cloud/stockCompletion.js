import { createHash } from 'node:crypto';
import { stockClosePlan, stockRowUid } from '../../agent/stockClosePlan.js';
import { boxStockReadiness, rollStockReadiness } from '../../agent/stockReadiness.js';

export const stockSourceKey = ({department,destination}) => `${department}:${destination}`;
export const stockTaskKey = item => JSON.stringify([item.department,item.destination,item.sheetId,item.uid]);
export const stockCloseIsPending = item => ['writing','uncertain'].includes(item?.status);
const stage = (done, actual) => done ? 'done' : actual > 0 ? 'partial' : 'not_started';

export function stockTaskReadiness({department,destination}, current, snapshot, rollHistory) {
  const common = {current,change:{newQuantity:current.quantity},snapshot};
  if(department === 'box') {
    const state = boxStockReadiness(common);
    return {print:stage(state.printing,state.printRatio),cut:stage(state.cutting,state.cutRatio)};
  }
  if(!rollHistory) throw new Error('Журнал рулонов недоступен. Обновите список.');
  const sheetName = destination === 'warehouse' ? 'Запасы склад' : 'Срочные 2 этаж';
  const state = rollStockReadiness({...common,...rollHistory,sheetName});
  return {print:stage(state.printing.complete,state.printing.actual),cut:stage(state.cutting.complete,state.cutting.actual)};
}

function readyStockId(entry) {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([entry.sheetId,entry.uid,entry.article,entry.quantity]))
    .digest('hex');
  return `sheet:${stockSourceKey(entry)}:${entry.row}:${fingerprint}`;
}

export function parseReadyStockId(id) {
  const match = typeof id === 'string' && id.match(/^sheet:(box|roll):(warehouse|urgent):([1-9]\d{0,3}):[a-f0-9]{64}$/);
  if(!match || Number(match[3]) < 5) return null;
  return {department:match[1],destination:match[2],row:Number(match[3])};
}

function sheetEntry(source, snapshot, row) {
  const entry = {...source,...row,sheetId:snapshot.sheetId,uid:stockRowUid(snapshot,row.row)};
  return {...entry,id:readyStockId(entry)};
}

export function resolveReadyStockEntry(id, source, snapshot) {
  const row = snapshot.rows.find(item => item.row === source.row);
  const entry = row && sheetEntry(source,snapshot,row);
  if(!entry?.uid || entry.id !== id) throw new Error('Строка или количество изменились. Обновите список готовых заданий.');
  return entry;
}

export function readyStockEntries(source, snapshot, rollHistory, pendingKeys) {
  const ready = [];
  for(const row of snapshot.rows) {
    if(!stockRowUid(snapshot,row.row)) continue;
    try {
      const state = stockTaskReadiness(source,row,snapshot,rollHistory);
      if(state.print !== 'done' || state.cut !== 'done') continue;
      const entry = sheetEntry(source,snapshot,row);
      if(pendingKeys.has(stockTaskKey(entry))) continue;
      stockClosePlan({entry,snapshot,readiness:state});
      ready.push(entry);
    } catch { /* Unconfirmed rows must not be offered for completion. */ }
  }
  return ready;
}
