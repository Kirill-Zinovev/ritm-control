import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { cloudApi } from '../worker/cloud/runtime.js';
import { CloudStore } from '../worker/cloud/store.js';
import { printingReadModel } from '../worker/cloud/printing-workspace/read-model.mjs';
import { printingWorkspaceFeed, printingWorkspaceWrite } from '../worker/cloud/printing-workspace/feed.mjs';
import { LocalD1 } from './helpers/d1-sqlite.mjs';
import { cloudSchemaStatements } from './helpers/cloud-schema.mjs';

const box = 'box-fixture-document-id';
const roll = 'roll-fixture-document-id';
const sheet = (spreadsheetId,sheetId,sourceId) => ({spreadsheetId,sheetId,sourceId,name:'Test '+sourceId});
const sheets = [sheet(box,1,'box-printing'),sheet(roll,2,'roll-printing')];
const snapshot = {sheets, supplies:sheets.map(row => ({
  ...row,sheetName:row.name,uid:'uid-'+row.sheetId,row:5,article:'SKU-'+row.sheetId,
  quantity:10,printProgress:10,cutProgress:4,productionTabComplete:false,
}))};
const read = async () => snapshot;
const neverFetch = () => assert.fail('This test does not access Sheets');
const endpoint = new URL('https://ritm.example.test/api/printing-workspace-feed');

test('the workspace feed rejects writes and requests without its dedicated token', async () => {
  const env = {RITM_PRINTING_WORKSPACE_TOKEN:'a'.repeat(64)};
  assert.equal((await cloudApi(new Request(endpoint),env)).status,403);
  assert.equal((await cloudApi(new Request(endpoint,{method:'POST'}),env)).status,405);
  const write = new Request('https://ritm.example.test/api/printing-workspace-write',{
    method:'POST',headers:{Authorization:'Bearer '+env.RITM_PRINTING_WORKSPACE_TOKEN,'Content-Type':'application/json'},
  });
  assert.equal((await cloudApi(write,env)).status,403);
});

test('the first screen returns shipment and article rows before querying Google details', async () => {
  const url = new URL('?department=roll&boot=1',endpoint);
  const result = await (await printingWorkspaceFeed(url,{},neverFetch,read)).json();
  assert.equal(result.supportsSupplyPreview,true);
  assert.equal(result.preview.id,roll+':2');
  assert.equal(result.preview.writeReady,false);
  assert.equal(result.preview.rows[0].article,'SKU-2');
  assert.equal(result.supplies[0].progress.printed,1);
});

test('a selected supply uses the saved rows while the working journal is unavailable', async () => {
  const secondBox = {...snapshot.supplies[0],sheetId:3,sheetName:'Second box',article:'SKU-3'};
  const saved = JSON.stringify({
    sheets:[...sheets,{...sheets[0],sheetId:3,name:secondBox.sheetName}],
    supplies:[...snapshot.supplies,secondBox],
  });
  const result = {results:[{
    updated_at:Date.now()-360_000,chunks:1,
    digest:createHash('sha256').update(saved).digest('hex'),payload:saved,
  }]};
  const env = {
    DB:{
      batch:() => assert.fail('The preview must not write to the database'),
      prepare:query => {
        assert.match(query,/cloud_snapshot_chunks/);
        return {bind:kind => {
          assert.equal(kind,'printing');
          return {all:async () => result};
        }};
      },
    },
    RITM_PRINTING_WORKSPACE_TOKEN:'a'.repeat(64),
    RITM_PRINTING_WORK_CONNECTIONS:JSON.stringify({
      box:{sourceId:box,url:'https://script.google.com/macros/s/box/exec',token:'f'.repeat(64)},
    }),
  };
  const query = new URL('?department=box&preview=1&work=1',endpoint);
  const request = () => new Request(query,{headers:{
    Authorization:'Bearer '+env.RITM_PRINTING_WORKSPACE_TOKEN,
    'Content-Type':'application/json',
  }});
  query.searchParams.set('supply',box+':3');
  const response = await cloudApi(request(),env,undefined,{fetcher:neverFetch});
  const data = await response.json();
  assert.equal(response.status,200, data.message);
  assert.equal(data.id,box+':3');
  assert.deepEqual(data.rows.map(row => row.article),['SKU-3']);
  assert.equal(data.partial,true);
  assert.equal(data.writeReady,false);
  assert.equal(data.stale,true);
  query.searchParams.set('supply',roll+':2');
  assert.equal((await cloudApi(request(),env,undefined,{fetcher:neverFetch})).status,404);
});

