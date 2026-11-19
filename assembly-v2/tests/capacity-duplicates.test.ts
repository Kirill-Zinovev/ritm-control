import test from 'node:test';
import assert from 'node:assert/strict';
import {duplicateCapacity} from '../shared/catalog';
import type {CatalogRow} from '../shared/catalog';
import {openDatabase} from '../server/local-db';
import {bootstrap} from './fixtures';
const row=(n:string,t='М',text=n ? n+' '+t : ''):CatalogRow=>({sheet:'OZON',row:1,raw:{article:'KT0072.A0094(OZ)',store:'1',boxType:t,unitsPerBoxNumber:n,unitsPerBoxText:text},refs:{}});
test('пустой дубль не отменяет норму, реальные конфликты сохраняются',()=>{
 assert.equal(duplicateCapacity([row('350'),row('','')],'OZON').value,350);
 assert.equal(duplicateCapacity([row('',''),row('350')],'OZON').value,350);
 for(const rows of [[row('350'),row('155')],[row('350'),row('#N/A')],[row('350'),row('','Б')],[row('','')],[row('350','М','155 М')]])assert.equal(duplicateCapacity(rows,'OZON').value,null);
});
test('исправление пересчитывает короб без изменения количеств и кэфов, повтор безопасен',async t=>{
 const db=await openDatabase();t.after(()=>db.sqlite.close());const c=await bootstrap(db);const entry={id:'entry',sku:'TEST',market:'OZON',store:'1',rows:[row('350'),row('','')],unitsPerBox:null,issues:['Вместимость короба требует проверки','Нет фотографии']};
 db.sqlite.prepare("insert into av2_catalog_imports values('cap','{}','active',?,'test')").run(new Date().toISOString());db.sqlite.prepare("update av2_meta set active_catalog_id='cap'").run();
 db.sqlite.prepare("insert into av2_catalog_entries values('e','cap','entry','OZON','1','TEST','TEST','',1,?)").run(JSON.stringify(entry));
 db.sqlite.prepare("update av2_positions set catalog_import_id='cap',catalog_entry_id='entry',units_per_box=null where id=?").run(c.a.id);
 db.sqlite.prepare("insert into av2_cartons(id,label,market,store,destination,state,created_at) values('box','1екб7','OZON','1',?,'open',?)").run(c.supply.destination,new Date().toISOString());
 db.sqlite.prepare("insert into av2_legacy_allocations(id,carton_id,position_id,qty,units_per_box,created_at,actor) values('old','box',?,54,null,?,'test')").run(c.a.id,new Date().toISOString());
 const payload={importId:'cap',reason:'Исправление пустого дубля'};const before=await c.cmd('quality.repairEmptyCapacityDuplicates',payload);assert.equal((before.repaired as unknown[]).length,1);assert.equal(db.sqlite.prepare("select units_per_box n from av2_legacy_allocations").get()!.n,null);
 await c.cmd('quality.repairEmptyCapacityDuplicates',{...payload,apply:true});const second=await c.cmd('quality.repairEmptyCapacityDuplicates',{...payload,apply:true});assert.equal((second.repaired as unknown[]).length,0);
 assert.equal(db.sqlite.prepare("select units_per_box n from av2_legacy_allocations").get()!.n,350);assert.equal(db.sqlite.prepare("select qty from av2_legacy_allocations").get()!.qty,54);assert.equal(db.sqlite.prepare("select count(*) n from av2_work").get()!.n,0);assert.equal(db.sqlite.prepare("select count(*) n from av2_quality_repairs").get()!.n,1);assert.equal(db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox").get()!.n,0);
});
