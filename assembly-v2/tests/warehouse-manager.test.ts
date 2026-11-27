import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {openDatabase} from "../server/local-db";
import {bootstrap} from "./fixtures";
import {readWarehouse} from "../server/warehouse";
import {api} from "../server/api";
import {accountWorkbook, warehouseWorkbook} from "../src/exports/excel";
import {positionCatalogJoin,effectiveCatalogData} from "../server/catalog-store";
import type { WarehouseNumberPreview, WarehousePage } from "../shared/warehouse";
import type { Carton, Snapshot } from "../shared/model";

test("warehouse manager filters and complete Excel include open/closed reserve cartons and more than 30 items without changing stock",async t=>{
 const db=await openDatabase();t.after(()=>db.sqlite.close());const f=await bootstrap(db),at=new Date().toISOString();
 for(const [id,label,market,shop,state] of [['a','1скл1','OZON','1','open'],['b','2скл1','OZON','2','closed'],['c','1скл2','WB','1','open']]){
  db.sqlite.prepare('insert into av2_warehouse_cartons(id,label,market,store,state,created_at) values(?,?,?,?,?,?)').run(id,label,market,shop,state,at);
 }
 for(let i=0;i<32;i++)db.sqlite.prepare('insert into av2_warehouse_receipts(id,carton_id,sku,name,search,qty,employee_id,employee,supply,comment,actor,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)').run('r'+i,'a','SKU'+i,'Товар '+i,'SKU'+i,2,f.employee.id,f.employee.name,'На склад','','test',at);
 db.sqlite.prepare("update av2_warehouse_receipts set voided_at=? where id='r0'").run(at);
 db.sqlite.prepare('insert into av2_warehouse_receipts(id,carton_id,sku,name,search,qty,employee_id,employee,supply,comment,actor,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)').run('r32','a','SKU32','Товар 32','SKU32',2,f.employee.id,f.employee.name,'На склад','','test',at);
 const read=(q='')=>readWarehouse(db.store,new URL('https://local/api/warehouse'+q));
 assert.equal((await read()).total,3);
 assert.deepEqual((await read('?summary=1')).summary,{qty:64,openCount:2});
 assert.deepEqual((await read('?summary=1&market=OZON&store=1&q=1СКЛ1')).summary,{qty:64,openCount:1});
 assert.deepEqual((await read('?summary=1&state=closed')).summary,{qty:0,openCount:0});
 assert.deepEqual((await read('?summary=1&page=1')).summary,{qty:64,openCount:2});
 const summaryUrl='https://local/api/warehouse?summary=1';
 assert.deepEqual((await (await api(new Request(summaryUrl),db,'manager','manager')).json()).summary,{qty:64,openCount:2});
 assert.equal((await (await api(new Request(summaryUrl),db,'collector','collector')).json()).summary,undefined);
 assert.equal((await read('?market=OZON&store=1&state=open')).cartons[0].label,'1скл1');
 assert.equal((await read('?state=closed')).cartons[0].label,'2скл1');
 assert.equal((await read('?export=all')).cartons.length,3);
 const filteredExport=await read('?export=all&market=OZON&store=1&state=open');
 assert.equal(filteredExport.cartons.length,1);
 assert.equal(filteredExport.cartons[0].items.length,32);
 assert.equal((await read('?q=1СКЛ1')).cartons[0].items.length,30);
 const before=db.sqlite.prepare('select * from av2_warehouse_receipts').all();
 const url='https://local/api/warehouse?export='+encodeURIComponent(JSON.stringify(['a','b']));
 assert.equal((await api(new Request(url),db,'collector','collector')).status,403);
 const result=await read('?export='+encodeURIComponent(JSON.stringify(['a','b'])));
 assert.equal(result.cartons.find(b=>b.id==='a')!.items.length,32);
 const book=warehouseWorkbook(result.cartons,at);
 assert.equal(book.getWorksheet('Состав')!.rowCount,33);
 assert.equal(book.getWorksheet('Складские короба')!.rowCount,3);
 assert.deepEqual(db.sqlite.prepare('select * from av2_warehouse_receipts').all(),before);
 await assert.rejects(read('?export='+encodeURIComponent('["missing"]')),/не найдена/);
 assert.throws(()=>warehouseWorkbook([{...result.cartons.find(b=>b.id==='a')!,items:[]}],at),/не полностью/);
});

