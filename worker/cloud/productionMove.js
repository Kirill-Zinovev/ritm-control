import {prepareDepartmentMove,prepareDepartmentMoveGroup} from '../../agent/departmentMovePlan.js';
import {runDepartmentMove} from '../../agent/departmentMove.js';
import {supplyManifestRequests} from '../../agent/rollSupply.js';
import {createDepartmentMoveGateway} from './departmentMoveGateway.js';
import {sourceId} from './config.js';
import {CloudError} from './access.js';
import {createMoveReadSession} from './productionMoveReads.js';
import {boxRemovalOverlaps, pendingBoxRemoval} from './boxPositionRemoval.js';
const KIND='production-department-move';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function productionMoveParts(input,{scope,services}){
 // Compare physical sheet IDs: different shipment IDs may alias the same
 // sheets, so an unproven relationship must keep the conservative block.
 const registered=(scope.meta?.('productionSupplies')||[]).find(s=>s.id===input.shipmentId);
 const linkMatch=/^RITM-ROLL-(\d+)$/.exec(input.shipmentId||'');
 const links=linkMatch?(services?.transfer?.links()||[]).filter(l=>l.targetRollSheetId===Number(linkMatch[1])):[];
 return registered?.parts || (links.length===1?[{department:'roll',sheetId:Number(linkMatch[1])},{department:'box',sheetId:links[0].boxSheetId}]:[]);
}
export function findProductionMoveBlocker(input,context){
 const {scope}=context,incomingParts=productionMoveParts(input,context);
 const sheetFor=(items,department)=>items.find(p=>p.department===department)?.sheetId;
 return [...scope.operations.values()].find(r=>{
  if(r.kind!==KIND||r.value.id===input.operationId||['verified','cancelled'].includes(r.value.status))return false;
  const proof=r.value.proof?.plan?.proof;
  if(!proof?.box?.sheetId||!proof?.roll?.sheetId||!sheetFor(incomingParts,'box')||!sheetFor(incomingParts,'roll'))return true;
  return proof.box.sheetId===sheetFor(incomingParts,'box')||proof.roll.sheetId===sheetFor(incomingParts,'roll');
 })?.value || null;
}

export function productionMoveSummary(op){
 const p=op.proof?.plan;
 return {id:op.id,status:op.status,input:op.input,message:op.message||null,steps:op.steps,
  shipmentName:p?.proof?.shipment?.name||null,failedStep:op.failedStep||null,destinationAttemptAt:op.destinationAttemptAt||null,
  source:p?{department:p.proof.from||op.input?.sourceDepartment||'box',sheetId:p.proof[op.input?.sourceDepartment||'box']?.sheetId,row:p.proof.source?.row,uid:p.proof.source?.uid,quantity:p.proof.source?.quantity}:null,
  destination:p?{sheetId:p.destination?.sheetId,row:p.destination?.startRow,uids:p.destination?.uids,preserveExistingRows:p.destination?.preserveExistingRows===true}:null};
}

export async function reconcileProductionMoveBlocker(input,context){
 const pending=findProductionMoveBlocker(input,context);
 if(!pending)return null;
 if(!pending.input || pending.input.operationId!==pending.id || !pending.fingerprint)
  return {id:pending.id,article:pending.input?.article||'',status:'checking',message:'Не подтверждены исходные параметры прежнего переноса. Автоматическая запись остановлена.'};
 const parts=productionMoveParts(input,context),proof=pending.proof?.plan?.proof;
 const related=pending.input.shipmentId===input.shipmentId||['box','roll'].some(department=>{
  const sheet=parts.find(part=>part.department===department)?.sheetId;
  return Number.isSafeInteger(sheet)&&sheet>0&&sheet===proof?.[department]?.sheetId;
 });
 if(!related)return {id:pending.id,article:pending.input.article,status:'checking',message:'Не удалось подтвердить связь прежнего переноса с выбранной поставкой. Его автоматическое изменение остановлено.'};
 try{
  // Resume the original approved operation, never construct another ID or
  // infer success from the mere presence of the same SKU in another job.
  const op=await executeProductionMove(pending.input,context);
  return {id:op.id,article:op.input.article,status:op.status,message:op.message||null};
 }catch(error){return {id:pending.id,article:pending.input.article,status:'checking',message:error.message||'Не удалось сверить прежний перенос.'};}
}

