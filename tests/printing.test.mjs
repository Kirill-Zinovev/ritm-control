import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  indexOrders,
  collectJournalPrinting,
  collectJournalCutting,
  SUPPLY_SHEETS,
  ROLL_PRINTING_SHEET,
  ROLL_PRINTING_SHEET_ID,
  BOX_PRINTING_SHEET_ID,
  PRINTING_SOURCES,
  loadPrinting,
  loadStockRollPrinting,
  loadStockBoxOrders,
  assignCatalogStores,
} from "../worker/printing.js";

test('stock roll journal adds work without adding assembly supplies',async()=>{
 const csv=rows=>rows.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n');
 const order=Array.from({length:5},()=>Array(30).fill(''));order[0][28]='UID';order[3][4]='Артикул';order[3][14]='Кол-во';order[4][4]='A';order[4][14]=10;order[4][28]='stock-uid';
 const empty=order.map(row=>[...row]);empty[4][4]='';empty[4][14]='';empty[4][28]='';
 const header=Array(15).fill('');for(const [col,value] of Object.entries(PRINTING_SOURCES.find(s=>s.id==='roll-printing').journal.expectedHeaders))header[col]=value;
 const event=Array(15).fill('');event[0]='event';event[1]='04.11.2026';event[2]='Дмитрий';event[3]='Печать';event[4]='Запасы склад';event[6]='A';event[7]='stock-uid';event[9]=5;event[11]=1;
 const base={events:[],cutEvents:[],issues:[],supplies:[]};
 const result=await loadStockRollPrinting(async url=>{const gid=Number(new URL(url).searchParams.get('gid'));return new Response(csv(gid===1?order:gid===2?empty:[header,event]));},base,{spreadsheetId:'stock-book',sheets:[{gid:1,name:'Запасы склад'},{gid:2,name:'Срочные 2 этаж'}],journalId:3});
 assert.equal(result.stockRoll.status,'available');assert.equal(result.events.length,1);assert.equal(result.events[0].quantity,5);assert.equal(result.supplies.length,0);
});
test('unrelated seasonal sheets may contain duplicate stock-remaining headings',()=>{
 const rows=Array.from({length:4},()=>Array(30).fill(''));rows[0][29]='UID';rows[2][4]='Артикул';rows[2][14]='Кол-во';
 rows[2][16]='Кол-во осталось';rows[2][17]='Кол-во осталось';rows[3][4]='SEASON-TEST';rows[3][14]=10;rows[3][29]='season-uid';
 const result=indexOrders([{gid:1,name:'Сезонная',rows,sourceId:'seasonal-printing'}]);assert.equal(result.orders.length,1);assert.equal(result.orders[0].article,'SEASON-TEST');
});
test('new stock roll uses its remaining plan only with verified empty histories',async()=>{
 const csv=rows=>rows.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n');
 const uid='ritm-e4b754ba-465f-41b3-b48a-d6d3d887fe41-14';
 const order=Array.from({length:5},()=>Array(30).fill(''));order[0][29]='UID';
 for(const [i,h] of Object.entries({4:'Артикул',15:'Кол-во',17:'Кол-во осталось',18:'Печать',19:'Порезка',20:'Прогресс печати',21:'Прогресс порезки',22:'Дата готовности печати',23:'Дата готовности порезки',24:'остаток по печати:',27:'Рулоны'}))order[3][i]=h;
 order[4][4]='FD-TEST';order[4][15]=300;order[4][17]=300;order[4][29]=uid;
 const empty=order.map(row=>[...row]);empty[4]=Array(30).fill('');
 const journal=Array(15).fill('');for(const [col,value] of Object.entries(PRINTING_SOURCES.find(s=>s.id==='roll-printing').journal.expectedHeaders))journal[col]=value;
 journal[4]='Лист-источник';journal[6]='Артикул';
 const rolls=['ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','ROLL_NAME','ROLL_NUMBER','PRINT_READY','CUT_READY','CREATED_AT','UPDATED_AT','ROLL_QUANTITY','PRINT_DONE_AT','PRINT_EMPLOYEE','CUT_DONE_AT','CUT_EMPLOYEE','LEGACY_SOURCE'];
 const progress=['EVENT_ID','ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','OPERATION','EMPLOYEE','DATE','QUANTITY','AREA_PER_ITEM','AREA','ENTERED_AT','COMMENT'];
 const base={events:[],cutEvents:[],issues:[],supplies:[]};
 const options={spreadsheetId:'stock-book',sheets:[{gid:1,name:'Запасы склад'},{gid:2,name:'Срочные 2 этаж'}],journalId:3,historyIds:[4,5]};
 let histories=[[rolls],[progress]],fail=false;
 const read=()=>loadStockRollPrinting(async url=>{const gid=Number(new URL(url).searchParams.get('gid'));if(fail&&gid===4)return new Response('',{status:503});return new Response(csv(gid===1?order:gid===2?empty:gid===3?[journal]:histories[gid-4]));},base,options);
 const before=structuredClone(order);let result=await read();
 assert.equal(result.stockRoll.status,'available');assert.equal(result.stockRoll.orders[0].planningPrinted,0);assert.equal(result.stockRoll.orders[0].planningCut,0);assert.deepEqual(order,before);
 histories=[[rolls,['roll-id',uid,'Запасы склад',5,'FD-TEST']],[progress]];result=await read();assert.equal(result.stockRoll.orders[0].planningPrinted,undefined);
 histories=[[rolls],[progress]];fail=true;result=await read();assert.equal(result.stockRoll.status,'available');assert.equal(result.stockRoll.orders[0].planningPrinted,undefined);
 fail=false;histories=[[['unexpected header']],[progress]];result=await read();assert.equal(result.stockRoll.orders[0].planningPrinted,undefined);
 histories=[[rolls],[progress]];order[4][24]='#N/A';result=await read();assert.equal(result.stockRoll.orders[0].planningPrinted,undefined);
});
test('box stock orders remain separate from supply and Assembly lists',async()=>{
 const csv=rows=>rows.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n');
 const rows=Array.from({length:5},()=>Array(30).fill(''));rows[3][3]='Станок';rows[3][4]='Артикул';rows[3][15]='Кол-во';rows[4][3]='XEROX';rows[4][4]='A';rows[4][15]=10;
 const result=await loadStockBoxOrders(async()=>new Response(csv(rows)),{supplies:[]},{spreadsheetId:'stock-book',sheets:[{gid:1,name:'Запасы склад'},{gid:2,name:'Срочные 2 этаж'}]});
 assert.equal(result.stockBox.status,'available');assert.equal(result.stockBox.orders.length,2);assert.equal(result.supplies.length,0);
});
test('box stock reads the unlabeled AD identity and rejects a conflicting template',async()=>{
 const csv=rows=>rows.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n');
 const rows=Array.from({length:5},()=>Array(30).fill(''));rows[3][3]='Станок';rows[3][4]='Артикул';rows[3][15]='Кол-во';rows[3][28]='Порезано годных';rows[4][3]='XEROX';rows[4][4]='TEST';rows[4][15]=10;rows[4][28]=0;rows[4][29]='ritm-test-uid';
 const options={spreadsheetId:'stock-book',sheets:[{gid:1,name:'Запасы склад'},{gid:2,name:'Срочные 2 этаж'}]};
 const read=()=>loadStockBoxOrders(async()=>new Response(csv(rows)),{supplies:[]},options);
 const valid=await read();assert.equal(valid.stockBox.status,'available');
 assert.equal(valid.stockBox.orders[0].rawUid,'ritm-test-uid');
 assert.equal(valid.stockBox.orders[0].uid,'1::ritm-test-uid');
 rows[3][29]='Другая колонка';assert.equal((await read()).stockBox.status,'unavailable');
});
test('archived stock order keeps roll production visible after its source row is cleared',async()=>{
 const csv=rows=>rows.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n');
 const empty=Array.from({length:5},()=>Array(30).fill(''));empty[0][29]='UID';empty[3][4]='Артикул';empty[3][15]='Кол-во';
 const header=Array(15).fill('');for(const [col,value] of Object.entries(PRINTING_SOURCES.find(s=>s.id==='roll-printing').journal.expectedHeaders))header[col]=value;
 const event=Array(15).fill('');event[0]='event';event[1]='04.11.2026';event[2]='Дмитрий';event[3]='Печать';event[4]='Запасы склад';event[6]='A';event[7]='old-id';event[9]=5;event[11]=1;
 const values=Array(30).fill('');values[4]='A';values[15]=5;values[29]='old-id';
 const archive=[['Операция','Дата','Лист','Строка','UID','Артикул','План','Данные строки'],['operation','2026-11-06T12:00:00Z','Запасы склад',5,'old-id','A',5,JSON.stringify({values})]];
 const base={events:[],cutEvents:[],issues:[],supplies:[]};const result=await loadStockRollPrinting(async url=>{const gid=Number(new URL(url).searchParams.get('gid'));return new Response(csv(gid===4?archive:gid===3?[header,event]:empty));},base,{spreadsheetId:'stock-book',sheets:[{gid:1,name:'Запасы склад'},{gid:2,name:'Срочные 2 этаж'}],journalId:3,archiveId:4});
 assert.equal(result.stockRoll.status,'available');assert.equal(result.events.length,1);assert.equal(result.events[0].quantity,5);
});

