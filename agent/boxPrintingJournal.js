// Read-only interpretation of the box work journal; original records remain immutable.
function activeBoxJournalRows(rows) {
  const expected=['ID записи','Контроль запроса','Время','ID позиции','ID таблицы','ID листа','Поставка','Артикул','ID сотрудника','Сотрудник','Действие','Единица','Введено','Физических листов','Комплектов','Площадь, м²','План, комплектов','Листов в комплекте','План, листов','Ширина, м','Высота, м','Этап','Комментарий / причина','Отменяет ID'];
  if (!Array.isArray(rows) || expected.some((v,i)=>String(rows[0]?.[i]??'').trim()!==v)) throw new Error('Структура журнала бокса не подтверждена');
  const ids=new Map();
  for (const row of rows.slice(1)) {
    const id=String(row[0]??'').trim(); if(!id) continue;
    if(ids.has(id)) throw new Error('Повторный ID записи журнала бокса');
    ids.set(id,row);
  }
  const cancelled=new Set();
  for(const row of ids.values()) if(String(row[10]).trim()==='Отмена') {
    const target=String(row[23]??'').trim();
    if(!target || cancelled.has(target) || (!ids.has(target)&&!target.startsWith('baseline:')) || (ids.has(target)&&String(ids.get(target)[3])!==String(row[3]))) throw new Error('Отмена журнала бокса не подтверждена');
    cancelled.add(target);
  }
  return [...ids.values()].filter(row=>String(row[10]).trim()!=='Отмена'&&!cancelled.has(String(row[0]).trim()));
}

function parseBoxActionJournal(rows, action) {
  return activeBoxJournalRows(rows).filter(row=>String(row[10]).trim()===action).map(row=>({id:String(row[0]).trim(),positionId:String(row[3]),sheetId:Number(row[5]),shipment:String(row[6]),article:String(row[7]),employee:String(row[9]),date:String(row[2]),comment:String(row[22]??''),sheets:row[13]===''||row[13]==null?null:Number(row[13]),quantity:row[14]===''||row[14]==null?null:Number(row[14]),area:row[15]===''||row[15]==null?null:Number(row[15]),width:row[19]===''||row[19]==null?null:Number(row[19]),height:row[20]===''||row[20]==null?null:Number(row[20])}));
}

export function parseBoxJournal(rows) { return parseBoxActionJournal(rows, 'Печать'); }
export function parseBoxCutJournal(rows) { return parseBoxActionJournal(rows, 'Порезка'); }

