import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/local-db';
import {bootstrap,fixture} from './fixtures';
import {directionCity,directionCities} from '../shared/cities';
import {sameCartonScope} from '../shared/carton-scope';
import {cityKeySql} from '../server/carton-scope-sql';
import {sameScope,type Snapshot,type Market} from '../shared/model';

test('город короба: UI и SQLite одинаково распознают регистр, сокращения и границы; неизвестные города не объединяются',async t=>{
  const db=await openDatabase();t.after(()=>db.sqlite.close());
  const statement=db.sqlite.prepare(`select ${cityKeySql('destination')} city from(select ? destination)`);
  for(const city of directionCities)for(const alias of city.aliases)for(const name of [alias,alias.toLocaleLowerCase('ru-RU'),'OZON ('+alias+') Xerox 1 магазин','WB '+alias+' 17.11.2026']) {
    assert.equal(directionCity(name)?.key,city.key,name);
    assert.equal(statement.get(name)!.city,city.key,name);
  }
  for(const name of ['ЕКБУРГ','НЕМОСКВА','КАЗАНЬ2','Казань и Москва','Неизвестный склад','ПЕКБ','ЕКБЯ']) {
    assert.equal(directionCity(name),null,name);assert.equal(statement.get(name)!.city,null,name);
  }
  const a={market:'OZON' as const,store:'1',destination:'OZON ЕКБ 1й магазин'};
  assert(sameCartonScope(a,{...a,destination:'ozon екатеринбург (xerox 1 магазин)'}));
  assert(!sameScope(a,{...a,destination:'OZON Екатеринбург (xerox 1 магазин)'}),'Shipment/dispatch identity remains exact');
  for(const b of [{...a,market:'WB' as const},{...a,store:'2'},{...a,destination:'OZON Казань'},{...a,destination:'ЕКБ и Москва'}])assert(!sameCartonScope(a,b));
  assert(!sameCartonScope({...a,store:'Не подтверждён'},{...a,store:'Не подтверждён',destination:'OZON Екатеринбург'}));
});

test('ДАЧА и ДАЧА 2 используют один ключ только у WB', async t => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const key = db.sqlite.prepare(`select ${cityKeySql('destination','market')} city from(select ? destination, ? market)`);
  for (const name of ['WB ДАЧА', 'wb  Дача 2🔥', 'ВБ ДАЧА 2 🔥', 'ДАЧА', 'wildberries Дача']) {
    assert.equal(directionCity(name, 'WB')?.key, 'DACHA', name);
    assert.equal(key.get(name, 'WB')?.city, 'DACHA', name);
    assert.equal(key.get(name, 'OZON')?.city, null, name);
  }
  for (const name of ['WB ДАЧА 12', 'WB МОЯ ДАЧА', 'WB ДАЧА 2 27.11.2026']) {
    assert.equal(directionCity(name, 'WB'), null, name);
    assert.equal(key.get(name, 'WB')?.city, null, name);
  }
});

test('готовые короба ДАЧА видны для обеих поставок WB, граница магазина соблюдается при укладке', async t => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  async function supply(externalId: string, title: string, store = '1') {
    await f.cmd('supply.import', {
      ...fixture, externalId, title, destination: title, market: 'WB', store,
      positions: [{ ...fixture.positions[0], externalId: externalId + '|sku', sku: externalId, plan: 100, unitsPerBox: 100 }],
    });
    const roster = await db.snapshot(null) as Snapshot;
    const owner = roster.supplies.find(entry => entry.externalId === externalId)!;
    const state = await db.snapshot(owner.id) as Snapshot;
    return { ...owner, position: state.positions[0] };
  }
  const regular = await supply('D-REGULAR', 'WB ДАЧА');
  const urgent = await supply('D-URGENT', 'WB ДАЧА 2 🔥');
  const otherShop = await supply('D-SHOP2', 'WB ДАЧА', '2');
  const carton = async (supplyId: string) => String((await f.cmd('carton.create', { supplyId })).cartonId);
  const closed = await carton(regular.id);
  const open = await carton(regular.id);
  const shopTwoCarton = await carton(otherShop.id);
  db.sqlite.prepare("update av2_cartons set state='closed' where id=?").run(closed);
  for (const grouped of [true, false]) {
    const snapshot = await db.snapshot(urgent.id, true, grouped) as Snapshot;
    assert.deepEqual(snapshot.cartons.map(box => box.id).sort(), [closed, open].sort());
    assert.ok(snapshot.cartons.every(box => sameCartonScope(box, urgent)));
  }
  assert.ok(!sameCartonScope(urgent, otherShop));
  assert.ok(!sameCartonScope(urgent, { ...regular, market: 'OZON' }));
  const positionId = urgent.position.id;
  await f.cmd('work.save', { positionId, employeeId: f.employee.id, operation: 'packing', qty: 12 });
  await f.cmd('allocation.place', { positionId, qty: 5, cartonId: open });
  const updated = await db.snapshot(urgent.id, true, true) as Snapshot;
  assert.equal(updated.cartons.find(box => box.id === open)?.items[0]?.positionId, positionId);
  await assert.rejects(f.cmd('allocation.place', { positionId, qty: 1, cartonId: shopTwoCarton }), /другой|отличается/);
  db.sqlite.prepare('update av2_supplies set source_active=0 where id=?').run(regular.id);
  assert.deepEqual((await db.snapshot(urgent.id, true, true) as Snapshot).cartons.map(box => box.id).sort(), [closed, open].sort());
});

