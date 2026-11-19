import test from 'node:test';
import assert from 'node:assert/strict';
import { bitrixConfigured, decryptBitrixConfig, encryptBitrixConfig, drainBitrixNotifications, queueBitrixNotifications, sendBitrixNotification, reminderJoke, completionPraise } from '../worker/cloud/bitrixNotifications.js';
import { nextAssignmentJoke } from '../worker/cloud/arkadyPhrases.js';

const config = { RITM_BITRIX_WEBHOOK_URL:'https://kaleidoskop.bitrix24.ru/rest/1/testsecret/', RITM_BITRIX_BOT_ID:'12', RITM_BITRIX_BOT_TOKEN:'test-token-value', RITM_BITRIX_BOX_CHAT:'chat1', RITM_BITRIX_ROLL_CHAT:'chat2' };
const createScope = () => ({ operations:new Map(), values:new Map(), putOperation(kind, value) { this.operations.set(`${kind}:${value.id}`, {kind,value}); }, meta(key,value) { if(arguments.length===1)return structuredClone(this.values.get(key));this.values.set(key,structuredClone(value)); } });
const stock = {id:'one',status:'verified',destination:'urgent',steps:[{department:'box',status:'verified',plan:{entries:[{article:'BOX001',quantity:10},{article:'BOX002',quantity:3}]}},{department:'roll',status:'verified',plan:{entries:[{article:'ROLL001',quantity:5}]}}]};

test('an owner-selected assignment joke is claimed once with its notification, preserving humor settings and delivery retry identity',()=>{
  const scope=createScope(),text='Задание в деле. Кофе — по желанию, мастерство — обязательно!',nextJoke={id:'TEST-coffee',text,after:'2026-11-13T10:00:00Z'};
  const options={kind:'stock',enabled:true,nextJoke};
  scope.meta('bitrixHumorLevel','off');
  assert.equal(queueBitrixNotifications(scope,{...stock,createdAt:'2026-11-12T10:00:00Z'},options),1);
  assert.equal(scope.meta('bitrixAssignmentJokeOnce:TEST-coffee'),undefined);
  assert.equal(queueBitrixNotifications(scope,{...stock,id:'new',createdAt:'2026-11-13T11:00:00Z'},options),1);
  const event=scope.operations.get('bitrix-notification:stock:new:shared').value;
  assert.equal(event.presentation.joke,text);assert.match(event.message,/Кофе — по желанию/);
  assert.equal(scope.meta('bitrixAssignmentJokeOnce:TEST-coffee').notificationId,event.id);
  scope.values=new Map(JSON.parse(JSON.stringify([...scope.values])));
  assert.equal(queueBitrixNotifications(scope,{...stock,id:'new',createdAt:'2026-11-13T11:00:00Z'},options),0);
  queueBitrixNotifications(scope,{...stock,id:'next',createdAt:'2026-11-13T12:00:00Z'},options);
  assert.equal(scope.operations.get('bitrix-notification:stock:next:shared').value.presentation.joke,'');
  assert.equal(scope.meta('bitrixHumorLevel'),'off');
  assert.ok(scope.meta('bitrixJokeHistory').shared.used.normal.some(phrase=>phrase===text+' ☕'));
});

test('a one-time assignment joke is not consumed by disabled, unverified, empty or duplicate operations',()=>{
  for(const change of [{status:'writing'},{steps:[]}]){
    const scope=createScope();queueBitrixNotifications(scope,{...stock,...change,createdAt:'2026-11-13T11:00:00Z'},{kind:'stock',enabled:true,nextJoke:{id:'TEST',text:'Coffee',after:'2026-11-13T10:00:00Z'}});
    assert.equal(scope.meta('bitrixAssignmentJokeOnce:TEST'),undefined);
  }
  const scope=createScope();queueBitrixNotifications(scope,{...stock,createdAt:'2026-11-13T11:00:00Z'},{kind:'stock',enabled:false,nextJoke:{id:'TEST',text:'Coffee',after:'2026-11-13T10:00:00Z'}});
  assert.equal(scope.meta('bitrixAssignmentJokeOnce:TEST'),undefined);
});

