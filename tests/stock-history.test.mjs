import test from 'node:test';
import assert from 'node:assert/strict';
import {stockHistoryEntries, loadStockHistory, loadStockWorkspace} from '../worker/cloud/stockHistory.js';
import {parseReadyStockId, resolveReadyStockEntry} from '../worker/cloud/stockCompletion.js';
import {readStockSnapshot} from '../agent/stockSheets.js';
const now=Date.parse('2026-11-06T12:00:00Z');
const op=(date,status='verified')=>({kind:'stock',createdAt:date,value:{id:'op',status,manager:'Кирилл',destination:'urgent',steps:[{department:'box',status:'verified',plan:{sheetId:1,entries:[{article:'A1',quantity:20,row:5,uid:'u1'}]}}]}});
test('history retains seven days, only confirmed work and manager',()=>{const entries=stockHistoryEntries([op('2026-11-05T10:00:00Z'),op('2026-10-25T10:00:00Z'),op('2026-11-05T10:00:00Z','uncertain')],now);assert.equal(entries.length,1);assert.equal(entries[0].manager,'Кирилл');assert.equal(entries[0].quantity,20);});
test('unavailable sources never appear as completed',async()=>{const entries=await loadStockHistory({operations:[op('2026-11-05T10:00:00Z')],reader:{metadata:async()=>{throw Error('offline')}},boxId:'box',rollId:'roll',now});assert.equal(entries[0].print,'unknown');assert.equal(entries[0].cut,'unknown');});
test('newer operation timestamps are retained when source timestamp missing',()=>{let x=op(undefined);x.value.createdAt='2026-11-05T10:00:00Z';assert.equal(stockHistoryEntries([x],now).length,1)});
test('closed history is preserved by identity after source removal and does not match a new uid',async()=>{const original=op('2026-10-25T10:00:00Z');const closed={kind:'stock-close',value:{status:'verified',uid:'u1',sheetId:1,department:'box',destination:'urgent',closedAt:'2026-11-05T12:00:00Z'}};const reader={metadata:async()=>{throw Error('offline')}};const entries=await loadStockHistory({operations:[original,closed],reader,boxId:'box',rollId:'roll',now});assert.equal(entries.length,1);assert.equal(entries[0].status,'closed');assert.equal(entries[0].print,'done');const other=op('2026-11-05T10:00:00Z');other.value.steps[0].plan.entries[0].uid='new';const active=await loadStockHistory({operations:[other,closed],reader,boxId:'box',rollId:'roll',now});assert.equal(active[0].status,undefined);assert.equal(active[0].print,'unknown')});

const sourceRow = cells => ({values:Array.from({length:30},(_,index)=>{
  const cell=cells[index];
  const value=typeof cell==='number'?{numberValue:cell}:typeof cell==='boolean'?{boolValue:cell}:{stringValue:cell||''};
  return {userEnteredValue:value,effectiveValue:value};
})});
function stockBooks() {
  const book={box:[],roll:[]};
  function sheet(id,title,sheetId,rows) {
    book[id].push({properties:{title,sheetId,gridProperties:{rowCount:Math.max(5,rows.length)}},data:[{rowData:rows.map(sourceRow)}]});
  }
  const headers=[[],[],[],{4:'Артикул',15:'Кол-во'}];
  const box={3:'XEROX',4:'A1',6:4,13:8,15:20,27:10,28:10,29:'u1'};
  const roll={4:'ROLL-READY',15:300,22:46334,23:46338,29:'roll-uid'};
  sheet('box','Срочные 2 этаж',1,[...headers,box]);
  sheet('box','Запасы склад',2,[...headers,{...box,4:'BOX-PARTIAL',28:2,29:'partial'}]);
  sheet('roll','Срочные 2 этаж',3,headers);
  sheet('roll','Запасы склад',4,[...headers,roll]);
  sheet('roll','ROLLS_V2',5,[
    ['ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','ROLL_NAME','ROLL_NUMBER','PRINT_READY','CUT_READY','CREATED_AT','UPDATED_AT','ROLL_QUANTITY','PRINT_DONE_AT','PRINT_EMPLOYEE','CUT_DONE_AT','CUT_EMPLOYEE','LEGACY_SOURCE'],
    ['roll-id','roll-uid','Запасы склад',5,'ROLL-READY','Рулон',1,true,true,'','',300,46334,'',46338],
  ]);
  sheet('roll','ROLLS_V2_PROGRESS',6,[['EVENT_ID','ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','OPERATION','EMPLOYEE','DATE','QUANTITY','AREA_PER_ITEM','AREA','ENTERED_AT','COMMENT']]);
  sheet('roll','Журнал выпуска',7,[
    ['ID записи','Дата','Сотрудник','Операция','Лист-источник','Строка заказа','Артикул','UID заказа','Рулон','Сделано','м² на 1 шт.','Выпуск м²','Время записи','Комментарий','ID рулона'],
    ['p',46334,'Печатник','Печать','Запасы склад',5,'ROLL-READY','roll-uid','Рулон',300,1,300,'','','roll-id'],
    ['c',46338,'Печатник','Резка','Запасы склад',5,'ROLL-READY','roll-uid','Рулон',300,1,300,'','','roll-id'],
  ]);
  const reader={
    metadata:async id=>({spreadsheetId:id,sheets:book[id].map(({properties})=>({properties}))}),
    grid:async (id,ranges)=>({spreadsheetId:id,sheets:book[id].filter(s=>ranges.some(range=>range.startsWith(`'${s.properties.title}'!`)))}),
  };
  return {book,reader,boxId:'box',rollId:'roll',now};
}

test('current completed Box and roll positions are offered even without a recent addition',async()=>{
  const f=stockBooks(), operations=[op('2026-10-25T10:00:00Z')];
  const view=await loadStockWorkspace({...f,operations});
  assert.deepEqual(view.entries,[]);
  assert.deepEqual(view.unavailable,[]);
  assert.deepEqual(view.ready.map(({article,quantity})=>[article,quantity]),[['ROLL-READY',300],['A1',20]]);
  const {id}=view.ready[0], source=parseReadyStockId(id);
  const snapshot=await readStockSnapshot(f.reader,'roll','warehouse');
  assert.equal(resolveReadyStockEntry(id,source,snapshot).uid,'roll-uid');
  snapshot.rows[0].quantity=310;
  assert.throws(()=>resolveReadyStockEntry(id,source,snapshot),/количество изменились/);
});

test('pending closure is shown for verification, then retained in history without an addition record',async()=>{
  const f=stockBooks(), {ready}=await loadStockWorkspace({...f,operations:[]});
  const value={id:'operation',entryId:ready[0].id,status:'uncertain',uid:'roll-uid',sheetId:4,row:5,
    department:'roll',destination:'warehouse',article:'ROLL-READY',quantity:300,closedBy:'Менеджер'};
  const pending=await loadStockWorkspace({...f,operations:[{kind:'stock-close',value}]});
  assert.deepEqual(pending.ready.map(item=>item.article),['A1']);
  assert.equal(pending.checking[0].operationId,'operation');
  f.book.roll.find(sheet=>sheet.properties.sheetId===4).data[0].rowData.pop();
  const closed=await loadStockWorkspace({...f,operations:[{kind:'stock-close',value:{...value,status:'verified',closedAt:'2026-11-05T12:00:00Z'}}]});
  assert.deepEqual(closed.checking,[]);
  assert.deepEqual(closed.entries.map(item=>[item.article,item.quantity,item.print,item.cut,item.status,item.event]),
    [['ROLL-READY',300,'done','done','closed','close']]);
});
