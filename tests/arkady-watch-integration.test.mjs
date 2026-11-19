import test from 'node:test';import assert from 'node:assert/strict';import {runArkadyWatch,runArkadyStockWatch} from '../worker/cloud/runtime.js';
import {completionPraise,encryptBitrixConfig,drainBitrixNotifications} from '../worker/cloud/bitrixNotifications.js';
import {CloudSheetsReader} from '../worker/cloud/googleSheets.js';
import {CloudStore} from '../worker/cloud/store.js';
import {LocalD1} from './helpers/d1-sqlite.mjs';
import {cloudSchemaStatements} from './helpers/cloud-schema.mjs';
const supply={id:'RITM-SUPPLY-test',name:'OZON Тест',parts:[{department:'box',sheetId:9}]};
function makeStore(){const values=new Map([['productionSupplies',[supply]],['bitrixNotificationConfig',{version:1}],['arkadyWatchStates',{'RITM-SUPPLY-test:box':{print:false,cut:false}}]]);const operations=new Map();const scope={operations,meta(key,v){if(arguments.length===2)values.set(key,v);return values.get(key)},putOperation(kind,value){operations.set(`${kind}:${value.id}`,{kind,value})}};return {scope:async()=>scope,withScope:async cb=>cb(scope),now:()=>Date.parse('2026-11-07T12:00:00Z'),values,operations}}
const printing={ok:true,quality:{status:'valid'},sheets:[{sourceId:'box-printing',sheetId:9,assemblyShipmentId:supply.id,spreadsheetUrl:'https://docs.google.com/spreadsheets/d/test/edit#gid=9'}],supplies:[{sourceId:'box-printing',sheetId:9,assemblyShipmentId:supply.id,uid:'u',quantity:20,printProgress:20,cutProgress:20}]};
test('maintenance queues a completion with praise exactly once without changing source data',async()=>{const store=makeStore();const before=structuredClone(printing);const one=await runArkadyWatch({},store,printing);assert.equal(one.queued,1);assert.equal((await runArkadyWatch({},store,printing)).queued,0);const event=[...store.operations.values()][0].value;assert.match(event.message,/Печать и порезка завершены/);assert.match(event.message,/Открыть таблицу участка/);assert.match(event.message,/\[I\].+\[\/I\]/);assert.deepEqual(printing,before)});
test('unconfirmed snapshot never changes state or sends messages',async()=>{const store=makeStore();const old=structuredClone(store.values.get('arkadyWatchStates'));let result=await runArkadyWatch({},store,{...printing,stale:true});assert.equal(result.queued,0);assert.deepEqual(store.values.get('arkadyWatchStates'),old);assert.equal(store.operations.size,0)});

test('stock and supply completions still praise after all old phrases, queue once and never contact the chat', async t => {
  const store = makeStore(), scope = await store.scope();
  for (let i = 0; i < 16; i++) completionPraise(scope, `old-${i}`);
  const legacyHistory = structuredClone(store.values.get('bitrixCompletionPraisesUsed'));
  store.values.set('bitrixHumorLevel', 'off');
  store.values.set('arkadyStockBatchWatchStatesV1', {'stock-test': {eligible:true, notified:false}});
  const operation = {id:'stock-test', status:'verified', destination:'urgent', createdAt:'2026-11-07T11:00:00Z', steps:[
    {department:'box', status:'verified', plan:{sheetId:7, entries:[{row:5, uid:'stock-uid', article:'TEST001', quantity:32}]}},
  ]};
  store.operations.set('stock:stock-test', {kind:'stock', value:operation});
  const boxId = 'SYNTHETIC_STOCK_BOX_000000000', rollId = 'SYNTHETIC_STOCK_ROLL_000000000';
  const properties = {sheetId:7, title:'Срочные 2 этаж', gridProperties:{rowCount:5, columnCount:30}};
  const rowData = Array.from({length:5}, () => ({values:[]}));
  const cell = value => ({userEnteredValue: typeof value === 'number' ? {numberValue:value} : {stringValue:value}});
  rowData[3].values[4] = cell('Артикул'); rowData[3].values[15] = cell('Кол-во');
  for (const [index, value] of [[3,'Уф планшет'], [4,'TEST001'], [15,32], [21,'07.11.2026'], [22,'07.11.2026'], [27,32], [28,32], [29,'stock-uid']]) rowData[4].values[index] = cell(value);
  const sourceBefore = structuredClone({rowData,operation,printing});
  t.mock.method(CloudSheetsReader.prototype, 'metadata', async id => {
    assert.equal(id, boxId);
    return {spreadsheetId:id, sheets:[{properties}]};
  });
  t.mock.method(CloudSheetsReader.prototype, 'grid', async (id, ranges) => {
    assert.equal(id, boxId); assert.deepEqual(ranges, ["'Срочные 2 этаж'!A1:AD5"]);
    return {spreadsheetId:id, sheets:[{properties, data:[{rowData}]}]};
  });
  let outbound = 0;
  const options = {fetcher:async () => {outbound++; throw Error('Live network forbidden');}};
  const bindings = {RITM_GOOGLE_STOCK_BOX_PRINTING_ID:boxId, RITM_GOOGLE_STOCK_ROLL_PRINTING_ID:rollId};
  assert.equal((await runArkadyStockWatch(bindings,store,options)).queued, 1);
  assert.equal((await runArkadyWatch(bindings,store,printing,options)).queued, 1);
  const messages = [...store.operations.values()].filter(row => row.kind === 'bitrix-notification').map(row => row.value);
  assert.equal(messages.length, 2);
  assert.equal(messages.every(message => message.status === 'pending' && /\[I\].+\[\/I\]/u.test(message.message)), true);
  assert.equal(messages.every(message => message.presentation?.version===1&&message.presentation.type==='completion'),true);
  assert.equal(messages[0].presentation.entries[0].article,'TEST001');assert.equal(messages[0].presentation.entries[0].quantity,32);
  assert.equal(messages[0].presentation.url,`https://docs.google.com/spreadsheets/d/${boxId}/edit#gid=7`);
  assert.match(messages[0].message, /TEST001[\s\S]*32 шт\./u);
  assert.match(messages[1].message, /Печать и порезка завершены/u);
  assert.notEqual(messages[0].message.match(/\[I\](.+)\[\/I\]/u)[1], messages[1].message.match(/\[I\](.+)\[\/I\]/u)[1]);
  assert.equal((await runArkadyStockWatch(bindings,store,options)).queued, 0);
  assert.equal((await runArkadyWatch(bindings,store,printing,options)).queued, 0);
  assert.equal(store.values.get('bitrixCompletionPraiseSequenceV2'), '2');
  assert.deepEqual(store.values.get('bitrixCompletionPraisesUsed'), legacyHistory);
  assert.deepEqual({rowData,operation,printing}, sourceBefore);
  assert.equal(outbound, 0);
});

