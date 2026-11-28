import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../worker/index.mjs';
import { fingerprint } from '../worker/import-data.mjs';
import { refreshCatalog } from '../worker/catalog.mjs';
import { correctionPlan, progressFacts } from '../worker/workflow.mjs';
import { transferPrinting } from '../scripts/import-snapshot.mjs';
import { boxSelectionText, boxTakeBlockReason, boxWorkEntry, matchesRoll, rollEmployee, rollSizeLabel, takeEntry } from '../src/printing-workflow.mjs';
import { buildJobFilterIndex, filterJobRows, selectedJobRows } from '../src/job-filters.mjs';
import { rollBatchEntries, rollChoiceMatches, rollWorkChoice } from '../src/roll-batch-work.mjs';

const boxSupply='fixture-workspace-box-0001:1';
const rollSupply='fixture-workspace-roll-001:2';
const url='https://fixture.print.test';
const hash='a'.repeat(64);
const at='2026-11-20T10:00:00.000Z';
const reports='/api/reporting/printing-work?month=2026-11';
const reportAccess={Authorization:'Bearer '+'e'.repeat(64)};

function binding(sql) {
  function prepare(query, params=[]) {
    function execute() {
      const stmt=sql.prepare(query);
      if (stmt.columns().length) return {results:stmt.all(...params),meta:{changes:0}};
      return {results:[],meta:{changes:stmt.run(...params).changes}};
    }
    return {
      bind: (...values)=>prepare(query,values),
      first: async ()=>execute().results[0]??null,
      all: async ()=>execute(),
      run: async ()=>execute(),
      execute,
    };
  }
  async function batch(statements) {
    sql.exec('BEGIN IMMEDIATE');
    try {
      const rows=statements.map(statement=>statement.execute());
      sql.exec('COMMIT');
      return rows;
    } catch (error) {sql.exec('ROLLBACK');throw error;}
  }
  return {prepare,batch};
}

function snapshot(extraRoll = false) {
  const a={id:'a',article:'SKU-A',name:'Изделие',machine:'XEROX',catalogStore:'2',plan:2,taken:2,printed:0,cut:0,
    sheetsInProduct:1,multiplicity:2,fingerprint:hash,areaPerPiece:0.03};
  const b={id:'b',article:'SKU-B',name:'Рулонный заказ',machine:'УФ',plan:2,printed:0,cut:0,rolls:[],
    cutEmployeeCode:'лукман',areaPerPiece:0.04};
  const c={...b,id:'c',article:'SKU-C',plan:3};
  const priorId='11111111-1111-4111-8111-111111111111';
  const old=[boxSupply,{rowId:'a',requestId:priorId,action:'take',unit:'sheets',employeeId:'e1',fingerprint:hash,quantity:1}];
  const past=[{operation:'take',employee:'Печатник',article:'SKU-A',pieces:2,quantity:1,unit:'sheets',area:null}];
  const parts={
    supplies:[[[boxSupply,'OZON Поставка 2 магазин','box','open',0,'OZON'],
      [rollSupply,'OZON Рулоны','roll','open',1,'OZON']]],
    positions:[[[boxSupply,a.id,0,JSON.stringify(a),2,0,0,0],
      [rollSupply,b.id,0,JSON.stringify(b),2,0,0,0],
      ...(extraRoll ? [[rollSupply,c.id,1,JSON.stringify(c),3,0,0,0]] : [])]],
    employees:[[['e1','Печатник',0]]],
    receipts:[[[priorId,boxSupply,fingerprint(old),at,JSON.stringify(old),
      JSON.stringify({ok:true,rowId:'a',article:'SKU-A',totals:{taken:1,printed:0,cut:0}}),JSON.stringify(past),'sqlite-import']]],
    catalog:[[['c2','OZON','SKU-A(OZ)','SKU-A','2','Карточка магазина 2','DTF','','','catalog-v1'],
      ['c1','OZON','SKU-A(OZ)','SKU-A','1','Чужая карточка','FP','','','catalog-v1']]],
  };
  const manifest=Object.fromEntries(Object.entries(parts).map(([key,group])=>[key,
    {count:group.flat().length,chunks:group.map(fingerprint)}]));
  return {snapshotId:hash,capturedAt:at,catalogAt:at,manifest,parts,manifestHash:fingerprint([hash,at,at,manifest]),old};
}

function host(t, {cutterConfigured=true}={}) {
  const sql=new DatabaseSync(':memory:');
  t.after(()=>sql.close());
  const migrations = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
  for (const {tag} of migrations.entries) {
    sql.exec(readFileSync(new URL('../drizzle/'+tag+'.sql',import.meta.url),'utf8'));
  }
  const configs={box:'2580',roll:'1479',cutter:'3692'};
  const pins=Object.fromEntries(Object.entries(configs).map(([key,pin])=>{
    const salt='d'.repeat(32);
    return [key,{salt,hash:scryptSync(pin,salt,32).toString('hex')}];
  }));
  const env={DB:binding(sql),PRINTING_IMPORT_KEY:'b'.repeat(64),PRINTING_KPI_READ_KEY:'e'.repeat(64),PRINTING_PINS:JSON.stringify({version:1,pins})};
  if (cutterConfigured) env.PRINTING_CUTTER_PIN=JSON.stringify({...pins.cutter,employee:'Резчик теста'});
  async function call(route, body, headers={}) {
    const init=body?{method:'POST',headers:{Origin:url,'Content-Type':'application/json',...headers},body:JSON.stringify(body)}:{headers};
    const result=await worker.fetch(new Request(url+route,init),env,{});
    return {status:result.status,value:await result.json(),cookie:result.headers.get('set-cookie')?.split(';',1)[0]};
  }
  async function admin(input) {
    const result=await call('/api/printing-import',input,{'X-Ritm-Printing-Import':env.PRINTING_IMPORT_KEY});
    assert.equal(result.status,200,JSON.stringify({step:input.action,result:result.value}));
    return result.value;
  }
  async function login(department,pin=configs[department]) {
    return call('/api/printing-access',{action:'login',department,pin});
  }
  return {sql,call,login,admin};
}

