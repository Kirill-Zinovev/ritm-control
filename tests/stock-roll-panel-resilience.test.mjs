import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync}from'node:fs';import ts from'typescript';
import {patchRollPanelTransport} from '../scripts/patch-roll-panel-transport.mjs';
const html=readFileSync(new URL('../apps-script/stock-gateway/RollsV2Panel.html',import.meta.url),'utf8'),code=html.match(/<script>([\s\S]*?)<\/script>/)[1],ast=ts.createSourceFile('panel.js',code,99,true,ts.ScriptKind.JS);
function fixture(){const calls=[],timers=[],messages=[];let success,failure;const runner=new Proxy({withSuccessHandler(fn){success=fn;return this;},withFailureHandler(fn){failure=fn;return this;}},{get(target,key){return key in target?target[key]:(...args)=>calls.push({method:key,args,success,failure});}});
 const c=vm.createContext({console,setTimeout:fn=>timers.push(fn),loadVersion:0,busy:false,pollBusy:false,auditBusy:false,workspace:{pending:null},document:{hidden:false},panelFieldFocused:()=>false,state:{orders:[{article:'KEPT'}],signature:'selected',revision:'1'},panelVersion:'version',google:{script:{run:runner}},msg:text=>messages.push(text),drawOrders:()=>assert.fail('failed read must preserve previous order'),setBusy:value=>{c.busy=value;if(value)c.loadVersion++;}});
 vm.runInContext(ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&['panelRead','server','pollSelection'].includes(n.name.text)).map(n=>n.getFullText(ast)).join('\n'),c);return {c,calls,timers,messages};}
 test('stock roll read retries transient INTERNAL twice and returns the real response',()=>{const f=fixture();let result;f.c.panelRead('r2PanelData',[],v=>result=v,()=>assert.fail('must recover'));f.calls[0].failure({message:'INTERNAL'});assert.equal(f.calls.length,1);f.timers.shift()();f.calls[1].failure({message:'ошибка сервера'});f.timers.shift()();f.calls[2].success({orders:[{article:'REAL'}]});assert.equal(result.orders[0].article,'REAL');assert.equal(f.calls.length,3);});
 test('stock roll writes never retry an uncertain acknowledgement',()=>{const f=fixture();f.c.server('r2PanelAddRolls',['uid'],()=>{},()=>{});f.calls[0].failure({message:'INTERNAL'});assert.equal(f.calls.length,1);assert.equal(f.timers.length,0);});
 test('stock roll polling preserves the last confirmed order after a permanent read failure',()=>{const f=fixture();f.c.pollSelection();f.calls[0].failure({message:'Headers changed'});assert.equal(f.c.state.orders[0].article,'KEPT');assert.equal(f.c.pollBusy,false);assert.match(f.messages[0],/Headers changed/);});
 test('new operation cancels delayed read retry from the previous selection',()=>{const f=fixture();let cancelled=false;f.c.panelRead('r2PanelData',[],()=>assert.fail('old read'),()=>cancelled=true);f.calls[0].failure({message:'INTERNAL'});f.c.loadVersion++;f.timers.shift()();assert.equal(f.calls.length,1);assert.equal(cancelled,true);});
 test('stock roll RPC serialization removes Date instances without changing quantity or area',()=>{const c=vm.createContext({JSON});const source=readFileSync(new URL('../apps-script/stock-gateway/RollsV2PanelApi.gs',import.meta.url),'utf8');vm.runInContext(source,c);const result=c.r2PanelSerializable_({orders:[{print:{date:new Date('2026-11-10T10:00:00Z'),actual:105},printArea:7.392}]});assert.equal(result.orders[0].print.date,'2026-11-10T10:00:00.000Z');assert.equal(result.orders[0].print.actual,105);assert.equal(result.orders[0].printArea,7.392);});

