import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/local-db";
import { bootstrap, fixture } from "./fixtures";
import { readWarehouse } from "../server/warehouse";
import { readWorkHistory } from "../server/work-history";
import { readRitmWarehousePage } from "../server/ritm-warehouse";
import type { Snapshot } from "../shared/model";

async function setup(t: TestContext) {
  const db = await openDatabase(); t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  const entry = { id: JSON.stringify(["OZON", "1", "STOCK"]), market: "OZON", store: "1", sku: "STOCK", name: "Товар на склад", photoId: null, kind: "Наклейки", sheetsPerUnit: "" };
  db.sqlite.prepare("insert into av2_catalog_imports values(?,?,?,?,?)").run("stock-catalog", "{}", "active", new Date().toISOString(), "test");
  db.sqlite.prepare("insert into av2_catalog_entries values(?,?,?,?,?,?,?,?,?,?)").run("stock-entry", "stock-catalog", entry.id, "OZON", "1", "STOCK", "STOCK", "", 0, JSON.stringify(entry));
  db.sqlite.prepare("update av2_meta set active_catalog_id=? where id=1").run("stock-catalog");
  db.sqlite.prepare("insert into av2_shift_norms values(?,?,?,?)").run("наклейки", JSON.stringify({type:"Наклейки",packing:500,assembly:200,cut:1000,row:2}), "test", new Date().toISOString());
  const payload = { market: "OZON", store: "1", entryId: entry.id, catalogImportId: "stock-catalog", employeeId: f.employee.id, qty: 200 };
  const warehouse = () => readWarehouse(db.store, new URL("https://assembly.test/api/warehouse"));
  const history = () => readWorkHistory(db.store, new URL("https://assembly.test/api/work-history"));
  return { db, ...f, payload, warehouse, history };
}

test("две операции в запас одной командой: разные сотрудники, замороженные кэфы, одно поступление и повтор без дублей", async t => {
  const c=await setup(t), other=c.state.employees.find(e=>e.id!==c.employee.id)!;
  const payload={...c.payload,qty:100,receiptMode:"packing",operation:"packing",additionalWork:{operation:"assembly",employeeId:other.id}}, key=crypto.randomUUID();
  await c.cmd("warehouse.receive",payload,key);await c.cmd("warehouse.receive",payload,key);
  const h=await c.history(), box=(await c.warehouse()).cartons[0];
  assert.equal(h.total,2);assert.equal(box.qty,100);assert.equal(box.itemCount,1);
  const packing=h.items.find(i=>i.operation==="packing")!, cutting=h.items.find(i=>i.operation==="assembly")!;
  assert.equal(packing.employeeId,c.employee.id);assert.equal(Number(packing.coefficient),0.2);
  assert.equal(cutting.employeeId,other.id);assert.equal(Number(cutting.coefficient),0.5);
  const events=c.db.sqlite.prepare("select payload from av2_ritm_work_outbox").all().map(r=>JSON.parse(String(r.payload)));
  assert.equal(events.length,2);assert(events.every(e=>e.kind==="warehouse-work"));assert.equal(new Set(events.map(e=>e.eventId)).size,2);
  assert.equal(events.find(e=>e.operation==="assembly").employee,other.name);
  assert.equal(events.find(e=>e.operation==="packing").employee,c.employee.name);
  c.db.sqlite.prepare("update av2_shift_norms set data=?").run(JSON.stringify({type:"Наклейки",packing:10000,assembly:10000,row:2}));
  assert.equal((await c.history()).totals.coefficient,0.7);
  await c.cmd("warehouse.remove",{cartonId:box.id,receiptId:box.items[0].id,version:box.version,reason:"Ошибочная упаковка"});
  assert.equal((await c.warehouse()).cartons[0].qty,0);
  const after=await c.history();assert.equal(after.items.find(i=>i.id===cutting.id)!.canceled,false);assert.equal(after.totals.coefficient,0.5);
});