const list='/api/printing-workspace?department=';
const write='/api/printing-write';
const cutter='/api/printing-cutter';
const use = cookie => ({Cookie:cookie});

test('roll operation selection includes unprinted articles awaiting rolls and keeps cutting separate', ()=>{
  const base={plan:50,areaPerPiece:0.063,cutEmployeeCode:'лукман'};
  const readyForAssignment=rollWorkChoice({...base,id:'unassigned',printed:0,cut:null,rolls:[]},'',true);
  const readyForCut=rollWorkChoice({...base,id:'printed',printed:50,cut:0,
    rolls:[{id:'r',name:'д5',quantity:50,printed:50,cut:0}]},'',true);
  const selected=[readyForAssignment,readyForCut];
  assert.deepEqual(selected.filter(value=>rollChoiceMatches(value,'print')).map(value=>value.row.id),['unassigned']);
  assert.deepEqual(selected.filter(value=>rollChoiceMatches(value,'cut')).map(value=>value.row.id),['printed']);
  assert.equal(readyForAssignment.unassigned,50);
  assert.equal(readyForAssignment.print.length,0);
  assert.equal(rollChoiceMatches(rollWorkChoice({...readyForAssignment.row,printed:null},'',true),'print'),true);
  assert.equal(rollChoiceMatches(rollWorkChoice({...readyForAssignment.row,printed:50},'',true),'print'),false);

  const assigned={...readyForAssignment.row,rolls:[{id:'rd',name:'д5',quantity:50,printed:0,cut:0}]};
  const readyForPrint=rollWorkChoice(assigned,'д5',true);
  assert.equal(readyForPrint.print[0].quantity,50);
  assert.equal(readyForPrint.unassigned,0);
  assert.equal(rollChoiceMatches(readyForPrint,'print'),true);
  assert.equal(rollChoiceMatches(rollWorkChoice(assigned,'а5',true),'print'),false);
});

test('roll search and batch operations match complete names without regard to case', ()=>{
  const base={quantity:20,printed:10,cut:0};
  const rolls=[
    {...base,id:'exact',name:'Д1'},
    {...base,id:'prefix',name:'д11'},
    {...base,id:'suffix',name:'ад1'},
    {...base,id:'numbered',name:'д1',number:2},
    {...base,id:'spaced',name:'д 1'},
  ];
  const row={id:'a',plan:100,printed:50,cut:0,areaPerPiece:0.03,cutEmployeeCode:'лукман',rolls};
  assert.deepEqual(rolls.filter(roll=>matchesRoll(roll,' д1 ')).map(roll=>roll.id),['exact','numbered']);
  assert.deepEqual(rolls.filter(roll=>matchesRoll(roll,'Д1 №2')).map(roll=>roll.id),['numbered']);
  assert.deepEqual(rolls.filter(roll=>matchesRoll(roll,'д1№2')).map(roll=>roll.id),['numbered']);
  assert.equal(matchesRoll(rolls[0],'д'),false);
  assert.equal(matchesRoll(rolls[0],'  '),false);
  for (const operation of ['print','cut']) {
    assert.deepEqual(rollBatchEntries(row,operation,'д1').map(entry=>entry.rollId),['exact','numbered']);
    assert.deepEqual(rollBatchEntries(row,operation,'Д11').map(entry=>entry.rollId),['prefix']);
  }
});

test('direct Box, Roll, and Cutter URLs serve the app without a redirect to the home URL', async ()=>{
  const assets={fetch:request=>new URL(request.url).pathname==='/' ? new Response('print app') : Response.redirect(url)};
  for (const section of ['/box','/roll','/cutter','/cutter/']) {
    const response=await worker.fetch(new Request(url+section),{ASSETS:assets});
    assert.equal(response.status,200);
    assert.equal(await response.text(),'print app');
  }
});

test('imports position state and existing receipts, preserves shop scope, and blocks unauthorized reads', async t=>{
  const h=host(t), data=snapshot();
  assert.equal((await h.call('/api/printing-import',{action:'verify'})).status,404);
  assert.equal((await h.login('box')).status,503);
  const ready=await transferPrinting(data,h.admin);
  assert.equal(ready.counts.positions,2);
  assert.equal(ready.counts.receipts,1);
  assert.equal((await transferPrinting(data,h.admin)).counts.receipts,1);
  const login=await h.login('box');
  assert.equal(login.status,200);
  assert.equal((await h.call(list+'roll',null,use(login.cookie))).status,401);
  const detail=await h.call(list+'box&supply='+encodeURIComponent(boxSupply),null,use(login.cookie));
  assert.equal(detail.value.rows[0].name,'Карточка магазина 2');
  assert.equal(detail.value.rows[0].extension,'DTF');
  const replay=await h.call(write,{department:'box',supplyId:boxSupply,command:'work',items:[data.old[1]]},use(login.cookie));
  assert.equal(replay.value.results[0].repeated,true);
  assert.equal((await h.call(list+'box&journal=1',null,use(login.cookie))).value.work.length,1);
});

test('roll sizes group equivalent separators without mixing units or orientation', ()=>{
  assert.equal(rollSizeLabel(' 40х60 мм '),'40 × 60 мм');
  assert.equal(rollSizeLabel('40 X 60  мм'),rollSizeLabel('40×60 мм'));
  assert.notEqual(rollSizeLabel('40×60 мм'),rollSizeLabel('40×60 см'));
  assert.notEqual(rollSizeLabel('40×60 мм'),rollSizeLabel('60×40 мм'));
  assert.equal(rollSizeLabel(undefined),'');
});

