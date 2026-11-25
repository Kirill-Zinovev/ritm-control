import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/local-db";
import { bootstrap, fixture } from "./fixtures";
import { digest } from "../shared/catalog";
import type { CatalogEntry } from "../shared/catalog";
import type { Snapshot } from "../shared/model";
import { readRitmWarehousePage } from "../server/ritm-warehouse";
import { api } from "../server/api";
import type { RitmSupply } from "../shared/ritm";

async function setup() {
  const db=await openDatabase(); const f=await bootstrap(db);
  const importId="catalog-quality-test";
  db.sqlite.prepare("insert into av2_catalog_imports(id,manifest,state,created_at,actor) values(?,'{}','active',?,'test')").run(importId,new Date().toISOString());
  db.sqlite.prepare("update av2_meta set active_catalog_id=? where id=1").run(importId);
  const add=(sku:string,market:"WB"|"OZON"="WB",shop="1",raw:Record<string,string>={})=>{
    const e:CatalogEntry={id:JSON.stringify([market,shop,sku]),market,store:shop,sku,aliases:[sku],name:sku+" товар",barcode:"0012345",kind:"Наклейки",category:"",machine:"XEROX",packaging:"Пакет",size:"А5",sheetsPerUnit:"2",printFolder:"",catalogDepartment:"Бокс",boxType:"М",unitsPerBox:100,rollMultiplicity:"",xeroxMultiplicity:"",capacitySource:"consistent",photoId:null,issues:[],rows:[{sheet:market,row:2,raw:{article:sku,alias:sku+"(OZ)",ozonBarcode:"OZN12345",store:shop,...raw},refs:{article:market+"!A2",alias:market+"!B2",ozonBarcode:market+"!D2",store:market+"!T2"}}]};
    db.sqlite.prepare("insert into av2_catalog_entries(id,import_id,entry_id,market,store,sku,search,machine,review,data) values(?,?,?,?,?,?,?,?,0,?)").run(importId+e.id,importId,e.id,market,shop,sku,sku,e.machine,JSON.stringify(e));
    for(const alias of e.aliases)db.sqlite.prepare("insert into av2_catalog_aliases(id,import_id,market,store,alias,entry_id,is_primary) values(?,?,?,?,?,?,1)").run(importId+e.id+alias,importId,market,shop,alias,e.id);
    return e;
  };
  const shift=()=>db.sqlite.prepare("insert into av2_shift_norms(type_key,data,source_hash,captured_at) values('наклейки',?,'confirmed-source','now')").run(JSON.stringify({type:"Наклейки",cut:7000,packing:850,assembly:650,row:2}));
  return {...f,db,add,shift,importId};
}