test('completion praise continues after the legacy phrases without repeating or clearing history', () => {
  const scope=createScope();
  const phrases=Array.from({length:16},(_,i)=>completionPraise(scope,`completion-${i}`));
  assert.equal(phrases.filter(Boolean).length,16);
  assert.equal(new Set(phrases).size,16);
  const history = structuredClone(scope.meta('bitrixCompletionPraisesUsed'));
  for (let i = 0; i < 8200; i++) {
    // Simulate separate maintenance requests reloading saved metadata.
    scope.values = new Map(JSON.parse(JSON.stringify([...scope.values])));
    const phrase = completionPraise(scope,`completion-after-exhaustion-${i}`);
    assert.ok(phrase.length > 0 && phrase.length < 500);
    assert.ok(!phrases.includes(phrase), `repeated praise at ${i}`);
    phrases.push(phrase);
  }
  assert.deepEqual(scope.meta('bitrixCompletionPraisesUsed'),history);
  assert.equal(scope.meta('bitrixCompletionPraiseSequenceV2'),'8200');
});

test('completion praise uses one shared durable sequence, independent of assignment/reminder humor', () => {
  const scope=createScope();
  for (let i = 0; i < 16; i++) completionPraise(scope,`legacy-${i}`);
  scope.meta('bitrixHumorLevel','off');
  scope.meta('bitrixReminderHumorLevel','off');
  scope.meta('bitrixCompletionPraiseSequenceV2','9007199254740993');
  const supply = completionPraise(scope,'watch:test:box:complete');
  const stock = completionPraise(scope,'stock:box:7:uid:complete:0');
  assert.ok(supply && stock && supply !== stock);
  assert.equal(scope.meta('bitrixCompletionPraiseSequenceV2'),'9007199254740995');
  assert.equal(scope.meta('bitrixHumorSequence'),undefined);
  assert.equal(scope.meta('bitrixReminderHumorSequence'),undefined);
});

test('reminder humor is independent, follows frequency and never repeats', () => {
  for (const [level, expected] of [['off',0], ['sometimes',2], ['always',6]]) {
    const scope=createScope(); scope.meta('bitrixReminderHumorLevel',level);
    const shown=Array.from({length:6},(_,i)=>reminderJoke(scope,`reminder-${i}`)).filter(Boolean);
    assert.equal(shown.length,expected); assert.equal(new Set(shown).size,shown.length);
    assert.equal(scope.meta('bitrixHumorSequence'),undefined);
    if(level==='always') assert.equal(reminderJoke(scope,'after-exhaustion'),'');
  }
});

test('humor frequency changes only jokes and retains verified assignment totals', () => {
  for (const [level, expected] of [['off', 0], ['sometimes', 2], ['always', 6]]) {
    const scope = createScope(); scope.meta('bitrixHumorLevel', level);
    let count = 0;
    for (let i = 0; i < 6; i++) {
      const operation = {...stock, id: `${level}-${i}`};
      assert.equal(queueBitrixNotifications(scope, operation, {kind:'stock', enabled:true}), 1);
      const message = scope.operations.get(`bitrix-notification:stock:${operation.id}:shared`).value.message;
      if (message.includes('[I]')) count++;
      assert.match(message, /Рулонная печать:[\s\S]*ROLL001 — 5 шт\.[\s\S]*Бокс:[\s\S]*BOX001 — 10 шт\.[\s\S]*BOX002 — 3 шт\./);
      assert.equal(queueBitrixNotifications(scope, operation, {kind:'stock', enabled:true}), 0);
    }
    assert.equal(count, expected);
  }
});