test('multiple sizes combine with machine, layout and extension and scope bulk selection', ()=>{
  const rows = [
    {id:'a',size:'40х60 мм',machine:'УФ',layout:'available',extension:'PDF'},
    {id:'b',size:'75×100 мм',machine:'УФ',layout:'available',extension:'PDF'},
    {id:'c',size:'75 X 100 мм',machine:'Латекс',layout:'available',extension:'PDF'},
    {id:'d',size:'40×60 мм',machine:'УФ',layout:'missing',extension:'PDF'},
    {id:'e',size:'40×60 мм',machine:'УФ',layout:'available',extension:'TIFF'},
    {id:'f',size:'100×200 мм',machine:'УФ',layout:'available',extension:'PDF'},
    {id:'g',machine:'УФ',layout:'available',extension:'PDF'},
  ];
  const groups = [
    ['size','Размеры',row=>rollSizeLabel(row.size)],
    ['machine','Станок',row=>row.machine],['layout','Макет',row=>row.layout],
    ['extension','Расширение',row=>row.extension],
  ];
  const indexed = buildJobFilterIndex(rows,groups);
  assert.deepEqual(indexed.options.size,['40 × 60 мм','75 × 100 мм','100 × 200 мм']);
  const filters={size:['40 × 60 мм','75 × 100 мм'],machine:['УФ'],layout:['available'],extension:['PDF']};
  const matching = filterJobRows(indexed,filters,()=>true);
  assert.deepEqual(matching.map(row=>row.id),['a','b']);
  assert.deepEqual(filterJobRows(indexed,{...filters,size:['75 × 100 мм']},()=>true).map(row=>row.id),['b']);
  assert.deepEqual(filterJobRows(indexed,filters,row=>row.id!=='a').map(row=>row.id),['b']);
  assert.deepEqual(filterJobRows(indexed,{},()=>true),rows);
  const refreshed = buildJobFilterIndex(rows.slice(2),groups);
  assert.deepEqual(filterJobRows(refreshed,{...filters,size:['75 × 100 мм']},()=>true),[]);
  assert.deepEqual(selectedJobRows(matching,new Set(rows.map(row=>row.id)),new Set(['a','c','f'])).map(row=>row.id),['a']);
});

test('catalog upgrade refreshes sizes and keeps the existing market and store scope', async t=>{
  const h=host(t);
  await transferPrinting(snapshot(true),h.admin);
  const {cookie}=await h.login('roll');
  const route=list+'roll&supply='+encodeURIComponent(rollSupply);
  assert.equal((await h.call(route,null,use(cookie))).value.rows[0].size,undefined);

  const position=h.sql.prepare('SELECT payload FROM printing_positions WHERE supply_id=? AND row_id=?');
  const stored=JSON.parse(position.get(rollSupply,'b').payload);
  h.sql.prepare('UPDATE printing_positions SET payload=? WHERE supply_id=? AND row_id=?')
    .run(JSON.stringify({...stored,catalogStore:'2'}),rollSupply,'b');
  h.sql.prepare('UPDATE printing_catalog_sync SET page=7,updated_at=? WHERE singleton=1')
    .run(new Date().toISOString());

  const cards=[
    ['b-1','SKU-B','1','90×100 мм'],['b-2','SKU-B','2',' 40х60 мм '],
    ['c-1','SKU-C','1','10×20 мм'],['c-2','SKU-C','2','30×40 мм'],
  ].map(([id,sku,store,size])=>({id,sku,store,size,market:'OZON',importId:'fixture-catalog'}));
  const pages=[];
  t.mock.method(globalThis,'fetch',async url=>{
    const target=new URL(url);
    if (target.pathname==='/api/access/collector') {
      return new Response(null,{headers:{'set-cookie':'__Host-av2-workplace=fixture; Secure; Path=/'}});
    }
    assert.equal(target.pathname,'/api/catalog');
    pages.push(target.searchParams.get('page'));
    return Response.json({active:{id:'fixture-catalog'},page:0,total:cards.length,items:cards});
  });
  const jobs=[];
  const state=await refreshCatalog(binding(h.sql),'f'.repeat(64),false,{waitUntil:job=>jobs.push(job)});
  assert.equal(state.refreshing,true);
  await Promise.all(jobs);
  assert.deepEqual(pages,['0']);
  assert.equal(h.sql.prepare('SELECT format_version FROM printing_catalog_sync').get().format_version,2);

  const result=await h.call(route,null,use(cookie));
  assert.equal(result.status,200);
  assert.deepEqual(result.value.rows.map(({id,size})=>[id,size]),[['b','40х60 мм'],['c',undefined]]);
});

test('catalog retry remains pending during backoff and resumes after a temporary upstream error', async t=>{
  const h=host(t);
  await transferPrinting(snapshot(),h.admin);
  const jobs=[], log=[];
  const ctx={waitUntil:job=>jobs.push(job)};
  const db=binding(h.sql);
  let unavailable=true, calls=0;
  t.mock.method(console,'error',(...args)=>log.push(args));
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    calls++;
    assert.equal(init.redirect,'manual');
    const path=new URL(url).pathname;
    if (path==='/api/access/collector') {
      return unavailable ? new Response(null,{status:503}) :
        new Response(null,{headers:{'set-cookie':'__Host-av2-workplace=fixture; Secure; Path=/'}});
    }
    assert.equal(path,'/api/catalog');
    return Response.json({active:{id:'fixture-catalog'},page:0,total:1,
      items:[{id:'sku-b',sku:'SKU-B',store:'2',market:'OZON',importId:'fixture-catalog',size:'40×60 мм'}]});
  });

  const token='b'.repeat(64);
  assert.equal((await refreshCatalog(db,token,false,ctx)).refreshing,true);
  await Promise.all(jobs.splice(0));
  assert.deepEqual(log,[['Printing catalog sync paused',{stage:'collector_http',status:503}]]);
  const paused=await refreshCatalog(db,token,false,ctx);
  assert.equal(paused.refreshing,true);
  assert.ok(paused.retryAfterMs>0 && paused.retryAfterMs<=30_000);
  assert.equal(jobs.length,0);
  assert.equal(calls,1);

  unavailable=false;
  h.sql.prepare('UPDATE printing_catalog_sync SET retry_at=0 WHERE singleton=1').run();
  assert.equal((await refreshCatalog(db,token,false,ctx)).refreshing,true);
  await Promise.all(jobs.splice(0));
  assert.equal(h.sql.prepare('SELECT size FROM printing_catalog_cards WHERE sku_key=?').get('SKU-B').size,'40×60 мм');
  assert.equal((await refreshCatalog(db,token,false,ctx)).refreshing,false);
});

