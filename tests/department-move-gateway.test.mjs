import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../apps-script/box-worklog/BoxMoveGateway.gs',import.meta.url),'utf8');
function fixture(failAt=0){
 const data=Array(35).fill('');data[4]='SKU';data[5]='X';data[15]=32;data[17]=32;data[29]='position';const props=new Map();let clearCount=0,failed=false,locked=true;
 const metadata=[{getKey:()=> 'RITM_BOX_MOVE',remove:()=>{locked=false;}},{getKey:()=> 'RITM_BOX_POSITION',remove:()=>{}}];
 const sh={getSheetId:()=>1,getRange:(r,col)=>({getValues:()=>[data.slice()],getValue:()=>data[col-1],getFormula:()=>'',getDeveloperMetadata:()=>metadata,clearContent:()=>{clearCount++;if(clearCount===failAt&&!failed){failed=true;throw Error('temporary failure');}data[col-1]='';}})};
 const c=vm.createContext({SpreadsheetApp:{flush:()=>{}},boxLocked_:fn=>fn(),boxMoveLock_:()=>locked?'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa':null});vm.runInContext(code,c);
 const req={operationId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',uid:'position',article:'SKU',quantity:32,row:5,action:'remove'};const properties={getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v)};
 return {run:()=>c.boxMoveApply_(sh,req,properties),status:()=>c.boxMoveApply_(sh,{...req,action:'status'},properties),data,props};
}
test('gateway removes only intended input cells and repeats from receipt',()=>{const f=fixture();assert.equal(f.run().status,'removed');assert.equal(f.run().repeated,true);assert.equal(f.status().status,'removed');assert.ok([4,5,15,17,29].every(c=>f.data[c]===''));});
for(let n=1;n<=5;n++)test('partial source clear recovers after failure at cell '+n,()=>{const f=fixture(n);assert.throws(f.run,/temporary/);assert.equal(f.run().status,'removed');});
test('changed article is not cleared by a resumed receipt',()=>{const f=fixture(2);assert.throws(f.run);f.data[4]='OTHER';assert.throws(f.run,/изменилась/);assert.equal(f.data[4],'OTHER');});