test("порядок двух операций не меняет склад; один сотрудник может выполнить обе, две резки не создают остаток", async t => {
  const c=await setup(t);
  await c.cmd("warehouse.receive",{...c.payload,qty:100,receiptMode:"packing",operation:"cut",additionalWork:{operation:"packing",employeeId:c.employee.id}});
  assert.equal((await c.warehouse()).cartons[0].qty,100);assert.equal((await c.history()).total,2);
  await c.cmd("warehouse.receive",{...c.payload,qty:50,receiptMode:"packing",operation:"cut",additionalWork:{operation:"assembly",employeeId:c.employee.id}});
  assert.equal((await c.warehouse()).cartons[0].qty,100);assert.equal((await c.history()).total,4);
});

test("разные количества операций: кэфы и события РИТМ используют своё количество, склад только упаковку", async t => {
  const c=await setup(t), other=c.state.employees.find(e=>e.id!==c.employee.id)!;
  const payload={...c.payload,qty:80,receiptMode:"packing",operation:"packing",additionalWork:{operation:"assembly",employeeId:other.id,qty:100}},key=crypto.randomUUID();
  await c.cmd("warehouse.receive",payload,key);await c.cmd("warehouse.receive",payload,key);
  let h=await c.history();
  assert.equal(h.items.find(w=>w.operation==="packing")!.qty,80);
  assert.equal(Number(h.items.find(w=>w.operation==="packing")!.coefficient),0.16);
  assert.equal(h.items.find(w=>w.operation==="assembly")!.qty,100);
  assert.equal(Number(h.items.find(w=>w.operation==="assembly")!.coefficient),0.5);
  assert.equal((await c.warehouse()).cartons[0].qty,80);
  let events=c.db.sqlite.prepare("select payload from av2_ritm_work_outbox").all().map(r=>JSON.parse(String(r.payload)));
  assert.equal(events.length,2);assert.equal(events.find(e=>e.operation==="packing").qty,80);assert.equal(events.find(e=>e.operation==="assembly").qty,100);
  await c.cmd("warehouse.receive",{...c.payload,qty:60,receiptMode:"packing",operation:"cut",additionalWork:{operation:"packing",employeeId:other.id,qty:40}});
  h=await c.history();assert.equal(h.total,4);assert.equal((await c.warehouse()).cartons[0].qty,120);
  events=c.db.sqlite.prepare("select payload from av2_ritm_work_outbox").all().map(r=>JSON.parse(String(r.payload)));
  assert(events.some(e=>e.operation==="packing"&&e.qty===40&&Number(e.coefficient)===0.08));
  assert(events.some(e=>e.operation==="cut"&&e.qty===60&&Number(e.coefficient)===0.06));
});

test("неверное количество второй работы отклоняет весь пакет без первой операции и поступления", async t => {
  const c=await setup(t);
  for(const qty of [0,-1,1.5,"100",null,2147483648,NaN]) {
    await assert.rejects(c.cmd("warehouse.receive",{...c.payload,receiptMode:"packing",operation:"packing",additionalWork:{operation:"assembly",employeeId:c.employee.id,qty}}));
  }
  assert.equal((await c.history()).total,0);assert.equal((await c.warehouse()).total,0);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox").get()!.n,0);
});

