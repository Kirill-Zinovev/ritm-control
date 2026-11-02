import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const code=readFileSync(new URL('../apps-script/box-worklog/BoxWorklog.gs',import.meta.url),'utf8');
test('panel JavaScript parses at its actual source boundary',()=>{const html=readFileSync(new URL('../apps-script/box-worklog/BoxPanel.html',import.meta.url),'utf8');new vm.Script(html.split('<script>')[1].split('</script>')[0]);});
test('stable row identity uses an unbounded entire-row A1 range required by Apps Script',()=>{const f=fixture();let created=false;const sheet={getRange:notation=>{assert.equal(notation,'5:5');return {getDeveloperMetadata:()=>[],addDeveloperMetadata:(key,id)=>{assert.equal(key,'RITM_BOX_POSITION');assert.ok(id);created=true;}};}};assert.ok(f.c.boxIdentity_(sheet,5));assert.equal(created,true);});
function fixture(){
 const data=[],sourceId='TEST-BOX-ONLY',base={positionId:'position-1',taken:0,printed:0,cut:0,defect:0,surplus:0,takenAt:'',printedAt:'',cutAt:''};
 let failProjection=false,failAppend=false,locked=false,hasLock=false;const projections=[];
 const journal={getLastRow:()=>data.length+1,appendRow:row=>{assert.ok(hasLock);data.push(row);if(failAppend){failAppend=false;throw new Error('lost append reply');}},getRange:(row,col,n=1,width=1)=>({
   getValues:()=>data.slice(row-2,row-2+n).map(v=>v.slice(col-1,col-1+width)),
   createTextFinder:value=>({matchEntireCell(){return this;},useRegularExpression(){return this;},findAll:()=>data.flatMap((v,i)=>String(v[col-1])===String(value)?[{getRow:()=>i+2}]:[])})
 })};
 const p={sheetId:7,row:5,shipment:'OZON Test',article:'NC0005.A5121',planKits:20,sheetsPerKit:2,planSheets:40,widthM:.21,heightM:.297,fingerprint:'known-plan'};
 const c=vm.createContext({console,Date,Number,Object,JSON,Utilities:{getUuid:randomUUID,DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,text)=>[...createHash('sha256').update(text).digest()]},
   LockService:{getScriptLock:()=>({tryLock:()=>{if(locked)return false;hasLock=true;return true;},releaseLock:()=>{hasLock=false;}})},PropertiesService:{getScriptProperties:()=>({setProperty(){}})}});
 vm.runInContext(code,c);
 c.boxBooks_=()=>({source:{getId:()=>sourceId,getSheetById:id=>Number(id)===7?{}:null},journal:{getSheetByName:()=>journal,getUrl:()=>'https://example.invalid/test-journal'}});
 c.boxEmployees_=()=>[{id:'employee-1',name:'Тестовый сотрудник'}];c.boxRow_=(_,id)=>{assert.equal(id,'position-1');return 5;};c.boxPosition_=()=>({...p});c.boxBaseline_=()=>({...base});
 c.boxProject_=(_books,_sh,pos,id,totals)=>{assert.ok(hasLock);if(failProjection){failProjection=false;throw new Error('projection unavailable');}projections.push(JSON.parse(JSON.stringify(totals)));};
 const req=(overrides={})=>({requestId:randomUUID(),positionId:'position-1',sheetId:7,fingerprint:p.fingerprint,employeeId:'employee-1',action:'print',unit:'sheets',quantity:12,stage:'',reason:'',reverses:'',...overrides});
 return {c,data,base,p,projections,req,loseProjection:()=>failProjection=true,loseAppend:()=>failAppend=true,lock:()=>locked=true};
}
test('physical sheets: 20 kits × 2 = 40; 6 kits record 12 sheets and source area',()=>{
 const f=fixture(),r=f.c.saveBoxWork(f.req({unit:'kits',quantity:6}));assert.equal(r.totals.printed,12);
 assert.equal(f.data[0][13],12);assert.equal(f.data[0][14],6);assert.ok(Math.abs(f.data[0][15]-12*.21*.297)<1e-12);
});
test('partial printing sums while defect and surplus stay separate',()=>{const f=fixture();f.c.saveBoxWork(f.req({quantity:16}));f.c.saveBoxWork(f.req({quantity:12}));f.c.saveBoxWork(f.req({action:'defect',quantity:3,stage:'print'}));const r=f.c.saveBoxWork(f.req({action:'surplus',quantity:4}));assert.equal(r.totals.printed,28);assert.equal(r.totals.defect,3);assert.equal(r.totals.surplus,4);assert.equal(f.data.length,4);});
test('same request ID never duplicates quantities after restart-like reread',()=>{const f=fixture(),q=f.req();f.c.saveBoxWork(q);const r=f.c.saveBoxWork(q);assert.equal(r.repeated,true);assert.equal(r.totals.printed,12);assert.equal(f.data.length,1);assert.equal(f.projections.length,2);});
test('same ID cannot be reused for another quantity',()=>{const f=fixture(),q=f.req();f.c.saveBoxWork(q);assert.throws(()=>f.c.saveBoxWork({...q,quantity:13}),/другой записи/);assert.equal(f.data.length,1);});
test('projection failure retains committed event; retry repairs only display',()=>{const f=fixture(),q=f.req();f.loseProjection();assert.throws(()=>f.c.saveBoxWork(q),/projection unavailable/);assert.equal(f.data.length,1);const r=f.c.saveBoxWork(q);assert.equal(r.repeated,true);assert.equal(r.totals.printed,12);assert.equal(f.data.length,1);});
test('lost journal append reply is reconciled using same ID',()=>{const f=fixture(),q=f.req();f.loseAppend();assert.throws(()=>f.c.saveBoxWork(q),/lost append reply/);assert.equal(f.c.saveBoxWork(q).repeated,true);assert.equal(f.data.length,1);});
test('missing or unknown employee rejects every new operation including cancellation',()=>{for(const action of ['take','print','cut','defect','surplus','cancel']){const f=fixture();assert.throws(()=>f.c.saveBoxWork(f.req({action,employeeId:''})),/NOT_SAVED:.*Без имени/);assert.equal(f.data.length,0);}});
test('negative, fractional and invalid quantities are rejected before journal append',()=>{for(const quantity of [0,-1,1.5,NaN,Infinity,1000001]){const f=fixture();assert.throws(()=>f.c.saveBoxWork(f.req({quantity})),/NOT_SAVED/);assert.equal(f.data.length,0);}});
test('waste and surplus require whole physical sheets; waste requires stage',()=>{const f=fixture();for(const q of [f.req({action:'defect',stage:''}),f.req({action:'defect',stage:'print',unit:'kits'}),f.req({action:'surplus',unit:'kits'})])assert.throws(()=>f.c.saveBoxWork(q),/NOT_SAVED/);assert.equal(f.data.length,0);});
test('cutting cannot exceed good printing and good print cannot exceed plan',()=>{const f=fixture();assert.throws(()=>f.c.saveBoxWork(f.req({action:'cut',quantity:1})),/Порезка превышает/);assert.throws(()=>f.c.saveBoxWork(f.req({quantity:41})),/излишек/);f.c.saveBoxWork(f.req({quantity:10}));const r=f.c.saveBoxWork(f.req({action:'cut',quantity:8}));assert.equal(r.totals.cut,8);});
test('named cancellation requires reason, retains event and recomputes quantity/date',()=>{const f=fixture(),q=f.req();f.c.saveBoxWork(q);assert.throws(()=>f.c.saveBoxWork(f.req({action:'cancel',reverses:q.requestId})),/причину/);const r=f.c.saveBoxWork(f.req({action:'cancel',reverses:q.requestId,reason:'Ошибка ввода'}));assert.equal(r.totals.printed,0);assert.equal(r.totals.printedAt,'');assert.equal(f.data.length,2);assert.equal(f.data[0][10],'Печать');assert.equal(f.data[1][23],q.requestId);});
test('printing cancellation cannot strand a confirmed cut quantity',()=>{const f=fixture(),q=f.req();f.c.saveBoxWork(q);f.c.saveBoxWork(f.req({action:'cut',quantity:8}));assert.throws(()=>f.c.saveBoxWork(f.req({action:'cancel',reverses:q.requestId,reason:'Ошибка'})),/Сначала отмените/);assert.equal(f.data.length,2);});
test('baseline completion can be cancelled with an attributed audit event',()=>{const f=fixture();f.base.printed=40;f.base.printedAt='2026-10-30T09:00:00.000Z';const r=f.c.saveBoxWork(f.req({action:'cancel',reverses:'baseline:print:position-1',reason:'Исправить исходную отметку'}));assert.equal(r.totals.printed,0);assert.equal(f.data[0][9],'Тестовый сотрудник');});
test('changed source plan, another source position or occupied writer never writes',()=>{const f=fixture();assert.throws(()=>f.c.saveBoxWork(f.req({fingerprint:'stale'})),/изменились/);assert.throws(()=>f.c.saveBoxWork(f.req({positionId:'another'})));f.lock();assert.throws(()=>f.c.saveBoxWork(f.req()),/другая запись/);assert.equal(f.data.length,0);});
test('scope accepts shipment prefixes and excludes hidden/cache/bare marketplace tabs',()=>{const f=fixture();for(const name of ['OZON МОСКВА','wb test','  OZON СПБ '])assert.equal(f.c.boxEligible_({getName:()=>name,isSheetHidden:()=>false}),true);for(const name of ['OZON','WB','Cache FBO','_SYSTEM','OZONISH test','Журнал OZON'])assert.equal(f.c.boxEligible_({getName:()=>name,isSheetHidden:()=>false}),false);assert.equal(f.c.boxEligible_({getName:()=>'OZON Old',isSheetHidden:()=>true}),false);});
test('cancellation never affects another article and surplus does not increase readiness',()=>{const f=fixture();f.c.saveBoxWork(f.req({action:'surplus',quantity:45}));assert.throws(()=>f.c.saveBoxWork(f.req({action:'cancel',reverses:'unrelated-article-event',reason:'Ошибка'})),/не найдена/);assert.equal(f.projections.at(-1).printed,0);});
test('card selection never projects or rewrites totals; unchanged polling avoids journal and writer lock',()=>{
 const f=fixture();let journalReads=0;
 const sheet={getName:()=>'OZON TEST',isSheetHidden:()=>false,getSheetId:()=>7,getRange:()=>({getValues:()=>[['NC0005.A5121',2,20]]})};
 f.c.SpreadsheetApp={getActiveSpreadsheet:()=>({getId:()=>'TEST-BOX-ONLY',getActiveRange:()=>({getSheet:()=>sheet,getRow:()=>5})})};
 f.c.PropertiesService={getScriptProperties:()=>({getProperty:key=>key==='BOX_SOURCE_ID'?'TEST-BOX-ONLY':''})};
 f.c.boxIdentity_=()=>'position-1';f.c.boxBaseline_=(_books,_p,_id,create)=>{assert.equal(create,false);journalReads++;return {...f.base};};
 f.c.boxProject_=()=>{throw new Error('read must not rewrite source');};
 const first=f.c.getBoxPanelContext('');assert.equal(first.article,'NC0005.A5121');assert.equal(journalReads,1);
 const books=f.c.boxBooks_;f.lock();f.c.boxBooks_=()=>{throw new Error('unchanged read must not open journal');};
 assert.equal(f.c.getBoxPanelContext(first.key).unchanged,true);assert.equal(journalReads,1);assert.equal(f.data.length,0);
 f.c.boxBooks_=books;assert.equal(f.c.getBoxPanelContext('').article,'NC0005.A5121');assert.equal(journalReads,2);
});
test('card cache speeds revisits; a saved-event revision and manual refresh always invalidate it',()=>{
 const f=fixture(),cache=new Map();let revision='',reads=0;
 const sheet={getName:()=>'OZON TEST',isSheetHidden:()=>false,getSheetId:()=>7,getRange:()=>({getValues:()=>[['NC0005.A5121',2,20]]})};
 f.c.SpreadsheetApp={getActiveSpreadsheet:()=>({getId:()=>'TEST-BOX-ONLY',getActiveRange:()=>({getSheet:()=>sheet,getRow:()=>5})})};
 f.c.PropertiesService={getScriptProperties:()=>({getProperty:key=>key==='BOX_SOURCE_ID'?'TEST-BOX-ONLY':key==='BOX_REVISION'?revision:'TEST-JOURNAL'})};
 f.c.CacheService={getScriptCache:()=>({get:key=>cache.get(key),put:(key,value)=>cache.set(key,value)})};
 f.c.boxIdentity_=()=>'position-1';f.c.boxBaseline_=()=>{reads++;return {...f.base};};
 const first=f.c.getBoxPanelContext('');assert.equal(reads,1);
 assert.equal(f.c.getBoxPanelContext('previous-other-row').totals.printed,0);assert.equal(reads,1);
 f.base.printed=12;revision='new-confirmed-event';assert.equal(f.c.getBoxPanelContext(first.key).totals.printed,12);assert.equal(reads,2);
 f.c.getBoxPanelContext('');assert.equal(reads,3);
});
