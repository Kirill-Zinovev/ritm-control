import { recalculateStockReadiness } from './stockPlanning.js';
import { xeroxSheetCount } from './xeroxQuantity.js';

const cell=(row,index)=>row?.values?.[index];
const effective=c=>c?.effectiveValue?.stringValue??c?.effectiveValue?.numberValue??c?.effectiveValue?.boolValue??c?.userEnteredValue?.stringValue??c?.userEnteredValue?.numberValue??c?.userEnteredValue?.boolValue??'';
const number=(value,label)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error(`Не подтверждено значение «${label}».`);return value;};
const boxMachine = row => String(effective(cell(row,3))).trim().toLowerCase();
export function boxStockXeroxFormat(row) {
  if (!/^(xerox|ксерокс|x|х)$/.test(boxMachine(row))) return null;
  return {factor:effective(cell(row,6)), multiplicity:effective(cell(row,13))};
}

export async function readRollStockHistory(reader,spreadsheetId,signal){
  const schemas={
    ROLLS_V2:['ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','ROLL_NAME','ROLL_NUMBER','PRINT_READY','CUT_READY','CREATED_AT','UPDATED_AT','ROLL_QUANTITY','PRINT_DONE_AT','PRINT_EMPLOYEE','CUT_DONE_AT','CUT_EMPLOYEE','LEGACY_SOURCE'],
    ROLLS_V2_PROGRESS:['EVENT_ID','ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','OPERATION','EMPLOYEE','DATE','QUANTITY','AREA_PER_ITEM','AREA','ENTERED_AT','COMMENT'],
    'Журнал выпуска':['ID записи','Дата','Сотрудник','Операция','Лист-источник','Строка заказа','Артикул','UID заказа','Рулон','Сделано','м² на 1 шт.','Выпуск м²','Время записи','Комментарий','ID рулона'],
  };
  const meta=await reader.metadata(spreadsheetId,signal,5);
  if(meta.spreadsheetId!==spreadsheetId)throw new Error('Не подтверждён журнал запасов.');
  const descriptor=Object.entries(schemas).map(([name,headers])=>{const found=(meta.sheets||[]).filter(s=>s.properties?.title===name);const props=found[0]?.properties;if(found.length!==1||!Number.isSafeInteger(props?.gridProperties?.rowCount)||props.gridProperties.rowCount>50000)throw new Error('Не подтверждены листы истории рулонов.');return {name,headers,props};});
  const endColumn=n=>String.fromCharCode(64+n);
  const grid=await reader.grid(spreadsheetId,descriptor.map(d=>`'${d.name}'!A1:${endColumn(d.headers.length)}${d.props.gridProperties.rowCount}`),signal,5);
  if(grid.spreadsheetId!==spreadsheetId)throw new Error('Не подтверждён журнал запасов.');
  const output={};
  for(const d of descriptor){
    const data=grid.sheets?.find(s=>s.properties?.sheetId===d.props.sheetId)?.data?.[0];
    if(!data||data.startRow||data.startColumn||!Array.isArray(data.rowData))throw new Error('Не прочитана история рулонов.');
    const rows=data.rowData.map(row=>Array.from({length:d.headers.length},(_,index)=>effective(cell(row,index))));
    if(d.headers.some((header,index)=>String(rows[0]?.[index]||'').trim()!==header))throw new Error('Изменились заголовки журнала рулонов.');
    output[d.name]=rows.slice(1).filter(row=>row.some(value=>value!==''));
  }
  return {rolls:output.ROLLS_V2,progress:output.ROLLS_V2_PROGRESS,journal:output['Журнал выпуска']};
}