test("список складских коробов находит точные номера и выгружает реальный состав за пределами одной страницы", async t => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const { employee } = await bootstrap(db);
  const at = new Date().toISOString();
  const addBox = db.sqlite.prepare("insert into av2_warehouse_cartons(id,label,market,store,state,created_at) values(?,?,?,?,?,?)");
  addBox.run("a-open", "1скл1", "OZON", "1", "open", at);
  addBox.run("b-closed", "2скл6", "WB", "2", "closed", at);
  addBox.run("c-prefix", "1скл10", "OZON", "1", "open", at);
  addBox.run("d-duplicate", "2скл40", "WB", "2", "open", at);
  addBox.run("e-duplicate", "2СКЛ40", "OZON", "2", "closed", at);
  addBox.run("f-other", "3скл5", "OZON", "3", "closed", at);
  const addReceipt = db.sqlite.prepare(`insert into av2_warehouse_receipts
    (id,carton_id,sku,name,search,qty,employee_id,employee,supply,comment,actor,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)`);
  addReceipt.run("r1", "a-open", "0000123", "Первый товар", "0000123", 42, employee.id, employee.name, "На склад", "", "test", at);
  addReceipt.run("r2", "b-closed", "DEMO(OZ)", "Второй товар", "DEMO", 11, employee.id, employee.name, "На склад", "", "test", at);
  const revision = await db.revision();

  const lookup = (input: string) => new Request("https://local/api/warehouse/number-preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ numbers: input }),
  });
  const numbers = " 2СКЛ6\n1скл1, 1СКЛ1; 1скл 2скл40 9скл9";
  assert.equal((await api(lookup(numbers), db, "collector", "collector")).status, 403);
  const matched = await api(lookup(numbers), db, "manager", "manager");
  assert.equal(matched.status, 200);
  const preview = await matched.json() as WarehouseNumberPreview;
  assert.deepEqual(preview.cartons.map(box => [box.label, box.market, box.state]), [
    ["2скл6", "WB", "closed"], ["1скл1", "OZON", "open"],
  ]);
  assert.deepEqual(preview.issues, [
    { label: "1скл", reason: "missing" },
    { label: "2скл40", reason: "ambiguous" },
    { label: "9скл9", reason: "missing" },
  ]);
  const selection = new URLSearchParams({ export: JSON.stringify(preview.cartons.map(box => box.id)) });
  const response = await api(new Request(`https://local/api/warehouse?${selection}`), db, "manager", "manager");
  assert.equal(response.status, 200);
  const exported = await response.json() as WarehousePage;
  const bytes = await warehouseWorkbook(exported.cartons, at).xlsx.writeBuffer();
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(bytes);
  const composition: unknown[][] = [];
  reopened.getWorksheet("Состав")!.eachRow((row, index) => {
    if (index > 1) composition.push([row.getCell("A").value, row.getCell("D").value, row.getCell("F").value]);
  });
  assert.deepEqual(composition.sort(), [["1скл1", "0000123", 42], ["2скл6", "DEMO(OZ)", 11]]);
  assert.equal(await db.revision(), revision);
});

test("indexed catalog lookup matches resolved catalog for imported, managed, reference and absent cards",async t=>{
 const db=await openDatabase();t.after(()=>db.sqlite.close());const at=new Date().toISOString();
 db.sqlite.prepare('insert into av2_catalog_imports values(?,?,?,?,?)').run('i','{}','active',at,'test');
 const data=(sku:string,name:string)=>JSON.stringify({sku,name,kind:'Вид',aliases:[sku]});
 db.sqlite.prepare('insert into av2_catalog_entries values(?,?,?,?,?,?,?,?,?,?)').run('base','i','base','OZON','1','BASE','BASE','',0,data('BASE','Исходник'));
 db.sqlite.prepare('insert into av2_catalog_references values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ref','i','ref','base','OZON','1','REF','REF','',0,data('REF','Дополнение'),'evidence','test',at);
 for(const [id,sku] of [['base','BASE'],['managed','MANAGED']])db.sqlite.prepare('insert into av2_catalog_products values(?,?,?,?,?,?,?,?,?,?,?)').run(id,'OZON','1',sku,sku,'',0,data(sku,'Правка'),1,'test',at);
 for(const entryId of ['base','managed','ref','missing']){
  const expected=await db.store.all<{data:string}>(`select ${effectiveCatalogData()} data from av2_resolved_catalog_entries e where import_id=? and entry_id=?`,['i',entryId]);
  const actual=await db.store.all<{data:string|null}>(`select pc.value data from (select ? catalog_import_id,? catalog_entry_id) p ${positionCatalogJoin()}`,['i',entryId]);
  assert.deepEqual(actual[0].data?JSON.parse(actual[0].data):null,expected[0]?.data?JSON.parse(expected[0].data):null,entryId);
 }
});

