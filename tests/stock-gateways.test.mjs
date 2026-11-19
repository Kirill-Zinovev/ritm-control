import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function fixture(department){
 const cells=Array(30).fill('');cells[3]='XEROX';cells[4]='A123';cells[6]=2;cells[13]=1;cells[15]=20;cells[21]='date';cells[22]='date';cells[27]=30;cells[28]=20;cells[29]='uid-1';
 const properties=new Map([['BOX_STOCK_SOURCE_ID','book']]);let locks=0,releases=0,recalculations=0;
 const sh={getName:()=> 'Запасы склад',getMaxRows:()=>100,getRange:(row,col,height=1,width=1)=>({getValues:()=>[cells.slice(col-1,col-1+width)],getValue:()=>cells[col-1],getFormula:()=>'',setValue:value=>{cells[col-1]=value;},setValues:values=>values[0].forEach((v,i)=>{cells[col-1+i]=v;}),clearContent:()=>{cells[col-1]='';}})};
 const props={getProperty:key=>properties.get(key)||null,setProperty:(key,value)=>properties.set(key,value)};
 const lock={waitLock:()=>locks++,tryLock:()=>{locks++;return true;},releaseLock:()=>releases++};
 const ctx={JSON,Number,String,Array,Object,Math,Error,Utilities:{DigestAlgorithm:{SHA_256:'x'},Charset:{UTF_8:'x'},computeDigest:()=>[1,2,3]},LockService:{getScriptLock:()=>lock},SpreadsheetApp:{openById:()=>({getSheetById:()=>sh}),setActiveSpreadsheet:()=>{},flush:()=>{}},boxHash_:value=>JSON.stringify(value),boxLocked_:fn=>{lock.waitLock();try{return fn();}finally{lock.releaseLock();}},withDocumentLock_:fn=>{lock.waitLock();try{return fn();}finally{lock.releaseLock();}},r2GetOrder_:()=>({article:cells[4],orderQty:cells[15]}),r2UpdateOrderProgress_:order=>{assert.equal(order.orderQty,30);recalculations++;return {};},r2WriteIfNoFormula_:()=>{},r2HeaderMap_:()=>({printRemaining:25})};
 const file=new URL(`../apps-script/stock-gateway/${department==='box'?'BoxGateway':'RollGateway'}.gs`,import.meta.url);vm.runInNewContext(readFileSync(file,'utf8'),ctx);
 return {ctx,cells,props,get locks(){return locks;},get releases(){return releases;},get recalculations(){return recalculations;}};
}
for(const department of ['box','roll'])test(`${department} stock gateway serializes changes and never repeats an operation`,()=>{
 const f=fixture(department),input={operationId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',sheetId:7,entries:[{action:'increase',row:5,article:'A123',previousQuantity:20,newQuantity:30}]};
 assert.equal(f.ctx.stockGatewayApply_({...input,dryRun:true},f.props).status,'validated');assert.equal(f.cells[15],20);
 assert.equal(f.ctx.stockGatewayApply_(input,f.props).status,'verified');assert.equal(f.cells[15],30);
 assert.equal(f.ctx.stockGatewayApply_(input,f.props).status,'verified');assert.equal(f.cells[15],30);
 assert.equal(f.ctx.stockGatewayApply_({...input,dryRun:true},f.props).status,'verified');assert.equal(f.cells[15],30);assert.equal(f.locks,4);assert.equal(f.releases,4);
 if(department==='box'){assert.equal(f.cells[18],false);assert.equal(f.cells[19],false);assert.equal(f.cells[21],'');assert.equal(f.cells[22],'');}
 else assert.equal(f.recalculations,1);
 const other={...input,operationId:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'};assert.throws(()=>f.ctx.stockGatewayApply_(other,f.props),/изменился|изменились/);assert.equal(f.cells[15],30);
});

test('empty roll stock template locates its explicitly labelled UID column',()=>{
 const headers=['Дата скидывания','Фото','Наличие макета','Станок','Артикул','расширения','Кол-во листов','Размер','Ширина','Высота','Объем','','','Кратность','','Кол-во','','Кол-во осталось','Печать','Порезка','Прогресс печати','Прогресс порезки','Дата готовности печати','Дата готовности порезки','остаток по печати:','','','Рулоны','',''];
 const sheet={getSheetId:()=>42,getName:()=> 'Запасы склад',getParent:()=>({getId:()=> '1vzLLRe7oi4IlvzIaWZd08dte7byCkqeXVAL4iSFqhOg'}),getLastColumn:()=>30,getLastRow:()=>4,getRange:(row,col)=>({getDisplayValues:()=>[headers],getDisplayValue:()=>row===1&&col===30?'UID':''})};
 const ctx={String,Number,Array,Object,Math,Error};
 vm.runInNewContext(readFileSync(new URL('../apps-script/stock-gateway/RollsV2.gs',import.meta.url),'utf8'),ctx);
 assert.equal(ctx.r2HeaderMap_(sheet).uid,30);
});
