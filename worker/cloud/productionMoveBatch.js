import {createHash} from 'node:crypto';
import {CloudError} from './access.js';
import {executeProductionMove,cancelProductionMove,reconcileProductionMoveBlocker} from './productionMove.js';

export const MOVE_BATCH_KIND = 'production-department-move-batch';
const CHILD_KIND = 'production-department-move';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const fail = message => {throw new CloudError('move_batch_invalid', message, 400);};

function validate(input) {
  if (!input || Object.keys(input).sort().join() !== 'items,operationId' || !uuid(input.operationId) ||
      !Array.isArray(input.items) || !input.items.length || input.items.length > 500)
    fail('Выберите от 1 до 500 позиций одной поставки.');
  const ids = new Set([input.operationId]), positions = new Set(), articles = new Set();
  const first = input.items[0];
  for (const item of input.items) {
    if (!item || Object.keys(item).sort().join() !== 'article,extension,machine,operationId,quantity,shipmentId,sourceDepartment,uid' ||
        !uuid(item.operationId) || !['box','roll'].includes(item.sourceDepartment) ||
        !['shipmentId','uid','article','machine','extension'].every(k => typeof item[k] === 'string' && item[k].trim() && item[k].length <= 300) ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
        item.shipmentId !== first.shipmentId || item.sourceDepartment !== first.sourceDepartment)
      fail('Для массового переноса нужны точные позиции одного исходного участка и одной поставки.');
    const article = item.article.trim().toUpperCase().replace(/\(OZ\)$/u, '');
    if (ids.has(item.operationId) || positions.has(item.uid) || articles.has(article)) fail('В выбранном составе есть повторяющиеся позиции.');
    ids.add(item.operationId); positions.add(item.uid); articles.add(article);
  }
}

const finished = row => ['verified','skipped','cancelled'].includes(row.status);
function settleGroup(batch,scope) {
  if(!batch.group)return false;
  const child=scope.operations.get(CHILD_KIND+':'+batch.group.input.operationId)?.value;
  if(!child||!['verified','cancelled'].includes(child.status))return false;
  for(const row of batch.results.filter(r=>batch.group.ids.includes(r.id))){row.status=child.status;row.message=child.status==='verified'?'Перенесён':'Отменён';}
  delete batch.group;return true;
}

export function publicMoveBatch(batch) {
  if (!batch) return null;
  return {id:batch.id, status:batch.status, input:batch.input, results:batch.results, updatedAt:batch.updatedAt,blocker:batch.blocker||null};
}

export function lookupMoveBatch(scope, params) {
  const id = params.get('id');
  if (id) return publicMoveBatch(scope.operations.get(MOVE_BATCH_KIND + ':' + id)?.value);
  const matches = [...scope.operations.values()].filter(row => row.kind === MOVE_BATCH_KIND &&
    row.value.input.items[0].shipmentId === params.get('shipmentId') &&
    row.value.input.items[0].sourceDepartment === params.get('sourceDepartment') && row.value.status !== 'complete');
  if (matches.length > 1) throw new CloudError('move_batch_ambiguous', 'Сохранено несколько списков переноса. Нужна сверка их состояния.', 409);
  return publicMoveBatch(matches[0]?.value);
}

export async function cancelMoveBatch(id, context, cancel = cancelProductionMove) {
  const {scope} = context;
  if (!uuid(id) || !scope.lease) fail('Не подтверждён список для отмены.');
  const batch = structuredClone(scope.operations.get(MOVE_BATCH_KIND + ':' + id)?.value);
  if (!batch) throw new CloudError('move_batch_missing','Список переноса не найден.',404);
  if (batch.status === 'complete') return publicMoveBatch(batch);
  settleGroup(batch,scope);
  if(batch.group){
    const group=batch.group,child=scope.operations.get(CHILD_KIND+':'+group.input.operationId)?.value;
    if(child&&child.status!=='cancelled')await cancel(child.id,context);
    for(const row of batch.results.filter(r=>group.ids.includes(r.id))){row.status='cancelled';row.message='Оставшаяся позиция отменена.';}
    delete batch.group;
  }
  for (const row of batch.results) {
    if (['verified','skipped','cancelled'].includes(row.status)) continue;
    const child = scope.operations.get(CHILD_KIND + ':' + row.id)?.value;
    if (child?.status === 'verified') {row.status='verified'; row.message='Перенесён'; continue;}
    // Existing cancellation only releases a source when copying has not begun.
    // An ambiguous destination is retained for reconciliation, never discarded.
    if (child && child.status !== 'cancelled') await cancel(row.id,context);
    row.status='cancelled'; row.message='Не переносился. Оставшаяся позиция отменена.';
  }
  batch.status='complete'; batch.updatedAt=new Date().toISOString();
  scope.putOperation(MOVE_BATCH_KIND,batch); await scope.checkpoint();
  return publicMoveBatch(batch);
}

