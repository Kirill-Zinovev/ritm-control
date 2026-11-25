import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudApi } from '../worker/cloud/runtime.js';
import { CloudStore } from '../worker/cloud/store.js';
import { LocalD1 } from './helpers/d1-sqlite.mjs';
import { cloudSchemaStatements } from './helpers/cloud-schema.mjs';
import { bindings } from './cloud-env.mjs';
import { queueBitrixNotifications, drainBitrixNotifications, encryptBitrixConfig, decryptBitrixConfig } from '../worker/cloud/bitrixNotifications.js';
import { saveBitrixConfiguration } from '../worker/cloud/bitrixSettings.js';

test('only the owner can save validated encrypted connection settings', async()=>{
  const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));
  const env={...bindings,DB:db,RITM_OWNER_USER_IDS:'owner',RITM_GOOGLE_READER_JSON:'{}',RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)};
  const body=JSON.stringify({webhook:'https://kaleidoskop.bitrix24.ru/rest/1/fixtureWebhookToken1/',clientId:'fictional-client-key'});
  const request=(id,origin='https://ritm.test')=>new Request('https://ritm.test/api/bitrix-setup',{method:'POST',headers:{'oai-authenticated-user-id':id,'content-type':'application/json',origin},body});
  let calls=0;const mock=async()=>{calls++;return Response.json({result:[5768]});};
  try {
    assert.equal((await cloudApi(request('other'),env,{}, {fetcher:mock})).status,403);
    assert.equal((await cloudApi(request('owner','https://other.test'),env,{}, {fetcher:mock})).status,403);
    assert.equal(calls,0);
    const response=await cloudApi(request('owner'),env,{}, {fetcher:mock});
    assert.equal(response.status,200,await response.text());
    assert.equal(calls,2);
    const stored=(await new CloudStore(db).scope()).meta('bitrixNotificationConfig');
    assert.ok(stored.ciphertext);
    assert.equal(JSON.stringify(stored).includes('fixtureWebhookToken1'),false);
    const settings = (method, id, body) => new Request('https://ritm.test/api/bitrix-settings',{method,headers:{'oai-authenticated-user-id':id,'content-type':'application/json',origin:'https://ritm.test'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await cloudApi(settings('GET','other'),env,{}, {fetcher:mock})).status,403);
    const before=await (await cloudApi(settings('GET','owner'),env,{}, {fetcher:mock})).json();
    assert.equal(before.configured,true);assert.equal(before.enabled,true);
    assert.ok(!JSON.stringify(before).includes('fixtureWebhookToken1'));
    const disabled=await (await cloudApi(settings('POST','owner',{enabled:false}),env,{}, {fetcher:mock})).json();
    assert.equal(disabled.enabled,false);
    const enabled=await (await cloudApi(settings('POST','owner',{enabled:true}),env,{}, {fetcher:mock})).json();
    assert.equal(enabled.enabled,true);
    assert.equal((await cloudApi(settings('POST','owner',{chatId:'chat12345'}),env,{}, {fetcher:async()=>Response.json({error:'NO_ACCESS'},{status:403})})).status,409);
    assert.equal((await (await cloudApi(settings('GET','owner'),env,{}, {fetcher:mock})).json()).chatId,'chat37628');
    assert.equal((await (await cloudApi(settings('POST','owner',{chatId:'chat12345'}),env,{}, {fetcher:mock})).json()).chatId,'chat12345');
    await cloudApi(settings('POST','owner',{chatId:'chat37628'}),env,{}, {fetcher:mock});
    await cloudApi(settings('POST','owner',{chatId:'chat26688'}),env,{}, {fetcher:mock});
    const greeting = () => new Request('https://ritm.test/api/bitrix-setup/greeting',{method:'POST',headers:{'oai-authenticated-user-id':'owner','content-type':'application/json',origin:'https://ritm.test'},body:'{}'});
    let greetings=0;const greetFetch=async ()=>{greetings++;return Response.json({result:123});};
    assert.equal((await (await cloudApi(greeting(),env,{}, {fetcher:greetFetch})).json()).status,'superseded');
    assert.equal(greetings,0);
    await cloudApi(settings('POST','owner',{chatId:'chat37628'}),env,{}, {fetcher:mock});
    const check = new Request('https://ritm.test/api/bitrix-setup/test',{method:'POST',headers:{'oai-authenticated-user-id':'owner','content-type':'application/json',origin:'https://ritm.test'},body:'{}'});
    const delivered=[];
    const testResponse=await cloudApi(check,env,{}, {fetcher:async (_url,init)=>{delivered.push(JSON.parse(init.body));return Response.json({result:123});}});
    assert.deepEqual((await testResponse.json()).results,{private:'sent'});
    assert.deepEqual(delivered.map(row=>row.DIALOG_ID),['1698']);
    assert.ok(delivered.every(row=>row.MESSAGE==='🦎 Аркадий'));
    assert.ok(delivered.every(row=>JSON.stringify(row.ATTACH).includes('Тестовое сообщение')));
    env.ASSETS={fetch:async()=>new Response(new Uint8Array([1,2,3]))};
    const avatarReq = new Request('https://ritm.test/api/bitrix-setup/avatar',{method:'POST',headers:{'oai-authenticated-user-id':'owner','content-type':'application/json',origin:'https://ritm.test'},body:'{}'});
    let avatarRequest;
    const avatarResponse=await cloudApi(avatarReq,env,{}, {fetcher:async (url,init)=>{avatarRequest={url,body:JSON.parse(init.body)};return Response.json({result:{bot:{id:5768},users:[{id:5768,avatar:'https://example.test/avatar.png'}]}});}});
    assert.deepEqual(await avatarResponse.json(),{ok:true,confirmed:true});
    assert.ok(avatarRequest.url.endsWith('imbot.v2.Bot.update'));
    assert.equal(avatarRequest.body.fields.properties.avatar,'AQID');
  } finally { db.close(); }
});