test('queues a single event for each confirmed department and ignores duplicates', () => {
  const scope=createScope();
  assert.equal(queueBitrixNotifications(scope,stock,{kind:'stock',manager:'Аня',enabled:true}),1);
  assert.equal(queueBitrixNotifications(scope,stock,{kind:'stock',manager:'Аня',enabled:true}),0);
  assert.match(scope.operations.get('bitrix-notification:stock:one:shared').value.message,/Рулонная печать:[\s\S]*ROLL001 — 5 шт\.[\s\S]*Бокс:[\s\S]*BOX001 — 10 шт\.[\s\S]*BOX002 — 3 шт\.[\s\S]*Аня/);
  assert.equal(queueBitrixNotifications(createScope(),{...stock,status:'uncertain'},{kind:'stock',enabled:true}),0);
});

test('adjacent notifications in each chat never repeat a joke, even across urgent and normal tasks',()=>{
  const scope=createScope();let prior='';
  for(let i=0;i<30;i++){
    const operation={...stock,id:`operation-${i}`,destination:i%3===0?'urgent':'warehouse',steps:[stock.steps[0]]};
    queueBitrixNotifications(scope,operation,{kind:'stock',manager:'Тест',enabled:true});
    const message=scope.operations.get(`bitrix-notification:stock:operation-${i}:shared`).value.message;
    const joke=message.match(/\[I\]([^]+)\[\/I\]$/)?.[1];
    assert.ok(joke);assert.notEqual(joke,prior);prior=joke;
    assert.match(message,/Аркадий на связи/);
    assert.doesNotMatch(message,/Открыть задание в RITM/);
  }
});

test('assignment jokes continue after the old list without clearing its history',()=>{
  for(const [destination,count] of [['warehouse',24],['urgent',16]]){
    const scope=createScope(),seen=new Set();
    for(let i=0;i<count;i++){
      const operation={...stock,id:`${destination}-${i}`,destination,steps:[stock.steps[0]]};
      queueBitrixNotifications(scope,operation,{kind:'stock',enabled:true});
      const joke=scope.operations.get(`bitrix-notification:stock:${destination}-${i}:shared`).value.message.match(/\[I\]([^]+)\[\/I\]$/)[1];
      assert.equal(seen.has(joke),false);seen.add(joke);
    }
    const oldHistory = structuredClone(scope.meta('bitrixJokeHistory').shared.used);
    const category = destination === 'urgent' ? 'urgent' : 'normal';
    for (let i = 0; i < 2100; i++) {
      scope.values = new Map(JSON.parse(JSON.stringify([...scope.values])));
      const kind = i % 2 === 0 ? 'stock' : 'production';
      const operation = kind === 'stock' ? {...stock,id:`${destination}-extra-${i}`,destination} : {
        id:`${destination}-extra-${i}`,status:'verified',action:'append',name:'OZON Тест',priority:category,
        steps:[{department:'box',status:'verified',lines:[{quantity:10}]}],
      };
      const options = {kind,enabled:true,manager:'Тест'};
      assert.equal(queueBitrixNotifications(scope,operation,options),1);
      const message=scope.operations.get(`bitrix-notification:${kind}:${operation.id}:shared`).value.message;
      const joke=message.match(/\[I\]([^]+)\[\/I\]$/)?.[1];
      assert.ok(joke && joke.length < 500);
      assert.equal(seen.has(joke),false);seen.add(joke);
      assert.match(message,/Бокс:/);
      assert.match(message,category === 'urgent' ? /СРОЧНОЕ ЗАДАНИЕ/u : /Новое задание в производство/u);
      assert.equal(queueBitrixNotifications(scope,operation,options),0);
      assert.equal(scope.meta(`bitrixAssignmentJokeSequenceV2:${category}`),String(i+1));
    }
    assert.deepEqual(scope.meta('bitrixJokeHistory').shared.used, oldHistory);
  }
});

