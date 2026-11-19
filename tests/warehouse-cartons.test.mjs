import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWarehouseSnapshot } from '../worker/warehouseCartons.js';
import { activeWarehouseShipmentIds, activeWarehouseShipmentInfo } from '../worker/cloud/warehouse.js';

const carton = { cartonId:'c1', directionId:'d1', 'Направление':'OZON Москва', 'Номер':'1мск1', 'Занято, шт':70, 'Статус':'Закрыт', createdAt:'2026-10-20T10:00:00Z', closedAt:'2026-10-20T11:00:00Z', shipmentId:'s1', 'Тип короба':'M' };
const add = { allocationId:'a1', cartonId:'c1', shipmentId:'s1', directionId:'d1', positionId:'p1', 'Артикул':'ITEM1', 'Количество, шт':100, createdAt:'2026-10-20T10:10:00Z', action:'ADD' };
const remove = { ...add, allocationId:'a2', 'Количество, шт':-30, action:'REMOVE', sourceAllocationId:'a1', createdAt:'2026-10-20T10:20:00Z' };
const catalog = { OZON:[['Артикул','Артикул (oz)','Наименование','Тип короба','Кол-во вида','В коробке','магазин'], ['ITEM1','ITEM1(OZ)','Товар','M',100,'100 M','1']], WB:[] };

test('manual finished goods appear in warehouse stock without a production supply or catalog record',()=>{
  const stock={...carton,cartonId:'carton-stock-manual','Номер':'1скл1','Занято, шт':17,'Тип короба':'Склад'};
  const entry={...add,allocationId:'stock-manual-test',eventId:'MANUAL_STOCK_test',cartonId:stock.cartonId,shipmentId:'RITM-WAREHOUSE-MANUAL-OZON-1',directionId:'WAREHOUSE',positionId:'RITM-WAREHOUSE-MANUAL-OZON-1|UNKNOWN','Артикул':'UNKNOWN','Количество, шт':17,'Сотрудник':'Соня'};
  const result=buildWarehouseSnapshot([stock],[entry],{activeShipmentIds:new Set(['s1'])});
  assert.equal(result.cartons.length,0);assert.equal(result.stockCartons.length,1);
  const box=result.stockCartons[0];assert.equal(box.quantity,17);assert.equal(box.contents[0].article,'UNKNOWN');assert.equal(box.contents[0].store,'1');assert.equal(box.history[0].employee,'Соня');assert.deepEqual(box.issues,[]);
});
test('manual receipt origin cannot bypass marketplace, store or source identity checks',()=>{
  const stock={...carton,cartonId:'carton-stock-manual','Номер':'1скл1','Занято, шт':17};
  const entry={...add,allocationId:'stock-manual-test',eventId:'MANUAL_STOCK_test',cartonId:stock.cartonId,shipmentId:'RITM-WAREHOUSE-MANUAL-WB-2',directionId:'WAREHOUSE',positionId:'RITM-WAREHOUSE-MANUAL-WB-2|ITEM1','Количество, шт':17};
  const box=buildWarehouseSnapshot([stock],[entry],{catalog}).stockCartons[0];assert.ok(box.issues.includes('Не подтверждена поставка товара в общем коробе'));
});

test('складской излишек не попадает в отгрузочные короба и ошибки состава', () => {
  const stockCarton = { ...carton, cartonId:'carton-stock-1', 'Номер':'1скл1', source:'RITM_ASSEMBLY_STOCK' };
  const stockAdd = { ...add, cartonId:'carton-stock-1', allocationId:'stock-a1' };
  const result = buildWarehouseSnapshot([carton, stockCarton], [add, remove, stockAdd], { catalog, activeShipmentIds:new Set(['s1']) });
  assert.deepEqual(result.cartons.map(item => item.id), ['c1']);
  assert.deepEqual(result.issues, []);
});

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

test('короба удалённой поставки скрываются без удаления записей из журнала', () => {
  const removedBox = { ...carton, cartonId:'c2', shipmentId:'deleted', 'Направление':'OZON индивидуалка', 'Номер':'1инд1' };
  const removedAdd = { ...add, allocationId:'a3', cartonId:'c2', shipmentId:'deleted', 'Артикул':'OLD' };
  const snapshot = buildWarehouseSnapshot([carton, removedBox], [add, remove, removedAdd], { catalog, activeShipmentIds:new Set(['s1']) });
  assert.deepEqual(snapshot.cartons.map((row) => row.id), ['c1']);
  assert.equal(snapshot.cartons[0].quantity, 70);
  assert.deepEqual(snapshot.issues, []);
});

