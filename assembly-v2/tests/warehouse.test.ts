import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/local-db";
import { bootstrap, fixture } from "./fixtures";
import type { Snapshot } from "../shared/model";
import { readWarehouse } from "../server/warehouse";
import { readWorkHistory } from "../server/work-history";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
const url = (q = "") => new URL("https://assembly.test/api/warehouse" + q);
async function setup(path?: string) {
  const db = await openDatabase(path),
    f = await bootstrap(db);
  return {
    ...f,
    db,
    pack: (qty: number) =>
      f.cmd("work.save", {
        positionId: f.a.id,
        employeeId: f.employee.id,
        operation: "packing",
        qty,
      }),
  };
}
test("склад: ручная приёмка не создаёт выработку, запрос повторяем, карточка и магазин проверяются", async (t) => {
  const c = await setup();
  t.after(() => c.db.sqlite.close());
  const entry = {
    id: JSON.stringify(["OZON", "1", "MANUAL"]),
    market: "OZON",
    store: "1",
    sku: "MANUAL",
    name: "Готовый товар",
    photoId: "photo-manual",
  };
  c.db.sqlite
    .prepare("insert into av2_catalog_imports values(?,?,?, ?,?)")
    .run("catalog", "{}", "active", new Date().toISOString(), "test");
  c.db.sqlite
    .prepare("insert into av2_catalog_entries values(?,?,?,?,?,?,?,?,?,?)")
    .run(
      "row",
      "catalog",
      entry.id,
      "OZON",
      "1",
      "MANUAL",
      "MANUAL",
      "",
      "0",
      JSON.stringify(entry),
    );
  c.db.sqlite
    .prepare("update av2_meta set active_catalog_id=? where id=1")
    .run("catalog");
  const p = {
    market: "OZON",
    store: "1",
    entryId: entry.id,
    catalogImportId: "catalog",
    employeeId: c.employee.id,
    qty: 20,
    comment: "Найден готовый товар",
  };
  const key = crypto.randomUUID();
  await c.cmd("warehouse.receive", p, key);
  await c.cmd("warehouse.receive", p, key);
  const state = (await c.db.snapshot(c.supply.id)) as Snapshot;
  assert.equal(state.works.length, 0);
  assert.equal(state.positions[0].packing, 0);
  assert.equal(state.cartons.length, 0);
  const wh = await readWarehouse(c.db.store, url());
  assert.equal(wh.cartons[0].qty, 20);
  assert.equal(wh.cartons[0].label, "1скл1");
  assert.equal(wh.cartons[0].items[0].employee, c.employee.name);
  assert.equal(wh.cartons[0].items[0].photoId, "photo-manual");
  await assert.rejects(
    c.cmd("warehouse.receive", { ...p, store: "2" }),
    /не совпадает/,
  );
  await assert.rejects(
    c.cmd("warehouse.receive", { ...p, catalogImportId: "old" }),
    /изменился/,
  );
  await assert.rejects(
    c.cmd("warehouse.receive", { ...p, qty: -1 }),
    /количество/,
  );
  assert.equal((await readWarehouse(c.db.store, url("?q=MANUAL"))).total, 1);
  assert.equal(
    (await readWarehouse(c.db.store, url("?q=1%D0%A1%D0%9A%D0%9B1"))).total,
    1,
  );
  assert.equal((await readWarehouse(c.db.store, url("?q=OTHER"))).total, 0);
});
test("общий журнал не обрезает историю до 100 и открывает нужную поставку отдельно", async (t) => {
  const c = await setup();
  t.after(() => c.db.sqlite.close());
  for (let i = 0; i < 105; i++) await c.pack(1);
  await c.cmd("supply.import", { ...fixture, externalId: "SECOND-HISTORY" });
  const state = (await c.db.snapshot(null)) as Snapshot;
  await c.cmd("work.save", {
    positionId: state.positions[0].id,
    employeeId: c.employee.id,
    operation: "cut",
    qty: 7,
  });
  const first = await readWorkHistory(
    c.db.store,
    new URL("https://assembly.test/api/work-history"),
  );
  assert.equal(first.total, 106);
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0].supplyId, state.selectedSupplyId);
  const old = await readWorkHistory(
    c.db.store,
    new URL(
      "https://assembly.test/api/work-history?supply=" +
        c.supply.id +
        "&page=5",
    ),
  );
  assert.equal(old.total, 105);
  assert.equal(old.items.length, 5);
  assert.equal(old.items[0].supplyId, c.supply.id);
});