test('подтверждённый магазин переносит карточку и её ссылки атомарно, не создавая дубль и не меняя работу',async t=>{
 const f=await setup();t.after(()=>f.db.sqlite.close());const e=f.add('STORE-MISSING(OZ)','OZON','',{store:'#N/A'});
 const payload={importId:f.importId,entryId:e.id,store:'2',sourceRowsDigest:await digest(JSON.stringify(e.rows)),reason:'Подтверждение владельца'},key=crypto.randomUUID();
 const counts=()=>f.db.sqlite.prepare('select (select count(*) from av2_work) work,(select count(*) from av2_catalog_entries) entries,(select count(*) from av2_ritm_work_outbox) events').get();const before=counts();
 await assert.rejects(f.cmd('quality.assignCatalogStore',{...payload,sourceRowsDigest:'stale'}),/изменилась/);
 await assert.rejects(f.cmd('quality.assignCatalogStore',{...payload,store:'3'}),/магазин/);
 const result=await f.cmd('quality.assignCatalogStore',payload,key);await f.cmd('quality.assignCatalogStore',payload,key);
 assert.equal(result.entryId,JSON.stringify(['OZON','2',e.sku]));assert.deepEqual(counts(),before);
 const entry=f.db.sqlite.prepare('select entry_id,store,data from av2_catalog_entries where sku=?').get(e.sku)!;
 assert.equal(entry.store,'2');assert.deepEqual(JSON.parse(String(entry.data)).rows,e.rows);
 const aliases=f.db.sqlite.prepare('select entry_id,store from av2_resolved_catalog_aliases where alias=?').all(e.sku);assert.equal(aliases.length,1);assert.equal(aliases[0].store,'2');assert.equal(aliases[0].entry_id,entry.entry_id);
 assert.equal(f.db.sqlite.prepare("select count(*) n from av2_quality_repairs where kind='catalog.assignStore'").get()?.n,1);
 const duplicate=f.add('DUPLICATE(OZ)','OZON','');f.add('DUPLICATE(OZ)','OZON','1');
 await assert.rejects(f.cmd('quality.assignCatalogStore',{...payload,entryId:duplicate.id,store:'1',sourceRowsDigest:await digest(JSON.stringify(duplicate.rows))}),/уже существует/);
 for(const role of ['manager','collector'] as const){const r=await api(new Request('https://test/api/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'quality.assignCatalogStore',key:crypto.randomUUID(),payload})}),f.db,role,role);assert.equal(r.status,403);}
});

test("явные OZON-поля восстанавливают магазин, штрихкод и короб без изменения WB и ID позиции; повтор и дальнейшая синхронизация не создают копий",async t=>{
  const f=await setup();t.after(()=>f.db.sqlite.close());const base=f.add("SKU");
  const root="RITM-ROLL-42";
  const imported=await f.cmd("supply.import",{...fixture,externalId:"confirmed-group",originShipmentId:root,store:"1",positions:[{...fixture.positions[2],sku:"EXISTING",externalId:root+"|uid:existing|EXISTING"}]});
  const missing=await f.cmd("supply.import",{...fixture,externalId:"unknown-group",originShipmentId:root,store:"Не подтверждён",positions:[{...fixture.positions[0],sku:"SKU",externalId:root+"|uid:one|SKU",unitsPerBox:null}]});
  const before=(await f.db.snapshot(String(missing.supplyId))) as Snapshot;const p=before.positions[0];
  const payload={reason:"Явные OZON-поля исходной строки",positions:[{positionId:p.id,externalId:p.externalId,sourceEntryId:base.id,sourceDigest:await digest(JSON.stringify(base))}]};
  const key=crypto.randomUUID();await f.cmd("quality.resolveStores",payload,key);await f.cmd("quality.resolveStores",payload,key);
  const state=(await f.db.snapshot(String(imported.supplyId))) as Snapshot;const resolved=state.positions.find(x=>x.id===p.id)!;assert.ok(resolved);assert.equal(resolved.barcode,"OZN12345");assert.equal(resolved.unitsPerBox,100);
  assert.equal(f.db.sqlite.prepare("select data from av2_catalog_entries where entry_id=?").get(base.id)?.data,JSON.stringify(base));
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_catalog_references").get()?.n,1);
  assert.equal(state.supplies.some(s=>s.id===missing.supplyId),false);
  const source={shipmentId:root,title:fixture.title,market:"OZON",locked:false,positions:[{positionId:p.externalId,sku:"SKU",name:"SKU",quantity:5,sourceId:"roll-printing",store:"",storeStatus:"missing"}]};
  const plan=await f.cmd("ritm.import",{source,sourceRevision:Date.now(),fingerprint:await digest(JSON.stringify(source))});
  assert.deepEqual(plan.issues,[]);assert.equal(f.db.sqlite.prepare("select count(*) n from av2_positions where external_id=?").get(p.externalId)?.n,1);
  f.shift();await f.cmd("work.save",{positionId:p.id,employeeId:f.employee.id,operation:"packing",qty:5});
  await f.cmd("allocation.place",{positionId:p.id,qty:5,newCarton:true});
  assert.equal((await f.db.workHistory!(new URL("https://test/api/work-history?q=SKU")) as {totals:{missingCoefficient:number}}).totals.missingCoefficient,0);
  const forbidden=await api(new Request("https://test/api/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"quality.resolveStores",key:crypto.randomUUID(),payload})}),f.db,"collector","collector");assert.equal(forbidden.status,403);
});

test("связка не подменяет собственную карточку OZON и без явного штрихкода не записывает частичное исправление",async t=>{
  const f=await setup();t.after(()=>f.db.sqlite.close());const bad=f.add("BAD","WB","1",{ozonBarcode:""});
  const root="RITM-ROLL-43";await f.cmd("supply.import",{...fixture,externalId:"group",originShipmentId:root,store:"1",positions:[{...fixture.positions[2],sku:"EXISTING",externalId:root+"|uid:existing|EXISTING"}]});
  const missing=await f.cmd("supply.import",{...fixture,externalId:"unknown",originShipmentId:root,store:"Не подтверждён",positions:[{...fixture.positions[0],sku:"BAD",externalId:root+"|uid:bad|BAD"}]});
  const p=((await f.db.snapshot(String(missing.supplyId))) as Snapshot).positions[0];
  const payload={reason:"Проверка",positions:[{positionId:p.id,externalId:p.externalId,sourceEntryId:bad.id,sourceDigest:await digest(JSON.stringify(bad))}]};
  await assert.rejects(f.cmd("quality.resolveStores",payload),/однозначных/);
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_catalog_references").get()?.n,0);
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_quality_repairs").get()?.n,0);
  const source=f.add("OWN"), own=f.add("OWN","OZON");
  const another=await f.cmd("supply.import",{...fixture,externalId:"own-unknown",originShipmentId:root,store:"Не подтверждён",positions:[{...fixture.positions[0],sku:"OWN",externalId:root+"|uid:own|OWN"}]});
  const ownPosition=((await f.db.snapshot(String(another.supplyId))) as Snapshot).positions[0];
  await assert.rejects(f.cmd("quality.resolveStores",{reason:"Собственная карточка приоритетна",positions:[{positionId:ownPosition.id,externalId:ownPosition.externalId,sourceEntryId:source.id,sourceDigest:await digest(JSON.stringify(source))}]}),/собственные данные OZON/);
  assert.equal(f.db.sqlite.prepare("select data from av2_catalog_entries where entry_id=?").get(own.id)?.data,JSON.stringify(own));
});

test("подтверждение магазина Ozon переносит одну упакованную позицию с историей и разрешает создание короба", async t => {
  const f = await setup();
  t.after(() => f.db.sqlite.close());
  const shipmentId = "RITM-ROLL-64";
  const sku = "STORE-REPAIR";
  const position = (article: string, shop: string) => ({
    positionId: shipmentId + "|uid:" + article + "|" + article,
    sku: article, name: article, quantity: 9, sourceId: "roll-printing" as const,
    sheetId: 64, row: 2, rawUid: article, store: shop, storeStatus: shop ? "matched" : "missing",
  });
  const source: RitmSupply = {shipmentId, title: "OZON СПБ 2-й магазин", market: "OZON", locked: false,
    positions: [position(sku, ""), position("OTHER-UNCONFIRMED", ""), position("ALREADY-CONFIRMED", "2")]};
  const fingerprint = await digest(JSON.stringify(source));
  const sync = (sourceRevision:number) => f.cmd("ritm.import", {source,sourceRevision,fingerprint});
  await sync(10);
  const [before] = await f.db.store.all<{id:string; supplyId:string}>("select id,supply_id from av2_positions where external_id=?", [source.positions[0].positionId]);
  for (const operation of ["cut", "packing"]) {
    await f.cmd("work.save", {positionId:before.id, employeeId:f.employee.id, operation, qty:9});
  }
  f.db.sqlite.prepare("update av2_work set norm='900',coefficient='0.01' where position_id=?").run(before.id);
  const workFacts = () => f.db.sqlite.prepare("select id,position_id,employee_id,operation,qty,norm,coefficient from av2_work where position_id=? order by id").all(before.id);
  const facts = workFacts();
  const events = f.db.sqlite.prepare("select * from av2_ritm_work_outbox order by id").all();
  const card = f.add(sku, "OZON", "2");
  await sync(11);
  assert.equal(f.db.sqlite.prepare("select source_active from av2_positions where id=?").get(before.id)?.source_active, 0);
  const direction = (await f.db.snapshot(before.supplyId, true, true)) as Snapshot;
  const waitingForStore = direction.positions.find((position) => position.id === before.id);
  assert.ok(waitingForStore?.storeNeedsReview);

  const action = "quality.confirmPositionStore";
  const payload = {shipmentId,sku,reason:"Сверили подтверждённую карточку Ozon"};
  const call = (role:"owner"|"manager"|"collector", cmd:string, data:Record<string,unknown>) => api(
    new Request("https://assembly.test/api/command", {method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({action:cmd,key:crypto.randomUUID(),payload:data})}), f.db, role, role,
  );
  for (const role of ["manager","collector"] as const) assert.equal((await call(role,action,payload)).status,403);

  const targetedUpdate = f.db.sqlite.prepare("update av2_ritm_links set payload=? where shipment_id=?");
  targetedUpdate.run(JSON.stringify({...source,locked:true}),shipmentId);
  await assert.rejects(f.cmd(action,payload),/открыта для сборки/);
  assert.deepEqual(workFacts(),facts);
  targetedUpdate.run(JSON.stringify(source),shipmentId);

  const key = crypto.randomUUID();
  const repaired = await f.cmd(action,payload,key);
  assert.deepEqual(await f.cmd(action,payload,key),repaired);
  assert.deepEqual(repaired,{positionId:before.id,store:"2",updatedWorks:2});
  assert.deepEqual(workFacts(),facts);
  assert.deepEqual(f.db.sqlite.prepare("select * from av2_ritm_work_outbox order by id").all(),events);
  const bound = f.db.sqlite.prepare(`select p.id,p.supply_id,p.external_id,p.barcode,p.units_per_box,p.ready,s.store
    from av2_positions p join av2_supplies s on s.id=p.supply_id where p.id=?`).get(before.id)!;
  assert.equal(bound.external_id,source.positions[0].positionId);
  assert.equal(bound.store,"2");
  assert.equal(bound.ready,1);
  assert.equal(bound.units_per_box,card.unitsPerBox);
  assert.equal(bound.barcode,card.barcode);
  assert.deepEqual(f.db.sqlite.prepare("select distinct supply_id from av2_work where position_id=?").all(before.id)
    .map(row => row.supply_id), [bound.supply_id]);
  assert.equal(f.db.sqlite.prepare("select supply_id from av2_positions where sku='OTHER-UNCONFIRMED'").get()?.supply_id,before.supplyId);

  await sync(12);
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_positions where external_id=?").get(bound.external_id)?.n,1);
  assert.equal((await call("collector","allocation.place",{positionId:before.id,qty:9,newCarton:true})).status,200);
  assert.deepEqual(workFacts(),facts);
  assert.equal(f.db.sqlite.prepare("select qty from av2_allocations where position_id=?").get(before.id)?.qty,9);
});

test("две Дачи сгруппированы по магазинам, подтверждённые позиции WB подтягивают карточку", async t => {
  const f = await setup();
  t.after(() => f.db.sqlite.close());
  const shipment = (sheetId: number, title: string, entries: [string, string, number][]): RitmSupply => ({
    shipmentId: "RITM-ROLL-" + sheetId, title, market: "WB", locked: false,
    positions: entries.map(([sku, store, quantity], index) => ({
      sku, store, quantity, name: sku, positionId: "RITM-ROLL-" + sheetId + "|uid:" + sku + "|" + sku,
      sourceId: "roll-printing", sheetId, row: index + 2, rawUid: sku, storeStatus: store ? "matched" : "missing",
    })),
  });
  const regular = shipment(70, "WB ДАЧА", [
    ["D-WAIT-A", "", 21], ["D-WAIT-B", "", 35], ["D-ONE", "1", 500], ["D-TWO", "2", 20],
  ]);
  const urgent = shipment(71, "WB ДАЧА 2 🔥", [["D-URGENT-ONE", "1", 50], ["D-URGENT-TWO", "2", 7]]);
  const sync = async (source: RitmSupply, sourceRevision: number) =>
    f.cmd("ritm.import", { source, sourceRevision, fingerprint: await digest(JSON.stringify(source)) });
  await sync(regular, 20);
  await sync(urgent, 20);
  const waiting = f.db.sqlite.prepare("select id,sku,external_id from av2_positions where sku like 'D-WAIT-%' order by sku").all();
  const repair = (sku: string) => f.cmd("quality.confirmPositionStore", {
    shipmentId: regular.shipmentId, sku, reason: "Магазин подтверждён в справочнике",
  });
  await assert.rejects(repair("D-WAIT-A"), /Нужна одна карточка WB/);
  for (const { sku } of waiting) {
    f.add(String(sku), "WB", "2");
    assert.equal((await repair(String(sku))).store, "2");
  }
  await sync(regular, 21);
  const roster = (await f.db.snapshot(null)) as Snapshot;
  const findSupply = (shipmentId: string, store: string) =>
    roster.supplies.find(s => s.originShipmentId === shipmentId && s.store === store)!;
  const shopTwo = findSupply(regular.shipmentId, "2");
  const urgentShopTwo = findSupply(urgent.shipmentId, "2");
  const carton = (supplyId: string) => f.cmd("carton.create", { supplyId });
  const sameShopCartons = [await carton(shopTwo.id), await carton(urgentShopTwo.id)];
  await carton(findSupply(regular.shipmentId, "1").id);

  const state = (await f.db.snapshot(shopTwo.id, true, true)) as Snapshot;
  assert.deepEqual(state.supplies.filter(s => s.title.startsWith("WB ДАЧА")).map(s => s.title).sort(),
    ["WB ДАЧА · Магазин 1", "WB ДАЧА · Магазин 2"]);
  assert.equal(state.progress.plan, 83);
  assert.deepEqual(state.supplies.find(s => s.id === shopTwo.id)?.sources?.map(s => s.id).sort(),
    [shopTwo.id, urgentShopTwo.id].sort());
  assert.deepEqual(state.cartons.map(c => c.id).sort(), sameShopCartons.map(c => c.cartonId).sort());
  assert.equal(waiting.length, 2);
  for (const original of waiting) {
    const positions = state.positions.filter(p => p.externalId === original.external_id);
    assert.equal(positions.length, 1);
    const [position] = positions;
    assert.equal(position.id, original.id);
    assert.equal(position.supplyId, shopTwo.id);
    assert.equal(position.unitsPerBox, 100);
    assert.equal(position.packing, 0);
  }
});

test("норма восстанавливается отдельным подписываемым событием: количество и прежний пакет работы неизменны, известный коэффициент защищён",async t=>{
  const f=await setup();t.after(()=>f.db.sqlite.close());const e=f.add("REAL","OZON");
  const root="RITM-ROLL-44";
  const created=await f.cmd("supply.import",{...fixture,externalId:"real-group",originShipmentId:root,positions:[{...fixture.positions[0],sku:"REAL",externalId:root+"|uid:r|REAL"}]});
  const p=((await f.db.snapshot(String(created.supplyId))) as Snapshot).positions[0];
  await f.cmd("work.save",{positionId:p.id,employeeId:f.employee.id,operation:"cut",qty:35});
  const before=f.db.sqlite.prepare("select * from av2_work where position_id=?").get(p.id)!;
  const original=f.db.sqlite.prepare("select payload from av2_ritm_work_outbox").get()?.payload;
  f.shift();const payload={reason:"Подтверждённый справочник",workIds:[before.id]};const key=crypto.randomUUID();
  await f.cmd("quality.repairNorms",payload,key);await f.cmd("quality.repairNorms",payload,key);
  const after=f.db.sqlite.prepare("select * from av2_work where id=?").get(before.id)!;
  assert.equal(after.qty,35);assert.equal(after.created_at,before.created_at);assert.equal(after.norm,"3500");assert.equal(after.coefficient,"0.01");
  assert.equal(f.db.sqlite.prepare("select payload from av2_ritm_work_outbox where id not like 'av2:norm:%'").get()?.payload,original);
  const repair=JSON.parse(String(f.db.sqlite.prepare("select payload from av2_ritm_work_outbox where id like 'av2:norm:%'").get()?.payload));
  assert.equal(repair.kind,"norm");assert.equal(repair.qty,35);assert.equal(repair.eventId,"av2:"+before.id);assert.equal(repair.positionId,p.externalId);
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_work where position_id=?").get(p.id)?.n,1);
  await assert.rejects(f.cmd("quality.repairNorms",payload),/уже сохранён/);
  assert.throws(()=>f.db.sqlite.exec("update av2_quality_repairs set kind='changed'"),/IMMUTABLE_REPAIR/);
  assert.ok(e.id);
});

test("демонстрация исключается из рабочего журнала и коробов, исходные факты сохраняются; неверная норма откатывает весь пакет",async t=>{
  const f=await setup();t.after(()=>f.db.sqlite.close());
  await f.cmd("work.save",{positionId:f.a.id,employeeId:f.employee.id,operation:"packing",qty:20});
  await f.cmd("allocation.place",{positionId:f.a.id,qty:20,newCarton:true});
  const count=f.db.sqlite.prepare("select count(*) n from av2_work").get()?.n;
  await assert.rejects(f.cmd("quality.repairNorms",{reason:"Нет источника",workIds:[String(f.db.sqlite.prepare("select id from av2_work").get()?.id)]}),/карточка/);
  await f.cmd("quality.archiveDemo",{reason:"Изолированная демонстрация",supplyId:f.supply.id});
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_work").get()?.n,count);
  assert.equal((await f.db.workHistory!(new URL("https://test/api/work-history")) as {total:number}).total,0);
  assert.equal((await f.db.workHistory!(new URL("https://test/api/work-history?includeDemo=1")) as {total:number}).total,1);
  const page=await readRitmWarehousePage(f.db.store,new URL("https://test/api/ritm/warehouse"));assert.equal(page.total,0);
  await assert.rejects(f.cmd("work.save",{positionId:f.a.id,employeeId:f.employee.id,operation:"packing",qty:1}),/приостанов|подтверд|готов|источник/i);
});

test("пробная работа и её вложения исключаются атомарно с историей; повтор не вычитает количество дважды",async t=>{
  const f=await setup();t.after(()=>f.db.sqlite.close());
  const group=await f.cmd("supply.import",{...fixture,externalId:"RITM-V2:test",originShipmentId:"RITM-ROLL-45",positions:[{...fixture.positions[0],externalId:"RITM-ROLL-45|uid:one|REAL",sku:"REAL"}]});
  const p=((await f.db.snapshot(String(group.supplyId))) as Snapshot).positions[0];
  await f.cmd("work.save",{positionId:p.id,employeeId:f.employee.id,operation:"packing",qty:50});
  const box=await f.cmd("allocation.place",{positionId:p.id,qty:20,newCarton:true});await f.cmd("allocation.add",{positionId:p.id,qty:30,cartonId:box.cartonId});
  const work=f.db.sqlite.prepare("select * from av2_work where position_id=?").get(p.id)!;
  const payload={reason:"Подтверждённая пробная запись",classification:"test",workId:work.id,expectedQty:50,employeeId:f.employee.id,positionId:p.id};const key=crypto.randomUUID();
  await f.cmd("quality.excludeWork",payload,key);await f.cmd("quality.excludeWork",payload,key);
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_work where id=?").get(work.id)?.n,1);
  const totals=f.db.sqlite.prepare("select * from av2_position_totals where position_id=?").get(p.id)!;assert.equal(totals.packing,0);assert.equal(totals.boxed,0);
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_allocations where removed_at is not null").get()?.n,2);
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_quality_repairs where kind='carton.test'").get()?.n,1);
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_production_cartons").get()?.n,0);
  const history=await f.db.workHistory!(new URL("https://test/api/work-history")) as {totals:{qty:number;missingCoefficient:number};items:{canceled:boolean}[]};assert.equal(history.totals.qty,0);assert.equal(history.totals.missingCoefficient,0);assert.equal(history.items[0].canceled,true);
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox where id like 'av2:cancel:%'").get()?.n,1);
  await assert.rejects(f.cmd("quality.excludeWork",payload),/исключена|отменена/);
});