test('a mixed stock upload produces one native completion after every member is ready and never sends old individual completions', async t => {
  const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));t.after(()=>db.close());
  const store=new CloudStore(db,{now:()=>Date.parse('2026-11-07T12:00:00Z')}),scope=await store.scope();
  const boxId='SYNTHETIC_STOCK_BOX_000000000',rollId='SYNTHETIC_STOCK_ROLL_000000000';
  const bindings={RITM_GOOGLE_STOCK_BOX_PRINTING_ID:boxId,RITM_GOOGLE_STOCK_ROLL_PRINTING_ID:rollId,RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)};
  scope.meta('bitrixNotificationConfig',await encryptBitrixConfig(bindings,{RITM_BITRIX_WEBHOOK_URL:'https://kaleidoskop.bitrix24.ru/rest/1/fictionalkey/',RITM_BITRIX_BOT_TOKEN:'fictional-client-key',RITM_BITRIX_BOT_ID:'5768',RITM_BITRIX_BOX_CHAT:'chat1',RITM_BITRIX_ROLL_CHAT:'chat2'}));
  const cell=value=>({userEnteredValue:typeof value==='number'?{numberValue:value}:typeof value==='boolean'?{boolValue:value}:{stringValue:value}});
  const source=(sheetId,entries)=>{
    const rowData=Array.from({length:entries.length+4},()=>({values:[]}));rowData[3].values[4]=cell('Артикул');rowData[3].values[15]=cell('Кол-во');
    for(const [index,entry] of entries.entries())for(const [col,value] of [[3,sheetId===7?'Уф планшет':'2-GO'],[4,entry.article],[15,entry.quantity],[21,'07.11.2026'],[22,'07.11.2026'],[23,'07.11.2026'],[27,entry.quantity],[28,entry.quantity],[29,entry.uid]])rowData[index+4].values[col]=cell(value);
    return {properties:{sheetId,title:'Срочные 2 этаж',gridProperties:{rowCount:rowData.length,columnCount:30}},data:[{rowData}]};
  };
  const box=source(7,[{article:'BOX001',quantity:32,uid:'box-one'},{article:'BOX002',quantity:10,uid:'box-two'}]);
  const roll=source(8,[{article:'ROLL001',quantity:20,uid:'roll-one'}]);
  const table=(sheetId,title,rows)=>({properties:{sheetId,title,gridProperties:{rowCount:rows.length,columnCount:rows[0].length}},data:[{rowData:rows.map(values=>({values:values.map(cell)}))}]});
  const rolls=table(9,'ROLLS_V2',[
    ['ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','ROLL_NAME','ROLL_NUMBER','PRINT_READY','CUT_READY','CREATED_AT','UPDATED_AT','ROLL_QUANTITY','PRINT_DONE_AT','PRINT_EMPLOYEE','CUT_DONE_AT','CUT_EMPLOYEE','LEGACY_SOURCE'],
    ['r-one','roll-one','Срочные 2 этаж',5,'ROLL001','п1',1,true,true,'2026-11-07','2026-11-07',20,'2026-11-07','Паша','2026-11-07','Лукман',''],
  ]);
  const progress=table(10,'ROLLS_V2_PROGRESS',[['EVENT_ID','ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','OPERATION','EMPLOYEE','DATE','QUANTITY','AREA_PER_ITEM','AREA','ENTERED_AT','COMMENT']]);
  const journal=table(11,'Журнал выпуска',[['ID записи','Дата','Сотрудник','Операция','Лист-источник','Строка заказа','Артикул','UID заказа','Рулон','Сделано','м² на 1 шт.','Выпуск м²','Время записи','Комментарий','ID рулона']]);
  const books=new Map([[boxId,[box]],[rollId,[roll,rolls,progress,journal]]]);
  t.mock.method(CloudSheetsReader.prototype,'metadata',async id=>({spreadsheetId:id,sheets:books.get(id).map(sheet=>({properties:sheet.properties}))}));
  t.mock.method(CloudSheetsReader.prototype,'grid',async(id,ranges)=>({spreadsheetId:id,sheets:ranges.map(range=>books.get(id).find(sheet=>sheet.properties.title===range.match(/^'([^']+)'!/)[1]))}));
  const operation={id:'mixed-list',status:'verified',destination:'urgent',manager:'Кирилл',createdAt:'2026-11-07T11:00:00Z',steps:[
    {department:'box',status:'verified',plan:{sheetId:7,entries:[{row:5,uid:'box-one',article:'BOX001',quantity:32,newQuantity:32},{row:6,uid:'box-two',article:'BOX002',quantity:10,newQuantity:10}]}},
    {department:'roll',status:'verified',plan:{sheetId:8,entries:[{row:5,uid:'roll-one',article:'ROLL001',quantity:20,newQuantity:20}]}},
  ]};scope.putOperation('stock',operation);
  const legacy={id:'stock:box:7:box-one:complete:0',status:'pending',department:'roll',message:'old individual'};scope.putOperation('bitrix-notification',legacy);
  scope.putOperation('bitrix-notification',{...legacy,id:'stock:box:7:old:complete:0',status:'uncertain'});
  const legacyState={'box:7:box-one':{plan:32,readyBoth:true}};scope.meta('arkadyStockWatchStates',structuredClone(legacyState));
  await store.withScope(persist=>{
    for(const key of ['bitrixNotificationConfig','arkadyStockWatchStates'])persist.meta(key,scope.meta(key));
    for(const row of scope.operations.values())persist.putOperation(row.kind,row.value);
  });
  const noNetwork={fetcher:async()=>assert.fail('Live network forbidden')};
  box.data[0].rowData[5].values[28]=cell(0);
  assert.equal((await runArkadyStockWatch(bindings,store,noNetwork)).queued,0);
  assert.equal((await store.scope()).operations.get(`bitrix-notification:${legacy.id}`).value.status,'superseded');
  box.data[0].rowData[5].values[28]=cell(10);const sourceBefore=structuredClone([...books]);
  assert.equal((await runArkadyStockWatch(bindings,store,noNetwork)).queued,1);
  const event=(await store.scope()).operations.get('bitrix-notification:stock-batch:mixed-list:complete').value;
  assert.equal(event.presentation.sections.length,2);assert.equal(event.presentation.entries.length,3);assert.equal(event.presentation.quantity,62);
  let sends=0;const fake=async(url,init)=>{sends++;assert.ok(url.endsWith('imbot.message.add'));const payload=JSON.parse(init.body),body=JSON.stringify(payload.ATTACH);const articleRows=payload.ATTACH.BLOCKS.flatMap(block=>block.GRID||[]).filter(row=>/^(ROLL|BOX)00/.test(row.NAME));assert.deepEqual(articleRows.map(({NAME,VALUE})=>[NAME,VALUE]),[['ROLL001','20 шт.'],['BOX001','32 шт.'],['BOX002','10 шт.']]);assert.match(body,/✅ Печать и порезка готовы/);return Response.json({result:123});};
  await drainBitrixNotifications(bindings,store,fake);
  const reloaded=new CloudStore(db,{now:store.now});assert.equal((await runArkadyStockWatch(bindings,reloaded,noNetwork)).queued,0);await drainBitrixNotifications(bindings,reloaded,fake);
  const saved=await reloaded.scope();assert.equal(sends,1);assert.equal(saved.meta('bitrixCompletionPraisesUsed').length,1);assert.deepEqual(saved.meta('arkadyStockWatchStates'),legacyState);
  assert.equal(saved.operations.get('bitrix-notification:stock-batch:mixed-list:complete').value.status,'sent');
  assert.equal(saved.operations.get('bitrix-notification:stock:box:7:old:complete:0').value.status,'uncertain');assert.deepEqual([...books],sourceBefore);
});

