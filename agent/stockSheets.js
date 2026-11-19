import { createHash, randomUUID } from 'node:crypto';
import { stockCellRequests } from './stockCells.js';
import { boxStockXeroxFormat } from './stockReadiness.js';
const targetName = destination => destination==='warehouse'?'Запасы склад':destination==='urgent'?'Срочные 2 этаж':'';
const fail = message => { throw Object.assign(new Error(message),{code:'stock_source_unavailable',status:409}); };
const entered=(cell)=>cell?.userEnteredValue?.stringValue??cell?.userEnteredValue?.numberValue??cell?.userEnteredValue?.boolValue??'';

// Read exact stock plans, retaining spreadsheet identity. Empty or malformed
// existing rows cannot be silently replaced by an insert.
export async function readStockSnapshot(reader, spreadsheetId, destination, signal) {
  const name=targetName(destination);
  if(!name||!spreadsheetId)fail('Не подтверждена таблица запасов.');
  const meta=await reader.metadata(spreadsheetId,signal,5);
  if(meta.spreadsheetId!==spreadsheetId)fail('Google вернул другую таблицу.');
  const matches=(meta.sheets||[]).filter(sheet=>sheet.properties?.title===name&&!sheet.properties.hidden);
  if(matches.length!==1)fail('Не найден однозначный рабочий лист запасов.');
  const properties=matches[0].properties, count=properties.gridProperties?.rowCount;
  if(!Number.isSafeInteger(count)||count<5||count>4096)fail('Размер листа запасов не подтверждён.');
  const response=await reader.grid(spreadsheetId,[`'${name}'!A1:AD${count}`],signal,5);
  const target=response.sheets?.find(sheet=>sheet.properties?.sheetId===properties.sheetId);
  const data=target?.data?.[0];
  if(response.spreadsheetId!==spreadsheetId||target?.properties?.title!==name||!data||data.startRow||data.startColumn||!Array.isArray(data.rowData))fail('Не удалось прочитать план запасов.');
  const headers=data.rowData[3]?.values||[];
  if(String(entered(headers[4])).trim().toLocaleLowerCase('ru-RU')!=='артикул'||String(entered(headers[15])).trim().toLocaleLowerCase('ru-RU')!=='кол-во')fail('Изменились заголовки листа запасов.');
  const rows=[];
  for(let index=4;index<data.rowData.length;index++){
    const cells=data.rowData[index]?.values||[],article=entered(cells[4]),quantity=entered(cells[15]);
    if(article===''&&quantity==='')continue;
    if(cells[4]?.userEnteredValue?.formulaValue||cells[15]?.userEnteredValue?.formulaValue||typeof article!=='string'||!article.trim()||!Number.isSafeInteger(quantity)||quantity<=0)fail(`Не подтверждён артикул или план в строке ${index+1}.`);
    rows.push({row:index+1,article:article.trim(),quantity});
  }
  return {rows,sheetId:properties.sheetId,rowCount:count,data:data.rowData};
}
export async function readStockRows(reader, spreadsheetId, destination, signal, department) {
  const {rows, data} = await readStockSnapshot(reader,spreadsheetId,destination,signal);
  if (department !== 'box') return rows;
  return rows.map(row => {
    const xerox = boxStockXeroxFormat(data[row.row-1]);
    return xerox ? {...row, xerox} : row;
  });
}

