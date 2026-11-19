import test from 'node:test';
import assert from 'node:assert/strict';
import {readAssemblyStocks, ASSEMBLY_STOCK_ID} from '../worker/cloud/assemblyStock.js';
import {isRitmAssemblyShipmentId, parseAssemblyWorkLog} from '../worker/assemblyWorkLog.js';

const cell = x => ({userEnteredValue: typeof x==='number'?{numberValue:x}:typeof x==='boolean'?{boolValue:x}:{stringValue:x??''}});
function fixture() {
  const books={};
  for(const [id,sku] of [['box-book','BOX'],['roll-book','ROLL']]) {
    const values=Array(30).fill(''); Object.assign(values,{3:id==='box-book'?'XEROX':'2-GO',4:sku,6:2,13:4,15:20,18:'Готов',19:'',27:10,28:5,29:'uid-'+sku});
    const rows=Array.from({length:5},()=>({values:[]})); rows[3].values=Array(30).fill(null);rows[3].values[4]=cell('Артикул');rows[3].values[15]=cell('Кол-во');rows[4].values=values.map(cell);
    books[id]={values,queue:{properties:{sheetId:7,title:'Запасы склад',gridProperties:{rowCount:6}},data:[{rowData:rows}]},archive:null};
  }
  const reader={metadata:async id=>({spreadsheetId:id,sheets:[books[id].queue,...(books[id].archive?[books[id].archive]:[])]}),grid:async(id,ranges)=>({spreadsheetId:id,sheets:[ranges[0].includes('_RITM_STOCK_ARCHIVE')?books[id].archive:books[id].queue]})};
  return {books,reader,read:()=>readAssemblyStocks({reader,boxId:'box-book',rollId:'roll-book'})};
}
function archive(book,values=book.values) {
  book.archive={properties:{sheetId:9,title:'_RITM_STOCK_ARCHIVE',gridProperties:{rowCount:4}},data:[{rowData:[
    {values:['Операция','Дата','Лист','Строка','UID','Артикул','План','Данные строки'].map(cell)},
    {values:['op','2026-11-10T10:00:00Z','Запасы склад',5,values[29],values[4],values[15],JSON.stringify({values})].map(cell)}]}]};
}
test('warehouse projection combines both departments with stable, separate identities and pieces plans',async()=>{
  const f=fixture(),before=JSON.stringify(f.books),out=await f.read();
  assert.equal(out.items.length,2);assert.equal(out.shipmentId,ASSEMBLY_STOCK_ID);assert.equal(new Set(out.items.map(i=>i.positionId)).size,2);
  assert.equal(out.items[0].quantity,20);assert.equal(out.items[0].print,'done');assert.equal(out.items[0].cut,'partial');
  assert.equal(out.items[1].print,'done');assert.equal(JSON.stringify(f.books),before,'projection is read-only');
  f.books['box-book'].queue.data[0].rowData[4].values[15]=cell(40);
  const next=await f.read();assert.equal(next.items[0].positionId,out.items[0].positionId);assert.equal(next.items[0].quantity,40);assert.notEqual(next.revision,out.revision);
});
test('closed production jobs remain available and a closing overlap is counted once',async()=>{
  const f=fixture();archive(f.books['box-book']);let out=await f.read();assert.equal(out.items.length,2);
  f.books['box-book'].queue.data[0].rowData[4].values=[];out=await f.read();assert.equal(out.items.length,2);assert.equal(out.items[0].archivedAt,'2026-11-10T10:00:00Z');assert.equal(out.items[0].cut,'done');
});
test('an urgent archive is excluded and conflicting identity or missing UID blocks writes',async()=>{
  const f=fixture();archive(f.books['box-book']);f.books['box-book'].archive.data[0].rowData[1].values[2]=cell('Срочные 2 этаж');assert.equal((await f.read()).items.length,2);
  f.books['box-book'].queue.data[0].rowData[4].values[29]=cell('');await assert.rejects(f.read(),/UID/);
  const g=fixture();archive(g.books['box-book'],g.books['box-book'].values.map((v,i)=>i===15?30:v));await assert.rejects(g.read(),/конфликт/);
});
test('malformed archive, duplicate archive and unavailable department never become an empty authoritative list',async()=>{
  const f=fixture();archive(f.books['box-book']);f.books['box-book'].archive.data[0].rowData.push(f.books['box-book'].archive.data[0].rowData[1]);await assert.rejects(f.read(),/повторяется UID/);
  const g=fixture();archive(g.books['box-book']);g.books['box-book'].archive.data[0].rowData[1].values[7]=cell('{');await assert.rejects(g.read(),/архив/);
  const h=fixture();h.reader.grid=async()=>{throw Error('offline');};await assert.rejects(h.read(),/offline/);
});
test('only the exact stock shipment identity is admitted to existing RITM work reconciliation',()=>{
  assert.equal(isRitmAssemblyShipmentId(ASSEMBLY_STOCK_ID),true);assert.equal(isRitmAssemblyShipmentId('RITM-STOCK-OTHER'),false);
});
