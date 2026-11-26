import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBoxJournal,parseBoxCutJournal} from '../agent/boxPrintingJournal.js';
const header=['ID записи','Контроль запроса','Время','ID позиции','ID таблицы','ID листа','Поставка','Артикул','ID сотрудника','Сотрудник','Действие','Единица','Введено','Физических листов','Комплектов','Площадь, м²','План, комплектов','Листов в комплекте','План, листов','Ширина, м','Высота, м','Этап','Комментарий / причина','Отменяет ID'];
const row=(id,action,target='')=>[id,'hash','2026-11-02T10:00:00Z','p1','s',7,'OZON Test','A1','emp','Тест',action,'Листы',10,10,20,0.63,20,2,10,.21,.3,'','',target];

test('rate metadata uses active journal rows and unambiguous machine; cancellation cannot contribute',()=>{
 const a=row('rate','Печать'), cancelled=row('cancelled','Печать'), cancel=row('cancel','Отмена','cancelled');
 const orders=[{sourceId:'box-printing',spreadsheetId:'s',sheetId:7,article:'A1',machine:'XEROX'}];
 const result=boxPrintingEvents([header,a,cancelled,cancel],orders);
 assert.equal(result.length,1);assert.equal(result[0].machine,'xerox');assert.equal(result[0].spreadsheetId,'s');
 assert.equal(boxPrintingEvents([header,a],[...orders,{...orders[0],machine:'DTF'}])[0].machine,null);
});
test('cancelled records excluded, other employees and events retained',()=>{const a=row('a','Печать'),b=row('b','Печать'),cancel=row('c','Отмена','a');b[9]='Другой';const result=parseBoxJournal([header,a,b,cancel]);assert.equal(result.length,1);assert.equal(result[0].id,'b');assert.equal(result[0].employee,'Другой');});
test('duplicate IDs and unverified cancellations fail closed',()=>{const a=row('a','Печать');assert.throws(()=>parseBoxJournal([header,a,a]),/Повторный/);assert.throws(()=>parseBoxJournal([header,a,row('c','Отмена','missing')]),/Отмена/);});
import {boxPrintingEvents,boxCuttingEvents,loadBoxPrinting,loadStockBoxPrinting} from '../agent/boxPrintingJournal.js';
test('late supply dimensions restore blank box area for print and cut',()=>{
 const order={sourceId:'box-printing',spreadsheetId:'s',sheetId:7,article:'A1',machine:'XEROX',
  quantity:20,areaKnown:true,plannedArea:2.52,sheetsInProduct:2,widthM:.21,heightM:.3};
 for(const [action,parse] of [['Печать',boxPrintingEvents],['Порезка',boxCuttingEvents]]){
  const event=row('late',action);event[15]=event[19]=event[20]='';
  assert.equal(parse([header,event],[])[0].area,null);
  assert.equal(parse([header,event],[order,order])[0].area,null);
  assert.ok(Math.abs(parse([header,event],[order])[0].area-2.52)<1e-9);
  event[15]=.63;
  assert.equal(parse([header,event],[order])[0].area,.63);
 }
});
test('an archived Xerox position keeps its sheets when the same article is reused on another machine',()=>{const event=row('old','Печать');const orders=[{sourceId:'box-printing',spreadsheetId:'s',sheetId:7,article:'A1',machine:'XEROX',archived:true,boxPositionId:'p1'},{sourceId:'box-printing',spreadsheetId:'s',sheetId:7,article:'A1',machine:'УФ планшет'}];assert.equal(boxPrintingEvents([header,event],orders)[0].sheets,10);const next=row('new','Печать');next[3]='p2';assert.equal(boxPrintingEvents([header,next],orders)[0].sheets,null)});
test('stock box journal merges active events without requiring historical area snapshots',async()=>{
 const print=row('stock-event','Печать');print[4]='stock-source';
 const cut=row('stock-cut','Порезка');cut[4]='stock-source';cut[15]='';
 const values=[header,print,[],cut].map(r=>({values:r.map(value=>({effectiveValue:typeof value==='number'?{numberValue:value}:{stringValue:value}}))}));
 const reader={metadata:async()=>({spreadsheetId:'stock-journal',sheets:[{properties:{title:'Журнал',sheetId:8,gridProperties:{rowCount:4}}}]}),grid:async()=>({spreadsheetId:'stock-journal',sheets:[{properties:{sheetId:8},data:[{rowData:values}]}]})};
 const original={supplies:[],stockBox:{status:'available',orders:[]},boxPrinting:{status:'available',events:[],cutEvents:[],exceptions:[]}};
 const result=await loadStockBoxPrinting(reader,original,{journalId:'stock-journal',sourceId:'stock-source'});
 assert.equal(result.boxPrinting.stockStatus,'available');assert.equal(result.boxPrinting.events.length,1);
 assert.equal(result.boxPrinting.events[0].journalUrl,undefined);
 assert.equal(result.boxPrinting.cutEvents[0].area,null);
 assert.equal(result.boxPrinting.cutEvents[0].areaOrigin,'journal');
 assert.equal(result.boxPrinting.cutEvents[0].journalUrl,'https://docs.google.com/spreadsheets/d/stock-journal/edit#gid=8&range=P4');
 const wrong=await loadStockBoxPrinting(reader,original,{journalId:'stock-journal',sourceId:'different'});
 assert.equal(wrong.boxPrinting.stockStatus,'unavailable');assert.equal(wrong.boxPrinting.events.length,0);
});
test('identical sheet IDs in different books cannot cross-assign Xerox equipment',()=>{
 const event=row('stock-print','Печать');event[4]='stock-book';
 const orders=[{sourceId:'box-printing',spreadsheetId:'old-book',sheetId:7,article:'A1',machine:'УФ планшет'},{sourceId:'box-printing',spreadsheetId:'stock-book',sheetId:7,article:'A1',machine:'XEROX'}];
 const actual=boxPrintingEvents([header,event],orders);
 assert.equal(actual[0].sheets,10);
});
test('saved event area is stable when current plan changes',()=>{const a=row('a','Печать');a[15]=1.4;const orders=[{sourceId:'box-printing',sheetId:7,article:'A1',machine:'УФ планшет',quantity:40,plannedArea:28,areaKnown:true}];assert.equal(boxPrintingEvents([header,a],orders)[0].area,1.4);});
test('historical snapshot takes precedence over old journal formula',()=>{const a=row('a','Печать');a[15]=1.056;const history={areas:new Map([['a',4.224]]),cutoff:Date.parse(a[2])};const event=boxPrintingEvents([header,a],[{sourceId:'box-printing',sheetId:7,article:'A1',machine:'XEROX'}],history)[0];assert.equal(event.area,4.224);assert.equal(event.sheets,10);});
test('missing old snapshot stays unknown and new missing area stays unknown',()=>{const a=row('a','Печать');a[15]=2;const history={areas:new Map(),cutoff:Date.parse(a[2])};assert.equal(boxPrintingEvents([header,a],[],history)[0].area,null);a[15]='';history.cutoff=0;assert.equal(boxPrintingEvents([header,a],[],history)[0].area,null);});
test('legacy sheet entries are never labelled Xerox without confirmed equipment',()=>{const a=row('a','Печать');a[15]='';const events=boxPrintingEvents([header,a]);assert.equal(events[0].sheets,null);assert.equal(events[0].area,null);});
test('invalid active quantities and wrong-position cancellations rejected',()=>{const a=row('a','Печать');a[14]='bad';assert.throws(()=>boxPrintingEvents([header,a]),/Некорректная/);const b=row('b','Отмена','a');b[3]='other';assert.throws(()=>parseBoxJournal([header,row('a','Печать'),b]),/Отмена/);});
test('loader reads history and journal without writes',async()=>{const rows=[header,row('a','Печать'),row('b','Порезка')];const gridRows=rs=>rs.map(r=>({values:r.map(value=>({effectiveValue:typeof value==='number'?{numberValue:value}:{stringValue:value}}))}));const reader={metadata:async()=>({spreadsheetId:'TEST',sheets:[{properties:{title:'Журнал',sheetId:8,gridProperties:{rowCount:3}}},{properties:{title:'По дням',sheetId:9,gridProperties:{rowCount:3,columnCount:22}}}]}),grid:async(id,ranges)=>ranges[0].includes('По дням')?({spreadsheetId:id,sheets:[{properties:{sheetId:9},data:[{startRow:1,startColumn:20,rowData:gridRows([['a',4.2],['b',5.2]])}]}]}):({spreadsheetId:id,sheets:[{properties:{sheetId:8},data:[{rowData:gridRows(rows)}]}]})};const result=await loadBoxPrinting(reader,{supplies:[]},{journalId:'TEST'});assert.equal(result.boxPrinting.status,'available');assert.equal(result.boxPrinting.events[0].area,4.2);assert.equal(result.boxPrinting.cutEvents[0].area,5.2);assert.equal((await loadBoxPrinting(reader,{},{})).boxPrinting.status,'unavailable');});
test('verified Xerox dimensions fill only their original print records', async () => {
  const journalId = 'test-box-journal';
  const missing = (id, action = 'Печать') => {
    const event = row(id, action);
    event[15] = event[19] = event[20] = '';
    return event;
  };
  const rows = [header, missing('fixed'), missing('different-sheet'), missing('duplicate'),
    missing('cut', 'Порезка'), missing('cancelled'), row('cancel', 'Отмена', 'cancelled'),
    row('known', 'Печать')];
  const corrections = [
    ['ID записи', 'ID листа', 'Артикул', 'Ширина, м', 'Высота, м', 'Источник размера'],
    ['fixed', 7, 'A1', .15, .11, 'Подтверждённый макет'],
    ['different-sheet', 700, 'A1', .15, .11, 'Подтверждённый макет'],
    ['duplicate', 7, 'A1', .15, .11, 'Подтверждённый макет'],
    ['duplicate', 7, 'A1', .21, .30, 'Другой макет'],
    ['cut', 7, 'A1', .15, .11, 'Подтверждённый макет'],
    ['cancelled', 7, 'A1', .15, .11, 'Подтверждённый макет'],
    ['known', 7, 'A1', .15, .11, 'Подтверждённый макет'],
  ];
  const tabs = [
    {title:'Журнал', sheetId:8, rows},
    {title:'По дням', sheetId:9, rows:[['known', 4.2]], startRow:1, startColumn:20},
    {title:'Уточнения площади', sheetId:10, rows:corrections},
  ];
  const reader = {
    metadata: async () => ({spreadsheetId:journalId, sheets:tabs.map(tab => ({
      properties:{title:tab.title, sheetId:tab.sheetId, gridProperties:{rowCount:20,columnCount:22}},
    }))}),
    grid: async (id, ranges) => {
      const tab = tabs.find(t => ranges[0].includes(t.title));
      return {spreadsheetId:id, sheets:[{properties:{sheetId:tab.sheetId}, data:[{
        startRow:tab.startRow, startColumn:tab.startColumn,
        rowData:tab.rows.map(r => ({values:r.map(value => ({effectiveValue:typeof value==='number'
          ? {numberValue:value} : {stringValue:value}}))})),
      }]}]};
    },
  };
  const supplies = [{sourceId:'box-printing', spreadsheetId:'s', sheetId:7, article:'A1', machine:'XEROX'}];
  const report = (await loadBoxPrinting(reader, {supplies}, {journalId})).boxPrinting;
  assert.equal(report.status, 'available');
  const events = new Map(report.events.map(event => [event.id, event]));
  assert.ok(Math.abs(events.get('fixed').area - .66) < 1e-9);
  assert.equal(events.get('fixed').quantity, 20);
  assert.equal(events.get('fixed').sheets, 10);
  assert.equal(events.get('fixed').width, .15);
  assert.equal(events.get('fixed').areaOrigin, undefined);
  assert.equal(events.get('fixed').journalUrl, undefined);
  assert.equal(events.get('different-sheet').area, null);
  assert.equal(events.get('duplicate').area, null);
  assert.equal(events.get('known').area, 4.2);
  assert.equal(events.has('cancelled'), false);
  assert.equal(report.cutEvents[0].area, null);
  assert.equal(report.cutEvents[0].areaOrigin, 'historical');
  assert.equal(report.cutEvents[0].journalUrl, 'https://docs.google.com/spreadsheets/d/test-box-journal/edit#gid=8&range=P5');
  assert.equal(rows[1][15], '');
});
import {boxJournalExceptions} from '../agent/boxPrintingJournal.js';
test('defects and surplus retain original units and comments; cancelled entries excluded',()=>{const a=row('d','Брак'), b=row('s','Излишек'), c=row('c','Отмена','d'); b[11]='Шт. товара';b[12]=5;b[22]='Осталось после печати';const result=boxJournalExceptions([header,a,b,c]);assert.equal(result.length,1);assert.equal(result[0].id,'s');assert.equal(result[0].unit,'pieces');assert.equal(result[0].comment,'Осталось после печати');assert.equal(result[0].quantity,5);});
test('defect sheets are kept separate from printed totals',()=>{const defect=row('d','Брак');defect[22]='Полоса';const result=boxJournalExceptions([header,defect]);assert.equal(result[0].unit,'sheets');assert.equal(result[0].kind,'defect');assert.equal(boxPrintingEvents([header,defect]).length,0);});
test('printing event preserves its own employee comment from the journal',()=>{const a=row('a','Печать'),b=row('b','Печать');a[22]='Проверить цвет';b[22]='';const events=boxPrintingEvents([header,a,b]);assert.equal(events[0].comment,'Проверить цвет');assert.equal(events[1].comment,'');});
test('cutting quantity is separate, Xerox sheets remain independent, and cancelled cuts are excluded',()=>{const print=row('p','Печать'),cut=row('c','Порезка'),cancel=row('x','Отмена','c');cut[9]='Роман';cut[13]=12;cut[14]=24;cut[22]='Проверить рез';const rows=[header,print,cut,cancel];assert.equal(parseBoxJournal(rows).length,1);assert.equal(parseBoxCutJournal(rows).length,0);assert.equal(boxCuttingEvents(rows,[{sourceId:'box-printing',sheetId:7,article:'A1',machine:'XEROX'}]).length,0);const active=boxCuttingEvents([header,cut],[{sourceId:'box-printing',sheetId:7,article:'A1',machine:'XEROX'}]);assert.equal(active.length,1);assert.equal(active[0].quantity,24);assert.equal(active[0].sheets,12);assert.equal(active[0].comment,'Проверить рез');assert.equal(active[0].operation,'cut');});
test('non-Xerox cutting reports goods pieces and leaves Xerox sheets blank',()=>{const cut=row('cut','Порезка');cut[11]='Шт. товара';cut[13]='';cut[14]=18;const result=boxCuttingEvents([header,cut],[{sourceId:'box-printing',sheetId:7,article:'A1',machine:'УФ планшет'}]);assert.equal(result[0].quantity,18);assert.equal(result[0].sheets,null);});
