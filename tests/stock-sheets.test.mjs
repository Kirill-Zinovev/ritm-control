import test from 'node:test';
import assert from 'node:assert/strict';
import {readStockRows,StockSheetsAdapter} from '../agent/stockSheets.js';
import {stockCellRequests} from '../agent/stockCells.js';

function fixture(){
 const rows=Array.from({length:6},()=>({values:Array(30).fill(null)}));
 const value=x=>({userEnteredValue:typeof x==='number'?{numberValue:x}:{stringValue:x}});
 rows[3].values[4]=value('Артикул');rows[3].values[15]=value('Кол-во');rows[4].values[4]=value('A');rows[4].values[15]=value(12);
 const sheet={properties:{sheetId:7,title:'Запасы склад',gridProperties:{rowCount:10}},data:[{rowData:rows}]};
 return {rows,reader:{metadata:async()=>({spreadsheetId:'book',sheets:[sheet]}),grid:async()=>({spreadsheetId:'book',sheets:[sheet]})}};
}
test('reads exact source rows and rejects incomplete plans',async()=>{
 const f=fixture();assert.deepEqual(await readStockRows(f.reader,'book','warehouse'),[{row:5,article:'A',quantity:12}]);
 f.rows[5].values[4]={userEnteredValue:{stringValue:'B'}};
 await assert.rejects(readStockRows(f.reader,'book','warehouse'),/строке 6/);
});
test('the Box preview only uses the effective Xerox norms in the production row', async () => {
 const f = fixture();
 Object.assign(f.rows[4].values,{
  3:{effectiveValue:{stringValue:'XEROX'}},
  6:{userEnteredValue:{formulaValue:'=20'},effectiveValue:{numberValue:20}},
  13:{userEnteredValue:{formulaValue:'=8'},effectiveValue:{numberValue:8}},
 });
 assert.deepEqual(await readStockRows(f.reader,'book','warehouse',undefined,'box'),[
  {row:5,article:'A',quantity:12,xerox:{factor:20,multiplicity:8}},
 ]);
});
test('formula inputs and unexpected names cannot be used as stock plans',async()=>{
 const f=fixture();f.rows[4].values[15]={userEnteredValue:{formulaValue:'=12'}};
 await assert.rejects(readStockRows(f.reader,'book','warehouse'),/строке 5/);
 await assert.rejects(readStockRows(f.reader,'book','other'),/таблица запасов/);
});
test('adapter refuses a changed plan before issuing a write',async()=>{
 const f=fixture();let writes=0;
 const adapter=new StockSheetsAdapter({reader:f.reader,writer:{request:async()=>{writes++;}},spreadsheetId:'book',department:'box',layouts:async()=>new Set(),readiness:async()=>({printing:false,cutting:false})});
 const change={row:5,article:'A',previousQuantity:12,newQuantity:15,action:'increase',department:'box'};
 const plan=await adapter.prepare('warehouse',[change]);
 f.rows[4].values[15]={userEnteredValue:{numberValue:13}};
 await assert.rejects(adapter.write(plan),/изменились/);assert.equal(writes,0);
});
test('adapter blocks a missing prepared formula before inserting',async()=>{
 const f=fixture(),adapter=new StockSheetsAdapter({reader:f.reader,writer:{request:async()=>{}},spreadsheetId:'book',department:'box',layouts:async()=>new Set(),readiness:async()=>({})});
 await assert.rejects(adapter.prepare('warehouse',[{article:'B',newQuantity:3,action:'insert',department:'box'}]),/формулы/);
});
test('readback rejects a missing readiness update even when the plan was saved',async()=>{
 const f=fixture(),adapter=new StockSheetsAdapter({reader:f.reader,writer:{request:async()=>{}},spreadsheetId:'book',department:'box',layouts:async()=>new Set(),readiness:async()=>({printing:false,cutting:false})});
 const plan=await adapter.prepare('warehouse',[{row:5,article:'A',previousQuantity:12,newQuantity:15,action:'increase',department:'box'}]);
 f.rows[4].values[15]={userEnteredValue:{numberValue:15}};
 assert.equal(await adapter.verify(plan),false);
 for(const request of plan.requests){const {start,rows}=request.updateCells;f.rows[start.rowIndex].values[start.columnIndex]=rows[0].values[0];}
 assert.equal(await adapter.verify(plan),true);
});
test('insert verification accepts an automatically populated extension but still checks the ID and plan',async()=>{
 const f=fixture(),adapter=new StockSheetsAdapter({reader:f.reader,writer:{request:async()=>{}},spreadsheetId:'book',department:'box',layouts:async()=>new Set(),readiness:async()=>({})});
 const entry={row:6,article:'B',newQuantity:3,action:'insert',uid:'ritm-11111111-1111-4111-8111-111111111111-1',department:'box',layoutPresent:true};
 const plan={destination:'warehouse',sheetId:7,entries:[entry],requests:stockCellRequests(7,[entry])};
 for(const request of plan.requests){const {start,rows}=request.updateCells;f.rows[start.rowIndex].values[start.columnIndex]=rows[0].values[0];}
 f.rows[5].values[5]={userEnteredValue:{stringValue:'XPA'}};
 assert.equal(await adapter.verify(plan),true);
 f.rows[5].values[29]={userEnteredValue:{stringValue:'other-id'}};
 assert.equal(await adapter.verify(plan),false);
});