test("store lookup respects marketplace aliases, errors and conflicting duplicates", () => {
  const catalog = {
    WB: [["Артикул", "Артикул (oz)", "магазин"], ["WB-OWN", "WB-ALIAS", "2"], ["ONLY-WB", "", "1"]],
    OZON: [["Артикул", "", "магазин"], ["OZ-OWN(OZ)", "OZ-ALIAS", "1"], ["ERROR", "", "#N/A"], ["EMPTY", "", ""], ["CONFLICT", "", "1"], ["CONFLICT", "", "2"]],
  };
  const orders = [
    { sheetName: "ВБ Новая", article: "WB-ALIAS" },
    { sheetName: "ОЗОН Новая", article: "OZ-ALIAS" },
    { sheetName: "OZON Новая", article: "ONLY-WB", shop: "1" },
    { sheetName: "OZON Новая", article: "ERROR" },
    { sheetName: "OZON Новая", article: "EMPTY" },
    { sheetName: "OZON Новая", article: "CONFLICT" },
    { sheetName: "Неизвестная", article: "OZ-ALIAS" },
  ];
  const result = assignCatalogStores(orders, catalog);
  assert.deepEqual(result, { status: "partial", matched: 2, missing: 3, ambiguous: 1 });
  assert.equal(orders[0].shop, "2");
  assert.equal(orders[1].shop, "1");
  assert.equal(orders[2].shopCatalogReason, "article_missing");
  assert.equal(orders[3].shopCatalogReason, "store_error");
  assert.equal(orders[4].shopCatalogReason, "store_empty");
  assert.equal(orders[5].shopCatalogStatus, "ambiguous");
  assert.equal(orders[6].shopCatalogStatus, "unknown_marketplace");
  assignCatalogStores([orders[0]], null);
  assert.equal(orders[0].shopCatalogStatus, "unavailable");
});

