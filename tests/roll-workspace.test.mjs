import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {patchRollWorkspace} from '../scripts/patch-roll-workspace.mjs';

const source = path => readFileSync(new URL('../apps-script/stock-gateway/'+path,import.meta.url),'utf8');
function declarations(text,names){const ast=ts.createSourceFile('test.js',text,99,true,ts.ScriptKind.JS);return ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name.text)).map(n=>n.getText(ast)).join('\n');}
export function rollWorkspaceFixture(options={}){
  const db={rolls:[],progress:[],journal:[],writes:[],daily:0,failAt:'',revision:'1'};
  const orders=[{uid:'u1',sheetName:'OZON ТЕСТ',row:5,article:'LT0001.A5427',orderQty:60,areaPerPiece:.0704,areaValid:true,machine:'2-GO',size:'22×16',sheetsPerPiece:2,cutter:'Лукман'},
    {uid:'u2',sheetName:'OZON ТЕСТ',row:6,article:'KT0008.A6764',orderQty:40,areaPerPiece:.1056,areaValid:true,machine:'2-GO',size:'22×16',sheetsPerPiece:3,cutter:'Лукман'}];
  db.rolls=[{row:2,rollId:'r1',uid:'u1',sheetName:'OZON ТЕСТ',article:orders[0].article,name:'д17',number:1,quantity:30,print:false,cut:false},
    {row:3,rollId:'r2',uid:'u1',sheetName:'OZON ТЕСТ',article:orders[0].article,name:'д18',number:2,quantity:30,print:false,cut:false},
    {row:4,rollId:'r3',uid:'u2',sheetName:'OZON ТЕСТ',article:orders[1].article,name:'а12',number:1,quantity:40,print:false,cut:false}];
  const clone=value=>structuredClone(value);
  const c=vm.createContext({console,JSON,Date,Number,Object,Array,String,Math,
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_algorithm,text)=>Array.from(createHash('sha256').update(text).digest()),formatDate:d=>new Date(d).toISOString()},
    SpreadsheetApp:{getActiveSpreadsheet:()=>({getId:()=> 'test-book',getSheetByName:name=>({name})}),flush:()=>{}},
    PropertiesService:{getDocumentProperties:()=>({getProperty:()=>db.revision})},
    R2_CFG:{TZ:'Europe/Moscow',CUTTER_DEFAULT:'Лукман',STORE:'rolls',PROGRESS_STORE:'progress',JOURNAL:'journal',
      STORE_HEADERS:Array(17),PROGRESS_HEADERS:Array(14),JOURNAL_HEADERS:['ID записи','Дата','Сотрудник','Операция','Лист-источник','Строка заказа','Артикул','UID заказа','Рулон','Сделано','м² на 1 шт.','Выпуск м²','Время записи','Комментарий','ID рулона']},
    r2EnsureInitialized_:()=>{},withDocumentLock_:fn=>fn(),r2ReadStore_:()=>clone(db.rolls),r2JournalRows_:()=>clone(db.journal),r2ProgressRows_:()=>clone(db.progress),
    r2GetOrder_:(uid,sheetName)=>{const order=orders.find(o=>o.uid===uid&&o.sheetName===sheetName);if(!order)throw Error('Заказ не найден');return clone(order);},
    r2OrderArea_:o=>{if(!(o.areaPerPiece>0))throw Error('Нет площади');return o.areaPerPiece;},
    r2MoscowDay_:date=>new Date(date),r2PersistCutterCode_:()=>{},r2UpdateOrderProgress_:()=>{},r2PanelTouch_:()=>{db.revision='new';},
    r2RefreshDaily_:()=>{db.daily++;if(db.failAt==='daily'){db.failAt='';throw Error('INTERNAL daily');}},
    r2PanelSerializable_:value=>JSON.parse(JSON.stringify(value)),
    r2PanelWriteRecordBlocks_:(sheet,records)=>{
      db.writes.push({sheet:sheet.name,count:records.length});
      if(db.failAt===sheet.name){db.failAt='';throw Error('INTERNAL '+sheet.name);}
      for(const record of records){const key=sheet.name==='rolls'?'rollId':'id';const existing=db[sheet.name].findIndex(r=>r[key]===record[key]);
        if(existing>=0)db[sheet.name][existing]=clone({...record,row:db[sheet.name][existing].row});
        else{record.row=db[sheet.name].length+2;db[sheet.name].push(clone(record));}}
    }
  });
  const domain=options.domainSource||source('RollsV2.gs');
  vm.runInContext(declarations(domain,['r2Employee_','r2Normalize_','r2CutterNameFromCode_','r2CutterForOrder_','r2EmployeeForRoll_','r2EmployeeForOperation_','r2RollsForOrder_','r2JournalForOrder_','r2ProgressActualForRoll_','r2OperationTotals_','r2Progress_','r2DecorateOrder_']),c);
  vm.runInContext(declarations(options.panelApiSource||source('RollsV2PanelApi.gs'),['r2PanelRollValues_','r2PanelJournalValues_']),c);
  vm.runInContext(options.workspaceSource||source('RollsV2Workspace.gs'),c);
  return {db,c,orders,getData:()=>({orders:orders.map(o=>c.r2DecorateOrder_(clone(o),{rolls:clone(db.rolls),journal:clone(db.journal),progress:clone(db.progress)})),signature:'test-selection',revision:db.revision,workbookId:'test-book'}),
    payload:(ids=['r1','r3'],quantity=null,operation='Печать')=>({requestId:'request_1234',operation,comment:'Тестовая работа',items:ids.map(id=>{const r=db.rolls.find(r=>r.rollId===id);return {rollId:id,uid:r.uid,sheetName:r.sheetName,row:r.uid==='u1'?5:6,quantity,expectedActual:0,expectedQuantity:r.quantity};})})};
}

