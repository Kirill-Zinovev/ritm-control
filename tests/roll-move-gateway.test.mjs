import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../apps-script/roll-worklog/RollMoveGateway.gs',import.meta.url),'utf8');
function fixture(failAt=0,loggedId=null){
 let marker=null,hasRoll=false,n=0,failed=false,held=false;const data=Array(35).fill('');data[4]='SKU';data[5]='U3';data[15]=32;data[24]=32;data[29]='position';const props=new Map();
 const meta=()=>marker?[{getKey:()=> 'RITM_ROLL_MOVE',getValue:()=>marker,remove:()=>{marker=null;}}]:[];
 const log={getLastRow:()=>2,getDataRange:()=>({getValues:()=>[[],[]],createTextFinder:(needle)=>({matchEntireCell(){return this;},useRegularExpression(){return this;},findNext:()=>hasRoll||needle===loggedId?{}:null})})};
 const book={getSheetByName:()=>log,createDeveloperMetadataFinder:()=>({withKey(){return this;},find:meta})};
 const sh={getSheetId:()=>1,getParent:()=>book,getLastColumn:()=>35,getRange:(row,col)=>({getValues:()=>[data.slice()],getDeveloperMetadata:meta,addDeveloperMetadata:(_,v)=>{marker=v;},getValue:()=>data[col-1],getFormula:()=>'',clearContent:()=>{n++;if(n===failAt&&!failed){failed=true;throw Error('lost write');}data[col-1]='';}})};
 const c=vm.createContext({LockService:{getScriptLock:()=>({tryLock:()=>{assert.equal(held,false);held=true;return true;},releaseLock:()=>{held=false;}})},SpreadsheetApp:{flush:()=>{},getActiveSpreadsheet:()=>book},r2HeaderMap_:()=>({article:5,quantity:16,uid:30,printDate:22,cutDate:23,roll:27,print:19,cut:20,printProgress:21,cutProgress:24})});vm.runInContext(code,c);
 const q={operationId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',row:5,uid:'position',article:'SKU',quantity:32};
 const properties={getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v)};
 return {run:action=>c.rollMoveApply_(sh,{...q,action},properties),guard:()=>c.rollMoveAssertWritable_(),data,properties,api:c,q,hasRoll:()=>{hasRoll=true;}};
}
test('roll source freezes writers, removes exact inputs and repeats safely',()=>{const f=fixture();assert.equal(f.run('lock').status,'locked');assert.throws(f.guard,/перенос/);assert.equal(f.run('remove').status,'removed');assert.equal(f.run('remove').repeated,true);assert.doesNotThrow(f.guard);assert.ok([4,5,15,24,29].every(i=>f.data[i]===''));});
for(let i=1;i<=5;i++)test('reverse removal recovers partial clear '+i,()=>{const f=fixture(i);f.run('lock');assert.throws(()=>f.run('remove'),/lost/);assert.equal(f.run('remove').status,'removed');});
test('existing roll blocks even before printing',()=>{const f=fixture();f.hasRoll();assert.throws(()=>f.run('lock'),/рулон/);assert.equal(f.data[4],'SKU');});
for(const i of [18,19,20,21,22,23,26])test('recorded work column '+i+' prevents moving',()=>{const f=fixture();f.data[i]=i===21||i===22?'today':1;assert.throws(()=>f.run('lock'));});
test('abort unlocks only before source clearing begins',()=>{const f=fixture();f.run('lock');assert.equal(f.run('abort').status,'aborted');assert.doesNotThrow(f.guard);assert.equal(f.data[4],'SKU');});
test('all roll writing adapters share the transfer lock and guard',()=>{const base=readFileSync(new URL('../apps-script/roll-worklog/LegacyRolls.gs',import.meta.url),'utf8');const log=readFileSync(new URL('../apps-script/roll-worklog/ProductionLog.gs',import.meta.url),'utf8');assert.match(base,/function withDocumentLock_[\s\S]*?getScriptLock\(\)[\s\S]*?rollMoveAssertWritable_\(\);\s*return fn\(\)/);assert.match(log,/getScriptLock\(\)[\s\S]*?rollMoveAssertWritable_\(\)/);});