test("new registered roll, box and shared supplies load automatically with stable identities", async () => {
  const csv = rows => rows.map(row => row.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
  const parts = [
    { department: "roll", documentId: ROLL_PRINTING_SHEET_ID, sheetId: 900101, article: "ROLL-SHARED", quantity: 7 },
    { department: "box", documentId: BOX_PRINTING_SHEET_ID, sheetId: 900102, article: "BOX-SHARED", quantity: 13 },
    { department: "roll", documentId: ROLL_PRINTING_SHEET_ID, sheetId: 900103, article: "ROLL-ONLY", quantity: 11 },
    { department: "box", documentId: BOX_PRINTING_SHEET_ID, sheetId: 900104, article: "BOX-ONLY", quantity: 17 },
  ];
  const requested = [], activeBooks = new Map();
  let activeReads = 0, peakReads = 0;
  const result = await loadPrinting(async url => {
    const parsed = new URL(url), documentId = parsed.pathname.split('/')[3], gid = Number(parsed.searchParams.get('gid'));
    activeReads++;
    peakReads = Math.max(peakReads, activeReads);
    activeBooks.set(documentId,(activeBooks.get(documentId)||0)+1);
    assert.equal(activeBooks.size,1,'raw grids of different workbooks must not overlap');
    await new Promise(resolve=>setTimeout(resolve,1));
    activeReads--;
    const remaining = activeBooks.get(documentId)-1;
    if (remaining) activeBooks.set(documentId,remaining); else activeBooks.delete(documentId);
    requested.push(documentId + ':' + gid);
    const source = PRINTING_SOURCES.find(s => s.spreadsheetId === documentId);
    if (source?.journal?.gid === gid) {
      const headers = Array(15).fill('');
      for (const [column, header] of Object.entries(source.journal.expectedHeaders)) headers[column] = header;
      return new Response(csv([headers]));
    }
    const part = parts.find(p => p.documentId === documentId && p.sheetId === gid);
    const descriptor = source?.supplies.find(s => s.gid === gid);
    const headerRow = part ? 4 : descriptor?.headerRow || 3;
    const rows = Array.from({ length: 4 }, () => Array(29).fill(''));
    rows[0][28] = 'UID'; rows[headerRow - 1][4] = 'Артикул'; rows[headerRow - 1][14] = 'Кол-во';
    if (part) {
      const row = Array(29).fill(''); row[4] = part.article; row[14] = part.quantity; row[28] = part.article;
      rows.push(row);
    }
    return new Response(csv(rows));
  }, {
    additionalSheets: [{ gid: 900101, name: "OZON Общая" }],
    productionSupplies: [
      { id: "shared", name: "OZON Общая", parts: parts.slice(0, 2) },
      { id: "roll-only", name: "WB Рулон", parts: [parts[2]] },
      { id: "box-only", name: "WB Бокс", parts: [parts[3]] },
    ],
  });
  assert.equal(result.supplies.length, 4);
  assert.ok(peakReads > 1 && peakReads <= 4,'source reads are concurrent but bounded');
  assert.equal(result.supplies.reduce((sum, item) => sum + item.quantity, 0), 48);
  for (const part of parts) {
    assert.equal(requested.filter(key => key === part.documentId + ':' + part.sheetId).length, 1);
    const sheet = result.sheets.find(sheet => sheet.sheetId === part.sheetId);
    const order = result.supplies.find(order => order.sheetId === part.sheetId);
    assert.ok(sheet?.assemblyShipmentId);
    assert.equal(sheet.assemblyShipmentId, order.assemblyShipmentId);
  }
  assert.equal(result.sheets.find(sheet => sheet.sheetId === 900101).assemblyShipmentId, "shared");
  assert.equal(result.sheets.find(sheet => sheet.sheetId === 900102).assemblyShipmentId, "shared");
  assert.equal(result.events.length, 0);
});

test("box jobs load without an invented production journal or printer KPI", async () => {
  const csv = rows => rows.map(row => row.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
  const requested = [];
  const result = await loadPrinting(async url => {
    const parsed = new URL(url), documentId = parsed.pathname.split('/')[3], gid = Number(parsed.searchParams.get('gid'));
    requested.push({ documentId, gid });
    const source = PRINTING_SOURCES.find(s => s.spreadsheetId === documentId);
    if (source && gid === source.journal.gid) {
      const headers = Array(15).fill('');
      for (const [column, header] of Object.entries(source.journal.expectedHeaders)) headers[column] = header;
      return new Response(csv([headers]));
    }
    const rows = Array.from({ length: 4 }, () => Array(29).fill(''));
    const descriptor = source?.supplies.find(s => s.gid === gid);
    const headerRow = descriptor?.headerRow || (documentId === BOX_PRINTING_SHEET_ID ? 4 : 3);
    rows[0][28] = 'UID'; rows[headerRow - 1][4] = 'Артикул'; rows[headerRow - 1][14] = 'Кол-во';
    if (documentId === BOX_PRINTING_SHEET_ID) {
      const row = Array(29).fill(''); row[4] = 'BOX'; row[14] = 25; row[17] = 'TRUE'; row[18] = 'FALSE'; row[28] = 'box-id'; rows.push(row);
    }
    return new Response(csv(rows));
  }, { productionSupplies: [{ id: 'common', name: 'OZON Общая', parts: [{ department: 'box', documentId: BOX_PRINTING_SHEET_ID, sheetId: 700 }] }] });
  assert.equal(result.supplies.length, 1);
  assert.equal(result.supplies[0].sourceId, 'box-printing');
  assert.equal(result.supplies[0].assemblyShipmentId, 'common');
  assert.equal(result.events.length, 0);
  assert.equal(requested.filter(r => r.documentId === BOX_PRINTING_SHEET_ID).length, 1);
});

test("Assembly-linked box sheets load with row-based identity and share the roll shipment", async () => {
  const csv = rows => rows.map(row => row.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
  const requested = [];
  const rollSheetId = 900001;
  const boxSheetId = 900002;
  const result = await loadPrinting(async url => {
    const parsed = new URL(url);
    const documentId = parsed.pathname.split('/')[3];
    const gid = Number(parsed.searchParams.get('gid'));
    requested.push({ documentId, gid });
    const source = PRINTING_SOURCES.find(s => s.spreadsheetId === documentId);
    if (source?.journal?.gid === gid) {
      const headers = Array(15).fill('');
      for (const [column, header] of Object.entries(source.journal.expectedHeaders)) headers[column] = header;
      return new Response(csv([headers]));
    }
    const box = documentId === BOX_PRINTING_SHEET_ID && gid === boxSheetId;
    const descriptor = source?.supplies.find(sheet => sheet.gid === gid) ||
      (documentId === ROLL_PRINTING_SHEET_ID && gid === rollSheetId ? ROLL_PRINTING_SHEET : null);
    const rows = Array.from({ length: box ? 4 : 4 }, () => Array(29).fill(''));
    if (!box) rows[0][28] = 'UID';
    const headerRow = box ? 4 : descriptor?.headerRow || 3;
    rows[headerRow - 1][4] = 'Артикул';
    rows[headerRow - 1][14] = 'Кол-во';
    if (box) {
      const order = Array(29).fill('');
      order[4] = 'BOX-SKU';
      order[9] = '12.5';
      order[14] = '25';
      rows.push(order);
    }
    return new Response(csv(rows));
  }, {
    additionalSheets: [{ gid: rollSheetId, name: 'OZON linked roll' }],
    productionSupplies: [{
      id: 'shared-shipment',
      name: 'OZON linked roll',
      parts: [{ department: 'roll', documentId: ROLL_PRINTING_SHEET_ID, sheetId: rollSheetId }],
    }],
    assemblyBoxLinks: [{
      name: 'OZON linked roll',
      boxSheetId,
      targetRollSheetId: rollSheetId,
      boxRows: 1,
      boxQuantity: 25,
      positionKeys: ['row:5|BOX-SKU'],
    }],
  });
  const boxOrder = result.supplies.find(order => order.sourceId === 'box-printing');
  assert.ok(requested.some(request => request.documentId === BOX_PRINTING_SHEET_ID && request.gid === boxSheetId));
  assert.equal(boxOrder?.article, 'BOX-SKU');
  assert.equal(boxOrder?.uid, `${boxSheetId}::row:5`);
  assert.equal(boxOrder?.rawUid, null);
  assert.equal(boxOrder?.assemblyShipmentId, 'shared-shipment');
  assert.equal(boxOrder?.plannedArea, 12.5);
  assert.equal(boxOrder?.areaKnown, true);
  assert.equal(result.issues.some(issue => issue.source === 'OZON linked roll' && issue.code === 'missing_uid'), false);
});
const o = {
  uid: "NY-0001",
  rawUid: "NY-0001",
  sheetId: 437912546,
  sheetName: "OZON НОВЫЙ ГОД",
  article: "ART",
};
const ix = {
  orders: [o],
  byUid: { [o.uid]: o },
  byRaw: { [o.uid]: [o] },
  issues: [],
};

test('journal rate metadata comes from the exact source order, never another article match',()=>{
 const order={...o,machine:'2-GO',sourceId:'roll-printing'};
 const index={...ix,orders:[order],byUid:{[order.uid]:order},byRaw:{[order.uid]:[order]}};
 const row=['meta','12.11.2026','Дмитрий','Печать',order.sheetName,4,order.article,order.uid,'Д1',10,1,10];
 assert.equal(collectJournalPrinting(index,[row]).events[0].machine,'2-GO');
 const removed={...index,orders:[],byUid:{},byRaw:{}};
 const historical=collectJournalPrinting(removed,[row],{orderFallback:order,journalOrderFallback:{...order,machine:undefined}});
 assert.equal(historical.events.length,1,'historical output remains in its KPI');assert.equal(historical.events[0].machine,null,'historical facts do not acquire a guessed machine');
});
const log = (
  qty = 40,
  area = 7.04,
  name = "Павел",
  id = "j1",
  date = "06.10.2026",
) => [
  id,
  date,
  name,
  "Печать",
  o.sheetName,
  4,
  o.article,
  o.uid,
  "д1",
  qty,
  0.176,
  area,
  "",
  "",
  "r1",
];
const total = (r) => r.events.reduce((n, e) => n + e.area, 0);
const calc = (js) => collectJournalPrinting(ix, js);

test('a removed/transferred order keeps journal print and cut facts for every configured shipment',()=>{
  const empty={orders:[],byUid:{},byRaw:{},issues:[]};
  const fallback=name=>({sheetId:name==='First'?1:2,sheetName:name,journalAliases:[name],sourceId:'roll-printing',spreadsheetId:'roll-book'});
  const row=log(50,10.56,'Паша','history-event','29.10.2026');row[4]='Second';row[6]='JD0038.A3705';row[7]='old-source-uid';
  const options={sourceId:'roll-printing',orderFallbacks:[fallback('First'),fallback('Second')]};
  const print=collectJournalPrinting(empty,[row],options);
  assert.equal(print.issues.length,0);assert.equal(print.events.length,1);assert.equal(print.events[0].sheetId,2);assert.equal(print.events[0].area,10.56);assert.equal(print.events[0].quantity,50);
  const cut=[...row];cut[0]='history-cut';cut[3]='Резка';cut[2]='Лукман';
  assert.equal(collectJournalCutting(empty,[cut],options).events.length,1);
  assert.equal(collectJournalPrinting(empty,[row,row],options).events.length,0,'duplicate event IDs remain excluded');
  const unknown=[...row];unknown[4]='Unknown';assert.equal(collectJournalPrinting(empty,[unknown],options).events.length,0);
  const incomplete=[...row];incomplete[7]='';assert.equal(collectJournalPrinting(empty,[incomplete],options).events.length,0);
  assert.equal(collectJournalPrinting(empty,[row],{...options,orderFallbacks:[fallback('Second'),fallback('Second')]}).events.length,0,'ambiguous source descriptors remain excluded');
  const archivedOptions={...options,journalOrderFallback:{sheetId:126956215,sourceId:'roll-printing',sourceUrl:'https://example.test/journal'}};
  const archived=collectJournalPrinting(empty,[unknown],archivedOptions);
  assert.equal(archived.events.length,1);assert.equal(archived.events[0].historical,true);assert.equal(archived.events[0].sheetName,'Unknown');assert.equal(archived.events[0].sourceUrl,'https://example.test/journal');
  assert.equal(collectJournalPrinting(empty,[unknown,unknown],archivedOptions).events.length,0);
  assert.equal(collectJournalPrinting(empty,[incomplete],archivedOptions).events.length,0);
});
test("CSV preserves multiline cells, quotes, decimal commas and Russian", () =>
  assert.deepEqual(
    parseCsv('a,b\r\n"первый\nлист","10,56"\r\n"с ""кавычками""",0'),
    [
      ["a", "b"],
      ["первый\nлист", "10,56"],
      ['с "кавычками"', "0"],
    ],
  ));
test("CSV rejects HTML login pages and incomplete data", () => {
  assert.throws(() => parseCsv("<html>login"));
  assert.throws(() => parseCsv('"incomplete'));
});
test("partial output is counted directly from the journal", () =>
  assert.equal(total(calc([log()])), 7.04));
test("production date B is used instead of the record timestamp M", () => {
  const j = log();
  j[12] = "07.10.2026 16:00:00";
  const r = calc([j]);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].employee, "Павел");
  assert.equal(r.events[0].date, "2026-10-06");
});
test("roll printing maps P-prefixed rolls to Pasha and keeps seasonal Pavel separate", () => {
  const pRoll = log(24, 4.224, "П1", "roll-p1");
  const roll = collectJournalPrinting(ix, [pRoll], { sourceId: "roll-printing" });
  assert.equal(roll.events.length, 1);
  assert.equal(roll.events[0].employee, "Паша");

  const latinRoll = log(16, 2.816, "P2", "roll-p2");
  const latin = collectJournalPrinting(ix, [latinRoll], { sourceId: "roll-printing" });
  assert.equal(latin.events[0].employee, "Паша");

  const seasonal = collectJournalPrinting(ix, [log(10, 1.76, "П1", "seasonal-p1")], {
    sourceId: "seasonal-printing",
  });
  assert.equal(seasonal.events[0].employee, "Павел");
});
test("journal output area L is retained without roll precision adjustments", () => {
  const r = calc([log(100, 17.6, "Дмитрий", "AUTO_PRINT_r1", "07.10.2026")]);
  assert.equal(r.events.length, 1);
  assert.equal(total(r), 17.6);
});
test("duplicate journal IDs excluded and reported", () => {
  const r = calc([log(), log()]);
  assert.equal(r.events.length, 0);
  assert.equal(r.issues.length, 2);
});
test("cutting does not enter printing KPI", () => {
  const j = log();
  j[3] = "Резка";
  assert.equal(calc([j]).events.length, 0);
  const cut = collectJournalCutting(ix, [j], { eventIdPrefix: "cut:" });
  assert.equal(cut.events.length, 1);
  assert.equal(cut.events[0].id, "cut:j1");
  assert.equal(cut.events[0].quantity, 40);
  assert.equal(cut.events[0].area, 7.04);
});
test("cutting progress uses its quantity and does not require output area", () => {
  const j = log(25, 0);
  j[3] = "Резка";
  const cut = collectJournalCutting(ix, [j]);
  assert.equal(cut.events.length, 1);
  assert.equal(cut.events[0].quantity, 25);
  assert.equal(cut.events[0].area, 0);
  assert.equal(cut.issues.length, 0);
});
test("Lukman is recognized as a cutter and remains invalid as a printer", () => {
  const j = log(150, 15.84, "Лукман", "AUTO_CUT_13277008", "13.10.2026");
  j[3] = "Резка";
  const cut = collectJournalCutting(ix, [j]);
  assert.equal(cut.issues.length, 0);
  assert.equal(cut.events.length, 1);
  assert.equal(cut.events[0].employee, "Лукман");
  assert.equal(cut.events[0].quantity, 150);
  assert.equal(cut.events[0].area, 15.84);

  j[3] = "Печать";
  const print = collectJournalPrinting(ix, [j]);
  assert.equal(print.events.length, 0);
  assert.equal(print.issues[0].message, "Неизвестный сотрудник");
});
test("multiple partial records of the same physical roll count separately", () => {
  const r = calc([log(40, 7.04), log(60, 10.56, "Павел", "j2")]);
  assert.equal(r.events.length, 2);
  assert.ok(Math.abs(total(r) - 17.6) < 1e-9);
});
test("restored journal records resolve a unique UID without source sheet", () => {
  const j = log();
  j[4] = "";
  j[14] = "";
  assert.equal(calc([j]).events[0].uid, o.uid);
});
test("unknown employee and invalid date require review", () => {
  const r = calc([log(40, 7.04, "н1", "j1", "31.02.2026")]);
  assert.equal(r.events.length, 0);
  assert.equal(r.issues.length, 1);
});
test("raw UID resolved by source sheet", () => {
  const other = {
    ...o,
    uid: "123::NY-0001",
    sheetName: "Другая поставка",
    sheetId: 123,
  };
  const index = {
    ...ix,
    byUid: { ...ix.byUid, [other.uid]: other },
    byRaw: { [o.uid]: [o, other] },
  };
  const j = log();
  j[4] = other.sheetName;
  assert.equal(collectJournalPrinting(index, [j]).events[0].uid, other.uid);
});
test("all orders indexed with independent UID per sheet and no invented facts", () => {
  const rows = [Array(32).fill(""), [], Array(32).fill("")];
  rows[0][31] = "UID";
  rows[2][4] = "Артикул";
  rows[2][14] = "Кол-во";
  const row = Array(32).fill("");
  row[4] = "ART";
  row[5] = "2";
  row[7] = "0,22";
  row[8] = "0,16";
  row[9] = "2,112";
  row[14] = "30";
  row[31] = "same";
  rows.push(row);
  const index = indexOrders([
    { gid: 1, name: "Первая поставка", rows },
    { gid: 2, name: "Вторая поставка", rows },
  ]);
  assert.equal(index.orders.length, 2);
  assert.notEqual(index.orders[0].uid, index.orders[1].uid);
  assert.ok(Math.abs(index.orders[0].plannedArea - 2.112) < 1e-9);
  assert.equal(collectJournalPrinting(index, []).events.length, 0);
});
test("roll supply progress uses T/U/X values and ignores rows without article E", () => {
  const rows = [
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
  ];
  rows[0][29] = "UID";
  rows[3][4] = "Артикул";
  rows[3][14] = "Кол-во";
  const inactive = Array(33).fill("");
  inactive[19] = "999";
  inactive[20] = "999";
  inactive[23] = "999";
  inactive[29] = "inactive";
  const active = Array(33).fill("");
  active[4] = "ROLL-ART";
  active[14] = "100";
  active[19] = "83";
  active[20] = "45";
  active[23] = "17";
  active[29] = "roll-001";
  const index = indexOrders([
    {
      gid: ROLL_PRINTING_SHEET.gid,
      name: ROLL_PRINTING_SHEET.name,
      rows: [...rows, inactive, active],
      headerRow: 4,
      dataStartRow: 5,
      uidHeaderRow: 1,
      sourceId: "roll-printing",
    },
  ]);
  assert.equal(index.orders.length, 1);
  assert.equal(index.orders[0].printProgress, 83);
  assert.equal(index.orders[0].cutProgress, 45);
  assert.equal(index.orders[0].remainingPrint, 17);
});
test("X shows half the print run when T is empty; cutting stays unknown without U", () => {
  const rows = [
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
  ];
  rows[0][28] = "UID";
  rows[3][4] = "Артикул";
  rows[3][14] = "Кол-во";
  const active = Array(33).fill("");
  active[4] = "ROLL-EMPTY-PROGRESS";
  active[14] = "100";
  active[23] = "50";
  active[28] = "roll-empty-progress";
  const index = indexOrders([
    {
      gid: ROLL_PRINTING_SHEET.gid,
      name: ROLL_PRINTING_SHEET.name,
      rows: [...rows, active],
      headerRow: 4,
      dataStartRow: 5,
      uidHeaderRow: 1,
      sourceId: "roll-printing",
    },
  ]);
  assert.equal(index.orders[0].printProgress, 50);
  assert.equal(index.orders[0].cutProgress, null);
  assert.equal(index.orders[0].remainingPrint, 50);
});

test("box progress uses confirmed R/S flags and preserves unknown manual print area", () => {
  const rows = Array.from({ length: 4 }, () => Array(29).fill(""));
  rows[0][28] = "UID"; rows[3][4] = "Артикул"; rows[3][14] = "Кол-во";
  const row = Array(29).fill("");
  row[4] = "BOX-SKU"; row[14] = "25"; row[17] = "TRUE"; row[18] = "FALSE";
  row[23] = "999"; row[28] = "box-uid";
  const index = indexOrders([{ gid: 700, name: "OZON Общая", sourceId: "box-printing", assemblyShipmentId: "common", headerRow: 4, dataStartRow: 5, rows: [...rows, row] }]);
  const order = index.orders[0];
  assert.equal(order.printProgress, 25);
  assert.equal(order.cutProgress, 0);
  assert.equal(order.remainingPrint, 0, "box extras in X cannot become a print remainder");
  assert.equal(order.assemblyShipmentId, "common");
  assert.equal(order.areaKnown, false);
});

test("box sheets read extension F and production completion flags by their real headers", () => {
  const rows = Array.from({ length: 5 }, () => Array(29).fill(""));
  rows[0][28] = "UID";
  rows[3][4] = "Артикул";
  rows[3][5] = "Расширения";
  rows[3][15] = "Кол-во";
  rows[3][17] = "Завершил печать";
  rows[3][18] = "Завершил порезку";
  rows[4][4] = "BOX-SKU";
  rows[4][5] = "U3";
  rows[4][15] = 40;
  rows[4][17] = true;
  rows[4][18] = false;
  rows[4][28] = "box-header-uid";

  const order = indexOrders([{
    gid: 703,
    name: "OZON Бокс",
    sourceId: "box-printing",
    headerRow: 4,
    dataStartRow: 5,
    rows,
  }]).orders[0];

  assert.equal(order.extension, "U3");
  assert.equal(order.printProgress, 40);
  assert.equal(order.cutProgress, 0);
  assert.equal(order.remainingPrint, 0);
});

test("inserted supply columns preserve quantities, area and roll/box progress", () => {
  const headers = ["Дата скидывания", "Фото", "Наличие макета", "Станок", "Артикул", "расширения", "Кол-во листов", "Размер", "Ширина", "Высота", "Объем на все кол-во скинули", "Объем на все кол-во осталось", "Папка печати", "Кратность", "Время печати 1 кол-ва на листе (мин)", "Кол-во", "округление", "Кол-во осталось", "Готовность печати", "Готовность порезки", "Прогресс печати", "Прогресс порезки", "Дата готовности печати", "Дата готовности порезки", "остаток по печати:"];
  const rows = Array.from({length: 4}, () => Array(30).fill(""));
  rows[0][29] = "UID"; rows[3] = headers;
  const row = Array(30).fill("");
  row[4] = "SKU"; row[6] = "2"; row[8] = "0,21"; row[9] = "0,30";
  row[10] = "12,600"; row[15] = "100"; row[18] = "TRUE"; row[19] = "FALSE";
  row[20] = "70%"; row[21] = "40%"; row[24] = "30"; row[29] = "u1";
  const roll = indexOrders([{gid: 901, name: "roll", sourceId: "roll-printing", headerRow: 4, dataStartRow: 5, rows: [...rows, row]}]).orders[0];
  assert.equal(roll.quantity, 100); assert.ok(Math.abs(roll.plannedArea - 12.6) < 1e-9);
  assert.equal(roll.printProgress, 70); assert.equal(roll.cutProgress, 40); assert.equal(roll.remainingPrint, 30);
  const box = indexOrders([{gid: 902, name: "box", sourceId: "box-printing", headerRow: 4, dataStartRow: 5, rows: [...rows, row]}]).orders[0];
  assert.equal(box.quantity, 100); assert.equal(box.printProgress, 100); assert.equal(box.cutProgress, 0);
});

test("ambiguous quantity headers are rejected instead of choosing a wrong column", () => {
  const rows = Array.from({length: 4}, () => Array(30).fill(""));
  rows[0][29] = "UID"; rows[3][4] = "Артикул"; rows[3][14] = "Кол-во"; rows[3][15] = "Кол-во";
  assert.throws(() => indexOrders([{gid: 1, name: "ambiguous", headerRow: 4, dataStartRow: 5, rows}]), /Duplicate order column/);
});

test("supply area trusts valid J, preserves missing areas, and never invents manual dimensions", () => {
  const headers = Array.from({ length: 4 }, () => Array(29).fill(""));
  headers[0][28] = "UID";
  headers[3][4] = "Артикул";
  headers[3][14] = "Кол-во";
  const values = ["12,45", "#N/A", "", "0", "0,0003"];
  const rows = values.map((area, i) => {
    const row = Array(29).fill("");
    row[4] = `AREA-${i}`; row[9] = area; row[14] = "10"; row[28] = `area-${i}`;
    return row;
  });
  const index = indexOrders([{ gid: 700, name: "OZON Площадь", sourceId: "roll-printing", headerRow: 4, dataStartRow: 5, rows: [...headers, ...rows] }]);
  assert.equal(index.orders[0].plannedArea, 12.45);
  assert.equal(index.orders[0].areaKnown, true, "J is a valid source independently of manual dimensions");
  assert.equal(index.orders[1].areaKnown, false);
  assert.equal(index.orders[1].areaIssue, "J6: #N/A");
  assert.equal(index.orders[2].areaKnown, false);
  assert.equal(index.orders[2].areaIssue, "J7: площадь не заполнена");
  assert.equal(index.orders[3].areaKnown, false, "zero from blank dimensions must remain unknown");
  assert.equal(index.orders[4].plannedArea, 0.0003, "small valid manual area is not rounded down by absent dimensions");
  assert.equal(index.orders[4].areaKnown, true);
});
test("percentage progress is converted to pieces and respects a zero percent value", () => {
  const rows = [
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
  ];
  rows[0][28] = "UID";
  rows[3][4] = "Артикул";
  rows[3][14] = "Кол-во";
  const active = Array(33).fill("");
  active[4] = "ROLL-PERCENT";
  active[14] = "300";
  active[19] = "50%";
  active[20] = "0%";
  active[23] = "150";
  active[28] = "roll-percent";
  const index = indexOrders([
    {
      gid: ROLL_PRINTING_SHEET.gid,
      name: ROLL_PRINTING_SHEET.name,
      rows: [...rows, active],
      headerRow: 4,
      dataStartRow: 5,
      uidHeaderRow: 1,
      sourceId: "roll-printing",
    },
  ]);

  assert.equal(index.orders[0].printProgress, 150);
  assert.equal(index.orders[0].cutProgress, 0);
  assert.equal(index.orders[0].remainingPrint, 150);
});
test("displayed block progress bars in CSV are read as T and U percentages", () => {
  const rows = [
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
    Array(33).fill(""),
  ];
  rows[0][28] = "UID";
  rows[3][4] = "Артикул";
  rows[3][14] = "Кол-во";
  const active = Array(33).fill("");
  active[4] = "KS0002.A7665";
  active[14] = "300";
  active[19] = "█████░░░░░ 50%";
  active[20] = "█████░░░░░ 50%";
  active[23] = "150";
  active[28] = "roll-progress-bar";
  const index = indexOrders([
    {
      gid: ROLL_PRINTING_SHEET.gid,
      name: ROLL_PRINTING_SHEET.name,
      rows: [...rows, active],
      headerRow: 4,
      dataStartRow: 5,
      uidHeaderRow: 1,
      sourceId: "roll-printing",
    },
  ]);
  assert.equal(index.orders[0].printProgress, 150);
  assert.equal(index.orders[0].cutProgress, 150);
});
test("source failure cannot appear as empty KPI", async () =>
  assert.rejects(() =>
    loadPrinting(async () => new Response("denied", { status: 403 })),
  ));

test("live loader combines both printing sources without double-counting summaries", async () => {
  const seen = [];
  const sheetIds = [];
  const csv = (rows) =>
    rows
      .map((r) =>
        r
          .map((v) => '"' + String(v ?? "").replaceAll('"', '""') + '"')
          .join(","),
      )
      .join("\n");
  const headers = Array(15).fill("");
  Object.assign(headers, {
    0: "ID записи",
    1: "Дата",
    2: "Сотрудник",
    3: "Операция",
    7: "UID заказа",
    9: "Сделано, шт.",
    11: "Выпуск, м²",
  });
  const journal = [
    headers,
    ...["д74", "д75", "д76"].map((name) => {
      const j = log(60, 10.56, "Дмитрий", "AUTO_PRINT_" + name, "07.10.2026");
      j[8] = name;
      return j;
    }),
  ];
  const rollJournalHeaders = [...headers];
  rollJournalHeaders[9] = "Сделано";
  rollJournalHeaders[11] = "Выпуск м²";
  const rollJournalRow = log(
    100,
    17.6,
    "Дмитрий",
    "AUTO_PRINT_roll-001",
    "07.10.2026",
  );
  rollJournalRow[4] = "OZON МОСКВА";
  rollJournalRow[7] = "roll-001";
  rollJournalRow[12] = "07.10.2026 17:30:00";
  const historicalRow = log(20, 2, "Дмитрий", "R2_LEGACY_PRINT_old", "29.07.2026");
  historicalRow[4] = "OZON МОСКВА";
  historicalRow[6] = "HIST-ART";
  historicalRow[7] = "closed-order-uid";
  const incompleteRow = log(0, 0, "Дмитрий", "AUTO_PRINT_incomplete", "12.10.2026");
  incompleteRow[4] = "OZON МОСКВА";
  incompleteRow[6] = "INCOMPLETE-ART";
  incompleteRow[7] = "incomplete-uid";
  const rollCutRow = log(25, 0, "Дмитрий", "AUTO_CUT_roll-001", "07.10.2026");
  rollCutRow[3] = "Резка";
  rollCutRow[4] = "OZON МОСКВА";
  rollCutRow[7] = "roll-001";
  const rollJournal = [rollJournalHeaders, rollJournalRow, historicalRow, incompleteRow, rollCutRow];
  const makeOldSupply = (gid) => {
    const rows = [Array(32).fill(""), [], Array(32).fill("")];
    rows[0][31] = "UID";
    rows[2][4] = "Артикул";
    rows[2][14] = "Кол-во";
    if (gid === o.sheetId) {
      const row = Array(32).fill("");
      row[4] = o.article;
      row[14] = "100";
      row[31] = o.uid;
      rows.push(row);
    }
    return rows;
  };
  const makeRollSupply = () => {
    const rows = [Array(32).fill(""), Array(32).fill(""), Array(32).fill(""), Array(32).fill("")];
    rows[0][28] = "UID";
    rows[3][4] = "Артикул";
    rows[3][14] = "Кол-во";
    const row = Array(32).fill("");
    row[4] = "ROLL-ART";
    row[5] = "0.22";
    row[7] = "0.4";
    row[8] = "2";
    row[9] = "17.6";
    row[14] = "100";
    row[19] = "83";
    row[20] = "45";
    row[23] = "17";
    row[28] = "roll-001";
    rows.push(row);
    return rows;
  };
  const r = await loadPrinting(async (url) => {
    const gid = Number(new URL(url).searchParams.get("gid"));
    const spreadsheetId = new URL(url).pathname.split("/")[3];
    seen.push(gid);
    sheetIds.push(spreadsheetId);
    if (spreadsheetId === ROLL_PRINTING_SHEET_ID && gid === 126956215)
      return new Response(csv(rollJournal));
    if (spreadsheetId === ROLL_PRINTING_SHEET_ID && gid === ROLL_PRINTING_SHEET.gid)
      return new Response(csv(makeRollSupply()));
    if (spreadsheetId === ROLL_PRINTING_SHEET_ID && gid === 99887766)
      return new Response(csv(makeRollSupply()));
    if (spreadsheetId !== ROLL_PRINTING_SHEET_ID && gid === 725126844)
      return new Response(csv(journal));
    const supply = SUPPLY_SHEETS.find(([id]) => id === gid);
    assert.ok(
      supply,
      "No source outside supplies and journal may contribute to KPI",
    );
    return new Response(csv(makeOldSupply(gid)));
  }, { additionalSheets: [{ gid: 99887766, name: "Рулонная поставка тест" }] });
  assert.equal(seen.length, SUPPLY_SHEETS.length + 4);
  assert.equal(new Set(sheetIds).size, 2);
  assert.ok(!seen.includes(86586324));
  assert.ok(!seen.includes(2053830156), "Derived daily summary must not be counted");
  assert.equal(r.events.length, 5);
  assert.equal(r.cutEvents.length, 1);
  assert.equal(r.cutEvents[0].quantity, 25);
  assert.equal(r.cutEvents[0].area, 0);
  assert.equal(Number(total(r).toFixed(3)), 51.28);
  assert.deepEqual(r.events.slice(0, 3).map((e) => e.roll), ["д74", "д75", "д76"]);
  const rollEvent = r.events[3];
  assert.equal(rollEvent.sourceId, "roll-printing");
  assert.equal(rollEvent.site, "OZON РУЛОННАЯ ПЕЧАТЬ");
  assert.equal(rollEvent.uid, `${ROLL_PRINTING_SHEET.gid}::roll-001`);
  assert.equal(rollEvent.sourceUrl, `https://docs.google.com/spreadsheets/d/${ROLL_PRINTING_SHEET_ID}/edit#gid=${ROLL_PRINTING_SHEET.gid}`);
  assert.equal(r.supplies.length, 3);
  const rollOrder = r.supplies.find((order) => order.sourceId === "roll-printing");
  assert.equal(rollOrder.printProgress, 83);
  assert.equal(rollOrder.cutProgress, 45);
  assert.equal(rollOrder.remainingPrint, 17);
  assert.equal(r.sheets.length, SUPPLY_SHEETS.length + 2);
  assert.ok(r.sheets.some((sheet) => sheet.sheetId === 99887766));
  assert.equal(r.sources.length, PRINTING_SOURCES.length);
  const historicEvent = r.events[4];
  assert.equal(historicEvent.article, "HIST-ART");
  assert.equal(historicEvent.uid, "closed-order-uid");
  assert.equal(historicEvent.sheetId, ROLL_PRINTING_SHEET.gid);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].code, "invalid_record");
  assert.match(r.issues[0].message, /Нет количества или площади/);
});
test('legacy roll UID is taken only from the unlabeled former column next to current UID',()=>{const rows=Array.from({length:5},()=>Array(30).fill(''));rows[0][29]='UID';rows[3][4]='Артикул';rows[3][14]='Кол-во';rows[4][4]='JA0037.A0225';rows[4][14]='20';rows[4][28]='f6eeb59f-78aa-47c3-8392-f5f2885e95c0';rows[4][29]='new';const sheets=[{gid:119710351,name:'OZON test',rows,sourceId:'roll-printing',dataStartRow:5,headerRow:4,uidHeaderRow:1}];assert.equal(indexOrders(sheets).orders[0].legacyUid,rows[4][28]);rows[0][28]='Другие данные';assert.equal(indexOrders(sheets).orders[0].legacyUid,null);});