test('bulk whole remaining writes each selected roll once and uses saved area for each employee',()=>{const f=rollWorkspaceFixture();const p=f.payload();const result=f.c.r2WorkspaceSave(p);assert.equal(result.completed,2);assert.equal(result.partial,0);assert.equal(f.db.progress.length,2);assert.equal(f.db.journal.length,2);assert.equal(f.db.journal.find(e=>e.rollId==='r1').area,30*.0704);assert.equal(f.db.journal.find(e=>e.rollId==='r3').employee,'Андрей');assert.equal(f.db.rolls[1].print,false);assert.equal(result.orders.length,2);assert.equal(result.orders[0].print.actual,30);});
test('same request after acknowledgement loss cannot duplicate progress, journal or area',()=>{const f=rollWorkspaceFixture();const p=f.payload();f.c.r2WorkspaceSave(p);f.c.r2WorkspaceSave(p);assert.equal(f.db.progress.length,2);assert.equal(f.db.journal.length,2);assert.equal(f.db.journal.reduce((s,e)=>s+e.quantity,0),70);});
test('a new request on completed rolls skips them without adding output',()=>{const f=rollWorkspaceFixture();f.c.r2WorkspaceSave(f.payload());const next=f.payload();next.requestId='another_123';const r=f.c.r2WorkspaceSave(next);assert.equal(r.skipped,2);assert.equal(f.db.progress.length,2);assert.equal(f.db.journal.length,2);});
test('partial work stays in roll history and final remaining closes exactly the plan',()=>{const f=rollWorkspaceFixture();let p=f.payload(['r1'],10,'Резка');assert.equal(f.c.r2WorkspaceSave(p).partial,1);assert.equal(f.db.journal.length,0);assert.equal(f.db.rolls[0].cut,false);assert.equal(f.getData().orders[0].cut.actual,10);p=f.payload(['r1'],null,'Резка');p.requestId='remaining_123';p.items[0].expectedActual=10;const r=f.c.r2WorkspaceSave(p);assert.equal(r.completed,1);assert.equal(f.db.journal[0].quantity,30);assert.equal(f.db.journal[0].employee,'Лукман');assert.equal(f.db.journal[0].area,30*.0704);});
test('changed roll quantities and concurrent facts reject every selected item before any write',()=>{for(const changed of ['quantity','facts']){const f=rollWorkspaceFixture(),p=f.payload();if(changed==='quantity')f.db.rolls[2].quantity=45;else f.db.progress.push({id:'other',rollId:'r3',operation:'Печать',quantity:5,area:.528});const r=f.c.r2WorkspaceSave(p);assert.equal(r.rejected,true);assert.equal(f.db.writes.length,0);assert.equal(f.db.journal.length,0);}});
test('altered request with the same id cannot replace a previously written request',()=>{for(const change of [p=>p.comment='Другой',p=>p.operation='Резка',p=>p.items.reverse()]){const f=rollWorkspaceFixture(),p=f.payload();f.c.r2WorkspaceSave(p);change(p);const writes=f.db.writes.length;assert.throws(()=>f.c.r2WorkspaceSave(p),/уже сохранён/);assert.equal(f.db.writes.length,writes);assert.equal(f.db.progress.length,2);}});
test('cross-order and repeated roll references never mutate storage',()=>{for(const mutate of [p=>p.items[0].uid='u2',p=>p.items.push({...p.items[0]})]){const f=rollWorkspaceFixture(),p=f.payload();mutate(p);assert.equal(f.c.r2WorkspaceSave(p).rejected,true);assert.equal(f.db.writes.length,0);}});
test('write failure after durable receipts resumes the same facts and repairs derived records',()=>{for(const stage of ['rolls','journal','daily']){const f=rollWorkspaceFixture(),p=f.payload();f.db.failAt=stage;assert.throws(()=>f.c.r2WorkspaceSave(p),/INTERNAL/);assert.equal(f.db.progress.length,2);const r=f.c.r2WorkspaceSave(p);assert.equal(r.completed,2);assert.equal(f.db.progress.length,2);assert.equal(f.db.journal.length,2);assert.equal(f.db.journal.reduce((s,e)=>s+e.quantity,0),70);}});
test('negative, decimal, excessive and zero quantities do not write work',()=>{for(const quantity of [-1,1.5,0,100]){const f=rollWorkspaceFixture();assert.equal(f.c.r2WorkspaceSave(f.payload(['r1'],quantity)).rejected,true);assert.equal(f.db.writes.length,0);}});
test('patch preserves all existing writers and unrelated files, and is idempotent',()=>{const api=source('RollsV2PanelApi.gs');const files=[{name:'RollsV2Panel',type:'HTML',source:source('RollsV2Panel.html')},{name:'RollsV2PanelApi',type:'SERVER_JS',source:api},{name:'RollsV2',type:'SERVER_JS',source:'function historicWriter(){return 42;}'},{name:'appsscript',type:'JSON',source:'{}'}];const changed=patchRollWorkspace(files);assert.deepEqual(patchRollWorkspace(changed),changed);assert.deepEqual(changed.slice(2,4),files.slice(2));assert.equal(declarations(changed[1].source,['r2PanelComplete','r2PanelSaveFact','r2PanelDeleteRoll']),declarations(api,['r2PanelComplete','r2PanelSaveFact','r2PanelDeleteRoll']));});