test('confirmed production event is journaled, delivered once and survives reload', async()=>{
  const db=new LocalD1();db.db.exec(cloudSchemaStatements().join(';\n'));
  const env={...bindings,DB:db,RITM_OWNER_USER_IDS:'owner',RITM_GOOGLE_READER_JSON:'{}',RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)};
  const store=new CloudStore(db);
  const setup=new Request('https://ritm.test/api/bitrix-setup',{method:'POST',headers:{'oai-authenticated-user-id':'owner','content-type':'application/json',origin:'https://ritm.test'},body:JSON.stringify({webhook:'https://kaleidoskop.bitrix24.ru/rest/1/fixtureWebhookToken1/',clientId:'fictional-client-key'})});
  try {
    assert.equal((await cloudApi(setup,env,{}, {fetcher:async()=>Response.json({result:[5768]})})).status,200);
    const op={id:'test-op',action:'create',status:'verified',name:'Тестовая поставка',steps:[{department:'roll',status:'verified',lines:[{quantity:8}]}]};
    await store.withScope(scope=>queueBitrixNotifications(scope,op,{kind:'production',manager:'Тест',enabled:true}));
    let sends=0;
    const fake=async (_url,init)=>{sends++;assert.equal(JSON.parse(init.body).DIALOG_ID,'chat37628');return Response.json({result:123});};
    await drainBitrixNotifications(env,store,fake);
    await drainBitrixNotifications(env,store,fake);
    assert.equal(sends,1);
    assert.equal((await store.scope()).operations.get('bitrix-notification:production:test-op:shared').value.status,'sent');
  } finally { db.close(); }
});

const settingsRequest = (body, owner='owner') => new Request('https://ritm.test/api/bitrix-settings', {
  method: body ? 'POST' : 'GET', headers: {'oai-authenticated-user-id':owner, 'content-type':'application/json', origin:'https://ritm.test'},
  ...(body ? {body:JSON.stringify(body)} : {}),
});
const testConfig = {RITM_BITRIX_WEBHOOK_URL:'https://kaleidoskop.bitrix24.ru/rest/1/fixtureWebhookToken1/',RITM_BITRIX_BOT_TOKEN:'fictional-client-key',RITM_BITRIX_BOT_ID:'5768',RITM_BITRIX_BOX_CHAT:'chat37626',RITM_BITRIX_ROLL_CHAT:'chat26688'};