// Service reconciliation may acknowledge an already physically completed move,
// but it cannot copy goods or clear a source row. Only the original operation
// and authoritative receipts can release its durable checkpoint.
export async function finalizeConfirmedProductionMove(id,context){
 const op=context.scope.operations.get(KIND+':'+id)?.value;
 if(!context.scope.lease||!op)throw new CloudError('move_missing','Перенос не найден.',409);
 if(op.status==='verified'||op.status==='cancelled')return op;
 if(op.input?.operationId!==id||!op.fingerprint||!op.proof?.plan||op.steps?.freeze!=='verified'||op.steps?.destination!=='verified'||!['writing','uncertain','verified'].includes(op.steps?.source))
  throw new CloudError('move_receipts_required','Перенос ещё не подтверждён обоими участками. Автоматическое завершение остановлено.',409);
 return executeProductionMove(op.input,{...context,receiptsOnly:true});
}

export async function executeProductionMove(input,{bindings,scope,services,fetcher=fetch,receiptsOnly=false}){
 if(!scope.lease)throw new CloudError('lease_required','Перенос должен получить блокировку.',409);
 const existing=scope.operations.get(KIND+':'+input.operationId)?.value;
 if (pendingBoxRemoval(scope)) {
  const from = input.sourceDepartment || 'box';
  const sheet = productionMoveParts(input,{scope,services}).find(part => part.department === from);
  if (boxRemovalOverlaps(scope,sheet?.sheetId,from))
   throw new CloudError('box_remove_pending','Сначала завершите проверку удаления в этой поставке.',409);
 }
 const pending=findProductionMoveBlocker(input,{scope,services});
 if(pending)throw new CloudError('move_pending','В этой поставке не завершён перенос '+(pending.input?.article||'артикула')+'. Сначала проверьте его состояние.',409);
 const from=input.sourceDepartment||'box',to=from==='box'?'roll':'box';
 const reads=createMoveReadSession(services.production.writers),writers=reads.writers;
 const gateway=createDepartmentMoveGateway({url:bindings[from==='box'?'RITM_BOX_MOVE_GATEWAY_URL':'RITM_ROLL_MOVE_GATEWAY_URL'],token:bindings.RITM_BOX_MOVE_GATEWAY_TOKEN,fetcher,beforeWrite:action=>{if(action!=='health')reads.stop();return services.guard(writers[from].documentId);}});
 if(input.items?.length>1&&!existing){const health=await gateway('health',{});if(!health.capabilities?.includes('move-group-v1'))throw new CloudError('move_group_unavailable','Скрипт участка ещё не подтвердил пакетный перенос.',503);}
 let plan=existing?.proof?.plan;
 let lockAcknowledged=false,removalAcknowledged=false;
 const position=()=>({operationId:input.operationId,sheetId:plan.proof[from].sheetId,row:plan.proof.source.row,uid:plan.proof.source.uid,article:plan.proof.source.article,quantity:input.quantity,...(plan.proof.sources?{positions:plan.proof.sources.map(p=>({row:p.row,uid:p.uid,article:p.article,quantity:p.quantity}))}:{})});
 async function journal(){
  const id=sourceId(bindings,'boxJournalId'),meta=await services.reader.metadata(id);
  const sh=meta.sheets.find(s=>s.properties?.title==='Журнал');const n=sh?.properties?.gridProperties?.rowCount;
  if(!Number.isSafeInteger(n)||n<1||n>50000)throw new Error('Не подтверждён журнал бокса.');
  // Movement checks need the document, sheet and article in E/F/H only.
  // Keep the whole journal's row coverage, without downloading 16 unused columns.
  const grid=await services.reader.grid(id,[`'Журнал'!A1:H${n}`]);
  const data=grid.sheets?.find(s=>s.properties.sheetId===sh.properties.sheetId)?.data?.[0];
  if(!data||data.startRow||data.startColumn)throw new Error('Не подтверждены данные журнала.');
  return (data.rowData||[]).slice(1).map(r=>(r.values||[]).map(c=>c?.effectiveValue?.stringValue??c?.effectiveValue?.numberValue??''));
 }
 async function manifestWrite(part,value){const writer=writers[part.department];await writer.request(`https://sheets.googleapis.com/v4/spreadsheets/${writer.documentId}:batchUpdate`,{method:'POST',write:true,body:{requests:value===null?supplyManifestRequests(part.sheetId,value).slice(0,1):supplyManifestRequests(part.sheetId,value)}});}
 const parts=()=>[plan.proof.box,plan.proof.roll].map((p,i)=>({...p,department:i===0?'box':'roll'}));
 async function setManifests(value){
  const targets=parts();
  const manifests=await Promise.all(targets.map(part=>writers[part.department].manifest(part.sheetId)));
  for(const current of manifests)
    if(!same(current,value)&&!(plan.proof.legacy&&current===null)&&!same(current,plan.proof.manifest)&&!same(current,frozen()))
      throw new CloudError('move_manifest_changed','Связь поставки изменилась; требуется сверка.',409);
  for(const [index,part] of targets.entries())
    if(!same(manifests[index],value))await manifestWrite(part,value);
 }
 const frozen=()=>({...plan.proof.manifest,revision:input.operationId,ready:false});
 const published=()=>({...frozen(),ready:true});
 async function lockSource(){const r=await gateway('lock',position());lockAcknowledged=r.locked===true||r.status==='locked';}
 async function removeSource(){const r=await gateway('remove',position());if(r.status!=='removed')throw new Error('Исходная позиция не удалена.');removalAcknowledged=true;}
 async function publish(){
  await setManifests(published());
  if(plan.proof.legacy){const supplies=scope.meta('productionSupplies')||[];const existing=supplies.find(s=>s.id===input.shipmentId);if(existing&&!same(existing,plan.proof.shipment))throw new CloudError('move_registry_changed','Связь старой поставки изменилась.',409);scope.meta('productionSupplies',[...supplies.filter(s=>s.id!==input.shipmentId),plan.proof.shipment]);await scope.checkpoint();}
 }
 async function legacyComposition(supply){
  const id=sourceId(bindings,'assemblyDatabaseId'),meta=await services.reader.metadata(id),matches=meta.sheets.filter(s=>s.properties.title===supply.name&&!s.properties.hidden);
  const sh=matches[0],count=sh?.properties.gridProperties?.rowCount;
  if(matches.length!==1||!Number.isSafeInteger(count)||count>4096)throw new Error('Не подтверждён лист Assembly.');
  const grid=await services.reader.grid(id,["'"+supply.name.replace(/'/g,"''")+"'!A1:X"+count]);const data=grid.sheets?.find(s=>s.properties.sheetId===sh.properties.sheetId)?.data?.[0];
  if(!data||data.startRow||data.startColumn)throw new Error('Не подтверждён состав Assembly.');
  return (data.rowData||[]).slice(1).map(r=>(r.values||[]).map(c=>c?.effectiveValue?.stringValue??c?.effectiveValue?.numberValue??''));
 }
 const coordinator={
  freeze:async()=>{await lockSource();await setManifests(frozen());},
  isFrozen:async()=>(lockAcknowledged||(await gateway('status',position())).status==='locked')&&(await Promise.all(parts().map(p=>writers[p.department].manifest(p.sheetId)))).every(m=>same(m,frozen())),
  recoverFreeze:async()=>{await lockSource();await setManifests(frozen());},
  publish,
  recoverPublish:publish,
  verifyPublished:async()=>(await Promise.all(parts().map(p=>writers[p.department].manifest(p.sheetId)))).every(m=>same(m,published()))&&(!plan.proof.legacy||(scope.meta('productionSupplies')||[]).some(s=>same(s,plan.proof.shipment))),
 };
 const source={
  inspect:async()=>{plan=await (input.items?.length>1?prepareDepartmentMoveGroup:prepareDepartmentMove)({input,writers,registry:scope.meta('productionSupplies')||[],readBoxJournal:journal,legacyLinks:services.transfer?.links()||[],readLegacyComposition:legacyComposition});return {uid:input.uid,article:input.article,quantity:input.quantity,department:from,workConfirmed:true,hasWork:false,plan};},
  // The gateway's row lock is durable and every employee save respects it.
  // In this request it remains owned until remove/abort under the cloud lease;
  // remove also checks the original inputs and absence of work atomically.
  // Resumed requests have no acknowledgement and must query the gateway.
  verifyUnstarted:async()=>lockAcknowledged||(await gateway('status',position())).status==='locked',
  remove:removeSource,
  // The signed gateway returns 'removed' only after flushing and reading back
  // the cleared inputs. Reuse that receipt only in this invocation; a lost
  // response or a resumed request must query the durable receipt again.
  verifyRemoved:async()=>removalAcknowledged||(await gateway('status',position())).status==='removed',
  recoverRemove:removeSource,
 };
 const destination={
  exists:async()=>false,
  write:async()=>{
   if(plan.destination.preserveExistingRows===true && typeof writers[to].verifyAbsentMoveDestination==='function'){
    try{await writers[to].verifyAbsentMoveDestination(plan.destination);}
    catch(error){error.beforeExternalWrite=true;throw error;}
   }
   plan.destination.manifest=frozen();await writers[to].execute(plan.destination);
  },
  verify:async()=>{try{await writers[to].verify(plan.destination);return true;}catch{return false;}},
  recoverAbsent:async(op,beforeRetry)=>{
   // Box writes are guarded by its worklog and can be rechecked below. Roll
   // journal recovery needs its own authoritative check and stays fail-closed.
   if(from!=='box')return;
   // An old client may have lost the response to a still-running Sheets
   // request. Wait beyond Sheets' processing limit before proving absence.
   let lastAttempt=Number(op.destinationAttemptAt)||0;
   if(!lastAttempt){
    const db=scope.store?.db;
    if(!db?.prepare)return;
    const audit=await db.prepare("SELECT MAX(at) AS last_at FROM cloud_audit WHERE type=? AND instr(message,?)>0").bind('manager_supply_write','/api/production-moves '+op.id).first();
    lastAttempt=Number(audit?.last_at)||0;
   }
   if(!lastAttempt || lastAttempt>Date.now() || Date.now()-lastAttempt<240000)return;
   if(!await source.verifyUnstarted(op))throw new Error('Не подтверждена блокировка исходной позиции.');
   const part=plan.proof[from],original=plan.proof.source;
   const meta=(await writers[from].metadata()).find(s=>s.sheetId===part.sheetId&&s.title===(part.name||plan.proof.shipment.name)&&!s.hidden);
   if(!meta||meta.gridProperties?.rowCount<Math.max(...(plan.proof.sources||[original]).map(s=>s.row)))throw new Error('Исходный лист изменился. Восстановление остановлено.');
   const sourceGrid=await writers[from].grid(meta.title,meta.gridProperties.rowCount),block=sourceGrid.data?.[0];
   if(!block||(block.startColumn||0)!==0)throw new Error('Исходная строка недоступна.');
   for(const source of plan.proof.sources||[original]){const cells=block.rowData?.[source.row-1-(block.startRow||0)]?.values;
    if(!cells||source.cells.some((cell,i)=>!same(cell?.userEnteredValue||null,cells[i]?.userEnteredValue||null)))throw new Error('Исходная строка изменилась. Восстановление остановлено.');}
   const work=await journal();
   if(work.some(row=>String(row[4])===String(writers[from].documentId)&&Number(row[5])===part.sheetId&&(plan.proof.sources||[original]).some(source=>String(row[7]||'').trim().toUpperCase()===String(source.article).trim().toUpperCase())))
    throw new Error('В журнале появилась работа по артикулу. Восстановление остановлено.');
   if(!(await Promise.all(parts().map(p=>writers[p.department].manifest(p.sheetId)))).every(m=>same(m,frozen())))
    throw new Error('Связь участков изменилась. Восстановление остановлено.');
   if(typeof writers[to].verifyAbsentMoveDestination!=='function')return;
   await writers[to].verifyAbsentMoveDestination(plan.destination);
   // Inserting a fresh row at the saved boundary prevents overwriting data if
   // another editor appends a row after the readback and before this batch.
   plan.destination.recoveryInsert=true;
   op.proof.plan.destination.recoveryInsert=true;
   await beforeRetry();
   plan.destination.manifest=frozen();
   await writers[to].execute(plan.destination);
  },
 };
 if(receiptsOnly){
  if(!await destination.verify()||!await source.verifyRemoved())throw new CloudError('move_receipts_required','Не подтверждены копия назначения или завершённое удаление исходной позиции. Повторная запись не выполнялась.',409);
  const forbidden=async()=>{throw new CloudError('move_receipts_required','При сверке запрещено повторно копировать или удалять товар.',409);};
  source.remove=source.recoverRemove=forbidden;
  destination.write=destination.recoverAbsent=forbidden;
  coordinator.freeze=coordinator.recoverFreeze=forbidden;
 }
 const store={get:async id=>structuredClone(scope.operations.get(KIND+':'+id)?.value),put:async op=>{
  const prior=scope.operations.get(KIND+':'+op.id)?.value;
  if(!prior)scope.meta('printingMoveRevision',op.id+':pending');
  if(op.status==='verified'&&prior?.status!=='verified')scope.meta('printingMoveRevision',op.id);
  scope.putOperation(KIND,op);await scope.checkpoint();
 }};
 return runDepartmentMove(input,{store,source,destination,coordinator});
}

export async function cancelProductionMove(id,{scope,services,bindings,fetcher=fetch}){
 const row=scope.operations.get(KIND+':'+id),op=row?.value;
 if(!scope.lease||!op)throw new CloudError('move_missing','Перенос не найден.',409);
 if(op.status==='cancelled')return op;
 if(op.steps.destination!=='pending')throw new CloudError('move_cancel_forbidden','Запись назначения уже началась. Доступна только сверка.',409);
 const p=op.proof.plan,writers=services.production.writers,from=op.input.sourceDepartment||'box';
 const gateway=createDepartmentMoveGateway({url:bindings[from==='box'?'RITM_BOX_MOVE_GATEWAY_URL':'RITM_ROLL_MOVE_GATEWAY_URL'],token:bindings.RITM_BOX_MOVE_GATEWAY_TOKEN,fetcher,beforeWrite:()=>services.guard(writers[from].documentId)});
 for(const [department,part] of [['box',p.proof.box],['roll',p.proof.roll]]){
   const writer=writers[department],current=await writer.manifest(part.sheetId),frozen={...p.proof.manifest,revision:id,ready:false};
   if(p.proof.legacy?current===null:same(current,p.proof.manifest))continue;
   if(!same(current,frozen))throw new CloudError('move_manifest_changed','Состав поставки изменился. Отмена требует сверки.',409);
   await writer.request(`https://sheets.googleapis.com/v4/spreadsheets/${writer.documentId}:batchUpdate`,{method:'POST',write:true,body:{requests:p.proof.legacy?supplyManifestRequests(part.sheetId,null).slice(0,1):supplyManifestRequests(part.sheetId,p.proof.manifest)}});
   if(!same(await writer.manifest(part.sheetId),p.proof.legacy?null:p.proof.manifest))throw new Error('Отмена не подтверждена.');
 }
 const aborted=await gateway('abort',{operationId:id,sheetId:p.proof[from].sheetId,row:p.proof.source.row,uid:p.proof.source.uid,article:p.proof.source.article,quantity:op.input.quantity,...(p.proof.sources?{positions:p.proof.sources.map(s=>({row:s.row,uid:s.uid,article:s.article,quantity:s.quantity}))}:{})});
 if(aborted.status!=='aborted')throw new Error('Снятие блокировки переноса не подтверждено.');
 op.status='cancelled';op.message='Перенос отменён до копирования.';scope.meta('printingMoveRevision',id+':cancelled');scope.putOperation(KIND,op);await scope.checkpoint();return op;
}

// Recover the existing operation across browser sessions; never create a second
// operation for the same pending position just because sessionStorage is empty.
export function lookupProductionMove(scope, query) {
 const id=query.get('id');
 if(id)return scope.operations.get(KIND+':'+id)?.value || null;
 const shipmentId=query.get('shipmentId'),uid=query.get('uid'),article=query.get('article'),quantity=Number(query.get('quantity'));
 if(!shipmentId||!uid||!article||!Number.isSafeInteger(quantity)||quantity<=0)return null;
 const found=[...scope.operations.values()].filter(r=>r.kind===KIND&&!['verified','cancelled'].includes(r.value.status)&&r.value.input.shipmentId===shipmentId&&r.value.input.uid===uid&&r.value.input.article===article&&r.value.input.quantity===quantity);
 if(found.length>1)throw new CloudError('move_ambiguous','Найдены разные незавершённые переносы этой позиции. Новая запись заблокирована.',409);
 return found[0]?.value || null;
}