test("готовые к отгрузке короба выгружаются по номерам с полным составом, статус проверяется повторно", async t => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const { cmd, a, b, employee, supply } = await bootstrap(db);
  const snapshot = async () => await db.snapshot(supply.id) as Snapshot;
  for (const position of [a, b]) {
    await cmd("work.save", {
      positionId: position.id, employeeId: employee.id, operation: "packing", qty: 80,
    });
  }

  async function makeCarton(qty: number, close = true, extraQty = 0) {
    const { cartonId } = await cmd("allocation.place", { positionId: a.id, qty, newCarton: true });
    if (extraQty) await cmd("allocation.place", { positionId: b.id, qty: extraQty, cartonId });
    const box = (await snapshot()).cartons.find(({ id }) => id === cartonId)!;
    if (close) {
      await cmd("carton.close", {
        cartonId, items: box.items.map(({ id, qty }) => ({ id, qty })).sort((x, y) => x.id.localeCompare(y.id)),
      });
    }
    return box;
  }

  const readyFirst = await makeCarton(9, true, 11);
  const readySecond = await makeCarton(7);
  const open = await makeCarton(1, false);
  const prepared = await makeCarton(2);
  await cmd("dispatch.create", { cartonIds: [prepared.id] });
  const sent = await makeCarton(3);
  const { dispatchId } = await cmd("dispatch.create", { cartonIds: [sent.id] });
  await cmd("dispatch.send", { dispatchId, confirmed: true });
  const duplicate = await makeCarton(4);
  const otherDuplicate = await makeCarton(5);
  db.sqlite.prepare("update av2_cartons set label=? where id=?").run(duplicate.label.toUpperCase(), otherDuplicate.id);
  db.sqlite.prepare("insert into av2_warehouse_cartons(id,label,market,store,state,created_at) values(?,?,?,?,?,?)")
    .run("stock-only", "1скл99", "OZON", "1", "closed", new Date().toISOString());

  type Role = "owner" | "manager" | "collector";
  const call = (path: "number-preview" | "ready-export", body: object, role: Role) =>
    api(new Request(`https://local/api/warehouse/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), db, role, role);
  const numbers = [
    readySecond.label.toUpperCase(), readyFirst.label, readySecond.label,
    open.label, prepared.label, sent.label, duplicate.label, "1скл99", "отсутствует",
  ].join(",\n");
  const before = await snapshot();
  const input = { numbers, scope: "ready" };
  assert.equal((await call("number-preview", input, "collector")).status, 403);
  const lookup = await call("number-preview", input, "manager");
  assert.equal(lookup.status, 200);
  const preview = await lookup.json() as WarehouseNumberPreview;
  assert.deepEqual(preview.cartons.map(box => box.id), [readySecond.id, readyFirst.id]);
  assert.deepEqual(preview.issues.map(({ label, reason }) => [label, reason]), [
    [open.label, "open"], [prepared.label, "prepared"], [sent.label, "sent"],
    [duplicate.label, "ambiguous"], ["1скл99", "missing"], ["отсутствует", "missing"],
  ]);

  const ids = preview.cartons.map(box => box.id);
  assert.equal((await call("ready-export", { ids }, "collector")).status, 403);
  assert.equal((await call("ready-export", { ids: [...ids, open.id] }, "manager")).status, 409);
  const response = await call("ready-export", { ids }, "owner");
  assert.equal(response.status, 200);
  const { cartons } = await response.json() as { cartons: Carton[] };
  assert.deepEqual(cartons.map(({ id, qty, items }) => [id, qty, items.length]), [
    [readySecond.id, 7, 1], [readyFirst.id, 20, 2],
  ]);
  const workbook = accountWorkbook({ createdAt: new Date().toISOString(), payload: { cartons } });
  const persisted = new ExcelJS.Workbook();
  await persisted.xlsx.load(await workbook.xlsx.writeBuffer());
  assert.deepEqual(persisted.worksheets.map(sheet => sheet.name), ["Короба", "Состав", "Сводка"]);
  const boxesSheet = persisted.getWorksheet("Короба")!;
  assert.deepEqual([boxesSheet.getCell("A2").value, boxesSheet.getCell("A3").value], [readySecond.label, readyFirst.label]);
  const rows: unknown[][] = [];
  persisted.getWorksheet("Состав")!.eachRow((row, index) => {
    if (index > 1) rows.push(["A", "E", "G", "H"].map(column => row.getCell(column).value));
  });
  assert.deepEqual(rows.sort(), [
    [readyFirst.label, a.sku, a.barcode, 9],
    [readyFirst.label, b.sku, b.barcode, 11],
    [readySecond.label, a.sku, a.barcode, 7],
  ]);
  assert.deepEqual(await snapshot(), before);

  await cmd("dispatch.create", { cartonIds: [readyFirst.id] });
  assert.equal((await call("ready-export", { ids }, "manager")).status, 409);
});