const snapshotHash = snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const enteredValue = cell => {
  const value = cell?.userEnteredValue;
  return value?.stringValue === '' ? null : value ?? null;
};
const articleKey = article => String(article||'').trim().toUpperCase().replace(/\(OZ\)$/u,'').trim();
export class StockSheetsAdapter {
  constructor({reader,writer,spreadsheetId,department,readiness,layouts}){
    if(!reader||!writer||!spreadsheetId||!['roll','box'].includes(department)||!readiness||!layouts)throw new TypeError('Stock adapter requires source, journal and layout readers');
    Object.assign(this,{reader,writer,spreadsheetId,department,readiness,layouts});
  }
  async read(destination){return readStockRows(this.reader,this.spreadsheetId,destination,undefined,this.department);}
  async prepare(destination,changes){
    const snapshot=await readStockSnapshot(this.reader,this.spreadsheetId,destination);
    const occupied=new Set(snapshot.rows.map(row=>row.row)), entries=[];
    // Closed/archived rows can retain their UID, layout marker or extension.
    // They are not available for reuse even if E/P are empty. Select only rows
    // that the destination gateway will accept; never erase history to fit.
    const protectedColumns=this.department==='roll'?[3,5,6,9,16,30]:[3,5,6,16,30];
    const hasInput=cell=>!!cell?.userEnteredValue?.formulaValue||entered(cell)!=='';
    const freeRows=[];
    for(let row=5;row<=snapshot.rowCount;row++){
      const cells=snapshot.data[row-1]?.values||[];
      if(occupied.has(row)||protectedColumns.some(column=>hasInput(cells[column-1])))continue;
      if([4,7,8,10,11].some(column=>!cells[column-1]?.userEnteredValue?.formulaValue))continue;
      freeRows.push(row);
    }
    let nextFree=0;
    const layouts=await this.layouts();
    if(!(layouts instanceof Set))fail('Не удалось подтвердить таблицу макетов.');
    for(const [index,change] of changes.entries()){
      if(change.department!==this.department)fail('Участок позиции изменился.');
      if(change.action==='increase'){
        const current=snapshot.rows.find(row=>row.row===change.row);
        if(!current||articleKey(current.article)!==articleKey(change.article)||current.quantity!==change.previousQuantity)fail('План изменился после проверки.');
        const derived=await this.readiness({destination,current,change,snapshot});
        const existingUid=entered(snapshot.data[current.row-1]?.values?.[29]);
        entries.push({...change,article:current.article,uid:typeof existingUid==='string' && existingUid.trim() ? existingUid.trim() : null,readiness:derived});
      } else if(change.action==='insert'){
        const row=freeRows[nextFree++];
        if(!row)fail('Нет подготовленных свободных строк в таблице запасов. Строки с данными и историей сохранены; проверьте свободное место и формулы шаблона.');
        entries.push({...change,row,uid:`ritm-${randomUUID()}-${index+1}`,layoutPresent:layouts.has(String(change.article).trim().toUpperCase())});
      } else fail('Неизвестное действие с запасами.');
    }
    return {destination,spreadsheetId:this.spreadsheetId,sheetId:snapshot.sheetId,sourceHash:snapshotHash(snapshot.rows),entries,requests:stockCellRequests(snapshot.sheetId,entries)};
  }
  async write(plan,operationId){
    try {
    if(plan.spreadsheetId!==this.spreadsheetId)fail('Изменилась таблица назначения.');
    const fresh=await readStockSnapshot(this.reader,this.spreadsheetId,plan.destination);
    if(fresh.sheetId!==plan.sheetId||snapshotHash(fresh.rows)!==plan.sourceHash)fail('Планы запасов изменились. Повторите проверку.');
    for(const entry of plan.entries.filter(item=>item.action==='increase')){
      const current=fresh.rows.find(row=>row.row===entry.row);
      const actual=await this.readiness({destination:plan.destination,current,change:entry,snapshot:fresh});
      if(JSON.stringify(actual)!==JSON.stringify(entry.readiness))fail('Выработка изменилась во время проверки. Повторите операцию.');
    }
    if(typeof this.writer.applyStockPlan!=='function')fail('Безопасная запись запасов ещё не подключена.');
    } catch(error) { error.beforeExternalWrite=true; throw error; }
    await this.writer.applyStockPlan({operationId,sheetId:plan.sheetId,entries:plan.entries});
  }
  async inspect(plan,operationId){
    if(plan.spreadsheetId!==this.spreadsheetId||typeof this.writer.inspectStockPlan!=='function')return null;
    return this.writer.inspectStockPlan({operationId,sheetId:plan.sheetId,entries:plan.entries});
  }
  async verify(plan){
    const fresh=await readStockSnapshot(this.reader,this.spreadsheetId,plan.destination);
    if(fresh.sheetId!==plan.sheetId)return false;
    for (const request of plan.requests.filter(request => plan.entries.some(entry => entry.action==='insert' && entry.row-1===request.updateCells?.start?.rowIndex))) {
      const update = request.updateCells;
      const start = update?.start;
      const expected = update?.rows?.[0]?.values?.[0];
      // The stock gateway can enrich an initially empty extension from the
      // catalog. This does not change the identity or quantity of the insert.
      if (start?.sheetId === plan.sheetId && start.columnIndex === 5 && expected?.userEnteredValue?.stringValue === '' &&
          fresh.data[start.rowIndex]?.values?.[5]?.userEnteredValue?.stringValue?.trim()) continue;
      if (!start || start.sheetId !== plan.sheetId || !expected ||
          JSON.stringify(enteredValue(fresh.data[start.rowIndex]?.values?.[start.columnIndex])) !== JSON.stringify(enteredValue(expected))) return false;
    }
    for(const entry of plan.entries){
      const current=fresh.rows.find(row=>row.row===entry.row&&row.article===entry.article&&row.quantity===entry.newQuantity);
      if(!current)return false;
      if(entry.action==='increase'){
        if(entry.uid && entered(fresh.data[entry.row-1]?.values?.[29])!==entry.uid)return false;
        const latest=await this.readiness({destination:plan.destination,current,change:entry,snapshot:fresh});
        const row=fresh.data[entry.row-1]?.values||[];
        const effective=cell=>cell?.effectiveValue?.boolValue??cell?.effectiveValue?.stringValue??cell?.effectiveValue?.numberValue??cell?.userEnteredValue?.boolValue??cell?.userEnteredValue?.stringValue??cell?.userEnteredValue?.numberValue??'';
        if(this.department==='box'&&(effective(row[18])!==latest.printing||effective(row[19])!==latest.cutting))return false;
        if(this.department==='roll'&&((effective(row[18])!==(latest.printing.complete?'Готов':'В работе')&&!(latest.printing.actual===0&&effective(row[18])===''))||(effective(row[19])!==(latest.cutting.complete?'Готов':'В работе')&&!(latest.cutting.actual===0&&effective(row[19])===''))))return false;
      }
    }
    return true;
  }
}