test('legacy AC identity protects rolls created before AD migration',()=>{const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';const f=fixture(0,id);f.data[28]=id;assert.throws(()=>f.run('lock'),/рулон/);assert.equal(f.data[4],'SKU');});

test('a reused UID is ignored only when every historical record belongs to a different article',()=>{
 const f=fixture();const sheets={
  ROLLS_V2:[['ROLL_ID','ORDER_UID','','','ARTICLE'],['roll-old','position','','','OLD']],
  _SYSTEM_ROLLS:[['UID','','','','','','','','ROLL_ID'],['position','','','','','','','','roll-old']],
  'Журнал выпуска':[['','','','','','','Артикул','UID заказа','','','','','','','ID рулона'],['','','','','','','OLD','position','','','','','','','roll-old']],
 };
 const book={getSheetByName:name=>sheets[name]&&{getLastRow:()=>sheets[name].length,getDataRange:()=>({getValues:()=>sheets[name]})}};
 assert.equal(f.api.rollMoveDifferentArticleHistory_(book,'position','SKU'),true);
 sheets.ROLLS_V2[1][4]='SKU';assert.equal(f.api.rollMoveDifferentArticleHistory_(book,'position','SKU'),false);
 sheets.ROLLS_V2[1][4]='OLD';sheets._SYSTEM_ROLLS[1][8]='unknown';assert.equal(f.api.rollMoveDifferentArticleHistory_(book,'position','SKU'),false);
 sheets._SYSTEM_ROLLS[1][8]='roll-old';sheets['Журнал выпуска'][1][6]='SKU';assert.equal(f.api.rollMoveDifferentArticleHistory_(book,'position','SKU'),false);
 sheets['Журнал выпуска'][1][6]='OLD';sheets._KPI_LOG=[['unknown'],['position']];assert.equal(f.api.rollMoveDifferentArticleHistory_(book,'position','SKU'),false);
});

function approvedHistoryFixture(){const f=fixture();f.hasRoll();let history='frozen old roll';f.api.rollMoveHistorySnapshot_=()=>history;
 f.properties.setProperty('ROLL_MOVE_HISTORY_APPROVAL_position',JSON.stringify({uid:'position',sheetId:1,row:5,article:'SKU',quantity:32,legacyUid:'',history,expiresAt:Date.now()+100000}));
 return {...f,changeHistory:()=>{history='new work';}};}
test('explicit historical separation preserves old history while moving the current position once',()=>{const f=approvedHistoryFixture();assert.equal(f.run('lock').status,'locked');assert.equal(f.run('remove').status,'removed');assert.equal(f.run('remove').repeated,true);const a=JSON.parse(f.properties.getProperty('ROLL_MOVE_HISTORY_APPROVAL_position'));assert.equal(a.completed,true);assert.equal(a.history,'frozen old roll');assert.equal(a.operationId,f.q.operationId);});
test('new work after approval or a changed history prevents historical separation',()=>{for(const kind of ['row','history','legacyUid']){const f=approvedHistoryFixture();f.run('lock');if(kind==='row')f.data[18]=true;if(kind==='history')f.changeHistory();if(kind==='legacyUid')f.data[28]='changed';assert.throws(()=>f.run('remove'));assert.equal(f.data[4],'SKU');}});
test('historical permission cannot be reused by a different operation or quantity',()=>{for(const kind of ['operationId','quantity','expired']){const f=approvedHistoryFixture();const a=JSON.parse(f.properties.getProperty('ROLL_MOVE_HISTORY_APPROVAL_position'));if(kind==='operationId')a.operationId='other';if(kind==='quantity')a.quantity=33;if(kind==='expired')a.expiresAt=0;f.properties.setProperty('ROLL_MOVE_HISTORY_APPROVAL_position',JSON.stringify(a));assert.throws(()=>f.run('lock'));assert.equal(f.data[4],'SKU');}});