test("неверная вторая операция или сотрудник не сохраняют первую; сбой второй записи откатывает весь пакет", async t => {
  const c=await setup(t), p={...c.payload,receiptMode:"packing",operation:"packing"};
  for(const additionalWork of [null,[],{}, {operation:"packing",employeeId:c.employee.id}, {operation:"unknown",employeeId:c.employee.id}, {operation:"cut",employeeId:"missing"}]) {
    await assert.rejects(c.cmd("warehouse.receive",{...p,additionalWork}));
    assert.equal((await c.history()).total,0);assert.equal((await c.warehouse()).total,0);
    assert.equal(c.db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox").get()!.n,0);
  }
  await assert.rejects(c.cmd("warehouse.receive",{...p,receiptMode:"receipt",additionalWork:{operation:"cut",employeeId:c.employee.id}}),/только при записи работы/);
  c.db.sqlite.exec("create trigger fail_second_cut before insert on av2_stock_cut_work begin select raise(abort,'test failure'); end");
  await assert.rejects(c.cmd("warehouse.receive",{...p,additionalWork:{operation:"cut",employeeId:c.employee.id}}));
  assert.equal((await c.warehouse()).total,0);assert.equal((await c.history()).total,0);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox").get()!.n,0);
});

test("сверх плана по умолчанию остаётся в выбранном коробе, без приёмки на склад и повторной выработки", async t => {
  const c=await setup(t);
  await c.cmd("supply.import",{...fixture,sourceVersion:2,positions:fixture.positions.map((p,i)=>({...p,plan:i?p.plan:20}))});
  await c.cmd("work.save",{positionId:c.a.id,employeeId:c.employee.id,operation:"packing",qty:50});
  const before=await c.db.snapshot(c.supply.id) as Snapshot;
  const payload={positionId:c.a.id,newCarton:true,qty:50},key=crypto.randomUUID();
  await assert.rejects(c.cmd("allocation.place",{...payload,excessDestination:"anything"}),/излишек/);
  const result=await c.cmd("allocation.place",payload,key);await c.cmd("allocation.place",payload,key);
  assert.equal(result.shipmentQty,50);assert.equal(result.warehouseQty,0);
  const after=await c.db.snapshot(c.supply.id) as Snapshot;
  assert.equal(after.cartons[0].qty,50);assert.equal(after.positions[0].warehouseQty,0);assert.deepEqual(after.works,before.works);
  assert.equal((await c.warehouse()).total,0);
});

test("полный короб не перенаправляет превышение на склад; явный выбор склада не дублирует упаковку", async t => {
  const c=await setup(t);
  await c.cmd("supply.import",{...fixture,sourceVersion:2,positions:fixture.positions.map((p,i)=>({...p,plan:i?p.plan:20}))});
  await c.cmd("work.save",{positionId:c.a.id,employeeId:c.employee.id,operation:"packing",qty:120});
  await assert.rejects(c.cmd("allocation.place",{positionId:c.a.id,newCarton:true,qty:120}),/свободное место/);
  assert.equal((await c.warehouse()).total,0);
  const before=await c.db.snapshot(c.supply.id) as Snapshot;
  const result=await c.cmd("allocation.place",{positionId:c.a.id,newCarton:true,qty:120,excessDestination:"stock",employeeId:c.employee.id});
  assert.equal(result.shipmentQty,20);assert.equal(result.warehouseQty,100);
  const after=await c.db.snapshot(c.supply.id) as Snapshot;
  assert.equal(after.cartons[0].qty,20);assert.equal((await c.warehouse()).cartons[0].qty,100);assert.deepEqual(after.works,before.works);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_warehouse_work").get()!.n,0);
});

test("новая упаковка на склад начисляет замороженный кэф один раз, приём остатка — без новой работы", async t => {
  const c=await setup(t),before=await c.db.snapshot(c.supply.id) as Snapshot;
  const p={...c.payload,receiptMode:"packing",coefficient:99},key=crypto.randomUUID();
  await c.cmd("warehouse.receive",p,key);await c.cmd("warehouse.receive",p,key);
  let history=await c.history();assert.equal(history.total,1);assert.equal(history.totals.qty,200);assert.equal(history.totals.coefficient,0.4);
  assert.equal(history.items[0].scope,"warehouse");assert.equal(history.items[0].employee,c.employee.name);assert.equal(Number(history.items[0].norm),500);
  const receipt=(await c.warehouse()).cartons[0].items[0];assert.equal(receipt.workId,history.items[0].id);assert.equal(Number(receipt.coefficient),0.4);
  const event=JSON.parse(String(c.db.sqlite.prepare("select payload from av2_ritm_work_outbox").get()!.payload));
  assert.equal(event.kind,"warehouse-work");assert.equal(event.receiptId,receipt.id);assert.equal(Number(event.coefficient),0.4);assert.equal(event.shipmentId,undefined);
  await c.cmd("warehouse.receive",{...c.payload,qty:300,receiptMode:"receipt"});
  history=await c.history();assert.equal(history.total,1);assert.equal(history.totals.coefficient,0.4);assert.equal((await c.warehouse()).cartons[0].qty,500);
  c.db.sqlite.prepare("update av2_shift_norms set data=?").run(JSON.stringify({type:"Наклейки",packing:1000,row:2}));
  assert.equal((await c.history()).totals.coefficient,0.4);
  const after=await c.db.snapshot(c.supply.id) as Snapshot;assert.deepEqual(after.positions,before.positions);assert.deepEqual(after.works,before.works);assert.equal(after.supplies.length,before.supplies.length);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_work").get()!.n,0);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox").get()!.n,1);
});