test('an uncertain prior receipt remains recoverable when a later validation fails',()=>{
  const f=rollWorkspaceFixture(),p=f.payload();f.db.failAt='rolls';assert.throws(()=>f.c.r2WorkspaceSave(p),/INTERNAL/);f.db.rolls[0].quantity=35;
  assert.throws(()=>f.c.r2WorkspaceSave(p),/изменилось/);assert.equal(f.db.progress.length,2);assert.equal(f.db.journal.length,0);
});
test('saving unrelated rolls preserves historical journal records and their dates verbatim',()=>{
  const f=rollWorkspaceFixture();f.db.journal.push({id:'historical',rollId:'old-roll',employee:'Паша',quantity:50,area:12.34,date:new Date('2026-10-01T12:00:00Z'),comment:'Старая запись'});
  const saved=structuredClone(f.db.journal[0]);f.c.r2WorkspaceSave(f.payload());assert.deepEqual(f.db.journal[0],saved);
});
test('noncontiguous selections include only their own visible rows, not intervening or hidden rows',()=>{
  const ranges=[];const sheet={getName:()=> 'OZON TEST',getSheetId:()=>1,getLastRow:()=>12,getLastColumn:()=>3,
    isRowHiddenByFilter:row=>row===9,isRowHiddenByUser:row=>row===11,getRange:(start,_col,count)=>({getValues:()=>Array.from({length:count},(_,i)=>[start+i])})};
  for(const [start,end]of [[5,5],[9,12]])ranges.push({getSheet:()=>sheet,getRow:()=>start,getLastRow:()=>end,getA1Notation:()=>start+':'+end});
  const c=vm.createContext({JSON,Number,Object,Array,SpreadsheetApp:{getActiveRangeList:()=>({getRanges:()=>ranges})},R2_CFG:{DATA_ROW:5},r2IsTargetSheet_:()=>true,r2HeaderMap_:()=>({}),r2OrderFromValues_:(_sheet,row)=>({uid:'uid-'+row,row}),PropertiesService:{getUserProperties:()=>({setProperty:()=>{throw Error('User cache unavailable');}})}});
  vm.runInContext(declarations(source('RollsV2PanelApi.gs'),['r2PanelRanges_','r2PanelSelectedOrders_']),c);
  assert.deepEqual(Array.from(c.r2PanelSelectedOrders_(ranges[0]).orders,o=>o.row),[5,10,12]);
});

