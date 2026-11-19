import test from "node:test";
import assert from "node:assert/strict";
import {openDatabase} from "../server/local-db";
import {bootstrap} from "./fixtures";
import {readWarehouse} from "../server/warehouse";
import {api} from "../server/api";
import {warehouseWorkbook} from "../src/exports/excel";
import {positionCatalogJoin,effectiveCatalogData} from "../server/catalog-store";

test("warehouse manager filters and complete Excel include open/closed reserve cartons and more than 30 items without changing stock",async t=>{
 const db=await openDatabase();t.after(()=>db.sqlite.close());const f=await bootstrap(db),at=new Date().toISOString();
 for(const [id,label,market,shop,state] of [['a','1скл1','OZON','1','open'],['b','2скл1','OZON','2','closed'],['c','1скл2','WB','1','open']]){
  db.sqlite.prepare('insert into av2_warehouse_cartons(id,label,market,store,state,created_at) values(?,?,?,?,?,?)').run(id,label,market,shop,state,at);
 }
 for(let i=0;i<32;i++)db.sqlite.prepare('insert into av2_warehouse_receipts(id,carton_id,sku,name,search,qty,employee_id,employee,supply,comment,actor,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)').run('r'+i,'a','SKU'+i,'Товар '+i,'SKU'+i,2,f.employee.id,f.employee.name,'На склад','','test',at);
 const read=(q='')=>readWarehouse(db.store,new URL('https://local/api/warehouse'+q));
 assert.equal((await read()).total,3);
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