test('article search shows current progress from other supplies in the signed-in department', async t=>{
  const h=host(t), data=snapshot();
  const otherBox='fixture-workspace-box-0002:3';
  const otherRoll='fixture-workspace-roll-002:4';
  const boxRow={...JSON.parse(data.parts.positions[0][0][3]),name:'Стикеры для блокнота',plan:12,taken:12,printed:8,cut:4};
  data.parts.supplies[0].push([otherBox,'OZON Другая поставка','box','open',2,'OZON']);
  data.parts.positions[0].push([otherBox,boxRow.id,0,JSON.stringify(boxRow),12,8,4,4]);
  const roll=data.parts.positions[0][1];
  const rollRow={...JSON.parse(roll[3]),article:'SKU-A'};
  roll[3]=JSON.stringify(rollRow);
  data.parts.supplies[0].push([otherRoll,'OZON Другие рулоны','roll','open',3,'OZON']);
  const confirmedRoll={...rollRow,plan:12,printed:9,cut:4,extension:'PDF',rolls:[{id:'roll-1',name:'д1',quantity:5,printed:5,cut:4}]};
  const unknownRoll={...confirmedRoll,id:'unconfirmed',rolls:[]};
  data.parts.positions[0].push([otherRoll,confirmedRoll.id,0,JSON.stringify(confirmedRoll),12,9,4,1],
    [otherRoll,unknownRoll.id,1,JSON.stringify(unknownRoll),12,9,4,null]);
  for (const kind of ['supplies','positions']) {
    data.manifest[kind]={count:data.parts[kind][0].length,chunks:[fingerprint(data.parts[kind][0])]};
  }
  data.manifestHash=fingerprint([data.snapshotId,data.capturedAt,data.catalogAt,data.manifest]);
  await transferPrinting(data,h.admin);
  const {cookie}=await h.login('box');
  const search=list+'box&supply='+encodeURIComponent(boxSupply)+'&search=';
  assert.equal((await h.call(search+'sku-a')).status,401);
  const initial=await h.call(search+'sku-a',null,use(cookie));
  assert.equal(initial.status,200);
  assert.deepEqual(initial.value,{
    hits:[{supplyId:otherBox,supplyName:'OZON Другая поставка',rowId:boxRow.id,article:'SKU-A',
      name:boxRow.name,plan:12,printed:8,cut:4,cutAvailable:4,extension:'DTF'}],total:1,
  });
  assert.equal((await h.call(search+encodeURIComponent('БЛОКНОТА'),null,use(cookie))).value.hits[0].supplyId,otherBox);
  const cut=await h.call(write,{department:'box',supplyId:otherBox,command:'work',
    items:[{rowId:boxRow.id,requestId:randomUUID(),action:'cut',employeeId:'e1',unit:'sheets',quantity:1,fingerprint:hash}]},use(cookie));
  assert.equal(cut.value.results[0].ok,true);
  const updated=(await h.call(search+'sku-a',null,use(cookie))).value.hits[0];
  assert.equal(updated.cut,6);
  assert.equal(updated.cutAvailable,2);

  const rollLogin=await h.login('roll');
  const rollSearch=await h.call(list+'roll&supply='+encodeURIComponent(rollSupply)+'&search=sku-a',null,use(rollLogin.cookie));
  assert.equal(rollSearch.status,200);
  assert.deepEqual(rollSearch.value.hits.map(hit=>[hit.supplyId,hit.cutAvailable]),[[otherRoll,1],[otherRoll,null]]);
  assert.deepEqual(rollSearch.value.hits.map(hit=>hit.extension),['PDF','PDF']);
});

test('Box selection copies the selected operation amounts as spreadsheet columns in pieces', ()=>{
  const xerox = {id:'a',article:'SKU-A',machine:'Xerox',plan:30,taken:0,printed:0,sheetsInProduct:1,multiplicity:3};
  const other = {id:'b',article:'SKU-B',machine:'Laser',plan:1500,taken:230,printed:50,cut:24};
  assert.deepEqual(boxSelectionText([other,xerox],row=>takeEntry(row,[],row.id==='a'
    ? {quantity:'2',unit:'sheets'} : undefined)),{text:'SKU-B\t1270\nSKU-A\t6'});
  assert.deepEqual(boxSelectionText([other],row=>boxWorkEntry(row,[],'cut',false)),{text:'SKU-B\t26'});
  assert.match(boxSelectionText([xerox],row=>takeEntry(row,[],{quantity:'99'})).error,/SKU-A.*доступный остаток/u);
});