function createRequest(f,changes={}){
  const data=f.getData();
  return {requestId:'create_request_123',items:data.orders.map(o=>({uid:o.uid,sheetName:o.sheetName,row:o.row,article:o.article,
    name:'д19',quantity:null,count:1,expectedPlan:o.orderQty,expectedAllocated:o.allocated,...changes}))};
}
test('bulk creation assigns one shared name with each article own plan without recording work',()=>{
  const f=rollWorkspaceFixture();f.db.rolls=[];const p=createRequest(f),r=f.c.r2WorkspaceCreate(p);
  assert.equal(r.created,2);assert.deepEqual(f.db.rolls.map(x=>[x.name,x.quantity]),[['д19',60],['д19',40]]);
  assert.equal(f.db.journal.length,0);assert.equal(f.db.progress.length,0);assert.equal(f.db.daily,0);
  assert.ok(f.db.rolls.every(x=>!x.print&&!x.cut));
});
test('bulk creation supports individual names, quantities and roll counts',()=>{
  const f=rollWorkspaceFixture(),p=createRequest(f);p.items[0].name='а40';p.items[0].quantity=12;p.items[0].count=2;p.items[1].name='п27';p.items[1].quantity=17;
  const r=f.c.r2WorkspaceCreate(p);assert.equal(r.created,3);assert.deepEqual(f.db.rolls.slice(3).map(x=>[x.name,x.quantity,x.number]),[['а40',12,1],['а40',12,2],['п27',17,1]]);
  assert.equal(f.db.journal.length,0);
});
test('creation resumes after lost acknowledgement or failure updating source progress with no duplicate rolls',()=>{
  for(const failure of [false,true]){const f=rollWorkspaceFixture(),p=createRequest(f);let once=failure;
    f.c.r2UpdateOrderProgress_=()=>{if(once){once=false;throw Error('INTERNAL progress');}};
    if(failure)assert.throws(()=>f.c.r2WorkspaceCreate(p),/INTERNAL/);else f.c.r2WorkspaceCreate(p);
    const r=f.c.r2WorkspaceCreate({...p,resume:true});assert.equal(r.confirmed,2);assert.equal(f.db.rolls.length,5);assert.equal(new Set(f.db.rolls.map(x=>x.rollId)).size,5);assert.equal(f.db.journal.length,0);
  }
});
test('creation rejects altered replay, changed plans, duplicate orders and concurrent allocations safely',()=>{
  {const f=rollWorkspaceFixture(),p=createRequest(f);f.c.r2WorkspaceCreate(p);p.items[0].quantity=5;const n=f.db.rolls.length;assert.throws(()=>f.c.r2WorkspaceCreate(p),/другими данными/);assert.equal(f.db.rolls.length,n);}
  for(const change of [(f,p)=>f.orders[0].orderQty=65,(f,p)=>p.items.push({...p.items[0]}),(f,p)=>f.db.rolls[0].quantity=35]){
    const f=rollWorkspaceFixture(),p=createRequest(f);change(f,p);const n=f.db.rolls.length;assert.equal(f.c.r2WorkspaceCreate(p).rejected,true);assert.equal(f.db.rolls.length,n);assert.equal(f.db.writes.length,0);
  }
});
test('creation validates every article before its first write',()=>{
  for(const change of [p=>p.items[1].name='x1',p=>p.items[1].quantity=1.5,p=>p.items[1].quantity=0,p=>p.items[1].count=-1,p=>p.items[1].count=501]){
    const f=rollWorkspaceFixture(),p=createRequest(f);change(p);assert.equal(f.c.r2WorkspaceCreate(p).rejected,true);assert.equal(f.db.writes.length,0);
  }
});
test('new selections return source article preview without scanning roll or work journals',()=>{
  let scans=0,reads=0;
  const c=vm.createContext({JSON,SpreadsheetApp:{getActiveRange:()=>({}),getActiveSpreadsheet:()=>({getId:()=> 'book'})},r2PanelVersion_:()=> 'v',r2PanelSelection_:()=>({signature:'new',revision:'r'}),
    r2PanelSelectedOrders_:(_r,skip)=>{assert.equal(skip,true);reads++;return {orders:[{article:'ART1'}]};},r2PanelReadData_:()=>{scans++;return {orders:[]};},r2PanelSerializable_:x=>x,r2PanelReadFailure_:e=>{throw e;}});
  vm.runInContext(declarations(source('RollsV2PanelApi.gs'),['r2PanelPoll']),c);
  const preview=c.r2PanelPoll('old','r',false,'v',true);assert.equal(preview.preview,true);assert.equal(preview.orders[0].article,'ART1');assert.equal(scans,0);assert.equal(reads,1);
  c.r2PanelPoll('new','r',true,'v',true);assert.equal(scans,1);
  const unchanged=c.r2PanelPoll('new','r',false,'v',true);assert.equal(unchanged.changed,false);assert.equal(scans,1);
});
test('creation resumes a partial store append without repeating rows already confirmed by their IDs',()=>{
  const f=rollWorkspaceFixture(),p=createRequest(f,{count:2}),write=f.c.r2PanelWriteRecordBlocks_;let fail=true;
  f.c.r2PanelWriteRecordBlocks_=(sheet,records,width,serialize)=>{if(fail){fail=false;write(sheet,records.slice(0,1),width,serialize);throw Error('INTERNAL partial append');}return write(sheet,records,width,serialize);};
  assert.throws(()=>f.c.r2WorkspaceCreate(p),/INTERNAL/);assert.equal(f.db.rolls.length,4);
  f.c.r2WorkspaceCreate({...p,resume:true});assert.equal(f.db.rolls.length,7);assert.equal(new Set(f.db.rolls.map(r=>r.rollId)).size,7);
});
test('a read-only employee field cannot freeze selection polling',()=>{
  const document={activeElement:{tagName:'INPUT',readOnly:true,disabled:false},hasFocus:()=>true};
  const c=vm.createContext({document});const html=source('RollsV2Panel.html');
  vm.runInContext(declarations(html.match(/<script>([\s\S]*?)<\/script>/)[1],['panelFieldFocused']),c);
  assert.equal(c.panelFieldFocused(),false);document.activeElement.readOnly=false;assert.equal(c.panelFieldFocused(),true);
  document.hasFocus=()=>false;assert.equal(c.panelFieldFocused(),false);
});
test('acknowledgement of already created rolls survives later plan and allocation changes',()=>{
  const f=rollWorkspaceFixture(),p=createRequest(f);f.c.r2WorkspaceCreate(p);f.orders[0].orderQty=90;f.db.rolls[0].quantity=35;
  const n=f.db.rolls.length,r=f.c.r2WorkspaceCreate({...p,resume:true});assert.equal(r.confirmed,2);assert.equal(r.created,0);assert.equal(f.db.rolls.length,n);assert.equal(f.db.journal.length,0);
});