test('archived cartons remain separate from active totals and keep their verified composition', () => {
  const archived = { ...carton, cartonId:'old', shipmentId:'old-supply', 'Номер':'2мос19', 'Занято, шт':30 };
  const entry = { ...add, cartonId:'old', allocationId:'old-a', shipmentId:'old-supply', 'Количество, шт':30 };
  const cancelled = { ...archived, cartonId:'cancelled', 'Номер':'2мос20', 'Статус':'Отменён' };
  const snapshot = buildWarehouseSnapshot([carton, archived, cancelled], [add,remove,entry], { catalog, activeShipmentIds:new Set(['s1']), includeArchived:true });
  assert.deepEqual(snapshot.cartons.map(box=>box.id), ['c1']);
  assert.deepEqual(snapshot.archivedCartons.map(box=>box.id), ['old']);
  assert.equal(snapshot.archivedCartons[0].quantity, 30);
  assert.equal(snapshot.warehouseArchiveVersion, 1);
});

test('общий короб учитывается один раз и хранит отдельную поставку каждого товара', () => {
  const other = { ...add, allocationId:'a3', shipmentId:'s2', positionId:'p2', 'Количество, шт':20 };
  const snapshot = buildWarehouseSnapshot([{...carton,'Занято, шт':90}], [add,remove,other], {catalog,activeShipmentIds:new Set(['s1','s2']),shipmentInfo:{s2:{name:'OZON СПБ',directionId:'d1'}}});
  assert.equal(snapshot.cartons.length, 1);
  assert.equal(snapshot.cartons[0].quantity, 90);
  assert.ok(Math.abs(snapshot.cartons[0].fillPercent - 90) < 1e-9);
  assert.equal(snapshot.cartons[0].ready, true);
  assert.deepEqual(snapshot.cartons[0].contents.map(row => [row.shipmentId,row.quantity]), [['s1',70],['s2',20]]);
  const unconfirmed = buildWarehouseSnapshot([{...carton,'Занято, шт':90}], [add,remove,other], {catalog,activeShipmentIds:new Set(['s1','s2'])});
  assert.equal(unconfirmed.cartons[0].ready, false);
});

test('нормы общего короба берутся отдельно из OZON и WB даже для одинакового артикула', () => {
  const other = { ...add, allocationId:'wb-a', shipmentId:'wb1', positionId:'wb-p1', 'Количество, шт':10 };
  const catalogBoth = { ...catalog, WB:[['Артикул','Наименование','Тип короба','Кол-во вида','В коробке','магазин'], ['ITEM1','Товар WB','M',50,'50 M','1']] };
  const result = buildWarehouseSnapshot([{...carton,'Занято, шт':80}], [add,remove,other], {catalog:catalogBoth,activeShipmentIds:new Set(['s1','wb1']),shipmentInfo:{wb1:{name:'WB СПБ',directionId:'d1'}}}).cartons[0];
  assert.equal(result.quantity, 80);
  assert.ok(Math.abs(result.fillPercent - 90) < 1e-9);
  assert.equal(result.ready, true);
});

test('список действующих складских поставок строится по текущим производственным листам', () => {
  const ids = activeWarehouseShipmentIds({ ok:true, sheets:[
    { sourceId:'roll-printing', sheetId:119710351 },
    { sourceId:'box-printing', sheetId:202, assemblyShipmentId:'RITM-SUPPLY-11111111-1111-4111-8111-111111111111' },
    { sourceId:'seasonal-printing', sheetId:17 },
  ] });
  assert.deepEqual([...ids].sort(), ['RITM-ROLL-119710351', 'RITM-SUPPLY-11111111-1111-4111-8111-111111111111'].sort());
  assert.equal(activeWarehouseShipmentIds({ ok:false, sheets:[] }), null);
  assert.equal(activeWarehouseShipmentIds({ ok:true, sheets:[{ sourceId:'box-printing', sheetId:0 }] }), null);
});

test('данные поставок для общих коробов берутся только из подтверждённого списка', () => {
  const source = { ok:true, sheets:[{sourceId:'roll-printing',sheetId:123,name:'OZON СПБ'}] };
  assert.deepEqual({...activeWarehouseShipmentInfo(source)}, {'RITM-ROLL-123':{name:'OZON СПБ',directionId:'ROLL'}});
  assert.equal(activeWarehouseShipmentInfo({ok:false,sheets:[]}),null);
  assert.equal(activeWarehouseShipmentInfo({ok:true,sheets:[{sourceId:'roll-printing',sheetId:123}]}),null);
});

test('warehouse surplus is visible separately with original sender/time while dispatch totals stay unchanged',()=>{
  const stock={...carton,cartonId:'carton-stock-1','Номер':'1скл1'};
  const entry={...add,cartonId:stock.cartonId,'Сотрудник':'Арина',employeeId:'emp-009'};
  const result=buildWarehouseSnapshot([carton,stock],[add,remove,entry],{catalog});
  assert.equal(result.cartons.length,1); assert.equal(result.stockCartons.length,1);
  assert.equal(result.stockCartons[0].quantity,100);
  assert.equal(result.stockCartons[0].history[0].employee,'Арина');
  assert.equal(result.stockCartons[0].history[0].createdAt,entry.createdAt);
  const legacy=buildWarehouseSnapshot([stock],[{...entry,'Сотрудник':''}],{catalog});
  assert.equal(legacy.stockCartons[0].history[0].employee,null);
});