test('generated assignment jokes retain frequency after exhaustion and migrate both old chat histories', () => {
  const original=createScope();
  for (const [destination,count] of [['warehouse',24],['urgent',16]]) for(let i=0;i<count;i++)
    queueBitrixNotifications(original,{...stock,id:`seed-${destination}-${i}`,destination},{kind:'stock',enabled:true});
  const used=original.meta('bitrixJokeHistory').shared.used;
  for (const [level,expected] of [['off',0],['sometimes',4],['always',12]]) {
    const scope=createScope();scope.meta('bitrixHumorLevel',level);
    scope.meta('bitrixJokeHistory',{box:{used:{normal:used.normal.slice(0,12),urgent:used.urgent.slice(0,8)}},roll:{used:{normal:used.normal.slice(12),urgent:used.urgent.slice(8)}}});
    for(let i=0;i<12;i++) queueBitrixNotifications(scope,{...stock,id:`${level}-${i}`,destination:i%2?'urgent':'warehouse'},{kind:'stock',enabled:true});
    const jokes=[...scope.operations.values()].filter(row=>row.value.message.includes('[I]'));
    assert.equal(jokes.length,expected);
    const normal=Number(scope.meta('bitrixAssignmentJokeSequenceV2:normal')||0), urgent=Number(scope.meta('bitrixAssignmentJokeSequenceV2:urgent')||0);
    assert.equal(normal+urgent,expected);
    assert.deepEqual(scope.meta('bitrixJokeHistory').shared.used,used);
    const before=structuredClone([...scope.values]);
    assert.equal(queueBitrixNotifications(scope,{...stock,id:'disabled'},{kind:'stock',enabled:false}),0);
    assert.equal(queueBitrixNotifications(scope,{...stock,id:'uncertain',status:'uncertain'},{kind:'stock',enabled:true}),0);
    assert.deepEqual([...scope.values],before);
    assert.equal(scope.meta('bitrixCompletionPraiseSequenceV2'),undefined);
    assert.equal(scope.meta('bitrixReminderHumorSequence'),undefined);
  }
});

test('normal and urgent generated joke sequences remain distinct beyond Number precision', () => {
  const scope=createScope();const seen=new Set();
  for(const category of ['normal','urgent']){
    scope.meta(`bitrixAssignmentJokeSequenceV2:${category}`,'9007199254740993');
    for(let i=0;i<3;i++){
      const joke=nextAssignmentJoke(scope,category);
      assert.ok(joke && !seen.has(joke));seen.add(joke);
    }
    assert.equal(scope.meta(`bitrixAssignmentJokeSequenceV2:${category}`),'9007199254740996');
  }
});

test('generated assignment cards are delivered once using only the injected test transport', async () => {
  const scope=createScope();scope.checkpoint=async()=>{};
  const seed=createScope();
  for(const [destination,count] of [['warehouse',24],['urgent',16]]) for(let i=0;i<count;i++)
    queueBitrixNotifications(seed,{...stock,id:`seed-${destination}-${i}`,destination},{kind:'stock',enabled:true});
  scope.meta('bitrixJokeHistory',seed.meta('bitrixJokeHistory'));
  for(const destination of ['warehouse','urgent']) queueBitrixNotifications(scope,{...stock,id:destination,destination},{kind:'stock',enabled:true});
  const bindings={RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)};
  scope.meta('bitrixNotificationConfig',await encryptBitrixConfig(bindings,config));
  const store={scope:async()=>scope,withScope:async callback=>callback(scope)};
  const sent=[];
  const fetcher=async (url,init)=>{const data=JSON.parse(init.body);sent.push(data);return Response.json({result:{messageId:sent.length}})};
  await drainBitrixNotifications(bindings,store,fetcher);
  await drainBitrixNotifications(bindings,store,fetcher);
  assert.equal(sent.length,2);
  for(const payload of sent){assert.equal(payload.DIALOG_ID,'chat2');assert.ok(payload.ATTACH?.BLOCKS);assert.ok(payload.ATTACH.BLOCKS.some(block=>typeof block.MESSAGE==='string'&&block.MESSAGE.length>20));assert.ok(payload.ATTACH.BLOCKS.some(block=>block.GRID?.some(row=>row.NAME==='BOX001'&&row.VALUE==='10 шт.')))}
  assert.equal(scope.meta('bitrixAssignmentJokeSequenceV2:normal'),'1');
  assert.equal(scope.meta('bitrixAssignmentJokeSequenceV2:urgent'),'1');
});