function editRequest(f, overrides={}){
  const order=f.getData().orders[0],roll=order.rolls.find(r=>r.rollId==='r1');
  return {requestId:'edit_request_123',rollId:roll.rollId,uid:order.uid,sheetName:order.sheetName,row:order.row,article:order.article,
    expectedName:roll.name,name:'д19',expectedQuantity:roll.quantity,quantity:35,expectedPrintActual:roll.printActual,
    expectedCutActual:roll.cutActual,expectedPrint:roll.print,expectedCut:roll.cut,...overrides};
}
function useEditAudit(f){
  const receipts=new Map();
  f.c.r2WorkspaceEditAudit_=(item,fingerprint,create)=>{
    let receipt=receipts.get(item.requestId);
    if(receipt&&receipt.fingerprint!==fingerprint)throw Error('Этот запрос уже использован с другими данными.');
    if(!receipt&&create){receipt={fingerprint,status:'pending',item:structuredClone(item)};receipts.set(item.requestId,receipt);}
    return receipt||null;
  };
  f.c.r2WorkspaceEditFinishAudit_=receipt=>{receipt.status='confirmed';};
  return receipts;
}
test('editing a roll keeps work journals intact and retries the same receipt safely',()=>{
  const f=rollWorkspaceFixture(),receipts=useEditAudit(f),p=editRequest(f),result=f.c.r2WorkspaceEdit(p);
  assert.equal(result.confirmed,true);assert.equal(f.db.rolls[0].name,'д19');assert.equal(f.db.rolls[0].quantity,35);
  assert.equal(f.db.progress.length,0);assert.equal(f.db.journal.length,0);assert.equal(receipts.size,1);
  const writes=f.db.writes.length;assert.equal(f.c.r2WorkspaceEdit({...p,resume:true}).confirmed,true);assert.equal(f.db.writes.length,writes);assert.equal(receipts.size,1);
});
test('editing unfinished partial work preserves facts and prevents changing its printer or reducing below output',()=>{
  const f=rollWorkspaceFixture(),receipts=useEditAudit(f);
  f.db.progress.push({id:'old-fact',rollId:'r1',uid:'u1',sheetName:'OZON ТЕСТ',article:f.orders[0].article,operation:'Печать',quantity:10,area:.704});
  const before=structuredClone(f.db.progress),p=editRequest(f,{quantity:9});assert.equal(f.c.r2WorkspaceEdit(p).rejected,true);assert.equal(receipts.size,0);
  p.quantity=20;p.name='а19';assert.equal(f.c.r2WorkspaceEdit(p).rejected,true);assert.equal(receipts.size,0);
  p.name='д19';assert.equal(f.c.r2WorkspaceEdit(p).confirmed,true);assert.deepEqual(f.db.progress,before);assert.equal(f.db.journal.length,0);assert.equal(f.db.rolls[0].quantity,20);
});
test('completed roll quantity is protected while same-printer renaming retains old journal entries',()=>{
  const f=rollWorkspaceFixture(),receipts=useEditAudit(f);f.c.r2WorkspaceSave(f.payload(['r1']));
  const oldJournal=structuredClone(f.db.journal),p=editRequest(f);assert.equal(f.c.r2WorkspaceEdit(p).rejected,true);assert.equal(receipts.size,0);
  p.quantity=p.expectedQuantity;assert.equal(f.c.r2WorkspaceEdit(p).confirmed,true);assert.deepEqual(f.db.journal,oldJournal);assert.equal(f.db.rolls[0].print,true);
});
test('edit rejects wrong scope, stale facts and colliding roll names before writing',()=>{
  for(const change of [(f,p)=>p.article='WRONG',(f,p)=>f.db.rolls[0].quantity=31,(f,p)=>{f.db.rolls[1].name=p.name;f.db.rolls[1].number=1;}]){
    const f=rollWorkspaceFixture(),receipts=useEditAudit(f),p=editRequest(f);change(f,p);assert.equal(f.c.r2WorkspaceEdit(p).rejected,true);assert.equal(receipts.size,0);assert.equal(f.db.writes.length,0);
  }
});
test('a failed derived update resumes an existing edit without duplicating the receipt or facts',()=>{
  const f=rollWorkspaceFixture(),receipts=useEditAudit(f),p=editRequest(f);let fail=true;
  f.c.r2UpdateOrderProgress_=()=>{if(fail){fail=false;throw Error('INTERNAL');}};
  assert.throws(()=>f.c.r2WorkspaceEdit(p),/INTERNAL/);assert.equal(receipts.size,1);assert.equal(f.db.rolls[0].quantity,35);
  assert.equal(f.c.r2WorkspaceEdit({...p,resume:true}).confirmed,true);assert.equal(receipts.size,1);assert.equal(f.db.writes.length,1);assert.equal(f.db.journal.length,0);
});
test('edit history creates one auditable receipt and rejects a changed replay',()=>{
  const sheets=new Map();
  const makeSheet=()=>{const rows=[];return {rows,getLastRow:()=>rows.length,getRange:(r,c,h=1,w=1)=>({
    getValues:()=>Array.from({length:h},(_,i)=>Array.from({length:w},(_,j)=>rows[r+i-1]?.[c+j-1]??'')),
    setValues:values=>{values.forEach((row,i)=>{rows[r+i-1]||=[];row.forEach((value,j)=>{rows[r+i-1][c+j-1]=value;});});},
    setValue:value=>{rows[r-1]||=[];rows[r-1][c-1]=value;}
  })};};
  const c=vm.createContext({JSON,Date,Number,Object,Array,String,Math,SpreadsheetApp:{getActiveSpreadsheet:()=>({
    getSheetByName:name=>sheets.get(name)||null,insertSheet:name=>{const sheet=makeSheet();sheets.set(name,sheet);return sheet;}})}});
  vm.runInContext(source('RollsV2Workspace.gs'),c);
  const item={requestId:'edit_1234',rollId:'r1',uid:'u1',sheetName:'test',article:'TEST',expectedName:'д1',name:'д2',expectedQuantity:10,quantity:12,expectedPrintActual:0,expectedCutActual:0};
  assert.equal(c.r2WorkspaceEditAudit_(item,'hash',false),null);assert.equal(sheets.size,0);
  const first=c.r2WorkspaceEditAudit_(item,'hash',true);assert.equal(first.status,'pending');assert.equal(sheets.get('ROLLS_V2_EDIT_HISTORY').rows.length,2);
  assert.equal(c.r2WorkspaceEditAudit_(item,'hash',true).row,first.row);assert.throws(()=>c.r2WorkspaceEditAudit_(item,'other',true),/другими данными/);
  c.r2WorkspaceEditFinishAudit_(first);assert.equal(c.r2WorkspaceEditAudit_(item,'hash',false).status,'confirmed');assert.equal(sheets.get('ROLLS_V2_EDIT_HISTORY').rows[1][6],'д1');
});