test("отмена новой складской упаковки убирает её товар и кэф, сохраняет историю и готовые остатки", async t => {
  const c=await setup(t);
  await c.cmd("warehouse.receive",{...c.payload,receiptMode:"packing"});
  await c.cmd("warehouse.receive",{...c.payload,qty:30,receiptMode:"receipt"});
  const work=(await c.history()).items[0],key=crypto.randomUUID();
  await c.cmd("work.cancel",{workId:work.id,reason:"Ошибочное количество"},key);
  await c.cmd("work.cancel",{workId:work.id,reason:"Ошибочное количество"},key);
  const history=await c.history();assert.equal(history.total,1);assert.equal(history.items[0].canceled,true);assert.equal(history.totals.qty,0);assert.equal(history.totals.coefficient,0);
  assert.equal((await c.warehouse()).cartons[0].qty,30);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_warehouse_receipts").get()!.n,2);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_warehouse_receipts where voided_at is not null").get()!.n,1);
  const page=await readRitmWarehousePage(c.db.store,new URL("https://assembly.test/api/ritm/warehouse?kind=warehouse"));
  assert.equal(page.cartons[0].quantity,30);
  const events=c.db.sqlite.prepare("select payload from av2_ritm_work_outbox order by created_at,id").all().map(r=>JSON.parse(String(r.payload)));
  assert.equal(events.length,2);assert.equal(events.find(e=>e.kind==="cancel").eventId,"av2:"+work.id);
});

test("резка в запас и упаковка разных сотрудников дают отдельные кэфы; только упаковка создаёт готовый остаток", async t => {
  const c = await setup(t), other = c.state.employees.find(e => e.id !== c.employee.id)!;
  const p = {...c.payload, receiptMode: "packing", operation: "assembly", qty: 100}, key = crypto.randomUUID();
  await c.cmd("warehouse.receive", p, key);
  await c.cmd("warehouse.receive", p, key);
  assert.equal((await c.warehouse()).total, 0, "cutting never creates a finished-stock carton");
  await c.cmd("warehouse.receive", {...p, operation: "cut", qty: 200});
  await c.cmd("warehouse.receive", {...p, operation: "packing", employeeId: other.id});
  let h = await c.history();
  assert.equal(h.total, 3);
  assert.equal(h.totals.qty, 400);
  assert.equal(h.totals.coefficient, 0.9);
  assert.equal(h.items.find(w => w.operation === "assembly")!.employeeId, c.employee.id);
  assert.equal(h.items.find(w => w.operation === "packing")!.employeeId, other.id);
  assert.equal((await c.warehouse()).cartons[0].qty, 100);
  const events=c.db.sqlite.prepare("select payload from av2_ritm_work_outbox").all().map(r=>JSON.parse(String(r.payload)));
  assert.equal(events.length,3);
  assert(events.filter(e=>e.operation!=="packing").every(e=>e.taskId&& !e.receiptId && !e.shipmentId));
  const manual=h.items.find(w=>w.operation==="assembly")!;
  await c.cmd("work.cancel",{workId:manual.id,reason:"Проверка отдельной отмены"});
  h=await c.history();assert.equal(h.totals.qty,300);assert(Math.abs(Number(h.totals.coefficient)-0.4)<1e-10);
  assert.equal((await c.warehouse()).cartons[0].qty,100);
  assert.equal(h.items.find(w=>w.operation==="packing")!.canceled,false);
  await assert.rejects(c.cmd("warehouse.receive",{...p,operation:"unknown"}),/операцию/);
});

