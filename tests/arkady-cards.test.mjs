import test from 'node:test';
import assert from 'node:assert/strict';
import {assignmentPresentation, stockCompletionPresentation, supplyWatchPresentation, arkadyMessageFields} from '../worker/cloud/arkadyCards.js';
import {queueBitrixNotifications, sendBitrixNotification, drainBitrixNotifications, encryptBitrixConfig} from '../worker/cloud/bitrixNotifications.js';

const scope = () => ({operations:new Map(),values:new Map(),meta(key,value){if(arguments.length===1)return structuredClone(this.values.get(key));this.values.set(key,structuredClone(value));},putOperation(kind,value){this.operations.set(`${kind}:${value.id}`,{kind,value});},checkpoint:async()=>{}});
const config={RITM_BITRIX_WEBHOOK_URL:'https://kaleidoskop.bitrix24.ru/rest/1/testsecret/',RITM_BITRIX_BOT_ID:'12',RITM_BITRIX_BOT_TOKEN:'test-token-value',RITM_BITRIX_BOX_CHAT:'chat1',RITM_BITRIX_ROLL_CHAT:'chat2'};
const link=id=>`https://docs.google.com/spreadsheets/d/test-${id}/edit#gid=7`;
const assignment=overrides=>assignmentPresentation({kind:'production',title:'OZON МОСКВА · Магазин 1',urgent:false,manager:'Кирилл',joke:'План разложен, станки предупреждены.',sections:[{department:'roll',articles:147,quantity:5020,url:link('roll')},{department:'box',articles:127,quantity:5325,url:link('box')}],...overrides});
const contents=fields=>JSON.stringify(fields.ATTACH);

test('new supply card keeps each verified department, exact counts, manager, humor and clickable sheet links',()=>{
  const event={message:'legacy',presentation:assignment()},before=structuredClone(event),fields=arkadyMessageFields(event),body=contents(fields);
  assert.match(body,/НОВАЯ ПОСТАВКА/);assert.match(body,/147 артикулов/);assert.match(body,/127 артикулов/);assert.match(body,/274 артикула/);
  assert.ok(body.includes('5\u00a0020 шт.'));assert.ok(body.includes('5\u00a0325 шт.'));assert.ok(body.includes('10\u00a0345 шт.'));assert.match(body,/Кирилл|План разложен/);
  const links=fields.ATTACH.BLOCKS.flatMap(block=>block.GRID||[]).filter(row=>row.LINK);assert.deepEqual(links.map(row=>row.LINK),[link('roll'),link('box')]);
  assert.equal(fields.ATTACH.COLOR,'#2563eb');assert.match(body,/arkady-notification-v2\.png/);assert.doesNotMatch(body,/Открыть задание в RITM|Все этапы завершены|Готово к отгрузке|\[B\]|\[I\]/);assert.deepEqual(event,before);
});

test('stock assignment shows actual articles and quantities and only relevant stock-sheet links',()=>{
  const presentation=assignment({kind:'stock',title:'Срочные 2 этаж',urgent:true,sections:[{department:'box',articles:2,quantity:64,url:link('stock-box'),entries:[{article:'PT0001.A0337',quantity:32},{article:'CT0001.A8111',quantity:32}]}]});
  const fields=arkadyMessageFields({presentation,message:'legacy'}),body=contents(fields);
  assert.match(body,/СРОЧНОЕ ЗАДАНИЕ|PT0001.A0337/);assert.match(body,/CT0001.A8111/);assert.equal((body.match(/32 шт\./g)||[]).length,2);assert.match(body,/64 шт\./);assert.match(body,/test-stock-box/);assert.doesNotMatch(body,/Рулонная печать/);assert.equal(fields.ATTACH.COLOR,'#c66b10');
});

test('appending to an existing supply is labelled as added goods, not a new supply or its total plan',()=>{
  const fields=arkadyMessageFields({message:'legacy',presentation:assignment({action:'append'})});
  assert.match(contents(fields),/ТОВАРЫ ДОБАВЛЕНЫ В ПОСТАВКУ/);assert.doesNotMatch(contents(fields),/НОВАЯ ПОСТАВКА/);
  assert.ok(fields.ATTACH.BLOCKS.some(block=>block.GRID?.some(row=>row.NAME==='Добавлено')));
});