test('atomic Box write retries cannot exceed the plan or duplicate an existing receipt', async t=>{
  const h=host(t);
  await transferPrinting(snapshot(),h.admin);
  const {cookie}=await h.login('box');
  function print(requestId) {
    return h.call(write,{department:'box',supplyId:boxSupply,command:'work',
      items:[{rowId:'a',requestId,action:'print',employeeId:'e1',unit:'sheets',quantity:1,fingerprint:hash}]},use(cookie));
  }
  const first=randomUUID(),second=randomUUID();
  const results=await Promise.all([print(first),print(second)]);
  assert.equal(results.filter(result=>result.value.results[0].ok).length,1);
  const selected=results[0].value.results[0].ok?first:second;
  assert.equal((await print(selected)).value.results[0].repeated,true);
  const summary=await h.call(list+'box',null,use(cookie));
  assert.equal(summary.value.supplies[0].progress.printed,1);
  const journal=(await h.call(list+'box&journal=1',null,use(cookie))).value.work;
  assert.equal(journal.length,2);
  assert.equal(journal[0].area,0.06);
  assert.equal(journal[0].sheets,1);
  assert.equal((await h.call(reports)).status,404);
  h.sql.prepare("UPDATE printing_positions SET payload=json_set(payload,'$.areaPerPiece',0.36) WHERE supply_id=?").run(boxSupply);
  const month=new Date(Date.now()+3*3600_000).toISOString().slice(0,7);
  const currentReport='/api/reporting/printing-work?month='+month;
  const report=await h.call(currentReport,null,reportAccess);
  assert.equal(report.status,200);
  assert.deepEqual(report.value.work.map(({id,rowId,pieces,sheets,area,employee})=>({id,rowId,pieces,sheets,area,employee})),[
    {id:selected+':0',rowId:'a',pieces:2,sheets:1,area:0.06,employee:'Печатник'},
  ]);
  const resume=await h.call(currentReport+'&after='+report.value.next,null,reportAccess);
  assert.deepEqual(resume.value.work,[]);
});

test('the report cursor handles a receipt split across pages and excludes imported copies', async t=>{
  const h=host(t);
  await transferPrinting(snapshot(),h.admin);
  const uuid=randomUUID();
  const facts=Array.from({length:251},()=>({operation:'cut',employee:'Иван',article:'SKU-B',pieces:1,sheets:null,area:0.04}));
  const insert=h.sql.prepare('INSERT INTO printing_receipts VALUES (?,?,?,?,?,?,?,?)');
  insert.run(randomUUID(),rollSupply,hash,at,'[]','{}',JSON.stringify(facts),'sqlite-import');
  insert.run(uuid,rollSupply,hash,at,JSON.stringify([rollSupply,'work-many','cut',facts.map(()=>({rowId:'b'}))]),'{}',JSON.stringify(facts),'test-commit');
  insert.run(randomUUID(),rollSupply,hash,'2026-11-30T21:00:00.000Z','[]','{}',JSON.stringify(facts.slice(0,1)),'test-commit');
  const page=await h.call(reports,null,reportAccess);
  assert.equal(page.status,200);
  assert.equal(page.value.complete,false);
  assert.equal(page.value.work.length,250);
  assert.deepEqual(page.value.work.map(x=>x.id),facts.slice(0,250).map((_,i)=>uuid+':'+i));
  assert.equal(page.value.work[249].rowId,'b');
  insert.run(randomUUID(),rollSupply,hash,at,'[]','{}',JSON.stringify(facts.slice(0,1)),'test-commit');
  const last=await h.call(reports+'&after='+page.value.next+'&through='+page.value.through,null,reportAccess);
  assert.equal(last.status,200);
  assert.equal(last.value.complete,true);
  assert.deepEqual(last.value.work.map(x=>x.id),[uuid+':250']);
});

test('a fully printed Box item cannot be taken again and can still be cut', async t=>{
  const h=host(t), data=snapshot();
  const position=data.parts.positions[0][0];
  const row={...JSON.parse(position[3]),taken:1};
  position[3]=JSON.stringify(row);
  data.manifest.positions.chunks[0]=fingerprint(data.parts.positions[0]);
  data.manifestHash=fingerprint([data.snapshotId,data.capturedAt,data.catalogAt,data.manifest]);
  await transferPrinting(data,h.admin);
  const {cookie}=await h.login('box');
  const processItem=(action,unit)=>h.call(write,{department:'box',supplyId:boxSupply,command:'work',
    items:[{rowId:row.id,requestId:randomUUID(),action,unit,employeeId:'e1',fingerprint:hash,quantity:1}]},use(cookie));
  assert.equal(boxTakeBlockReason(row,[],true),'');
  assert.equal((await processItem('print','sheets')).value.results[0].ok,true);
  const detail=await h.call(list+'box&supply='+encodeURIComponent(boxSupply),null,use(cookie));
  assert.equal(boxTakeBlockReason(detail.value.rows[0],[],true),'План печати выполнен');
  assert.equal((await processItem('take','pieces')).value.results[0].ok,false);
  assert.equal((await processItem('cut','sheets')).value.results[0].ok,true);
});

test('Box selection keeps whole pieces that are smaller than a Xerox sheet', ()=>{
  const row={machine:'XEROX',plan:10,printed:9,cut:0,fingerprint:hash,sheetsInProduct:3,multiplicity:4};
  assert.deepEqual(boxWorkEntry(row,[],'print',true),{quantity:1,unit:'pieces',pieces:1});
});