test('общий короб доступен во всех поставках города: выбор и запись, изоляция магазина и города, SQL-защита и кэф',async t=>{
  const db=await openDatabase();t.after(()=>db.sqlite.close());const f=await bootstrap(db);
  async function supply(externalId:string,title:string,market:Market='OZON',store='1') {
    await f.cmd('supply.import',{...fixture,externalId,title,destination:title,market,store,positions:[{...fixture.positions[0],externalId:externalId+'|sku',sku:externalId,plan:100,unitsPerBox:100}]});
    const s=(await db.snapshot(null)) as Snapshot,owner=s.supplies.find(s=>s.externalId===externalId)!;
    const state=await db.snapshot(owner.id) as Snapshot;
    return {supply:owner,position:state.positions[0]};
  }
  const ekb=await supply('ekb','OZON ЕКБ 1й магазин'),xerox=await supply('xerox','OZON Екатеринбург (xerox 1 магазин)'),dated=await supply('dated','OZON ЕКАТЕРИНБУРГ 17.11.2026 (1 магазин)');
  const kaz=await supply('kaz','OZON Казань 1й магазин'),kazXerox=await supply('kaz-xerox','OZON Казань (xerox 1 магазин)'),otherShop=await supply('other-shop','OZON ЕКБ','OZON','2'),wb=await supply('wb','WB Екатеринбург','WB');
  const create=async(id:string,label:string)=>{const box=String((await f.cmd('carton.create',{supplyId:id})).cartonId);db.sqlite.prepare('update av2_cartons set label=? where id=?').run(label,box);return box;};
  const ekbBox=await create(ekb.supply.id,'1екб8'),kazBox=await create(kaz.supply.id,'1каз10');
  await create(otherShop.supply.id,'2екб7');await create(wb.supply.id,'wbекб8');
  for(const source of [ekb,xerox,dated])for(const grouped of [true,false]) {
    const view=await db.snapshot(source.supply.id,true,grouped) as Snapshot;
    assert.deepEqual(view.cartons.map(b=>b.label),['1екб8']);
    assert(view.cartons.every(b=>sameCartonScope(b,source.supply)));
  }
  assert.deepEqual((await db.snapshot(kazXerox.supply.id,true,true) as Snapshot).cartons.map(b=>b.label),['1каз10']);
  await f.cmd('work.save',{positionId:xerox.position.id,employeeId:f.employee.id,operation:'packing',qty:12});
  const workBefore=db.sqlite.prepare('select * from av2_work').all();
  await f.cmd('allocation.place',{positionId:xerox.position.id,qty:5,cartonId:ekbBox,excessDestination:'box'});
  assert.deepEqual(db.sqlite.prepare('select * from av2_work').all(),workBefore);
  const view=await db.snapshot(ekb.supply.id,true,true) as Snapshot;assert.equal(view.cartons[0].qty,5);assert.equal(view.cartons[0].items[0].supplyId,xerox.supply.id);
  await assert.rejects(f.cmd('allocation.add',{positionId:xerox.position.id,qty:1,cartonId:kazBox}),/другой|отличается/);
  const raw=db.sqlite.prepare("insert into av2_allocations(id,carton_id,position_id,qty,units_per_box,created_at,actor) values(?,?,?,1,100,'now','test')");
  assert.throws(()=>raw.run(crypto.randomUUID(),kazBox,xerox.position.id),/ASSEMBLY_CARTON_SCOPE/);
  assert.throws(()=>raw.run(crypto.randomUUID(),ekbBox,otherShop.position.id),/ASSEMBLY_CARTON_SCOPE/);
  assert.throws(()=>raw.run(crypto.randomUUID(),ekbBox,wb.position.id),/ASSEMBLY_CARTON_SCOPE/);
  // Historical source no longer appears in navigation, but its unshipped physical carton remains available.
  db.sqlite.prepare('update av2_supplies set source_active=0 where id=?').run(ekb.supply.id);
  assert((await db.snapshot(xerox.supply.id,true,true) as Snapshot).cartons.some(b=>b.id===ekbBox));
  db.sqlite.prepare("update av2_cartons set state='closed' where id=?").run(ekbBox);
  assert.throws(()=>raw.run(crypto.randomUUID(),ekbBox,xerox.position.id),/ASSEMBLY_CARTON_UNAVAILABLE/);
});