test('production deletion and disabled integration do not generate notifications', () => {
  const scope=createScope();
  assert.equal(queueBitrixNotifications(scope,{...stock,action:'deletePart'},{kind:'production',enabled:true}),0);
  assert.equal(queueBitrixNotifications(scope,stock,{kind:'stock',enabled:false}),0);
});

test('urgent shipment is marked urgent and retains both area totals',()=>{
  const scope=createScope();
  const operation={id:'urgent-one',status:'verified',action:'create',name:'OZON Тест 🔥',priority:'urgent',steps:[{department:'roll',status:'verified',lines:[{quantity:10}]},{department:'box',status:'verified',lines:[{quantity:7}]}]};
  assert.equal(queueBitrixNotifications(scope,operation,{kind:'production',enabled:true}),1);
  const msg=scope.operations.get('bitrix-notification:production:urgent-one:shared').value.message;
  assert.match(msg,/СРОЧНОЕ ЗАДАНИЕ/);assert.match(msg,/OZON Тест 🔥/);assert.match(msg,/10 шт/);assert.match(msg,/7 шт/);
});

test('sends to the selected chat; unknown outcomes are not considered successful', async () => {
  let payload;
  const success=await sendBitrixNotification(config,{department:'roll',message:'Задание'},async (url,init)=>{payload=JSON.parse(init.body);return new Response(JSON.stringify({result:{messageId:1}}),{status:200});});
  assert.equal(success.status,'sent');
  assert.equal(payload.DIALOG_ID,'chat2');
  const box=await sendBitrixNotification(config,{department:'box',message:'Бокс'},async (url,init)=>{payload=JSON.parse(init.body);return new Response(JSON.stringify({result:{messageId:2}}),{status:200});});
  assert.equal(box.status,'sent');assert.equal(payload.DIALOG_ID,'chat2');
  assert.equal((await sendBitrixNotification(config,{department:'box',message:'x'},async()=>{throw Error('lost response');})).status,'uncertain');
  assert.equal(bitrixConfigured({...config,RITM_BITRIX_WEBHOOK_URL:'https://evil.example/rest/1/token/'}),false);
});

test('one message includes both departments and avoids prior per-department duplicates',()=>{
  const scope=createScope();
  assert.equal(queueBitrixNotifications(scope,stock,{kind:'stock',enabled:true}),1);
  const msg=scope.operations.get('bitrix-notification:stock:one:shared').value.message;
  assert.match(msg,/Рулонная печать:[\s\S]*ROLL001 — 5 шт\./);
  assert.match(msg,/Бокс:[\s\S]*BOX001 — 10 шт\.[\s\S]*BOX002 — 3 шт\./);
  const old=createScope();old.operations.set('bitrix-notification:stock:one:box',{});
  assert.equal(queueBitrixNotifications(old,stock,{kind:'stock',enabled:true}),0);
});

test('ambiguous delivery is recorded once and is not sent again', async () => {
  const scope=createScope();
  scope.checkpoint=async()=>{};
  queueBitrixNotifications(scope,{...stock,steps:[stock.steps[0]]},{kind:'stock',enabled:true});
  const bindings={RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)};
  const encrypted=await encryptBitrixConfig(bindings,config);
  scope.meta=()=>encrypted;
  const store={scope:async()=>scope,withScope:async callback=>callback(scope)};
  let calls=0;
  await drainBitrixNotifications(bindings,store,async()=>{calls++;throw Error('reply lost');});
  await drainBitrixNotifications(bindings,store,async()=>{calls++;throw Error('unexpected repeat');});
  assert.equal(calls,1);
  assert.equal(scope.operations.get('bitrix-notification:stock:one:shared').value.status,'uncertain');
});