test("закрытая складская упаковка не отменяется без сверки короба; отсутствие нормы остаётся явным", async t => {
  const c=await setup(t);
  c.db.sqlite.prepare("delete from av2_shift_norms").run();
  await c.cmd("warehouse.receive",{...c.payload,receiptMode:"packing"});
  const work=(await c.history()).items[0];assert.equal(work.coefficient,null);assert.equal((await c.history()).totals.missingCoefficient,1);
  const box=(await c.warehouse()).cartons[0];await c.cmd("warehouse.close",{cartonId:box.id,version:box.version});
  await assert.rejects(c.cmd("work.cancel",{workId:work.id,reason:"Попытка отмены"}),/открытом складском коробе/);
  assert.equal((await c.warehouse()).cartons[0].qty,200);assert.equal((await c.history()).items[0].canceled,false);
});

test("удаление ошибочного складского артикула отменяет только его упаковку и доставляет отмену один раз", async t => {
  const c=await setup(t);
  await c.cmd("warehouse.receive",{...c.payload,receiptMode:"packing",operation:"assembly",qty:20});
  await c.cmd("warehouse.receive",{...c.payload,receiptMode:"packing",qty:20});
  await c.cmd("warehouse.receive",{...c.payload,receiptMode:"receipt",qty:5});
  const before=(await c.warehouse()).cartons[0], item=before.items.find(i=>i.workId)!;
  const p={cartonId:before.id,receiptId:item.id,version:before.version,reason:"Ошибочный артикул"}, key=crypto.randomUUID();
  await assert.rejects(c.cmd("warehouse.remove",{...p,reason:""}),/причину/);
  await assert.rejects(c.cmd("warehouse.remove",{...p,version:before.version-1}),/изменился/);
  await c.cmd("warehouse.remove",p,key);await c.cmd("warehouse.remove",p,key);
  assert.equal((await c.warehouse()).cartons[0].qty,5);
  const history=await c.history();
  assert.equal(history.items.find(i=>i.operation==="assembly")!.canceled,false);
  assert.equal(history.items.find(i=>i.operation==="packing")!.canceled,true);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox where json_extract(payload,'$.kind')='cancel'").get()!.n,1);
  await assert.rejects(c.cmd("warehouse.remove",p),/уже удалена/);
  const box=(await c.warehouse()).cartons[0];
  const events=c.db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox").get()!.n;
  await c.cmd("warehouse.remove",{cartonId:box.id,receiptId:box.items[0].id,version:box.version,reason:"Ошибочный остаток"});
  assert.equal((await c.warehouse()).cartons[0].qty,0);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox").get()!.n,events);
});

test("закрытый складской короб исправляется только после явного открытия; версия и чужой короб проверяются", async t => {
  const c=await setup(t);
  await c.cmd("warehouse.receive",{...c.payload,receiptMode:"packing",qty:20});
  const box=(await c.warehouse()).cartons[0],item=box.items[0];
  await c.cmd("warehouse.close",{cartonId:box.id,version:box.version});
  const p={cartonId:box.id,receiptId:item.id,version:box.version+1,reason:"Ошибочный артикул"};
  await assert.rejects(c.cmd("warehouse.remove",p),/откройте/);
  await assert.rejects(c.cmd("warehouse.reopen",{cartonId:box.id,version:box.version}),/изменился/);
  const key=crypto.randomUUID(),open={cartonId:box.id,version:box.version+1};
  await c.cmd("warehouse.reopen",open,key);await c.cmd("warehouse.reopen",open,key);
  const reopened=(await c.warehouse()).cartons[0];
  assert.equal(reopened.state,"open");assert.equal(reopened.closedAt,null);assert.equal(reopened.qty,20);
  assert.equal((await c.history()).items[0].canceled,false);
  await assert.rejects(c.cmd("warehouse.remove",{...p,cartonId:"foreign",version:reopened.version}),/не найдена/);
  await assert.rejects(c.cmd("warehouse.remove",p),/изменился/);
  await c.cmd("warehouse.remove",{...p,version:reopened.version});
  assert.equal((await c.warehouse()).cartons[0].qty,0);
});