function boxOperationEvents(rows, orders, action, history = null) {
  const operationName=action==='Порезка'?'порезки':'печати';
  return parseBoxActionJournal(rows, action).map(e=>{
    if(!e.employee.trim()||!Number.isFinite(Date.parse(e.date))||!Number.isFinite(e.quantity)||e.quantity<=0||e.sheets!==null&&(!Number.isFinite(e.sheets)||e.sheets<=0)) throw new Error('Некорректная запись '+operationName+' бокса');
    const matches=orders.filter(o=>o.sourceId==='box-printing'&&Number(o.sheetId)===e.sheetId&&o.article===e.article);
    const machines=new Set(matches.map(o=>String(o.machine||'').trim().toLowerCase()).filter(Boolean));
    const machine=machines.size===1?[...machines][0]:null;
    const xerox=machine!==null&&/^(xerox|ксерокс|x|х)$/.test(machine);
    const physicalSheets=xerox?e.sheets:null;
    // Older records used a different area formula. Their separately preserved
    // snapshot takes precedence; later records use the area saved at creation.
    const area=history?.areas.has(e.id)?history.areas.get(e.id)
      : history && Date.parse(e.date)<=history.cutoff ? null : e.area;
    if(area!==null&&(!Number.isFinite(area)||area<0))throw new Error('Некорректная площадь бокса');
    return {...e,area,sheets:physicalSheets,operation:action==='Порезка'?'cut':'print',sourceId:'box-printing',date:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(e.date))};
  });
}
export function boxPrintingEvents(rows, orders = [], history = null) { return boxOperationEvents(rows, orders, 'Печать', history); }
export function boxCuttingEvents(rows, orders = [], history = null) { return boxOperationEvents(rows, orders, 'Порезка', history); }
export function boxJournalExceptions(rows) {
  return activeBoxJournalRows(rows).filter(row=>['Брак','Излишек'].includes(String(row[10]).trim())).map(row=>{
    const timestamp=String(row[2]??'').trim(), quantity=Number(row[12]);
    if(!Number.isFinite(Date.parse(timestamp))||!Number.isFinite(quantity)||quantity<=0) throw new Error('Некорректная запись брака или излишка');
    const unit=String(row[11]??'').trim();
    return {id:String(row[0]).trim(),date:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp)),timestamp,
      sheetId:Number(row[5]),shipment:String(row[6]??''),article:String(row[7]??''),employee:String(row[9]??''),
      kind:String(row[10]).trim()==='Брак'?'defect':'surplus',quantity,unit:unit==='Листы'?'sheets':unit==='Шт. товара'?'pieces':'unknown',
      stage:String(row[21]??''),comment:String(row[22]??'')};
  });
}
export async function loadBoxPrinting(reader, printing, {journalId,signal}={}) {
  const unavailable=reason=>({...printing,boxPrinting:{status:'unavailable',events:[],cutEvents:[],exceptions:[],reason}});
  if(!journalId)return unavailable('Журнал бокса не подключён.');
  try {
    const metadata=await reader.metadata(journalId,signal,5);
    const sheet=metadata.sheets?.find(s=>s.properties?.title==='Журнал');
    const count=sheet?.properties?.gridProperties?.rowCount;
    if(metadata.spreadsheetId!==journalId||!Number.isSafeInteger(count)||count<1||count>50000)throw new Error('metadata');
    const grid=await reader.grid(journalId,[`'Журнал'!A1:X${count}`],signal,5);
    const block=grid.sheets?.find(s=>s.properties?.sheetId===sheet.properties.sheetId)?.data?.[0];
    if(grid.spreadsheetId!==journalId||!block||block.startRow||block.startColumn||!Array.isArray(block.rowData))throw new Error('grid');
    const values=r=>(r.values||[]).map(c=>c.effectiveValue?.stringValue??c.effectiveValue?.numberValue??c.userEnteredValue?.stringValue??c.userEnteredValue?.numberValue??'');
    const rows=block.rowData.map(values);
    const daily=metadata.sheets?.find(s=>s.properties?.title==='По дням');
    if(!daily || daily.properties.gridProperties?.columnCount<22 || daily.properties.gridProperties?.rowCount<2)throw new Error('Нет исторических площадей');
    const historyGrid=await reader.grid(journalId,[`'По дням'!U2:V${daily.properties.gridProperties.rowCount}`],signal,5);
    const historyBlock=historyGrid.sheets?.find(s=>s.properties?.sheetId===daily.properties.sheetId)?.data?.[0];
    if(historyGrid.spreadsheetId!==journalId||!historyBlock||historyBlock.startRow!==1||historyBlock.startColumn!==20||!Array.isArray(historyBlock.rowData))throw new Error('Исторические площади недоступны');
    const areas=new Map();
    for(const row of historyBlock.rowData.map(values)) {
      if(!row[0] && (row[1]===''||row[1]==null))continue;
      const id=String(row[0]??'').trim(), area=row[1];
      if(!id || areas.has(id) || typeof area!=='number' || !Number.isFinite(area) || area<0)throw new Error('Историческая площадь не подтверждена');
      areas.set(id,area);
    }
    if(!areas.size)throw new Error('Исторические площади отсутствуют');
    const dated=rows.slice(1).filter(r=>areas.has(String(r[0]??'').trim())).map(r=>Date.parse(String(r[2])));
    if(dated.length!==areas.size||dated.some(t=>!Number.isFinite(t)))throw new Error('Исторические записи не подтверждены');
    const history={areas,cutoff:Math.max(...dated)};
    return {...printing,boxPrinting:{status:'available',events:boxPrintingEvents(rows,printing.supplies||[],history),cutEvents:boxCuttingEvents(rows,printing.supplies||[],history),exceptions:boxJournalExceptions(rows),reason:null}};
  } catch(error) {if(signal?.aborted)throw error;return unavailable('Журнал бокса недоступен или содержит неподтверждённые записи.');}
}