// A bounded group shares preflight and the exact freeze/copy/readback/remove
// protocol. The saved group is immutable across retries and deploys.
export async function advanceMoveBatch(input, context, execute = executeProductionMove, reconcile = reconcileProductionMoveBlocker) {
  validate(input);
  const {scope} = context;
  if (!scope.lease) throw new CloudError('lease_required', 'Массовый перенос должен получить блокировку.', 409);
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  let batch = structuredClone(scope.operations.get(MOVE_BATCH_KIND + ':' + input.operationId)?.value);
  if (batch && batch.fingerprint !== fingerprint) throw new CloudError('move_batch_conflict', 'Этот ID уже занят другим списком переноса.', 409);
  if (batch?.status === 'complete') return publicMoveBatch(batch);
  if (!batch) {
    const other = lookupMoveBatch(scope, new URLSearchParams({shipmentId:input.items[0].shipmentId,sourceDepartment:input.items[0].sourceDepartment}));
    if (other) throw new CloudError('move_batch_pending', 'Сначала продолжите сохранённый массовый перенос.', 409);
    // A batch must not adopt an operation that was already owned by a different request.
    if (input.items.some(item => scope.operations.has(CHILD_KIND + ':' + item.operationId)))
      throw new CloudError('move_batch_conflict', 'ID позиции уже используется в другом переносе.', 409);
    batch = {id:input.operationId, fingerprint, input:structuredClone(input), status:'running',
      results:input.items.map(item => ({id:item.operationId, article:item.article, quantity:item.quantity, status:'pending', message:''}))};
  }
  settleGroup(batch,scope);
  async function save() {
    batch.updatedAt = new Date().toISOString();
    scope.putOperation(MOVE_BATCH_KIND, batch);
    await scope.checkpoint();
  }
  await save();
  const index = batch.results.findIndex(row => !finished(row));
  if (index !== -1) {
    const row = batch.results[index], item = batch.input.items[index];
    const blocker = await reconcile(batch.group?.input||item,context);
    if(blocker){
      batch.blocker=blocker;
      // A previous move is separate from the newly selected article. Its
      // reconciliation must not be shown as started work on the first row.
      if(!scope.operations.has(CHILD_KIND+':'+item.operationId)){row.status='pending';row.message='';}
      batch.status=['verified','cancelled'].includes(blocker.status)?'running':'checking';
      await save();return publicMoveBatch(batch);
    }
    batch.blocker=null;
    if(!batch.group&&context.groupSize>1&&!scope.operations.has(CHILD_KIND+':'+item.operationId)){
      const candidates=batch.input.items.filter((candidate,i)=>!finished(batch.results[i])&&batch.results[i].status==='pending'&&!scope.operations.has(CHILD_KIND+':'+candidate.operationId)).slice(0,Math.min(10,context.groupSize));
      if(candidates.length>1){batch.group={ids:candidates.map(p=>p.operationId),input:{...candidates[0],items:candidates}};await save();}
    }
    const request=batch.group?.input||item,ids=batch.group?.ids||[item.operationId];
    try {
      const child = await execute(request, context);
      for(const member of batch.results.filter(r=>ids.includes(r.id))){
        member.status = child.status === 'cancelled' ? 'cancelled' : child.status === 'verified' ? 'verified' : 'checking';
        member.message = child.message || (member.status === 'verified' ? 'Перенесён' : member.status === 'cancelled' ? 'Отменён' : 'Результат пакета проверяется. Продолжение использует тот же ID.');
      }
      if(['verified','cancelled'].includes(child.status))delete batch.group;
    } catch (error) {
      // Preflight rejection without a durable child means no write was sent.
      // Unknown errors and any existing child must remain resumable, never skipped.
      const child = scope.operations.get(CHILD_KIND + ':' + request.operationId)?.value;
      const reject=!child&&['production_move_conflict','roll_supply_article_exists'].includes(error.code);
      const failed=batch.results.find(r=>r.id===(error.itemOperationId||request.operationId));
      for(const member of batch.results.filter(r=>ids.includes(r.id))){member.status=reject?(member===failed?'skipped':'pending'):'checking';member.message=reject&&member!==failed?'':error.message||'Не удалось подтвердить перенос. Продолжите проверку.';}
      if(reject)delete batch.group;
    }
    batch.status = batch.results.some(r=>r.status==='checking') ? 'checking' : 'running';
  }
  if (batch.results.every(row => ['verified','skipped','cancelled'].includes(row.status))) batch.status = 'complete';
  await save();
  return publicMoveBatch(batch);
}
