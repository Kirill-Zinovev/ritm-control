import {stockClosePlan} from './stockClosePlan.js';

// The caller serializes this coordinator with ordinary stock writes and
// persists checkpoints before an external action. An uncertain remote result
// must never be replayed as a new close operation.
export async function closeStockTask({operationId,entry,store,checkpoint,readSnapshot,readiness,archive,verifyArchive,manager=null,now=Date.now}) {
  if(!/^[a-f0-9-]{36}$/i.test(String(operationId||''))) throw new Error('Не подтверждён номер операции.');
  const prior=store.get(operationId);
  if(prior){
    if(prior.entryId!==entry?.id)throw new Error('Номер операции уже используется.');
    if(['uncertain','writing'].includes(prior.status) && verifyArchive) {
      let proof=null; try { proof=await verifyArchive(prior); } catch { /* keep uncertain */ }
      if(proof && Number.isFinite(Date.parse(proof.closedAt))) { prior.status='verified'; prior.closedAt=proof.closedAt; delete prior.message; store.put(prior); await checkpoint(); }
    }
    return prior;
  }
  if(store.findPending(entry))throw new Error('Предыдущее закрытие ожидает проверки.');
  const snapshot=await readSnapshot(entry);
  const state=await readiness(entry,snapshot);
  const plan=stockClosePlan({entry,snapshot,readiness:state});
  const op={id:operationId,entryId:entry.id,...plan,closedBy:manager,status:'writing',createdAt:new Date(now()).toISOString()};
  store.put(op);await checkpoint();
  try {
    const result=await archive({...plan,operationId});
    if(result?.status!=='verified' || result.uid!==plan.uid) throw new Error('Результат архивации не подтверждён.');
    op.status='verified';op.closedAt=result.closedAt;
    if(!Number.isFinite(Date.parse(op.closedAt)))throw new Error('Дата закрытия не подтверждена.');
  } catch {
    op.status='uncertain';op.message='Результат закрытия требует сверки; не повторяйте операцию.';
    if (verifyArchive) { try { const proof=await verifyArchive(op); if(proof && Number.isFinite(Date.parse(proof.closedAt))) {op.status='verified';op.closedAt=proof.closedAt;delete op.message;} } catch { /* keep uncertain */ } }
  }
  store.put(op);await checkpoint();return op;
}