test('outbox suppresses obsolete single-stage notifications but sends normal jobs', async () => {
  const scope=createScope(); scope.checkpoint=async()=>{};
  for (const id of ['stock:box:7:uid:cut:0','stock:box:7:uid:print:0','stock:box:7:uid:complete:0','watch:s:box:cut','stock:new:shared'])
    scope.putOperation('bitrix-notification',{id,status:'pending',department:'roll',message:'test'});
  const bindings={RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)};
  const encrypted=await encryptBitrixConfig(bindings,config); scope.meta=()=>encrypted;
  let calls=0; await drainBitrixNotifications(bindings,{scope:async()=>scope,withScope:async callback=>callback(scope)},async()=>{calls++;return Response.json({result:1})});
  assert.equal(calls,1);
  assert.equal(scope.operations.get('bitrix-notification:stock:box:7:uid:cut:0').value.status,'superseded');
  assert.equal(scope.operations.get('bitrix-notification:stock:new:shared').value.status,'sent');
});

test('credentials are encrypted at rest and cannot be decrypted with a different key', async()=>{
  const bindings={RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)};
  const encrypted=await encryptBitrixConfig(bindings,config);
  assert.equal(JSON.stringify(encrypted).includes('testsecret'),false);
  assert.deepEqual(await decryptBitrixConfig(bindings,encrypted),config);
  await assert.rejects(decryptBitrixConfig({RITM_ASSEMBLY_SYNC_SECRET:'b'.repeat(64)},encrypted));
});
test('production links point to both verified shipment sheets',()=>{
 const scope=createScope();const operation={id:'links',status:'verified',action:'create',name:'Тест',steps:[{department:'roll',status:'verified',plan:{sheetId:123},lines:[{quantity:4}]},{department:'box',status:'verified',plan:{sheetId:456},lines:[{quantity:8}]}]};
 queueBitrixNotifications(scope,operation,{kind:'production',enabled:true,documentIds:{roll:'roll_doc',box:'box_doc'}});
 const msg=scope.operations.get('bitrix-notification:production:links:shared').value.message;
 assert.match(msg,/spreadsheets\/d\/roll_doc\/edit#gid=123/);assert.match(msg,/spreadsheets\/d\/box_doc\/edit#gid=456/);
});
test('stock links include only actual verified department and exact destination sheet',()=>{
 const scope=createScope();const operation={id:'stock-links',status:'verified',destination:'urgent',steps:[{department:'box',status:'verified',plan:{spreadsheetId:'box_stock',sheetId:77,entries:[{quantity:2}]}}]};
 queueBitrixNotifications(scope,operation,{kind:'stock',enabled:true,documentIds:{roll:'roll_stock',box:'box_stock'}});
 const msg=scope.operations.get('bitrix-notification:stock:stock-links:shared').value.message;
 assert.match(msg,/spreadsheets\/d\/box_stock\/edit#gid=77/);assert.doesNotMatch(msg,/Рулонная печать|roll_stock/);
});
test('unmatched stock document is never linked',()=>{
 const scope=createScope();const operation={id:'wrong-doc',status:'verified',destination:'urgent',steps:[{department:'box',status:'verified',plan:{spreadsheetId:'other',sheetId:77,entries:[{quantity:2}]}}]};
 queueBitrixNotifications(scope,operation,{kind:'stock',enabled:true,documentIds:{box:'box_stock'}});
 assert.doesNotMatch(scope.operations.get('bitrix-notification:stock:wrong-doc:shared').value.message,/spreadsheets\/d\//);
});