test('owner settings save during production work without changing its lease, outbox or phrase history', async()=>{
  const db=new LocalD1(); db.db.exec(cloudSchemaStatements().join(';\n'));
  const env={...bindings,DB:db,RITM_OWNER_USER_IDS:'owner',RITM_GOOGLE_READER_JSON:'{}',RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)},store=new CloudStore(db);
  try {
    await saveBitrixConfiguration(store,await encryptBitrixConfig(env,testConfig),null);
    await store.withScope(scope=>{
      scope.meta('bitrixCompletionPraiseSequenceV2',123);
      scope.meta('bitrixAssignmentJokeSequenceV2:normal',456);
      scope.putOperation('bitrix-notification',{id:'lost-ack',status:'uncertain',department:'roll',message:'keep',updatedAt:'2026-11-13T09:28:12Z'});
    });
    const lease=await store.acquire(),production=await store.scope(lease);
    production.meta('productionSupplies',[{id:'existing-production',name:'Keep production'}]);
    let checks=0;
    const fake=async(url,init)=>{checks++;assert.ok(url.endsWith('imbot.chat.user.list'));assert.equal(JSON.parse(init.body).CHAT_ID,12345);assert.ok(init.signal);return Response.json({result:[5768]});};
    for(const input of [{enabled:false},{humorLevel:'sometimes'},{reminderHumorLevel:'always'},{chatId:'chat12345'}]){
      const response=await cloudApi(settingsRequest(input),env,{}, {fetcher:fake});
      assert.equal(response.status,200,await response.clone().text());
    }
    const active=await db.prepare('SELECT owner,fence FROM cloud_leases WHERE name=?').bind('production').first();
    assert.equal(active.owner,lease.owner);assert.equal(active.fence,lease.fence);assert.equal(await store.leaseIsActive(),true);
    await production.checkpoint();await store.release(lease);
    const current=await (await cloudApi(settingsRequest(),env,{}, {fetcher:fake})).json();
    assert.equal(current.enabled,false);assert.equal(current.humorLevel,'sometimes');assert.equal(current.reminderHumorLevel,'always');assert.equal(current.chatId,'chat12345');assert.equal(current.uncertain,1);assert.equal(checks,1);
    const scope=await store.scope();
    assert.equal(scope.meta('bitrixCompletionPraiseSequenceV2'),123);assert.equal(scope.meta('bitrixAssignmentJokeSequenceV2:normal'),456);
    assert.equal(scope.operations.get('bitrix-notification:lost-ack').value.status,'uncertain');assert.equal(scope.meta('productionSupplies')[0].id,'existing-production');
    const encrypted=await store.readMeta('bitrixNotificationConfig');assert.equal(JSON.stringify(encrypted).includes('fixtureWebhookToken1'),false);
    assert.equal((await cloudApi(settingsRequest({humorLevel:'off'},'manager'),env,{}, {fetcher:fake})).status,403);
    assert.equal((await cloudApi(settingsRequest({enabled:'false'}),env,{}, {fetcher:fake})).status,400);
    assert.equal((await cloudApi(settingsRequest({humorLevel:'off',enabled:true}),env,{}, {fetcher:fake})).status,400);
    assert.equal((await (await cloudApi(settingsRequest(),env,{}, {fetcher:fake})).json()).humorLevel,'sometimes');
  } finally { db.close(); }
});

test('slow chat validation holds no production lease and cannot overwrite a changed connection', async()=>{
  const db=new LocalD1(); db.db.exec(cloudSchemaStatements().join(';\n'));
  const env={...bindings,DB:db,RITM_OWNER_USER_IDS:'owner',RITM_GOOGLE_READER_JSON:'{}',RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)},store=new CloudStore(db);
  try {
    const before=await encryptBitrixConfig(env,testConfig);await saveBitrixConfiguration(store,before,null);
    const changed={...testConfig,RITM_BITRIX_ROLL_CHAT:'chat99999'};
    const response=await cloudApi(settingsRequest({chatId:'chat12345'}),env,{}, {fetcher:async url=>{
      assert.ok(url.endsWith('imbot.chat.user.list'));assert.equal(await store.leaseIsActive(),false);
      await saveBitrixConfiguration(store,await encryptBitrixConfig(env,changed),before);
      return Response.json({result:[5768]});
    }});
    assert.equal(response.status,409);assert.equal((await response.json()).error,'bitrix_settings_changed');
    assert.equal((await decryptBitrixConfig(env,await store.readMeta('bitrixNotificationConfig'))).RITM_BITRIX_ROLL_CHAT,'chat99999');
    await assert.rejects(saveBitrixConfiguration(store,before,null),{code:'bitrix_settings_changed'});
    const failed=await cloudApi(settingsRequest({chatId:'chat12345'}),env,{}, {fetcher:async()=>{throw new DOMException('Timed out','TimeoutError');}});
    assert.equal(failed.status,502);assert.equal((await failed.json()).error,'bitrix_chat_check_failed');
    assert.equal((await decryptBitrixConfig(env,await store.readMeta('bitrixNotificationConfig'))).RITM_BITRIX_ROLL_CHAT,'chat99999');
  } finally { db.close(); }
});