for(const department of ['box','roll'])test(department+' stock allocation skips archived UID and orphaned cells without changing them',async()=>{
 const f=fixture();
 while(f.rows.length<10)f.rows.push({values:Array(30).fill(null)});
 for(let index=4;index<10;index++)for(const column of [4,7,8,10,11])f.rows[index].values[column-1]={userEnteredValue:{formulaValue:'=1'}};
 // Existing product in row 5; row 6 is archived with its stable historical ID.
 f.rows[5].values[29]={userEnteredValue:{stringValue:'historical-uid'}};
 f.rows[6].values[2]={userEnteredValue:{formulaValue:'=IF(E7="";"";"Есть")'}};
 f.rows[7].values[5]={userEnteredValue:{stringValue:'old-extension'}};
 if(department==='roll')f.rows[8].values[8]={userEnteredValue:{formulaValue:'=IF(E9="";"";1)'}};
 const before=JSON.stringify(f.rows);
 const adapter=new StockSheetsAdapter({reader:f.reader,writer:{applyStockPlan:async()=>assert.fail('preparation must be read-only')},spreadsheetId:'book',department,layouts:async()=>new Set(),readiness:async()=>({})});
 const plan=await adapter.prepare('warehouse',[{article:'B',newQuantity:3,action:'insert',department}]);
 assert.equal(plan.entries[0].row,department==='roll'?10:9);
 assert.equal(JSON.stringify(f.rows),before);
});

test('stock batch selects distinct prepared rows and skips damaged template rows',async()=>{
 const f=fixture();while(f.rows.length<10)f.rows.push({values:Array(30).fill(null)});
 for(let index=6;index<10;index++)for(const column of [4,7,8,10,11])f.rows[index].values[column-1]={userEnteredValue:{formulaValue:'=1'}};
 const adapter=new StockSheetsAdapter({reader:f.reader,writer:{},spreadsheetId:'book',department:'box',layouts:async()=>new Set(),readiness:async()=>({})});
 const changes=['B','C','D'].map(article=>({article,newQuantity:3,action:'insert',department:'box'}));
 assert.deepEqual((await adapter.prepare('warehouse',changes)).entries.map(e=>e.row),[7,8,9]);
 await assert.rejects(adapter.prepare('warehouse',[...changes,...['E','F'].map(article=>({article,newQuantity:1,action:'insert',department:'box'}))]),/Нет подготовленных свободных строк/);
});
