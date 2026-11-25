import { readStockSnapshot } from '../../agent/stockSheets.js';
import { readRollStockHistory } from '../../agent/stockReadiness.js';
import { stockArticleKey, stockRowUid } from '../../agent/stockClosePlan.js';
import { readyStockEntries, stockCloseIsPending, stockSourceKey, stockTaskKey, stockTaskReadiness } from './stockCompletion.js';

const unknown = { print:'unknown', cut:'unknown' };
const stockSources = ['warehouse','urgent'].flatMap(destination => ['roll','box'].map(department => ({department,destination})));

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
  const closed=new Map(all.filter(row=>row.kind==='stock-close' && row.value?.status==='verified' && row.value?.uid && Number.isFinite(Date.parse(row.value.closedAt)))
    .map(({value})=>[stockTaskKey(value),value]));
  const linked=new Set();
  const entries=all.filter(row => row.kind === 'stock' && row.value?.status === 'verified')
    .map(row => ({ operation:row.value, date:row.value.createdAt || row.createdAt }))
    .filter(row => Number.isFinite(Date.parse(row.date)) && Date.parse(row.date) <= now + 60000)
    .sort((a,b) => Date.parse(b.date)-Date.parse(a.date))
    .flatMap(({operation,date}) => (operation.steps || []).filter(step => step.status === 'verified' && ['box','roll'].includes(step.department)).flatMap(step => (step.plan?.entries || []).map(entry => ({ id:`${operation.id}:${step.department}:${entry.row}:${entry.article}`, date, manager:operation.manager || null, destination:operation.destination, department:step.department, article:entry.article, quantity:entry.quantity, sheetId:step.plan.sheetId, row:entry.row, uid:entry.uid || null }))))
    .map(entry=>{
      const identity=stockTaskKey(entry), completion=closed.get(identity);
      if(!completion || (completion.article && stockArticleKey(completion.article)!==stockArticleKey(entry.article))) return entry;
      linked.add(identity);
      return {...entry,closedAt:completion.closedAt};
    });
  for(const [identity,item] of closed) {
    if(linked.has(identity) || !item.id || !item.article || !Number.isSafeInteger(item.quantity) || item.quantity<=0) continue;
    entries.push({id:`closed:${item.id}`,date:item.closedAt,closedAt:item.closedAt,event:'close',manager:item.closedBy||null,
      destination:item.destination,department:item.department,article:item.article,quantity:item.quantity,sheetId:item.sheetId,row:item.row,uid:item.uid});
  }
  const latest = entry => Math.max(Date.parse(entry.date),Date.parse(entry.closedAt||'')||0);
  return entries.filter(entry=>includeOlder || latest(entry)>=now-7*86400000)
    .sort((a,b)=>latest(b)-latest(a))
    .slice(0, includeOlder ? 5000 : 500);
}

async function readStockSources(keys, reader, boxId, rollId) {
  const [snapshots,rollHistory]=await Promise.all([
    Promise.all(keys.map(async k => {
      const [department,destination] = k.split(':');
      try { return [k, await readStockSnapshot(reader, department === 'box' ? boxId : rollId, destination)]; }
      catch { return [k,null]; }
    })),
    keys.some(key => key.startsWith('roll:')) ? readRollStockHistory(reader,rollId).catch(() => null) : null,
  ]);
  return {snapshots:new Map(snapshots),rollHistory};
}

function describeHistory(entries, {snapshots,rollHistory}, readyByKey = new Map()) {
  return entries.map(entry => {
    const {sheetId,row,uid,...visible}=entry;
    if(entry.closedAt) return {...visible,print:'done',cut:'done',status:'closed'};
    const ready=readyByKey.get(stockTaskKey(entry));
    if(ready && stockArticleKey(ready.article)===stockArticleKey(entry.article))
      return {...visible,print:'done',cut:'done',currentPlan:ready.quantity,readyId:ready.id};
    let status = unknown;
    let currentPlan = null;
    try {
      const snapshot = snapshots.get(stockSourceKey(entry));
      const current = snapshot?.rows.find(item => item.row === row && stockArticleKey(item.article) === stockArticleKey(entry.article));
      if (!current || snapshot.sheetId !== sheetId || !uid || stockRowUid(snapshot,current.row)!==uid) return {...visible,...status,currentPlan};
      currentPlan=current.quantity;
      status=stockTaskReadiness(entry,current,snapshot,rollHistory);
    } catch { /* Never infer readiness when the source cannot be confirmed. */ }
    return {...visible,...status,currentPlan};
  });
}

export async function loadStockHistory({ operations, reader, boxId, rollId, now = Date.now(), includeOlder = false }) {
  const entries=stockHistoryEntries(operations,now,{includeOlder});
  const keys=[...new Set(entries.filter(item=>!item.closedAt).map(stockSourceKey))];
  return describeHistory(entries,await readStockSources(keys,reader,boxId,rollId));
}

export async function loadStockWorkspace({ operations, reader, boxId, rollId, now = Date.now() }) {
  const all=[...operations];
  const pending=all.filter(row=>row.kind==='stock-close' && stockCloseIsPending(row.value)).map(row=>row.value);
  const pendingKeys=new Set(pending.map(stockTaskKey));
  const data=await readStockSources(stockSources.map(stockSourceKey),reader,boxId,rollId);
  const ready=[], unavailable=[];
  for(const source of stockSources) {
    const snapshot=data.snapshots.get(stockSourceKey(source));
    if(!snapshot || (source.department==='roll' && !data.rollHistory)) unavailable.push(source);
    else ready.push(...readyStockEntries(source,snapshot,data.rollHistory,pendingKeys));
  }
  return {
    entries:describeHistory(stockHistoryEntries(all,now),data,new Map(ready.map(item=>[stockTaskKey(item),item]))),
    ready:ready.map(({id,article,quantity,department,destination})=>({id,article,quantity,department,destination})),
    checking:pending.map(({id,entryId,article,quantity,department,destination})=>({id:entryId,operationId:id,article,quantity,department,destination})),
    unavailable,
  };
}