export function boxStockReadiness({current,change,snapshot}){
  const row=snapshot.data[current.row-1],machine=boxMachine(row);
  if(!machine||machine.startsWith('#'))throw new Error('Не подтверждён станок бокса.');
  const format=boxStockXeroxFormat(row), xerox=!!format;
  const factor=xerox?number(format.factor,'листы товара'):1, multiplicity=xerox?number(format.multiplicity,'кратность'):1;
  const proof=change.xeroxRoundingProof;
  if (proof && (!xerox || factor!==proof.factor || multiplicity!==proof.multiplicity ||
      xeroxSheetCount(change.newQuantity,factor,multiplicity)!==proof.sheets))
    throw Object.assign(new Error(`Параметры Xerox для «${current.article}» изменились. Проверьте список и выберите округление заново.`),{code:'stock_rounding_changed',status:409});
  const printed=number(effective(cell(row,27)),'напечатано'),cut=number(effective(cell(row,28)),'порезано');
  const previousPlan=xerox?xeroxSheetCount(current.quantity,factor,multiplicity):current.quantity;
  // An older plan can contain part of a sheet. Retain the confirmed output
  // and compare it with that exact nominal plan before allowing an increase.
  const previousLimit=previousPlan ?? current.quantity/multiplicity*factor;
  if(!Number.isFinite(previousLimit)||previousLimit<=0||printed>previousLimit||cut>printed)
    throw new Error('Выработка превышает подтверждённый план; нужна сверка.');
  return recalculateStockReadiness({department:'box',planPieces:change.newQuantity,xerox,factor,multiplicity,printed,cut,printDate:effective(cell(row,21)),cutDate:effective(cell(row,22))});
}

// Roll facts use the exact same precedence as r2OperationTotals_: completed
// journal quantities, then partial work, then the ready roll's own quantity.
export function rollStockReadiness({current,change,snapshot,rolls,progress,journal,sheetName}){
  const row=snapshot.data[current.row-1],uid=String(effective(cell(row,29))||'');
  if(!uid)throw new Error('Не подтверждён ID заказа рулонной печати.');
  const relevant=rolls.filter(r=>String(r[1])===uid&&String(r[2])===sheetName&&String(r[4])===current.article);
  const ids=new Set();
  for(const r of relevant){const id=String(r[0]||'');if(!id||ids.has(id))throw new Error('Повторный ID рулона.');ids.add(id);number(r[11],'количество рулона');}
  function stage(operation,readyColumn){
    const release=new Map(),partial=new Map(),events=new Set();
    for(const r of journal){if(String(r[7])!==uid||String(r[4])!==sheetName||String(r[6])!==current.article||String(r[3])!==operation)continue;const id=String(r[0]||''),rollId=String(r[14]||'');if(!id||events.has(id)||!ids.has(rollId))throw new Error('Не подтверждён журнал рулонов.');events.add(id);release.set(rollId,(release.get(rollId)||0)+number(r[9],'выпуск'));}
    for(const r of progress){if(String(r[2])!==uid||String(r[3])!==sheetName||String(r[5])!==current.article||String(r[6])!==operation)continue;const rollId=String(r[1]||'');if(!ids.has(rollId))throw new Error('Не подтверждена частичная выработка.');partial.set(rollId,(partial.get(rollId)||0)+number(r[9],'частичная выработка'));}
    let actual=0,ready=0;
    for(const r of relevant){const id=String(r[0]),marked=r[readyColumn]===true;if(marked)ready++;actual+=marked?(release.has(id)?release.get(id):partial.has(id)?partial.get(id):r[11]):(partial.get(id)||0);}
    return {actual,rolls:{total:relevant.length,ready}};
  }
  const print=stage('Печать',7),cut=stage('Резка',8),printDate=effective(cell(row,22)),cutDate=effective(cell(row,23));
  if(print.actual>=change.newQuantity&&print.rolls.total&&print.rolls.ready===print.rolls.total&&!printDate||cut.actual>=change.newQuantity&&cut.rolls.total&&cut.rolls.ready===cut.rolls.total&&!cutDate)throw new Error('Не подтверждена дата завершения рулонов.');
  return recalculateStockReadiness({department:'roll',planPieces:change.newQuantity,printed:print.actual,cut:cut.actual,printDate,cutDate,printRolls:print.rolls,cutRolls:cut.rolls});
}