test('Box corrections reopen completed work, preserve history and reject stale totals', async t=>{
  const h=host(t);
  await transferPrinting(snapshot(),h.admin);
  const {cookie}=await h.login('box');
  const send=(command,items,requestId)=>h.call(write,{department:'box',supplyId:boxSupply,command,items,requestId},use(cookie));
  const record=action=>send('work',[{rowId:'a',requestId:randomUUID(),action,unit:'sheets',employeeId:'e1',fingerprint:hash,quantity:1}]);
  assert.equal((await record('print')).value.results[0].workRevision,1);
  assert.equal((await record('cut')).value.results[0].workRevision,2);
  const feed=list+'box&supply='+encodeURIComponent(boxSupply);
  const complete=await h.call(feed,null,use(cookie));
  assert.equal(complete.value.writeReady,false);
  assert.equal(complete.value.correctionReady,true);
  assert.equal(complete.value.rows[0].workRevision,2);
  assert.equal((await send('correct',[{rowId:'a',revision:2,printed:0}],randomUUID())).status,409);

  const fix={rowId:'a',revision:2,cut:0}, operationId=randomUUID();
  const cutFixed=await send('correct',[fix],operationId);
  assert.deepEqual(cutFixed.value.patches,[{id:'a',printed:2,cut:0,workRevision:3}]);
  assert.equal((await h.call(feed,null,use(cookie))).value.writeReady,true);
  assert.equal((await send('correct',[fix],operationId)).status,200);
  assert.equal((await send('correct',[{rowId:'a',revision:2,printed:0}],randomUUID())).status,409);
  const printFixed=await send('correct',[{rowId:'a',revision:3,printed:1}],randomUUID());
  assert.equal(printFixed.value.patches[0].printed,1);
  const {work}= (await h.call(list+'box&journal=1',null,use(cookie))).value;
  const corrections=work.filter(value=>value.correction);
  assert.deepEqual(corrections.map(({operation,before,after,pieces})=>[operation,before,after,pieces]),
    [['print',2,1,-1],['cut',2,0,-2]]);
  assert.equal(work.filter(value=>!value.correction).length,3);
  assert.equal(corrections[0].area,-0.03);
});

test('roll corrections rename and resize a roll and reset article progress independently', async t=>{
  const h=host(t), data=snapshot();
  const position=data.parts.positions[0][1];
  const row={...JSON.parse(position[3]),plan:6};
  position[3]=JSON.stringify(row);
  position[4]=row.plan;
  data.manifest.positions.chunks[0]=fingerprint(data.parts.positions[0]);
  data.manifestHash=fingerprint([data.snapshotId,data.capturedAt,data.catalogAt,data.manifest]);
  await transferPrinting(data,h.admin);
  const {cookie}=await h.login('roll');
  const send=(command,items,operation,requestId=randomUUID())=>h.call(write,{
    department:'roll',supplyId:rollSupply,command,requestId,operation,items,
  },use(cookie));
  const created=await send('create',[{rowId:'b',name:'д13',quantity:2,count:2,expectedPlan:6,expectedAllocated:0}]);
  const [first,second]=created.value.patches[0].rolls;
  const log=(operation,roll,quantity)=>send('work',[{
    rowId:'b',rollId:roll.id,quantity,expectedQuantity:2,expectedActual:0,
  }],operation);
  await log('print',first,2);
  const printed=await log('print',second,2);
  const cut=await log('cut',first,1);
  assert.equal(cut.status,403);
  assert.equal(cut.value.rejected,true);
  const revision=printed.value.patches[0].workRevision;
  const edit={rowId:'b',rollId:first.id,revision,name:'а52',quantity:3,printed:1};
  const changed=await send('correct',[edit]);
  const saved=changed.value.patches[0];
  assert.deepEqual([saved.printed,saved.cut,saved.rolls[0].name,saved.rolls[0].quantity],[3,0,'а52',3]);
  assert.equal(rollEmployee(saved.rolls[0],saved,'print'),'Андрей');
  assert.equal((await send('correct',[{...edit,revision:saved.workRevision,quantity:5}])).status,409);
  assert.equal((await send('correct',[{rowId:'b',revision:saved.workRevision,reset:'cut'}])).status,403);
  assert.equal((await send('correct',[{rowId:'b',rollId:first.id,revision:saved.workRevision,cut:1}])).status,403);
  const clearPrint=(await send('correct',[{rowId:'b',revision:saved.workRevision,reset:'print'}])).value.patches[0];
  assert.deepEqual([clearPrint.printed,clearPrint.cut],[0,0]);
  assert.deepEqual(clearPrint.rolls.map(roll=>[roll.name,roll.quantity,roll.printed]),[['а52',3,0],['д13',2,0]]);
  const {work}=(await h.call(list+'roll&journal=1',null,use(cookie))).value;
  assert.ok(work.some(entry=>entry.operation==='roll-edit' && entry.beforeName==='д13' && entry.afterName==='а52'));
  assert.equal(work.find(entry=>entry.correction && entry.operation==='print' && !entry.rollId).rolls.length,2);
});

test('corrections preserve historical rolls and the planned cap for imported overages', ()=>{
  const row={id:'r',article:'SKU-OLD',plan:10,printed:10,cut:10,rolls:[
    {id:'live',name:'д1',quantity:15,printed:15,cut:15},
    {id:'old',name:'д2',quantity:30,printed:30,cut:1,legacyOnly:true},
  ]};
  const change=(position,patch)=>correctionPlan({row:position,revision:0},{department:'roll',items:[{revision:0,...patch}]}).changes[0].row;
  const smaller=change(row,{rollId:'live',printed:12,cut:12});
  assert.deepEqual([smaller.printed,smaller.cut],[10,10]);
  assert.throws(()=>change(smaller,{reset:'print'}),/порезка уже записана/);
  const uncut=change(smaller,{rollId:'live',cut:0});
  const reset=change(uncut,{reset:'print'});
  assert.deepEqual([reset.printed,reset.cut,reset.rolls[0].printed],[0,0,0]);
  assert.deepEqual(reset.rolls[1],row.rolls[1]);
  assert.equal(progressFacts(reset,'roll').cutAvailable,0);
});

test('roll assignment and counted print are stored once with the automatic employee', async t=>{
  const h=host(t);
  await transferPrinting(snapshot(),h.admin);
  const {cookie}=await h.login('roll');
  const send=body=>h.call(write,{department:'roll',supplyId:rollSupply,...body},use(cookie));
  const input={command:'create',requestId:randomUUID(),items:[{rowId:'b',name:'д заказ',quantity:2,count:1,expectedPlan:2,expectedAllocated:0}]};
  const assigned=await send(input);
  assert.equal(assigned.status,200);
  const roll=assigned.value.patches[0].rolls[0];
  const op={command:'work',requestId:randomUUID(),operation:'print',
    items:[{rowId:'b',rollId:roll.id,quantity:1,expectedQuantity:2,expectedActual:0}]};
  assert.equal((await send(op)).value.patches[0].printed,1);
  assert.equal((await send(op)).value.patches[0].printed,1);
  assert.equal((await send({...input,requestId:randomUUID()})).status,409);
  const journal=(await h.call(list+'roll&journal=1',null,use(cookie))).value.work;
  assert.equal(journal.length,1);
  assert.equal(journal[0].employee,rollEmployee(roll,{},'print'));
  assert.equal(journal[0].area,0.04);
});

