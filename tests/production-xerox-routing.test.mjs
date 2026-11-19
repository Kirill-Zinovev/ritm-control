import test from 'node:test';
import assert from 'node:assert/strict';
import {routeSupplyLines,machineDepartment} from '../agent/productionSupplies.js';
import {planStockAddition} from '../agent/stockPlanning.js';
import {prepareDepartmentMove,prepareDepartmentMoveGroup} from '../agent/departmentMovePlan.js';
import {xeroxExtensionIssue} from '../shared/productionRouting.js';

function catalog(machine='2-GO',extension='X') {
  return {WB:[['Артикул','Вид станка по умолчанию'],['CT0001.A7333',machine]],OZON:[['Артикул','Артикул','станок','магазин'],['CT0001.A7333(OZ)','CT0001.A7333',machine,'1']],extensions:[['Артикул','Расширение печати'],['CT0001.A7333',extension]]};
}
const line={article:'CT0001.A7333',quantity:32};

test('contradictory X/roll catalog records are explicit skips in both marketplaces without guessing a replacement',()=>{
  for(const market of ['OZON','WB'])for(const machine of ['2-GO','УФ','УФ БЕЛ.','УФ ДВУСТОРОННИЙ']){
    const source=catalog(machine),before=structuredClone(source),result=routeSupplyLines([line],market,source)[0];
    assert.equal(result.department,null);assert.equal(result.machine,machine);assert.equal(result.extension,'X');assert.match(result.issue,/Xerox.*Бокс/);assert.deepEqual(source,before);
  }
});

test('corrected CT0001.A7333 routes to Xerox/box with the original piece plan and X, including aliases',()=>{
  for(const article of ['CT0001.A7333','ct0001.a7333(OZ)']){
    const result=routeSupplyLines([{...line,article}],'OZON',catalog('XEROX'))[0];
    assert.equal(result.machine,'XEROX');assert.equal(result.department,'box');assert.equal(result.extension,'X');assert.equal(result.quantity,32);assert.equal(result.issue,null);assert.equal(result.store,'1');
  }
});

test('stock preview skips the contradictory record and accepts the corrected box record without creating a second lane',()=>{
  const args={destination:'warehouse',lines:[line],existing:{box:[],roll:[]}};
  const invalid=planStockAddition({...args,catalog:catalog()}).changes[0];assert.equal(invalid.action,'skip');assert.equal(invalid.department,null);
  const valid=planStockAddition({...args,catalog:catalog('XEROX')}).changes[0];assert.equal(valid.action,'insert');assert.equal(valid.department,'box');assert.equal(valid.newQuantity,32);
  const duplicate=planStockAddition({...args,catalog:catalog('XEROX'),existing:{box:[],roll:[{article:line.article,row:5,quantity:32}]}}).changes[0];assert.equal(duplicate.action,'skip');assert.match(duplicate.issue,/другом участке/);
});

test('non-X extensions retain existing roll routing; X is case/whitespace normalized and requires Xerox',()=>{
  for(const extension of ['CBI','UF','D','A3'])assert.equal(routeSupplyLines([line],'OZON',catalog('2-GO',extension))[0].department,'roll');
  assert.equal(routeSupplyLines([line],'OZON',catalog('XEROX',' x '))[0].department,'box');
  assert.equal(xeroxExtensionIssue('box',' xerox ',' x '),null);assert.match(xeroxExtensionIssue('box','DTF','X'),/Xerox/);
});

test('an invalid single transfer fails before reading or writing any production sheet',async()=>{
  await assert.rejects(()=>prepareDepartmentMove({input:{sourceDepartment:'box',machine:'2-GO',extension:'X'},writers:{}}),/Xerox.*Бокс/);
});

test('an invalid bulk transfer identifies the exact item before sheet access',async()=>{
  const first={operationId:'one',uid:'uid-one',article:line.article,quantity:32,shipmentId:'TEST',sourceDepartment:'box',machine:'2-GO',extension:'X'};
  const second={...first,operationId:'two',uid:'uid-two',article:'SECOND'};
  await assert.rejects(()=>prepareDepartmentMoveGroup({input:{...first,items:[first,second]},writers:{}}),error=>error.code==='production_move_conflict'&&error.itemOperationId==='one'&&error.message.includes('Xerox'));
});

test('OZON-only white-UV articles use the existing roll lane without inventing WB catalog data',()=>{
  const source={WB:[['Артикул','Вид станка по умолчанию']],OZON:[['Артикул','Артикул','станок','магазин'],['KT0028.A7387(OZ)','KT0028.A7387','УФ белый','1'],['KT0028.A7387(OZ)','KT0028.A7387','УФ белый','1'],['WT0013.A0214(OZ)','WT0013.A0214','2-GO','1']],extensions:[['Артикул','Расширение печати'],['KT0028.A7387','CPB'],['WT0013.A0214','CBI'],['WT0013.A0214','CBI']]};
  const lines=[{article:'KT0028.A7387',quantity:20},{article:'WT0013.A0214',quantity:30}];
  const result=routeSupplyLines(lines,'OZON',source);
  assert.deepEqual(result.map(row=>[row.article,row.machine,row.department,row.extension,row.issue]),[['KT0028.A7387','УФ белый','roll','CPB',null],['WT0013.A0214','2-GO','roll','CBI',null]]);
  assert.equal(machineDepartment(' уф   белый '),'roll');
  assert.ok(routeSupplyLines(lines,'WB',source).every(row=>row.department===null));
  const stock=planStockAddition({destination:'warehouse',lines,catalog:source,existing:{box:[],roll:[]}});
  assert.ok(stock.changes.every(row=>row.action==='insert'&&row.department==='roll'));
  source.extensions.push(['WT0013.A0214','CPB']);
  const conflict=routeSupplyLines(lines,'OZON',source)[1];
  assert.equal(conflict.department,null);assert.match(conflict.issue,/разные расширения/);
});