test('writes reach only the configured Apps Script and return Google confirmations', async () => {
  const settings = Object.fromEntries([['roll',roll],['box',box]].map(([role,sourceId])=>[role,{
    sourceId,url:'https://script.google.com/macros/s/'+role+'/exec',token:'f'.repeat(64),
  }]));
  const env = {RITM_PRINTING_WORK_CONNECTIONS:JSON.stringify(settings)};
  let mutations = 0;
  const mock = async (url,init) => {
    const payload = JSON.parse(init.body);
    mutations++;
    assert.equal(payload.printingWeb,1);
    if (url===settings.box.url) {
      assert.equal(payload.sheetId,1);
      assert.equal(payload.items[0].article,'SKU-1');
      assert.equal(payload.items[0].row,5);
      return Response.json({ok:true,results:[{ok:true,totals:{taken:3,printed:0,cut:0}}]});
    }
    assert.equal(url,settings.roll.url);
    assert.equal(payload.sheetId,2);
    const printed = payload.operation === 'cut' ? 3 : payload.command === 'work' ? payload.items[0].quantity : 0;
    const cut = payload.operation === 'cut' ? payload.items[0].quantity : 0;
    return Response.json({ok:true,requestId:payload.requestId,confirmed:1,orders:[{
      row:5,uid:'uid-2',print:{actual:printed},cut:{actual:cut},
      rolls:[{rollId:'r1',name:'д99',number:1,quantity:10,printActual:printed,cutActual:cut,employee:'Дмитрий'}],
    }]});
  };
  const requestId='00000000-0000-4000-8000-000000000001';
  const post = async data => (await printingWorkspaceWrite(new Request('https://ritm.example.test/api/printing-workspace-write',{
    method:'POST',body:JSON.stringify(data),headers:{'Content-Type':'application/json'},
  }),env,mock,read)).json();
  for(const action of ['take','print','cut']){
    const response=await post({department:'box',supplyId:box+':1',command:'work',items:[{
      rowId:'uid-1:5',requestId,action,unit:'pieces',quantity:3,employeeId:'employee',fingerprint:'f'.repeat(64),
    }]});
    assert.equal(response.results[0].ok,true);
  }
  const scope={department:'roll',supplyId:roll+':2',requestId};
  const result=await post({...scope,command:'create',items:[{
    rowId:'uid-2:5',name:'д99',quantity:10,count:1,expectedPlan:10,expectedAllocated:0,
  }]});
  assert.equal(result.patches[0].rolls[0].id,'r1');
  for(const operation of ['print','cut']){
    const response=await post({...scope,command:'work',operation,items:[{
      rowId:'uid-2:5',rollId:'r1',quantity:3,expectedQuantity:10,expectedActual:0,
    }]});
    assert.equal(response.patches[0][operation==='print'?'printed':'cut'],3);
  }
  assert.equal((await post({...scope,supplyId:box+':1',command:'work',operation:'cut',items:[{
    rowId:'uid-1:5',rollId:'r1',quantity:3,expectedQuantity:10,expectedActual:0,
  }]})).rejected,true);
  assert.equal(mutations,6);
});

test('the box list uses the existing snapshot and cannot open a roll supply', async () => {
  const url = new URL('?department=box',endpoint);
  const result = await (await printingWorkspaceFeed(url,{},neverFetch,read)).json();
  assert.equal(result.readOnly,true);
  assert.equal(result.supplies.length,1);
  assert.equal(result.supplies[0].id,box+':1');
  assert.equal(result.supplies[0].progress.canCut,1);
  url.searchParams.set('supply',roll+':2');
  await assert.rejects(() => printingWorkspaceFeed(url,{},neverFetch,read),{status:404});
});

