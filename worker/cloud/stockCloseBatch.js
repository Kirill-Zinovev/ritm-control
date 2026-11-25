import { stockArticleKey, stockClosePlan } from '../../agent/stockClosePlan.js';
import { readRollStockHistory } from '../../agent/stockReadiness.js';
import { readStockSnapshot } from '../../agent/stockSheets.js';
import { stockCloseBatchSize } from '../../shared/stockCloseBatch.js';
import { CloudError } from './access.js';
import { sourceId } from './config.js';
import { parseReadyStockId, resolveReadyStockEntry, stockCloseIsPending, stockSourceKey, stockTaskKey, stockTaskReadiness } from './stockCompletion.js';
import { verifyArchivedStockCloses } from './stockCloseRecovery.js';

export function stockCloseRecords(scope) {
  return {
    get:operationId=>scope.operations.get('stock-close:'+operationId)?.value||null,
    put:op=>scope.putOperation('stock-close',op),
    findPending:item=>[...scope.operations.values()].some(({kind,value})=>{
      if(kind==='stock-close') return stockCloseIsPending(value)&&stockTaskKey(value)===stockTaskKey(item);
      return kind==='stock' && !['verified','not_saved'].includes(value?.status) && value?.destination===item.destination &&
        value.steps?.some(step=>step.department===item.department && step.plan?.sheetId===item.sheetId &&
          step.plan.entries?.some(row=>row.row===item.row || stockArticleKey(row.article)===stockArticleKey(item.article)));
    }),
  };
}

export function stockCloseBatchInput(input) {
  const invalid=()=>new CloudError('stock_close_invalid','Не подтверждён список для завершения.',400);
  if(!Array.isArray(input?.items)||!input.items.length||input.items.length>stockCloseBatchSize)throw invalid();
  const items=input.items.map(item=>{
    const source=parseReadyStockId(item?.entryId);
    if(!source||typeof item.operationId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.operationId))throw invalid();
    return {entryId:item.entryId,operationId:item.operationId,source};
  });
  if(new Set(items.map(x=>x.operationId)).size!==items.length ||
     new Set(items.map(x=>stockSourceKey(x.source)+':'+x.source.row)).size!==items.length)throw invalid();
  return items;
}

export async function closeStockBatch({items,records,readSnapshot,readRollHistory,archive,verifyArchives,checkpoint,manager,now=Date.now}) {
  const results=new Map(), fresh=[];
  for(const item of items) {
    const prior=records.get(item.operationId);
    if(prior) {
      if(prior.entryId!==item.entryId)throw new CloudError('stock_close_conflict','Номер операции уже используется.',409);
      results.set(prior.id,prior);
    } else fresh.push(item);
  }
  const snapshots=new Map();
  let rollHistory;
  const plans=await Promise.all(fresh.map(async ({entryId,operationId,source})=>{
    try {
      const key=stockSourceKey(source);
      if(!snapshots.has(key))snapshots.set(key,readSnapshot(source));
      if(source.department==='roll')rollHistory??=readRollHistory().then(value=>({value}),error=>({error}));
      const snapshot=await snapshots.get(key);
      const entry=resolveReadyStockEntry(entryId,source,snapshot);
      if(records.findPending(entry))throw new Error('Предыдущая операция по этой позиции ожидает сверки.');
      const current=snapshot.rows.find(row=>row.row===entry.row);
      const history=source.department==='roll'?await rollHistory:null;
      if(history?.error)throw history.error;
      const plan=stockClosePlan({entry,snapshot,readiness:stockTaskReadiness(entry,current,snapshot,history?.value)});
      return {id:operationId,entryId,...plan,closedBy:manager,status:'writing',createdAt:new Date(now()).toISOString()};
    } catch(error) {
      results.set(operationId,{id:operationId,status:'not_saved',message:error.message||'Не удалось проверить позицию.'});
      return null;
    }
  }));
  const writing=plans.filter(Boolean);
  for(const op of writing)records.put(op);
  if(writing.length)await checkpoint();

  // Each workbook has its own Apps Script lock. Settle both deliveries before
  // advancing the shared D1 checkpoint.
  await Promise.all(['roll','box'].map(async department=>{
    const group=writing.filter(item=>item.department===department);
    if(!group.length)return;
    let reply;
    try {reply=await archive(department,group.map(({id,sheetId,row,uid,article,quantity,destination})=>({
      operationId:id,sheetId,row,uid,article,quantity,destination,
    })));} catch { /* the gateway may already have written */ }
    const receipts=new Map();
    for(const receipt of Array.isArray(reply?.results)?reply.results:[]) {
      if(receipt?.operationId)receipts.set(receipt.operationId,receipts.has(receipt.operationId)?null:receipt);
    }
    for(const op of group) {
      const receipt=receipts.get(op.id);
      if(receipt?.uid===op.uid && receipt.status==='verified' && Number.isFinite(Date.parse(receipt.closedAt))) {
        results.set(op.id,{...op,status:'verified',closedAt:receipt.closedAt});
      } else if(receipt?.uid===op.uid && receipt.status==='not_saved') {
        results.set(op.id,{...op,status:'not_saved',message:receipt.message||'Позиция изменилась.'});
      } else results.set(op.id,{...op,status:'uncertain',message:'Завершение требует сверки.'});
    }
  }));
  // Save acknowledged rows before waiting for any readback.
  for(const op of writing)records.put(results.get(op.id));
  if(writing.length)await checkpoint();
  const recovered=(await Promise.all(['roll','box'].map(async department=>{
    const group=[...results.values()].filter(op=>op.department===department&&stockCloseIsPending(op));
    if(!group.length)return [];
    const proofs=await verifyArchives(department,group).catch(()=>new Map());
    return group.flatMap(op=>{
      const proof=proofs.get(op.id);
      return proof&&Number.isFinite(Date.parse(proof.closedAt))?[{...op,status:'verified',closedAt:proof.closedAt,message:undefined}]:[];
    });
  }))).flat();
  for(const op of recovered) {records.put(op);results.set(op.id,op);}
  if(recovered.length)await checkpoint();
  return items.map(({operationId})=>results.get(operationId));
}

export function runStockCloseBatch(items,{scope,services,bindings,manager}) {
  const document=department=>sourceId(bindings,department==='box'?'stockBoxPrintingId':'stockRollPrintingId');
  const adapters=services.stock().adapters;
  return closeStockBatch({
    items,records:stockCloseRecords(scope),manager,
    checkpoint:()=>services.guard(),
    readSnapshot:source=>readStockSnapshot(services.reader,document(source.department),source.destination),
    readRollHistory:()=>readRollStockHistory(services.reader,document('roll')),
    archive:(department,plans)=>adapters[department].writer.closeStockBatch(plans),
    verifyArchives:(department,operations)=>verifyArchivedStockCloses(services.reader,document(department),operations),
  });
}
