import { readStockSnapshot } from '../../agent/stockSheets.js';
import { boxStockReadiness, readRollStockHistory, rollStockReadiness } from '../../agent/stockReadiness.js';

const cellValue = cell => cell?.effectiveValue?.stringValue ?? cell?.effectiveValue?.numberValue ?? cell?.userEnteredValue?.stringValue ?? cell?.userEnteredValue?.numberValue ?? '';
const key = value => String(value || '').trim().toUpperCase().replace(/\(OZ\)$/u,'').trim();
const unknown = { print:'unknown', cut:'unknown' };
const stage = (complete, actual) => complete ? 'done' : actual > 0 ? 'partial' : 'not_started';

// Membership comes from the whole committed upload, never a bounded history
// page. Missing/truncated source rows must hold the entire batch.
export function stockNotificationBatches(operations, now = Date.now()) {
  return [...operations].filter(row => row.kind === 'stock' && row.value?.status === 'verified').map(row => {
    const operation = row.value, date = operation.createdAt || row.createdAt;
    const entries = (operation.steps || []).flatMap(step => (step.plan?.entries || []).map(entry => ({
      id:`${operation.id}:${step.department}:${entry.row}:${entry.article}`, department:step.department,
      sheetId:step.plan.sheetId, row:entry.row, uid:entry.uid, article:entry.article,
      quantity:entry.quantity, plannedQuantity:entry.newQuantity ?? entry.quantity,
    })));
    const identities = entries.map(entry => `${entry.department}:${entry.sheetId}:${entry.uid}`);
    const valid = typeof operation.id === 'string' && !!operation.id && ['urgent','warehouse'].includes(operation.destination)
      && operation.steps?.length > 0 && operation.steps.every(step => step.status === 'verified' && step.plan?.entries?.length > 0)
      && new Set(operation.steps.map(step => step.department)).size === operation.steps.length
      && entries.length > 0 && entries.every(entry => ['box','roll'].includes(entry.department)
        && Number.isSafeInteger(entry.sheetId) && entry.sheetId >= 0 && Number.isSafeInteger(entry.row) && entry.row >= 5
        && typeof entry.uid === 'string' && !!entry.uid.trim() && typeof entry.article === 'string' && !!entry.article.trim()
        && Number.isSafeInteger(entry.quantity) && entry.quantity > 0 && Number.isSafeInteger(entry.plannedQuantity) && entry.plannedQuantity >= entry.quantity)
      && new Set(identities).size === identities.length && Number.isSafeInteger(entries.reduce((sum,entry) => sum + entry.quantity,0));
    return {id:operation.id, date, destination:operation.destination, manager:operation.manager || null, entries, valid};
  }).filter(batch => Number.isFinite(Date.parse(batch.date)) && Date.parse(batch.date) <= now + 60000);
}

export function stockHistoryEntries(operations, now = Date.now(), {includeOlder = false} = {}) {
  const all=[...operations];
  const closed=all.filter(row=>row.kind==='stock-close' && row.value?.status==='verified' && row.value?.uid && Number.isFinite(Date.parse(row.value.closedAt)))
    .map(row=>row.value);
  return all.filter(row => row.kind === 'stock' && row.value?.status === 'verified')
    .map(row => ({ operation:row.value, date:row.value.createdAt || row.createdAt }))
    .filter(row => Number.isFinite(Date.parse(row.date)) && Date.parse(row.date) <= now + 60000)
    .sort((a,b) => Date.parse(b.date)-Date.parse(a.date))
    .flatMap(({operation,date}) => (operation.steps || []).filter(step => step.status === 'verified' && ['box','roll'].includes(step.department)).flatMap(step => (step.plan?.entries || []).map(entry => ({ id:`${operation.id}:${step.department}:${entry.row}:${entry.article}`, date, manager:operation.manager || null, destination:operation.destination, department:step.department, article:entry.article, quantity:entry.quantity, sheetId:step.plan.sheetId, row:entry.row, uid:entry.uid || null }))))
    .map(entry=>{const completion=closed.find(c=>c.uid===entry.uid && c.sheetId===entry.sheetId && c.department===entry.department && c.destination===entry.destination);return completion?{...entry,closedAt:completion.closedAt}:entry;})
    .filter(entry=>includeOlder || Math.max(Date.parse(entry.date),Date.parse(entry.closedAt||'')||0)>=now-7*86400000)
    .sort((a,b)=>Math.max(Date.parse(b.date),Date.parse(b.closedAt||'')||0)-Math.max(Date.parse(a.date),Date.parse(a.closedAt||'')||0))
    .slice(0, includeOlder ? 5000 : 500);
}

export async function loadStockHistory({ operations, reader, boxId, rollId, now = Date.now(), includeOlder = false }) {
  const entries = stockHistoryEntries(operations, now, {includeOlder});
  const keys = [...new Set(entries.map(item=>`${item.department}:${item.destination}`))];
  const snapshots = new Map(await Promise.all(keys.map(async k => {
    const [department,destination] = k.split(':');
    try { return [k, await readStockSnapshot(reader, department === 'box' ? boxId : rollId, destination)]; }
    catch { return [k,null]; }
  })));
  let rollHistory = null;
  if(entries.some(item => item.department === 'roll')) {
    try { rollHistory = await readRollStockHistory(reader, rollId); } catch { /* Individual statuses remain unknown. */ }
  }
  return entries.map(entry => {
    if(entry.closedAt){const {sheetId,row,uid,...visible}=entry;return {...visible,print:'done',cut:'done',status:'closed'};}
    let status = unknown;
    let currentPlan = null;
    try {
      const snapshot = snapshots.get(`${entry.department}:${entry.destination}`);
      const current = snapshot?.rows.find(row => row.row === entry.row && key(row.article) === key(entry.article));
      const uid = current && String(cellValue(snapshot.data[current.row-1]?.values?.[29]));
      if (!snapshot || snapshot.sheetId !== entry.sheetId || !current || (entry.uid && uid !== entry.uid) || !entry.uid) throw Error('unconfirmed');
      currentPlan=current.quantity;
      if(entry.department === 'box') {
        const result = boxStockReadiness({ current, change:{newQuantity:current.quantity}, snapshot });
        status = { print:stage(result.printing,result.printRatio), cut:stage(result.cutting,result.cutRatio) };
      } else {
        if (!rollHistory) throw Error('unavailable');
        const result = rollStockReadiness({current,change:{newQuantity:current.quantity},snapshot,...rollHistory,sheetName:entry.destination === 'warehouse' ? 'Запасы склад':'Срочные 2 этаж'});
        status = {print:stage(result.printing.complete,result.printing.actual),cut:stage(result.cutting.complete,result.cutting.actual)};
      }
    } catch { /* Never infer readiness when the source cannot be confirmed. */ }
    const {sheetId,row,uid,...visible}=entry;
    return {...visible,...status,currentPlan};
  });
}