test('Box and roll supply details are served from RITM after sync and refreshed after writing', async t => {
  const db = new LocalD1();
  t.after(() => db.close());
  db.db.exec(cloudSchemaStatements().join(';\n'));
  const store = new CloudStore(db);
  const sourceLease = await store.acquire('fixture-printing');
  await store.saveSnapshot('printing',snapshot,sourceLease);
  await store.release(sourceLease);

  const gateway = 'https://script.google.com/macros/s/box/exec';
  const {privateKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const env = {
    DB:db,RITM_GOOGLE_BOX_PRINTING_ID:box,RITM_GOOGLE_ROLL_PRINTING_ID:roll,
    RITM_GOOGLE_READER_JSON:JSON.stringify({type:'service_account',client_email:'fixture@example.test',
      private_key:privateKey.export({type:'pkcs8',format:'pem'})}),
    RITM_PRINTING_WORKSPACE_TOKEN:'a'.repeat(64),RITM_PRINTING_WORKSPACE_WRITE_TOKEN:'b'.repeat(64),
    RITM_PRINTING_WORK_CONNECTIONS:JSON.stringify(Object.fromEntries([['roll',roll],['box',box]].map(([role,sourceId]) =>
      [role,{sourceId,url:`https://script.google.com/macros/s/${role}/exec`,token:'f'.repeat(64)}]))),
  };
  let taken = 7;
  let contexts = 0;
  let rollCut = 4;
  const rollGateway='https://script.google.com/macros/s/roll/exec';
  const grid=(title,entries)=>({properties:{title},data:[{rowData:entries.map(cells=>({values:cells.map(value=>({
    effectiveValue:typeof value==='number'?{numberValue:value}:typeof value==='boolean'?{boolValue:value}:{stringValue:value},
  }))}))}]});
  const mock = async (url,init) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({access_token:'fixture',expires_in:1800});
    const requestUrl=new URL(url);
    if (requestUrl.hostname === 'sheets.googleapis.com') {
      if (!requestUrl.pathname.endsWith('/'+roll)) return Response.json({sheets:[{properties:{title:sheets[0].name}}]});
      const ranges=requestUrl.searchParams.getAll('ranges');
      if (!ranges.length) return Response.json({sheets:['ROLLS_V2','ROLLS_V2_PROGRESS'].map(title=>({properties:{title}}))});
      if (!ranges.some(range=>range.startsWith("'ROLLS_V2'"))) {
        return Response.json({sheets:[grid(sheets[1].name,[])]});
      }
      return Response.json({sheets:[
        grid('ROLLS_V2',[[],['r1','uid-2',sheets[1].name,5,'SKU-2','д99',1,true,false,'','',10,'','Дмитрий']]),
        grid('ROLLS_V2_PROGRESS',[[],['event','r1','uid-2',sheets[1].name,5,'SKU-2','Резка','','',rollCut]]),
      ]});
    }
    if (url===rollGateway) {
      const payload=JSON.parse(init.body);
      assert.equal(payload.operation,'cut');
      rollCut+=payload.items[0].quantity;
      return Response.json({ok:true,requestId:payload.requestId,confirmed:1,orders:[{
        row:5,uid:'uid-2',print:{actual:10},cut:{actual:rollCut},
        rolls:[{rollId:'r1',name:'д99',number:1,quantity:10,printActual:10,cutActual:rollCut,employee:'Дмитрий'}],
      }]});
    }
    assert.equal(url,gateway);
    const payload = JSON.parse(init.body);
    if (payload.command === 'context') {
      contexts++;
      return Response.json({ok:true,employees:[{id:'employee'}],items:[{row:5,taken,fingerprint:'f'.repeat(64)}]});
    }
    assert.equal(payload.command,'work');
    taken += payload.items[0].quantity;
    return Response.json({ok:true,results:[{ok:true,totals:{taken}}]});
  };
  async function getDetails(fetcher, fresh = false, department='box') {
    const id=department==='roll'?roll+':2':box+':1';
    const url = new URL(`?department=${department}&work=1&supply=${id}`,endpoint);
    if (fresh) url.searchParams.set('fresh','1');
    const response = await cloudApi(new Request(url,{headers:{Authorization:'Bearer '+env.RITM_PRINTING_WORKSPACE_TOKEN,
      'Content-Type':'application/json'}}),
      env,undefined,{fetcher});
    assert.equal(response.status,200);
    return response.json();
  }
  const initial = await getDetails(mock);
  assert.equal(initial.writeReady,true);
  assert.equal(initial.rows[0].taken,7);
  const calls = [];
  assert.deepEqual(await getDetails(async (url,init) => { calls.push(url); return mock(url,init); }),initial);
  assert.deepEqual(calls,[]);
  assert.equal((await getDetails(mock,true)).rows[0].taken,7);
  assert.equal(contexts,2);

  const write = await cloudApi(new Request(new URL('printing-workspace-write',endpoint),{
    method:'POST',headers:{Authorization:'Bearer '+env.RITM_PRINTING_WORKSPACE_WRITE_TOKEN,'Content-Type':'application/json'},
    body:JSON.stringify({department:'box',supplyId:box+':1',command:'work',items:[{
      rowId:'uid-1:5',requestId:'00000000-0000-4000-8000-000000000002',action:'take',unit:'pieces',
      quantity:1,employeeId:'employee',fingerprint:'f'.repeat(64),
    }]}),
  }),env,undefined,{fetcher:mock});
  assert.equal(write.status,200);
  assert.equal((await write.json()).results[0].ok,true);
  assert.equal((await getDetails(mock)).rows[0].taken,8);
  assert.equal(contexts,3);

  const rollDetails=await getDetails(mock,false,'roll');
  assert.equal(rollDetails.rows[0].rolls[0].cut,4);
  assert.deepEqual(await getDetails(neverFetch,false,'roll'),rollDetails);
  const rollWrite=await cloudApi(new Request(new URL('printing-workspace-write',endpoint),{
    method:'POST',headers:{Authorization:'Bearer '+env.RITM_PRINTING_WORKSPACE_WRITE_TOKEN,'Content-Type':'application/json'},
    body:JSON.stringify({department:'roll',supplyId:roll+':2',command:'work',operation:'cut',
      requestId:'00000000-0000-4000-8000-000000000003',
      items:[{rowId:'uid-2:5',rollId:'r1',quantity:1,expectedQuantity:10,expectedActual:4}]}),
  }),env,undefined,{fetcher:mock});
  assert.equal(rollWrite.status,200);
  assert.equal((await rollWrite.json()).patches[0].rolls[0].cut,5);
  assert.equal((await getDetails(mock,false,'roll')).rows[0].rolls[0].cut,5);
});

test('a Box sync started before a write cannot publish the obsolete details', async t => {
  const db = new LocalD1();
  t.after(() => db.close());
  db.db.exec(cloudSchemaStatements().join(';\n'));
  const model = printingReadModel(new CloudStore(db));
  const group = {department:'box',id:box+':1'}, source = {snapshotAt:new Date().toISOString()};
  const enter = Promise.withResolvers(), finish = Promise.withResolvers();
  const read = model.read(group,source,false,async () => {
    enter.resolve();
    return finish.promise;
  });
  await enter.promise;
  assert.equal(await model.read(group,source,false,neverFetch),null);
  await model.invalidate(group);
  finish.resolve({detailsAvailable:true,writeReady:true,rows:[{taken:7}]});
  assert.equal(await read,null);
  const updated = {detailsAvailable:true,writeReady:true,rows:[{taken:8}]};
  assert.deepEqual(await model.read(group,source,false,async () => updated),updated);
  assert.deepEqual(await model.read(group,source,false,neverFetch),updated);
});
