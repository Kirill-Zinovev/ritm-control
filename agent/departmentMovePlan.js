import { inspectDepartmentMove } from './departmentMoveSheets.js';
import { xeroxExtensionIssue } from '../shared/productionRouting.js';
const fail = message => {throw Object.assign(new Error(message),{code:'production_move_conflict',status:409});};
const cell = (sheetId,row,col,value) => ({updateCells:{start:{sheetId,rowIndex:row-1,columnIndex:col-1},rows:[{values:[value===null?{}:{userEnteredValue:value}]}],fields:'userEnteredValue'}});

// Prepare both Sheets changes before either is sent. The persisted plan keeps
// the old input values for audit and the generated destination UID for readback.
export async function prepareDepartmentMove(args) {
  const {input,writers}=args;
  const from=input.sourceDepartment||'box',to=from==='box'?'roll':'box';
  const machines=to==='roll'?['2-GO','УФ','УФ БЕЛ.','УФ ДВУСТОРОННИЙ']:['XEROX','УФ планшет','DTF'];
  if(!machines.includes(input.machine)) fail('Выберите станок участка назначения.');
  if(!/^[A-Za-z0-9._ -]{1,40}$/.test(input.extension||'')) fail('Укажите расширение печати.');
  const routingIssue=xeroxExtensionIssue(to,input.machine,input.extension);
  if(routingIssue)fail(routingIssue);
  const proof=await inspectDepartmentMove(args);
  const name=proof[to].name||proof.shipment.name;
  const destination=await writers[to].prepareAppend({preserveExistingRows:true,operationId:input.operationId,name,sheetId:proof[to].sheetId,lines:[{article:proof.source.article,quantity:input.quantity,extension:input.extension}],registeredSheets:[{gid:proof[to].sheetId,name}]});
  // A transfer is an intentional per-position routing override; the catalog
  // machine must not silently route this row back into box on the next refresh.
  destination.formulaRepairs=[...(destination.formulaRepairs||[]).filter(r=>r.column!==4),{row:destination.startRow,column:4,formula:'="'+input.machine+'"'}];
  const layout=writers[from].layout;
  if(layout.article!==5||layout.quantity!==16||layout.uid!==30) fail('Структура строки бокса не подтверждена.');
  const clearColumns=[5,6,16,layout.remainingPrint,30];
  if(new Set(clearColumns).size!==5) fail('Колонки исходной позиции пересекаются.');
  return {input:structuredClone(input),proof,destination,sourceRequests:clearColumns.map(column=>cell(proof[from].sheetId,proof.source.row,column,null)),audit:{sourceUid:proof.source.uid,destinationUid:destination.uids?.[0]?.uid,article:input.article,quantity:input.quantity,sourceInputs:proof.source.cells.map(c=>c?.userEnteredValue||null)}};
}

// One exact destination append for a small, immutable group. Writer reads are
// shared only during preflight; every destination/source receipt stays fresh.
export async function prepareDepartmentMoveGroup(args) {
 const {input,writers}=args,items=input.items;
 if(!Array.isArray(items)||items.length<2||items.length>10)fail('Не подтверждён пакет переноса.');
 const from=input.sourceDepartment||'box',to=from==='box'?'roll':'box';
 const ids=new Set(),uids=new Set(),articles=new Set(),proofs=[],inspection={};
 let journal=null,composition=null;
 const readBoxJournal=()=>journal||(journal=Promise.resolve().then(()=>args.readBoxJournal()));
 const readLegacyComposition=s=>composition||(composition=Promise.resolve().then(()=>args.readLegacyComposition(s)));
 for(const item of items){
  if(item.shipmentId!==input.shipmentId||item.sourceDepartment!==from||ids.has(item.operationId)||uids.has(item.uid)||articles.has(item.article.trim().toUpperCase()))fail('Повтор или другой участок в пакете.');
  ids.add(item.operationId);uids.add(item.uid);articles.add(item.article.trim().toUpperCase());
  if(!(to==='roll'?['2-GO','УФ','УФ БЕЛ.','УФ ДВУСТОРОННИЙ']:['XEROX','УФ планшет','DTF']).includes(item.machine)||!/^[A-Za-z0-9._ -]{1,40}$/.test(item.extension||''))fail('Не подтверждены станок и расширение пакета.');
  const routingIssue=xeroxExtensionIssue(to,item.machine,item.extension);
  if(routingIssue){const error=Object.assign(new Error(routingIssue),{code:'production_move_conflict',status:409,itemOperationId:item.operationId});throw error;}
  try{proofs.push(await inspectDepartmentMove({...args,input:item,readBoxJournal,readLegacyComposition,inspection}));}
  catch(error){error.itemOperationId=item.operationId;throw error;}
 }
 if(items[0].operationId!==input.operationId||items[0].uid!==input.uid||items[0].article!==input.article||items[0].quantity!==input.quantity)fail('Изменился первый артикул пакета.');
 const proof=proofs[0],name=proof[to].name||proof.shipment.name;
 proof.sources=proofs.map((p,i)=>({...p.source,operationId:items[i].operationId}));
 const lines=items.map((item,i)=>({article:proofs[i].source.article,quantity:item.quantity,extension:item.extension}));
 const destination=await writers[to].prepareAppend({preserveExistingRows:true,operationId:input.operationId,name,sheetId:proof[to].sheetId,lines,registeredSheets:[{gid:proof[to].sheetId,name}]});
 destination.formulaRepairs=[...(destination.formulaRepairs||[]).filter(r=>r.column!==4),...items.map((item,i)=>({row:destination.startRow+i,column:4,formula:'="'+item.machine+'"'}))];
 const layout=writers[from].layout,columns=[5,6,16,layout.remainingPrint,30];
 if(layout.article!==5||layout.quantity!==16||layout.uid!==30||new Set(columns).size!==5)fail('Колонки исходного участка не подтверждены.');
 return {input:structuredClone(input),proof,destination,sourceRequests:proof.sources.flatMap(p=>columns.map(c=>cell(proof[from].sheetId,p.row,c,null))),audit:{positions:proof.sources.map((p,i)=>({article:p.article,quantity:p.quantity,sourceUid:p.uid,destinationUid:destination.uids[i].uid,sourceInputs:p.cells.map(c=>c?.userEnteredValue||null)}))}};
}