test('main roll transport patch preserves every writer and unrelated project file and is idempotent',()=>{
 const api=readFileSync(new URL('../apps-script/stock-gateway/RollsV2PanelApi.gs',import.meta.url),'utf8');
 const files=[{name:'RollsV2Panel',type:'HTML',source:html},{name:'RollsV2PanelApi',type:'SERVER_JS',source:api},{name:'RollsV2',type:'SERVER_JS',source:'function writerMustStay() { return "unchanged"; }'},{name:'appsscript',type:'JSON',source:'{"timeZone":"Europe/Moscow"}'}];
 const patched=patchRollPanelTransport(files);assert.deepEqual(patchRollPanelTransport(patched),patched);
 assert.deepEqual(patched.slice(2),files.slice(2));
 const functions=source=>ts.createSourceFile('api.js',source,99,true,ts.ScriptKind.JS).statements.filter(ts.isFunctionDeclaration).map(n=>[n.name.text,n.getText()]);
 const changed=new Set(['r2PanelSerializable_','r2PanelData','r2PanelPoll','r2PanelVersion_']);const after=new Map(functions(patched[1].source));
 for(const [name,body]of functions(api))if(!changed.has(name))assert.equal(after.get(name),body,name);
 const c=vm.createContext({JSON,SpreadsheetApp:{getActiveRange:()=>null}});vm.runInContext(patched[1].source,c);
 c.r2PanelReadData_=()=>({orders:[{quantity:40,area:3.5,date:new Date('2026-11-12T09:00:00Z')}]});c.r2PanelSelection_=()=>({signature:'selection',revision:'v1'});
 const result=c.r2PanelData();assert.equal(result.orders[0].date,'2026-11-12T09:00:00.000Z');assert.equal(result.orders[0].quantity,40);assert.equal(result.orders[0].area,3.5);
});
test('initial roll order read failure also completes the KPI loading path without erasing the old card',()=>{
 const api=readFileSync(new URL('../apps-script/stock-gateway/RollsV2PanelApi.gs',import.meta.url),'utf8');
 const patched=patchRollPanelTransport([{name:'RollsV2Panel',type:'HTML',source:html},{name:'RollsV2PanelApi',type:'SERVER_JS',source:api}]);
 const script=patched[0].source.match(/<script>([\s\S]*?)<\/script>/)[1];const ast=ts.createSourceFile('panel.js',script,99,true,ts.ScriptKind.JS);let finished=0,message='';
 const c=vm.createContext({state:{orders:[{article:'KEPT'}]},Date,server:(_method,_args,_success,failure)=>failure('INTERNAL'),msg:text=>message=text,drawOrders:()=>assert.fail('must not discard previous card')});
 vm.runInContext(ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='load').getText(ast),c);c.load(false,()=>finished++);assert.equal(finished,1);assert.match(message,/Последние загруженные данные сохранены/);
});

test('repeated Google errors back off automatic polling and keep one stable notice and the confirmed card',()=>{
 const f=fixture();for(let n=0;n<4;n++){
  f.c.state.nextPollAt=0;f.c.pollSelection();f.calls.at(-1).failure({message:'INTERNAL'});f.timers.shift()();f.calls.at(-1).failure({message:'INTERNAL'});f.timers.shift()();f.calls.at(-1).failure({message:'INTERNAL'});
 }
 const count=f.calls.length;f.c.pollSelection();assert.equal(f.calls.length,count);assert.equal(f.messages.length,1);assert.equal(f.c.state.orders[0].article,'KEPT');assert.ok(f.c.state.nextPollAt-Date.now()>30000);
 f.c.state.nextPollAt=0;f.c.pollSelection();f.calls.at(-1).success({changed:false});assert.equal(f.c.state.pollFailures,0);assert.equal(f.c.state.lastReadFailed,false);
});

test('server-side transient errors use a serializable read envelope without reporting an empty order',()=>{
 const source=readFileSync(new URL('../apps-script/stock-gateway/RollsV2PanelApi.gs',import.meta.url),'utf8');
 const c=vm.createContext({JSON,SpreadsheetApp:{getActiveRange:()=>{throw Error('К сожалению, произошла ошибка сервера.');}}});vm.runInContext(source,c);
 const result=c.r2PanelData();assert.equal(result.readError,true);assert.equal(result.retryable,true);assert.equal(result.orders,undefined);assert.match(result.message,/временно не ответил/);
});

test('an explicit non-retryable schema failure never becomes a read retry',()=>{
 const f=fixture();let failed='';f.c.panelRead('r2PanelData',[],()=>assert.fail('must retain card'),text=>failed=text);
 f.calls[0].success({readError:true,retryable:false,message:'Не найден UID'});assert.match(failed,/UID/);assert.equal(f.timers.length,0);
});
