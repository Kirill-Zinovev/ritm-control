import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const shared=readFileSync(new URL('../apps-script/shared/DepartmentMoveGroup.gs',import.meta.url),'utf8');
function fixture(department,failAt=0){
 const rows=new Map(),metadata=new Map(),properties=new Map(),events={},baseline=[Array(13).fill('')];let held=false,clears=0,failed=false,historyReads=0;
 const positions=Array.from({length:3},(_,i)=>({row:i+5,article:'SKU-'+i,uid:'uid-'+i,quantity:i+10}));
 positions.forEach(p=>{const v=Array(35).fill('');v[4]=p.article;v[5]='X';v[15]=p.quantity;v[29]=p.uid;rows.set(p.row,v);metadata.set(p.row,[]);});
 const logs={ROLLS_V2:[['ROLL_ID','ORDER_UID','','','ARTICLE']], 'Журнал выпуска':[[]]};
 const logSheet=values=>({getLastRow:()=>values.length,getDataRange:()=>({getValues:()=>{historyReads++;return structuredClone(values);}}),getRange:(r,c,n,w)=>({getValues:()=>values.slice(r-1,r-1+n).map(v=>v.slice(c-1,c-1+w))})});
 const book={getId:()=>department,getSheetByName:name=>name==='_Позиции'?logSheet(baseline):logs[name]&&logSheet(logs[name])};
 const sh={getSheetId:()=>1,getLastColumn:()=>35,getParent:()=>book,getRange:(r,c,n=1,w=1)=>{
  const row=typeof r==='string'?Number(r.split(':')[0]):r;
  return {getValues:()=>Array.from({length:n},(_,i)=>rows.get(row+i).slice((c||1)-1,(c||1)-1+w)),getValue:()=>rows.get(row)[c-1],getFormula:()=>'',clearContent:()=>{assert.ok(held);if(++clears===failAt&&!failed){failed=true;throw Error('lost clear');}rows.get(row)[c-1]='';},
   getDeveloperMetadata:()=>metadata.get(row).map(m=>({getKey:()=>m.key,getValue:()=>m.value,remove:()=>metadata.set(row,metadata.get(row).filter(x=>x!==m))})),addDeveloperMetadata:(key,value)=>metadata.get(row).push({key,value})};}};
 const lock=fn=>{assert.equal(held,false);held=true;try{return fn();}finally{held=false;}};
 const c=vm.createContext({Date,encodeURIComponent,SpreadsheetApp:{flush:()=>{}},LockService:{getScriptLock:()=>({tryLock:()=>{assert.equal(held,false);held=true;return true;},releaseLock:()=>{held=false;}})},Utilities:{getUuid:()=>crypto.randomUUID()},boxLocked_:lock,BOXW:{positionHeaders:Array(13).fill('')},boxEventsMany_:(_,ids)=>Object.fromEntries(ids.map(id=>[id,events[id]||[]])),boxMoveLock_:(sheet,row)=>metadata.get(row).find(m=>m.key==='RITM_BOX_MOVE')?.value||null,r2HeaderMap_:()=>({article:5,quantity:16,uid:30,printDate:22,cutDate:23,roll:27,print:19,cut:20,printProgress:21,cutProgress:24})});
 vm.runInContext(shared+'\n'+readFileSync(new URL('../apps-script/'+(department==='box'?'box-worklog/BoxMoveGateway.gs':'roll-worklog/RollMoveGateway.gs'),import.meta.url),'utf8'),c);
 const props={getProperty:k=>properties.get(k),setProperty:(k,v)=>properties.set(k,v)},q={...positions[0],operationId:crypto.randomUUID(),positions};
 const run=(action,overrides={})=>department==='box'?c.boxMoveGroup_({source:book,journal:book},sh,{...q,action,...overrides},props):c.rollMoveGroup_(sh,{...q,action,...overrides},props);
 return {run,rows,metadata,properties,q,logs,events,baseline,historyReads:()=>historyReads};
}
for(const department of ['box','roll']){
 test(department+' group moves exact rows once and preserves unrelated cells/history',()=>{const f=fixture(department),history=JSON.stringify(f.logs);assert.equal(f.run('lock').status,'locked');assert.equal(f.run('remove').status,'removed');assert.equal(f.run('remove').repeated,true);assert.equal(JSON.stringify(f.logs),history);for(const v of f.rows.values()){assert.ok([4,5,15,29,department==='box'?17:24].every(i=>v[i]===''));assert.ok(v.slice(6,15).every(x=>x===''));}assert.ok([...f.metadata.values()].every(v=>v.length===0));});
 for(let n=1;n<=15;n++)test(department+' group recovers exact receipt after partial clear '+n,()=>{const f=fixture(department,n);f.run('lock');assert.throws(()=>f.run('remove'),/lost clear/);assert.equal(f.run('remove').status,'removed');assert.equal(f.run('status').status,'removed');});
 test(department+' changed later member prevents clearing every row',()=>{const f=fixture(department);f.run('lock');f.rows.get(7)[4]='REPLACEMENT';assert.throws(()=>f.run('remove'),/изменилась/);assert.equal(f.rows.get(5)[4],'SKU-0');assert.equal(f.rows.get(7)[4],'REPLACEMENT');});
 test(department+' partial receipt cannot erase a replacement',()=>{const f=fixture(department,7);f.run('lock');assert.throws(()=>f.run('remove'));f.rows.get(7)[4]='REPLACEMENT';assert.throws(()=>f.run('remove'),/изменилась/);assert.equal(f.rows.get(7)[4],'REPLACEMENT');});
 test(department+' immutable group rejects changed quantity and reordered members',()=>{const f=fixture(department);f.run('lock');for(const positions of [[{...f.q.positions[0],quantity:999},...f.q.positions.slice(1)], [...f.q.positions].reverse()])assert.throws(()=>f.run('remove',{positions}));assert.equal(f.rows.get(5)[4],'SKU-0');});
 test(department+' a later started member blocks the whole group before any lock',()=>{const f=fixture(department);f.rows.get(7)[21]=new Date();assert.throws(()=>f.run('lock'),/работа/);assert.ok([...f.metadata.values()].every(v=>v.length===0));});
 test(department+' work recorded after lock blocks source removal',()=>{const f=fixture(department);f.run('lock');f.rows.get(7)[21]=new Date();assert.throws(()=>f.run('remove'));assert.equal(f.rows.get(5)[4],'SKU-0');});
 test(department+' group abort keeps all source rows and rejects later removal',()=>{const f=fixture(department);f.run('lock');assert.equal(f.run('abort').status,'aborted');assert.equal(f.rows.get(5)[4],'SKU-0');assert.throws(()=>f.run('remove'));});
 test(department+' abort after a partial clear is forbidden',()=>{const f=fixture(department,3);f.run('lock');assert.throws(()=>f.run('remove'));assert.throws(()=>f.run('abort'),/начато/);});
}
 test('roll group reads each history table once per guarded stage and detects any UID',()=>{const f=fixture('roll');f.logs.ROLLS_V2.push(['other','unrelated']);f.logs['Журнал выпуска'].push(['unrelated']);f.run('lock');assert.equal(f.historyReads(),2);f.logs.ROLLS_V2.push(['roll-new',f.q.positions[2].uid,'','','SKU-2']);assert.throws(()=>f.run('remove'),/рулон/);assert.equal(f.rows.get(5)[4],'SKU-0');});
 test('box group detects journal entries even if cells show zero output',()=>{const f=fixture('box');f.run('lock');const id=f.metadata.get(7).find(m=>m.key==='RITM_BOX_POSITION').value;f.events[id]=[{action:'take'}];assert.throws(()=>f.run('remove'),/история/);assert.equal(f.rows.get(5)[4],'SKU-0');});
