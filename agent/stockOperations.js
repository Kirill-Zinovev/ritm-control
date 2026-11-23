import { createHash } from 'node:crypto';
import { applyStockRounding, planStockAddition } from './stockPlanning.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (code,message,status=409) => Object.assign(new Error(message),{code,status});

// Domain coordinator: adapters own preflight, a single bounded write, and
// readback. A checkpoint must persist before any external request is sent.
export class StockOperations {
  constructor({store, adapters, catalog, checkpoint, manager}) {
    if(!store||!adapters?.roll||!adapters?.box||!catalog||!checkpoint)throw new TypeError('Stock operations require durable storage and both source adapters');
    Object.assign(this,{store,adapters,catalog,checkpoint,manager});
  }
  async preview(input) {
    const [catalog,box,roll]=await Promise.all([this.catalog(input.lines),this.adapters.box.read(input.destination),this.adapters.roll.read(input.destination)]);
    return planStockAddition({...input,catalog,existing:{box,roll}});
  }
  async reconcile(operation) {
    if (!['uncertain','pending'].includes(operation.status) || !operation.steps?.length ||
        !operation.steps.every(step=>['uncertain','checking','verified','writing'].includes(step.status))) return false;
    let confirmed=false;
    try { confirmed=(await Promise.all(operation.steps.map(step=>this.adapters[step.department].verify(step.plan)))).every(Boolean); }
    catch { return false; }
    if (!confirmed) return false;
    operation.steps.forEach(step=>{step.status='verified';});
    operation.status='verified';delete operation.message;
    this.store.put(operation);await this.checkpoint();
    return true;
  }
  async saveUncertain(operation, message) {
    operation.status='uncertain';operation.message=message;
    this.store.put(operation);await this.checkpoint();
  }
  async writeStep(operation,step,{previouslyAttempted=false}={}) {
    step.status='writing';this.store.put(operation);await this.checkpoint();
    try {
      await this.adapters[step.department].write(step.plan,operation.id);
      step.status='checking';this.store.put(operation);await this.checkpoint();
      if(!await this.adapters[step.department].verify(step.plan))throw new Error('Результат не подтверждён.');
      step.status='verified';this.store.put(operation);await this.checkpoint();
      return true;
    } catch(error) {
      if(error?.beforeExternalWrite){
        if(!previouslyAttempted && !operation.steps.some(item=>item.status==='verified')){
          step.status='not_saved';operation.status='not_saved';operation.message='Изменения не отправлены. Обновите список и проверьте его заново.';
          this.store.put(operation);await this.checkpoint();return false;
        }
        // A preflight failure is known not to have reached the gateway. Keep
        // the already verified department and this original request together.
        // A prior timed-out call can still be in flight even if a later
        // dry-run found no receipt, so it must remain uncertain in that case.
        step.status=previouslyAttempted?'uncertain':'prepared';
        await this.saveUncertain(operation,previouslyAttempted
          ?'Исходный запрос всё ещё требует сверки. Повторное добавление заблокировано.'
          :'Часть списка уже сохранена. Оставшаяся часть не отправлена: данные изменились или не удалось завершить проверку. Повторное добавление всего списка заблокировано.');
        return false;
      }
      if(step.plan?.entries?.every(entry=>entry.action==='insert' && entry.uid)){
        let confirmed=false;
        try { confirmed=await this.adapters[step.department].verify(step.plan); } catch { /* remain uncertain */ }
        if(confirmed){step.status='verified';this.store.put(operation);await this.checkpoint();return true;}
      }
      step.status='uncertain';
      await this.saveUncertain(operation,'Запись требует сверки; повторное увеличение заблокировано.');
      return false;
    }
  }
  async resume(operation) {
    if(!['pending','uncertain'].includes(operation.status)||!operation.steps?.length)return;
    for(const step of operation.steps){
      if(step.status==='verified')continue;
      if(step.status==='prepared'){
        // The durable checkpoint precedes every gateway call: prepared means
        // this department has not been dispatched, even after a worker crash.
        if(!await this.writeStep(operation,step))return;
        continue;
      }
      if(!['writing','checking','uncertain'].includes(step.status))return;
      let receipt=null;
      try { receipt=await this.adapters[step.department].inspect?.(step.plan,operation.id); } catch { /* keep original request pending */ }
      if(receipt?.status==='validated'){
        // Under the document lock the gateway found no receipt and validated
        // the original before-values. The same ID remains idempotent if an
        // earlier network request arrives while this retry is in flight.
        if(!await this.writeStep(operation,step,{previouslyAttempted:true}))return;
        continue;
      }
      if(receipt?.status==='verified'||step.plan?.entries?.every(entry=>entry.action==='insert' && entry.uid)){
        let confirmed=false;
        try { confirmed=await this.adapters[step.department].verify(step.plan); } catch { /* leave uncertain */ }
        if(confirmed){step.status='verified';this.store.put(operation);await this.checkpoint();continue;}
      }
      await this.saveUncertain(operation,'Не удалось подтвердить предыдущую запись. Список сохранён для сверки; повторное добавление заблокировано.');
      return;
    }
    operation.status='verified';delete operation.message;
    this.store.put(operation);await this.checkpoint();
  }
  async execute({operationId,input,expectedFingerprint}) {
    if(!/^[a-f0-9-]{36}$/i.test(String(operationId||'')))throw failure('stock_operation_invalid','Не подтверждён идентификатор операции.',400);
    const requestHash=hash({input,expectedFingerprint});
    const previous=this.store.get(operationId);
    if(previous){
      if(previous.requestHash!==requestHash)throw failure('stock_operation_conflict','Этот номер операции уже использован для другого списка.');
      await this.resume(previous);
      return previous;
    }
    for (const pending of this.store.pending?.() || []) {
      // New sessions can reconcile only inserts with their unique source UID.
      // Ambiguous increases and unstarted departments remain guarded.
      if (!pending.steps?.every(step=>step.plan?.entries?.length && step.plan.entries.every(entry=>entry.action==='insert' && entry.uid)) || !await this.reconcile(pending))
        throw failure('stock_operation_pending','Предыдущая операция запасов ещё не подтверждена. Сначала необходимо сверить её результат.');
      const articles=new Set(pending.steps.flatMap(step=>step.plan.entries.map(entry=>String(entry.article).trim().toUpperCase())));
      if ((input?.lines||[]).some(line=>articles.has(String(line.article||'').trim().toUpperCase())))
        throw failure('stock_previous_confirmed','Предыдущая запись этих артикулов найдена в таблице. Проверьте план заново, прежде чем добавлять ещё.');
    }
    const preview=await this.preview(input);
    if(preview.fingerprint!==expectedFingerprint)throw failure('stock_preview_changed','Состав или планы изменились. Проверьте список ещё раз.');
    const confirmed=applyStockRounding(preview.changes,input.rounding);
    const accepted=confirmed.filter(change=>change.action!=='skip');
    if(!accepted.length)throw failure('stock_no_confirmed_articles','Нет артикулов с подтверждённым участком.');
    const steps=[];
    // Prepare every destination before changing either of them.
    for(const department of ['roll','box']){
      const changes=accepted.filter(change=>change.department===department);
      if(changes.length)steps.push({department,status:'prepared',plan:await this.adapters[department].prepare(input.destination,changes)});
    }
    const op={id:operationId,createdAt:new Date().toISOString(),manager:this.manager || null,requestHash,status:'pending',destination:input.destination,steps,skipped:confirmed.filter(change=>change.action==='skip')};
    this.store.put(op);await this.checkpoint();
    for(const step of steps)if(!await this.writeStep(op,step))return op;
    op.status='verified';this.store.put(op);await this.checkpoint();return op;
  }
}