test('batch print and cut handle several articles and rolls atomically', async t=>{
  const h=host(t);
  await transferPrinting(snapshot(true),h.admin);
  const {cookie}=await h.login('roll');
  const cutterLogin=await h.login('cutter');
  assert.equal(cutterLogin.status,200);
  assert.equal(cutterLogin.value.cutterConfigured,true);
  const cuttingAsCutter=body=>h.call(cutter,body,use(cutterLogin.cookie));
  const send=body=>h.call(write,{department:'roll',supplyId:rollSupply,...body},use(cookie));
  const detail=()=>h.call(list+'roll&supply='+encodeURIComponent(rollSupply),null,use(cookie));
  const journal=()=>h.call(list+'roll&journal=1',null,use(cookie));
  const assigned=await send({command:'create',requestId:randomUUID(),items:[
    {rowId:'b',name:'д3',quantity:1,count:2,expectedPlan:2,expectedAllocated:0},
    {rowId:'c',name:'Д3',quantity:3,count:1,expectedPlan:3,expectedAllocated:0},
  ]});
  assert.equal(assigned.status,200);
  let rows=(await detail()).value.rows;
  assert.equal(rollBatchEntries(rows[0],'cut').length,0);
  assert.equal(rollBatchEntries(rows[0],'print','д3№2').length,1);
  const items=rows.flatMap(row=>rollBatchEntries(row,'print'));
  const printing={command:'work-many',requestId:randomUUID(),operation:'print',items};
  const duplicate=await send({...printing,items:[...items,items[0]]});
  assert.equal(duplicate.status,409);
  const earlyPrint=await send({...printing,requestId:randomUUID(),items:[items[0]]});
  assert.equal(earlyPrint.status,200);
  assert.deepEqual((await cuttingAsCutter()).value.ready,[]);
  printing.items=items.slice(1);
  const print=await send(printing);
  assert.equal(print.status,200);
  assert.deepEqual(print.value.patches.map(row=>row.printed),[2,3]);
  assert.equal((await send(printing)).value.confirmed,2);
  assert.equal((await journal()).value.work.length,3);

  const {ready,supplies}= (await cuttingAsCutter()).value;
  assert.equal(supplies.find(supply=>supply.id===rollSupply).remaining,2);
  assert.deepEqual(ready.map(roll=>[roll.name,roll.number,roll.quantity,roll.items.length]),[['д3',1,4,2],['д3',2,1,1]]);
  rows=(await detail()).value.rows;
  const oldCutting={command:'work-many',requestId:randomUUID(),operation:'cut',items:rows.flatMap(row=>rollBatchEntries(row,'cut'))};
  assert.equal((await send(oldCutting)).status,403);
  assert.equal((await h.call(cutter,null,use(cookie))).status,403);
  assert.equal((await h.call(write,{department:'roll',supplyId:rollSupply,...printing},use(cutterLogin.cookie))).status,403);
  const cutting={requestId:randomUUID(),rolls:ready.map(({id,revision})=>({id,revision}))};
  const wrong=[cutting.rolls[0],{...cutting.rolls[1],revision:hash}];
  assert.equal((await cuttingAsCutter({...cutting,rolls:wrong})).status,409);
  assert.deepEqual((await detail()).value.rows.map(row=>row.cut),[0,0]);
  const [cut,retried]=await Promise.all([cuttingAsCutter(cutting),cuttingAsCutter(cutting)]);
  assert.equal(cut.status,200);
  assert.equal(retried.status,200);
  assert.deepEqual(cut.value,retried.value);
  assert.equal(cut.value.recorded,2);
  assert.equal(cut.value.quantity,5);
  const current=(await detail()).value.rows;
  assert.deepEqual(current.map(row=>row.cut),[2,3]);
  assert.equal((await send({command:'correct',requestId:randomUUID(),items:[{rowId:'b',revision:current[0].workRevision,reset:'print'}]})).status,409);
  assert.equal((await cuttingAsCutter({...cutting,requestId:randomUUID()})).status,409);
  const completed=(await cuttingAsCutter()).value;
  assert.equal(completed.supplies.find(supply=>supply.id===rollSupply).remaining,0);
  assert.equal(completed.ready.length,0);
  assert.equal(completed.completed.length,2);
  assert.ok(completed.completed.every(roll=>roll.remaining===0 && Number.isFinite(Date.parse(roll.completedAt))));
  const work=(await journal()).value.work;
  assert.equal(work.length,6);
  assert.equal(work.filter(entry=>entry.operation==='cut' && entry.employee==='Резчик теста').length,3);
  assert.ok(work.every(entry=>entry.area===entry.pieces*0.04));
});