test('stock completion retains pieces and exact article while completion never claims packing or shipment',()=>{
  const presentation=stockCompletionPresentation({destination:'urgent',department:'box',sheetId:9,article:'PT0001.A0337',quantity:32},{documentId:'stock-box',joke:'Команда, красиво сработали!'});
  const fields=arkadyMessageFields({presentation,message:'legacy'}),body=contents(fields);
  assert.equal(fields.ATTACH.COLOR,'#16a34a');assert.match(body,/✅ Печать и порезка готовы/);assert.equal(fields.MESSAGE,'🦎 Аркадий');assert.match(body,/PT0001.A0337/);assert.match(body,/32 шт\./);assert.match(body,/stock-box\/edit#gid=9/);assert.match(body,/красиво сработали/);assert.doesNotMatch(body,/упаковка|отправлено|отгрузке|Все этапы завершены/i);
});

test('supply completions and reminders have distinct status and safe links without changing the event',()=>{
  const event={kind:'completion',name:'OZON СПБ',department:'roll',articles:2,quantity:40,url:link('roll')};
  const complete=arkadyMessageFields({presentation:supplyWatchPresentation(event,'Молодцы!')});
  assert.equal(complete.ATTACH.COLOR,'#16a34a');assert.match(contents(complete),/✅ Печать и порезка готовы/);assert.match(contents(complete),/2 артикула · 40 шт\./);
  const reminder=arkadyMessageFields({presentation:supplyWatchPresentation({...event,kind:'reminder',url:'javascript:alert(1)'})});
  assert.match(contents(reminder),/ещё не взято в работу/);assert.doesNotMatch(contents(reminder),/javascript:|Печать и порезка готовы|✅/);assert.equal(reminder.ATTACH.COLOR,'#c66b10');
});

test('one stock batch card lists all members across departments with totals and exact stock links',()=>{
  const event={destination:'warehouse',quantity:62,manager:'Кирилл',sections:[
    {department:'roll',sheetId:8,entries:[{article:'ROLL001',quantity:20}]},
    {department:'box',sheetId:7,entries:[{article:'BOX001',quantity:32},{article:'BOX002',quantity:10}]},
  ]};
  const fields=arkadyMessageFields({message:'legacy',presentation:stockCompletionPresentation(event,{documentIds:{roll:'stock-roll',box:'stock-box'}})}),body=contents(fields);
  assert.match(body,/Весь список готов/);assert.match(body,/3 артикула · 62 шт\./);
  const articleRows=fields.ATTACH.BLOCKS.flatMap(block=>block.GRID||[]).filter(row=>/^(ROLL|BOX)00/.test(row.NAME));
  assert.deepEqual(articleRows.map(({NAME,VALUE,DISPLAY})=>[NAME,VALUE,DISPLAY]),[['ROLL001','20 шт.','ROW'],['BOX001','32 шт.','ROW'],['BOX002','10 шт.','ROW']]);
  assert.match(body,/stock-roll\/edit#gid=8/);assert.match(body,/stock-box\/edit#gid=7/);assert.match(body,/Кирилл/);
});

test('a 500-article upload retains full membership while the native card links the remaining rows',()=>{
  const entries=Array.from({length:500},(_,i)=>({article:`PT${String(i).padStart(4,'0')}.A0337`,quantity:32}));
  const presentation=stockCompletionPresentation({destination:'warehouse',quantity:16000,sections:[{department:'box',sheetId:7,entries}]},{documentId:'stock-box'});
  const fields=arkadyMessageFields({message:'legacy',presentation});assert.ok(fields.ATTACH);assert.ok(new TextEncoder().encode(contents(fields)).length<28000);
  const list=fields.ATTACH.BLOCKS.flatMap(block=>block.GRID||[]).filter(row=>/^PT\d/.test(row.NAME));
  assert.equal(list.length,40);assert.equal(list[0].NAME,'PT0000.A0337');assert.equal(list.at(-1).NAME,'PT0039.A0337');
  assert.match(contents(fields),/Ещё 460 артикулов/);assert.ok(contents(fields).includes('16\u00a0000 шт.'));
  assert.deepEqual(presentation.sections[0].entries,entries);
});

test('every native scenario puts source links last without repeating its heading or joke outside the card',()=>{
  const event={name:'OZON Тест',department:'roll',quantity:40,articles:2,url:link('roll')};
  const presentations=[
    assignment(),assignment({action:'append'}),assignment({urgent:true}),
    assignment({kind:'stock',sections:[{department:'box',articles:1,quantity:10,url:link('stock'),entries:[{article:'TEST001',quantity:10}]}]}),
    supplyWatchPresentation({...event,kind:'completion'},'Молодцы!'),
    supplyWatchPresentation({...event,kind:'reminder'},'Пора начинать.'),
    stockCompletionPresentation({destination:'warehouse',department:'box',sheetId:7,article:'TEST001',quantity:10},{documentId:'stock',joke:'Весь список готов.'}),
  ];
  for(const presentation of presentations){
    const before=structuredClone(presentation),fields=arkadyMessageFields({presentation,message:'Legacy repeated text'}),blocks=fields.ATTACH.BLOCKS;
    assert.equal(fields.MESSAGE,'🦎 Аркадий');
    const indexes=blocks.flatMap((block,index)=>(block.GRID||[]).filter(row=>row.LINK).map(()=>index));
    assert.ok(indexes.length>0);
    assert.deepEqual(indexes,Array.from({length:indexes.length},(_,index)=>blocks.length-indexes.length+index));
    if(presentation.joke)assert.equal(blocks.filter(block=>block.MESSAGE===presentation.joke).length,1);
    assert.deepEqual(presentation,before);
  }
});

test('long multibyte stock lists remain native cards instead of falling back to repeated legacy text',()=>{
  const entries=Array.from({length:500},(_,index)=>({article:'字'.repeat(115)+index,quantity:32}));
  const sections=['roll','box'].map((department,index)=>({department,sheetId:index+7,entries:entries.slice(index*250,(index+1)*250)}));
  const presentation=stockCompletionPresentation({destination:'warehouse',quantity:16000,sections},{documentIds:{roll:'stock-roll',box:'stock-box'}});
  const before=structuredClone(presentation),fields=arkadyMessageFields({presentation,message:'Legacy repeated text'}),body=contents(fields);
  assert.equal(fields.MESSAGE,'🦎 Аркадий');assert.ok(fields.ATTACH);
  assert.ok(new TextEncoder().encode(body).length<=28000);
  assert.ok(body.includes('16\u00a0000 шт.'));
  assert.equal(fields.ATTACH.BLOCKS.flatMap(block=>block.GRID||[]).filter(row=>row.NAME.startsWith('字')).length,40);
  assert.deepEqual(presentation,before);
});

test('large stock lists stay below legacy attach limit, preserve totals and explain the remaining rows',()=>{
  const entries=Array.from({length:500},(_,i)=>({article:'A'.repeat(110)+i,quantity:32}));
  const fields=arkadyMessageFields({message:'legacy',presentation:assignment({kind:'stock',sections:[{department:'box',articles:500,quantity:16000,url:link('stock'),entries}]})});
  assert.ok(new TextEncoder().encode(contents(fields)).length<28000);assert.match(contents(fields),/Ещё 460 артикулов/);assert.ok(contents(fields).includes('16\u00a0000 шт.'));assert.equal(fields.ATTACH.BLOCKS.flatMap(block=>block.GRID||[]).filter(row=>row.NAME.startsWith('AAAA')).length,40);
});

test('formatting does not mutate durable phrase cursors and skips old records without guessing their content',()=>{
  const s=scope();s.meta('bitrixHumorLevel','off');const op={id:'new',status:'verified',action:'create',name:'OZON Тест',steps:[{status:'verified',department:'box',plan:{sheetId:7},lines:[{quantity:32}]}]};
  queueBitrixNotifications(s,op,{kind:'production',enabled:true,manager:'Кирилл',documentIds:{box:'box-book'}});
  const before=structuredClone([...s.values]),event=s.operations.get('bitrix-notification:production:new:shared').value;
  assert.ok(event.presentation);assert.equal(event.presentation.joke,'');arkadyMessageFields(event);arkadyMessageFields(event);assert.deepEqual([...s.values],before);
  assert.deepEqual(arkadyMessageFields({message:'Previously queued message'}),{MESSAGE:'Previously queued message'});
});

test('native card is delivered once through a fake transport and unknown delivery is not retried',async()=>{
  for(const uncertain of [false,true]){
    const s=scope(),bindings={RITM_ASSEMBLY_SYNC_SECRET:'a'.repeat(64)};s.meta('bitrixNotificationConfig',await encryptBitrixConfig(bindings,config));
    s.putOperation('bitrix-notification',{id:'card',status:'pending',department:'roll',message:'legacy',presentation:assignment()});
    const requests=[],store={scope:async()=>s,withScope:async cb=>cb(s)};
    const fetcher=async(url,init)=>{requests.push(JSON.parse(init.body));assert.match(url,/imbot\.message\.add$/);if(uncertain)throw Error('Lost acknowledgement');return Response.json({result:42});};
    await drainBitrixNotifications(bindings,store,fetcher);await drainBitrixNotifications(bindings,store,fetcher);
    assert.equal(requests.length,1);assert.equal(requests[0].DIALOG_ID,'chat2');assert.ok(requests[0].ATTACH.BLOCKS.length);assert.equal(s.operations.get('bitrix-notification:card').value.status,uncertain?'uncertain':'sent');
  }
});
