import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWarehouseSnapshot } from '../worker/warehouseCartons.js';

const carton = { cartonId:'c1', directionId:'d1', 'Направление':'OZON Москва', 'Номер':'1мск1', 'Занято, шт':70, 'Статус':'Закрыт', createdAt:'2026-10-20T10:00:00Z', closedAt:'2026-10-20T11:00:00Z', shipmentId:'s1', 'Тип короба':'M' };
const add = { allocationId:'a1', cartonId:'c1', shipmentId:'s1', directionId:'d1', positionId:'p1', 'Артикул':'ITEM1', 'Количество, шт':100, createdAt:'2026-10-20T10:10:00Z', action:'ADD' };
const remove = { ...add, allocationId:'a2', 'Количество, шт':-30, action:'REMOVE', sourceAllocationId:'a1', createdAt:'2026-10-20T10:20:00Z' };
const catalog = { OZON:[['Артикул','Артикул (oz)','Наименование','Тип короба','Кол-во вида','В коробке','магазин'], ['ITEM1','ITEM1(OZ)','Товар','M',100,'100 M','1']], WB:[] };

test('корректировки уменьшают состав, не удаляя историю', () => {
  const snapshot = buildWarehouseSnapshot([carton], [add, remove], { catalog });
  assert.equal(snapshot.cartons[0].quantity, 70);
  assert.deepEqual(snapshot.cartons[0].history.map(row => row.action), ['add','remove','close']);
  assert.equal(snapshot.cartons[0].status, 'closed');
  assert.equal(snapshot.cartons[0].fillPercent, 70);
  assert.equal(snapshot.cartons[0].ready, true);
});

test('короб без подтверждённого закрытия, с нарушением состава или неизвестным магазином не готов', () => {
  assert.equal(buildWarehouseSnapshot([{...carton, closedAt:''}], [add,remove], {catalog}).cartons[0].ready, false);
  assert.equal(buildWarehouseSnapshot([{...carton,'Занято, шт':71}], [add,remove], {catalog}).cartons[0].ready, false);
  assert.equal(buildWarehouseSnapshot([carton], [add,remove]).cartons[0].ready, false);
  assert.equal(buildWarehouseSnapshot([{...carton,'Статус':'Открыт',closedAt:''}], [add,remove], {catalog}).cartons[0].ready, false);
});

test('дубликаты и неразрешённые корректировки требуют проверки', () => {
  const duplicate = buildWarehouseSnapshot([carton, carton], [add,remove], {catalog});
  assert.equal(duplicate.cartons[0].ready, false);
  const missing = buildWarehouseSnapshot([carton], [{...remove,sourceAllocationId:'missing'}], {catalog});
  assert.equal(missing.cartons[0].ready, false);
  const orphan = buildWarehouseSnapshot([carton], [add,remove,{...add,allocationId:'orphan',cartonId:'other'}], {catalog});
  assert.equal(orphan.cartons[0].ready, false);
});