test('forecast reads physical sheets and multiplicity by header and retains partial source totals without changing normal progress',()=>{
 const headers=Array(30).fill('');headers[4]='Артикул';headers[6]='Кол-во листов';headers[13]='Кратность';headers[15]='Кол-во';headers[3]='Станок';headers[17]='Готовность печати';headers[18]='Готовность порезки';headers[27]='Напечатано годных (Xerox — листы, остальные — шт.)';headers[28]='Порезано годных (Xerox — листы, остальные — шт.)';
 const row=Array(30).fill('');row[4]='XEROX-SKU';row[6]='4';row[13]='2';row[15]='100';row[3]='XEROX';row[17]='FALSE';row[18]='FALSE';row[27]='60';row[28]='20';row[29]='uid';
 const top=Array(30).fill('');top[29]='UID';
 const result=indexOrders([{gid:42,name:'OZON Test',sourceId:'box-printing',rows:[top,[],[],headers,row],headerRow:4,dataStartRow:5}]).orders[0];
 assert.equal(result.quantity,100);assert.equal(result.sheetsInProduct,4);assert.equal(result.multiplicity,2);assert.equal(result.planningPrinted,60);assert.equal(result.planningCut,20);assert.equal(result.printProgress,0);
});

test('only an untouched RITM-created roll position receives forecast zero facts; legacy, work evidence and errors stay unknown',()=>{
 const headers=Array(33).fill('');headers[4]='Артикул';headers[15]='Кол-во';headers[18]='Печать';headers[19]='Порезка';headers[20]='Прогресс печати';headers[21]='Прогресс порезки';headers[22]='Дата готовности печати';headers[23]='Дата готовности порезки';headers[24]='остаток по печати:';headers[27]='Рулоны';
 const top=Array(33).fill('');top[29]='UID';
 const row=Array(33).fill('');row[4]='NEW-SKU';row[15]='20';row[24]='20';row[29]='ritm-8bccc1a2-a162-4ba5-b63d-bb54eac2f5e1-1';
 const read=(r,h=headers)=>indexOrders([{gid:42,name:'OZON Test',sourceId:'roll-printing',rows:[top,[],[],h,r],headerRow:4,dataStartRow:5}]).orders[0];
 const before=structuredClone(row),result=read(row);
 assert.equal(result.planningPrinted,0);assert.equal(result.planningCut,0);assert.equal(result.planningPhysicalUnits,false);assert.equal(result.cutProgress,null);assert.deepEqual(row,before);
 for(const [column,value] of [[29,'legacy-uid'],[24,'10'],[18,'В работе'],[19,'Готов'],[20,'#N/A'],[21,'#REF!'],[22,'13.11.2026'],[23,'13.11.2026'],[27,'д25']]){
   const changed=[...row];changed[column]=value;assert.equal(read(changed).planningCut,undefined,`must not infer zero from column ${column}`);
 }
 const missing=[...headers];missing[27]='';assert.equal(read(row,missing).planningCut,undefined);
});
