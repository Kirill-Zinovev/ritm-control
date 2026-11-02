// Read-only interpretation of the box work journal; original records remain immutable.
export function parseBoxJournal(rows) {
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
  return [...ids.values()].filter(row=>String(row[10]).trim()==='Печать'&&!cancelled.has(String(row[0]).trim())).map(row=>({id:String(row[0]).trim(),positionId:String(row[3]),sheetId:Number(row[5]),shipment:String(row[6]),article:String(row[7]),employee:String(row[9]),date:String(row[2]),sheets:row[13]===''||row[13]==null?null:Number(row[13]),quantity:row[14]===''||row[14]==null?null:Number(row[14]),area:row[15]===''||row[15]==null?null:Number(row[15]),width:row[19]===''||row[19]==null?null:Number(row[19]),height:row[20]===''||row[20]==null?null:Number(row[20])}));
}

export function boxPrintingEvents(rows, orders = []) {
  return parseBoxJournal(rows).map(e=>{
    if(!e.employee.trim()||!Number.isFinite(Date.parse(e.date))||!Number.isFinite(e.quantity)||e.quantity<=0||e.sheets!==null&&(!Number.isFinite(e.sheets)||e.sheets<=0)) throw new Error('Некорректная запись выпуска бокса');
    const matches=orders.filter(o=>o.sourceId==='box-printing'&&Number(o.sheetId)===e.sheetId&&o.article===e.article);
    const machines=new Set(matches.map(o=>String(o.machine||'').trim().toLowerCase()).filter(Boolean));
    const machine=machines.size===1?[...machines][0]:null;
    const xerox=machine!==null&&/^(xerox|ксерокс|x|х)$/.test(machine);
    const physicalSheets=xerox?e.sheets:null;
    const area=e.area!==null?e.area:(e.width>0&&e.height>0&&(xerox?physicalSheets!==null:machine!==null||e.sheets===null)?(xerox?physicalSheets:machine||e.sheets===null?e.quantity:null)*e.width*e.height:null);
    if(area!==null&&(!Number.isFinite(area)||area<0))throw new Error('Некорректная площадь бокса');
    return {...e,area,sheets:physicalSheets,sourceId:'box-printing',date:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(e.date))};
  });
}
export async function loadBoxPrinting(reader, printing, {journalId,signal}={}) {
  const unavailable=reason=>({...printing,boxPrinting:{status:'unavailable',events:[],reason}});
  if(!journalId)return unavailable('Журнал бокса не подключён.');
  try {
    const metadata=await reader.metadata(journalId,signal,5);
    const sheet=metadata.sheets?.find(s=>s.properties?.title==='Журнал');
    const count=sheet?.properties?.gridProperties?.rowCount;
    if(metadata.spreadsheetId!==journalId||!Number.isSafeInteger(count)||count<1||count>50000)throw new Error('metadata');
    const grid=await reader.grid(journalId,[`'Журнал'!A1:X${count}`],signal,5);
    const block=grid.sheets?.find(s=>s.properties?.sheetId===sheet.properties.sheetId)?.data?.[0];
    if(grid.spreadsheetId!==journalId||!block||block.startRow||block.startColumn||!Array.isArray(block.rowData))throw new Error('grid');
    const rows=block.rowData.map(r=>(r.values||[]).map(c=>c.effectiveValue?.stringValue??c.effectiveValue?.numberValue??c.userEnteredValue?.stringValue??c.userEnteredValue?.numberValue??''));
    return {...printing,boxPrinting:{status:'available',events:boxPrintingEvents(rows,printing.supplies||[]),reason:null}};
  } catch(error) {if(signal?.aborted)throw error;return unavailable('Журнал бокса недоступен или содержит неподтверждённые записи.');}
}