test("удаление перенесённого излишка возвращает доступное количество, сохраняя работу и кэф", async t => {
  const c=await setup();t.after(()=>c.db.sqlite.close());
  await c.pack(510);
  await c.cmd("warehouse.transfer",{positionId:c.a.id,qty:10,employeeId:c.employee.id});
  const box=(await readWarehouse(c.db.store,url())).cartons[0], before=await readWorkHistory(c.db.store,new URL("https://assembly.test/api/work-history"));
  assert.equal(((await c.db.snapshot(c.supply.id)) as Snapshot).positions[0].boxed,10);
  await c.cmd("warehouse.remove",{cartonId:box.id,receiptId:box.items[0].id,version:box.version,reason:"Ошибочное размещение"});
  assert.equal(((await c.db.snapshot(c.supply.id)) as Snapshot).positions[0].boxed,0);
  assert.deepEqual(await readWorkHistory(c.db.store,new URL("https://assembly.test/api/work-history")),before);
  await c.cmd("warehouse.transfer",{positionId:c.a.id,qty:10,employeeId:c.employee.id});
  assert.equal((await readWarehouse(c.db.store,url())).cartons[0].qty,10);
});
test("план и излишек размещаются атомарно, склад не ограничен нормой короба, упаковка не начисляется повторно", async (t) => {
  const c = await setup();
  t.after(() => c.db.sqlite.close());
  // 80/100 already belongs to the shipment; a large excess remains on hand.
  await c.cmd("supply.import", {
    ...fixture,
    sourceVersion: 2,
    positions: fixture.positions.map((p, i) => ({
      ...p,
      plan: i ? p.plan : 100,
    })),
  });
  await c.pack(580);
  const box = String(
    (await c.cmd("carton.create", { supplyId: c.supply.id })).cartonId,
  );
  await c.cmd("allocation.add", { positionId: c.a.id, cartonId: box, qty: 80 });
  const before = (await c.db.snapshot(c.supply.id)) as Snapshot;
  const p = {
      positionId: c.a.id,
      cartonId: box,
      qty: 500,
      employeeId: c.employee.id,
      excessDestination: "stock",
    },
    key = crypto.randomUUID();
  const r = await c.cmd("allocation.place", p, key);
  await c.cmd("allocation.place", p, key);
  assert.equal(r.shipmentQty, 20);
  assert.equal(r.warehouseQty, 480);
  const after = (await c.db.snapshot(c.supply.id)) as Snapshot;
  assert.deepEqual(after.works, before.works);
  assert.equal(after.positions[0].packing, 580);
  assert.equal(after.positions[0].boxed, 580);
  assert.equal(after.positions[0].warehouseQty, 480);
  assert.equal(after.cartons[0].qty, 100);
  assert.equal((await readWarehouse(c.db.store, url())).cartons[0].qty, 480);
  await assert.rejects(
    c.cmd("work.cancel", { workId: after.works[0].id, reason: "Проверка" }),
    /уже на складе/,
  );
});
test("ошибка размещения не оставляет складского короба и не расходует остаток", async (t) => {
  const c = await setup();
  t.after(() => c.db.sqlite.close());
  await c.pack(600);
  await assert.rejects(
    c.cmd("allocation.place", {
      positionId: c.a.id,
      newCarton: true,
      qty: 600,
      employeeId: c.employee.id,
    }),
    /свободное место/,
  );
  assert.equal((await readWarehouse(c.db.store, url())).total, 0);
  assert.equal(
    ((await c.db.snapshot(c.supply.id)) as Snapshot).positions[0].boxed,
    0,
  );
  await assert.rejects(
    c.cmd("warehouse.transfer", {
      positionId: c.a.id,
      qty: 101,
      employeeId: c.employee.id,
    }),
    /излишек/,
  );
});
test("параллельные излишки не дублируются; новый текущий короб, закрытие и исторические номера сохраняются", async (t) => {
  const c = await setup();
  t.after(() => c.db.sqlite.close());
  await c.pack(510);
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      c.cmd("warehouse.transfer", {
        positionId: c.a.id,
        qty: 10,
        employeeId: c.employee.id,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const wh = await readWarehouse(c.db.store, url()),
    first = wh.cartons[0];
  assert.equal(first.qty, 10);
  await c.cmd("warehouse.create", { market: "OZON", store: "1" });
  const next = (await readWarehouse(c.db.store, url())).cartons;
  assert.equal(next.filter((b) => b.current).length, 1);
  assert.equal(next.find((b) => b.current)?.label, "1скл2");
  await c.cmd("warehouse.close", {
    cartonId: first.id,
    version: first.version,
  });
  await assert.rejects(
    c.cmd("warehouse.close", { cartonId: first.id, version: first.version }),
    /изменился/,
  );
  await c.cmd("warehouse.create", { market: "WB", store: "1" });
  assert.equal(
    (await readWarehouse(c.db.store, url())).cartons.find(
      (b) => b.market === "WB",
    )?.label,
    "1скл3",
  );
});
test("работа, короба и полный журнал переживают закрытие базы и повторное открытие; поставки изолированы", async () => {
  const path = join(
    tmpdir(),
    "assembly-persistence-" + crypto.randomUUID() + ".sqlite",
  );
  let c = await setup(path);
  try {
    await c.pack(50);
    await c.cmd("allocation.add", {
      positionId: c.a.id,
      newCarton: true,
      qty: 50,
    });
    const initial = (await c.db.snapshot(c.supply.id)) as Snapshot;
    c.db.sqlite.close();
    const db = await openDatabase(path);
    try {
      const reopened = (await db.snapshot(c.supply.id)) as Snapshot;
      assert.deepEqual(reopened.works, initial.works);
      assert.deepEqual(reopened.cartons, initial.cartons);
      assert.equal(reopened.positions[0].packing, 50);
      const page = await readWorkHistory(
        db.store,
        new URL("https://assembly.test/api/work-history"),
      );
      assert.equal(page.total, 1);
      assert.equal(page.items[0].qty, 50);
      assert.equal(
        (
          await readWorkHistory(
            db.store,
            new URL("https://assembly.test/api/work-history?supply=unknown"),
          )
        ).total,
        0,
      );
    } finally {
      db.sqlite.close();
    }
  } finally {
    for (const suffix of ["", "-wal", "-shm"])
      await unlink(path + suffix).catch(() => {});
  }
});

test("выбор складского короба и атомарное перемещение сохраняют работу и защищают от гонки", async (t) => {
  const c=await setup();t.after(()=>c.db.sqlite.close());await c.pack(540);
  const first=await c.cmd("warehouse.create",{market:"OZON",store:"1"});
  const second=await c.cmd("warehouse.create",{market:"OZON",store:"1"});
  const third=await c.cmd("warehouse.create",{market:"OZON",store:"1"});
  await c.cmd("warehouse.transfer",{positionId:c.a.id,qty:40,employeeId:c.employee.id,warehouseCartonId:first.warehouseCartonId});
  const before=await readWarehouse(c.db.store,url());const from=before.cartons.find(b=>b.id===first.warehouseCartonId)!;assert.equal(from.qty,40);
  c.db.sqlite.prepare("insert into av2_warehouse_work(id,receipt_id,product_type,norm,coefficient,created_at,actor) values(?,?,?,?,?,?,?)").run("move-work",from.items[0].id,"Test","100","0.4",new Date().toISOString(),"test");
  const warehouseWork=c.db.sqlite.prepare("select * from av2_warehouse_work").all();
  const works=c.db.sqlite.prepare("select * from av2_work").all(),totals=c.db.sqlite.prepare("select * from av2_position_totals").all(),outbox=c.db.sqlite.prepare("select * from av2_ritm_work_outbox").all();
  const payload={receiptId:from.items[0].id,fromCartonId:from.id,version:from.version,toCartonId:second.warehouseCartonId};
  const key=crypto.randomUUID();const raced=await Promise.allSettled([c.cmd("warehouse.move",payload,key),c.cmd("warehouse.move",{...payload,toCartonId:third.warehouseCartonId})]);assert.equal(raced.filter(r=>r.status==="fulfilled").length,1);
  const after=await readWarehouse(c.db.store,url());assert.equal(after.cartons.find(b=>b.id===from.id)!.qty,0);assert.equal(after.cartons.reduce((n,b)=>n+b.qty,0),40);
  if(raced[0].status==="fulfilled")assert.deepEqual(await c.cmd("warehouse.move",payload,key),raced[0].value);
  assert.deepEqual(c.db.sqlite.prepare("select * from av2_work").all(),works);assert.deepEqual(c.db.sqlite.prepare("select * from av2_position_totals").all(),totals);assert.deepEqual(c.db.sqlite.prepare("select * from av2_ritm_work_outbox").all(),outbox);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_commands where action='warehouse.move'").get()!.n,1);
  const current=after.cartons.find(b=>b.qty===40)!;
  const wrong=await c.cmd("warehouse.create",{market:"WB",store:"1"});
  await assert.rejects(c.cmd("warehouse.move",{...payload,fromCartonId:current.id,version:current.version,toCartonId:wrong.warehouseCartonId}),/магазина/);
  await c.cmd("warehouse.close",{cartonId:current.id,version:current.version});
  await assert.rejects(c.cmd("warehouse.move",{...payload,fromCartonId:current.id,version:current.version,toCartonId:from.id}),/открыты/);
  assert.deepEqual(c.db.sqlite.prepare("select * from av2_warehouse_work").all(),warehouseWork);
  assert.equal(c.db.sqlite.prepare("pragma foreign_key_check").all().length,0);
});

test("частичный перенос сохраняет одну работу и кэф; повторное разделение и отмена связаны", async t=>{
 const c=await setup();t.after(()=>c.db.sqlite.close());const a=await c.cmd('warehouse.create',{market:'OZON',store:'1'}),b=await c.cmd('warehouse.create',{market:'OZON',store:'1'}),d=await c.cmd('warehouse.create',{market:'OZON',store:'1'});
 c.db.sqlite.prepare("insert into av2_warehouse_receipts(id,carton_id,sku,name,search,qty,employee_id,employee,supply,comment,actor,created_at) values('root',?,'SKU','Товар','SKU',46,?,'Иван','Упаковка','','test',?)").run(String(a.warehouseCartonId),c.employee.id,new Date().toISOString());
 c.db.sqlite.prepare("insert into av2_warehouse_work(id,receipt_id,product_type,norm,coefficient,created_at,actor) values('split-work','root','Test','575','0.08',?,'test')").run(new Date().toISOString());
 const before=await readWorkHistory(c.db.store,new URL('https://test/api/work-history?supply=warehouse'));
 for(const qty of [0,-1,47,1.5,'20'])await assert.rejects(c.cmd('warehouse.move',{receiptId:'root',fromCartonId:a.warehouseCartonId,toCartonId:b.warehouseCartonId,version:0,qty}),/количество/);
 const p={receiptId:'root',fromCartonId:a.warehouseCartonId,toCartonId:b.warehouseCartonId,version:0,qty:20},key=crypto.randomUUID();const moved=await c.cmd('warehouse.move',p,key);assert.deepEqual(await c.cmd('warehouse.move',p,key),moved);
 let wh=await readWarehouse(c.db.store,url());assert.equal(wh.cartons.find(b=>b.id===a.warehouseCartonId)!.qty,26);
 const child=wh.cartons.find(x=>x.id===b.warehouseCartonId)!;assert.equal(child.qty,20);assert.equal(child.items[0].workId,'split-work');assert.equal(child.items[0].workQty,46);
 await c.cmd('warehouse.move',{receiptId:moved.warehouseReceiptId,fromCartonId:child.id,toCartonId:d.warehouseCartonId,version:child.version,qty:5});
 const after=await readWorkHistory(c.db.store,new URL('https://test/api/work-history?supply=warehouse'));assert.deepEqual(after,before);assert.equal(c.db.sqlite.prepare('select count(*) n from av2_warehouse_work').get()!.n,1);assert.equal(c.db.sqlite.prepare('select count(*) n from av2_ritm_work_outbox').get()!.n,0);
 wh=await readWarehouse(c.db.store,url());assert.equal(wh.cartons.reduce((n,b)=>n+b.qty,0),46);
 const current=wh.cartons.find(x=>x.id===a.warehouseCartonId)!;await assert.rejects(c.cmd('warehouse.remove',{receiptId:'root',cartonId:current.id,version:current.version,reason:'Ошибка'}),/История/);
 const target=wh.cartons.find(x=>x.id===d.warehouseCartonId)!;await c.cmd('warehouse.close',{cartonId:target.id,version:target.version});await assert.rejects(c.cmd('work.cancel',{workId:'split-work',reason:'Ошибка'}),/закрытом/);
 await c.cmd('warehouse.reopen',{cartonId:target.id,version:target.version+1});await c.cmd('work.cancel',{workId:'split-work',reason:'Ошибка'});
 assert.equal((await readWarehouse(c.db.store,url())).cartons.reduce((n,b)=>n+b.qty,0),0);const h=await readWorkHistory(c.db.store,new URL('https://test/api/work-history?supply=warehouse'));assert.equal(h.items[0].qty,46);assert.equal(h.items[0].canceled,true);assert.equal(c.db.sqlite.prepare('select count(*) n from av2_ritm_work_outbox').get()!.n,1);
});