test('cutter loads legacy history and records a selection across supplies with separate journal receipts', async t=>{
  const h=host(t);
  await transferPrinting(snapshot(),h.admin);
  const other='fixture-workspace-roll-002:3';
  const insertSupply=h.sql.prepare('INSERT INTO printing_supplies VALUES (?,?,?,?,?,?)');
  insertSupply.run(other,'WB Рулоны','roll','open',2,'WB');
  const add=h.sql.prepare('INSERT INTO printing_positions VALUES (?,?,?,?,?,?,?,?,?)');
  const amend=h.sql.prepare('UPDATE printing_positions SET payload=?,plan=?,printed=?,cut=?,cut_available=? WHERE supply_id=? AND row_id=?');
  const current=(id,rolls)=>({id,article:'SKU-'+id,name:'Позиция '+id,plan:rolls.length,printed:rolls.length,cut:0,rolls});
  const roll=(id,name)=>({id,name,number:1,quantity:1,printed:1,cut:0});
  const active=roll('active','п1'), additional=roll('additional','п1');
  const historical={...roll('old','п2'),cut:1,legacyOnly:true};
  const first={...current('b',[active,historical]),cut:1};
  amend.run(JSON.stringify(first),2,2,1,1,rollSupply,'b');
  add.run(other,'b',0,JSON.stringify(current('b',[additional])),1,1,0,1,0);
  const importCut=h.sql.prepare('INSERT INTO printing_receipts VALUES (?,?,?,?,?,?,?,?)');
  importCut.run(randomUUID(),rollSupply,'imported',at,'[]','{}',
    JSON.stringify([{operation:'cut',pieces:1,rollId:historical.id}]),'sqlite-import');
  const login=await h.login('cutter');
  const read=()=>h.call(cutter,null,use(login.cookie));
  const initial=(await read()).value;
  assert.deepEqual(initial.supplies.map(s=>s.remaining),[1,1]);
  assert.deepEqual(initial.completed.map(({name,completedAt})=>[name,completedAt]),[['п2',at]]);
  assert.equal(initial.ready.length,2);
  assert.notEqual(initial.ready[0].id,initial.ready[1].id);
  const input={requestId:randomUUID(),rolls:initial.ready.map(({id,revision})=>({id,revision}))};
  const result=await h.call(cutter,input,use(login.cookie));
  assert.equal(result.status,200);
  assert.deepEqual([result.value.recorded,result.value.quantity],[2,2]);
  const combined=h.sql.prepare('SELECT id,supply_id FROM printing_receipts WHERE id=? OR id=? ORDER BY id').all(input.requestId,input.requestId+':1');
  assert.deepEqual(combined.map(row=>row.supply_id),[rollSupply,other]);
  assert.deepEqual((await read()).value.supplies.map(s=>s.remaining),[0,0]);
});

test('cutter shows catalog names for ready and completed rolls in the matching market and shop', async t=>{
  const h=host(t);
  await transferPrinting(snapshot(),h.admin);
  const wb='fixture-workspace-roll-002:3';
  const unscoped='fixture-workspace-roll-003:4';
  h.sql.prepare('UPDATE printing_supplies SET name=? WHERE id=?').run('OZON Рулоны 1 магазин',rollSupply);
  const supply=h.sql.prepare('INSERT INTO printing_supplies VALUES (?,?,?,?,?,?)');
  supply.run(wb,'WB Рулоны 2 магазин','roll','open',2,'WB');
  supply.run(unscoped,'OZON Рулоны без магазина','roll','open',3,'OZON');
  h.sql.prepare(`INSERT INTO printing_catalog_cards(id,market,sku,sku_key,store,name,extension,photo,photo_id,import_id)
    VALUES ('wb-a','WB','SKU-A','SKU-A','2','Карточка WB','','','','catalog-v1')`).run();
  h.sql.prepare('DELETE FROM printing_positions WHERE supply_id=?').run(rollSupply);
  const position=h.sql.prepare('INSERT INTO printing_positions VALUES (?,?,?,?,?,?,?,?,?)');
  function add(supplyId,id,article,name,rollName,cut,catalogStore) {
    const row={id,article,name,catalogStore,plan:1,printed:1,cut,
      rolls:[{id:'roll-'+id,name:rollName,number:1,quantity:1,printed:1,cut}]};
    position.run(supplyId,id,0,JSON.stringify(row),1,1,cut,1-cut,0);
  }
  add(rollSupply,'override','sku-a(oz)','','д1',0,'2');
  add(rollSupply,'history','sku-a','','д2',1);
  add(rollSupply,'missing','SKU-UNKNOWN','Название из поставки','д3',0);
  add(wb,'wb','SKU-A','','д4',0);
  add(unscoped,'ambiguous','SKU-A','Название без магазина','д5',0);

  const {cookie}=await h.login('cutter');
  const feed=await h.call(cutter,null,use(cookie));
  assert.equal(feed.status,200);
  assert.deepEqual(feed.value.ready.map(({name,items})=>[name,items[0].name]),[
    ['д1','Карточка магазина 2'],
    ['д3','Название из поставки'],
    ['д4','Карточка WB'],
    ['д5','Название без магазина'],
  ]);
  assert.deepEqual(feed.value.completed.map(({name,items})=>[name,items[0].name]),[['д2','Чужая карточка']]);
});

test('missing cutter PIN leaves existing sign-ins available and cutter access fails closed', async t=>{
  const h=host(t,{cutterConfigured:false});
  await transferPrinting(snapshot(),h.admin);
  const user=await h.login('roll');
  assert.equal(user.status,200);
  assert.equal(user.value.cutterConfigured,false);
  assert.equal((await h.login('cutter')).status,503);
  assert.equal((await h.call(cutter)).status,401);
  assert.equal((await h.call(cutter,null,use(user.cookie))).status,403);
});

test('batch quantities are limited by the article and include only matching printed rolls', ()=>{
  const row={id:'x',plan:10,printed:10,cut:6,areaPerPiece:0.02,cutEmployeeCode:'лукман',
    rolls:[{id:'a',name:'д3',quantity:6,printed:6,cut:0},{id:'b',name:'д4',quantity:6,printed:6,cut:0}]};
  assert.deepEqual(rollBatchEntries(row,'cut','д4').map(entry=>[entry.rollId,entry.quantity]),[['b',4]]);
  assert.equal(rollBatchEntries(row,'cut').reduce((sum,entry)=>sum+entry.quantity,0),4);
  assert.deepEqual(rollBatchEntries(row,'print'),[]);
  assert.deepEqual(rollBatchEntries({...row,areaPerPiece:null},'cut'),[]);
});
