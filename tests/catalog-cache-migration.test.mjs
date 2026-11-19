import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogCacheFormula, planCatalogCacheSheet, catalogCacheRequests,catalogCacheGroups,shiftCatalogSkuRow} from '../scripts/lib/catalog-cache-migration.mjs';
const f = (formula, overrides = {}) => catalogCacheFormula({formula, department:'roll', row:973, column:14, header:'Кратность', ...overrides});
test('roll and box multiplicities use confirmed separate source fields, without fabricated defaults', () => {
  assert.match(f('=VLOOKUP(E:E;Cache!A:G;7;0)'), /\$B:\$Q;16;FALSE/);
  assert.match(f('=VLOOKUP(E:E;Cache!B:P;15;0)', {column:13}), /\$B:\$Q;16;FALSE/);
  const box=f('=VLOOKUP(E:E;Cache!B:Q;16;0)', {department:'box'});
  assert.match(box, /'_RITM_МАКЕТЫ'!\$A:\$P;16;FALSE/);assert.match(box, /IF\(\$E973="";"";/);
  assert.ok(!box.includes('IFERROR'));assert.ok(!box.includes('WB'));
  assert.equal(f('=VLOOKUP(E:E;Cache!A:G;7;0)', {department:'box'}), box);
});
test('compact groups preserve gaps and differing formulas; relative references move but literals do not',()=>{
  assert.equal(shiftCatalogSkuRow('=IF(E5="E5";E5;E$5)',2),'=IF(E7="E5";E7;E$5)');
  const plan={sheetId:7,title:'OZON test',changes:[
    {row:5,column:14,before:'=VLOOKUP(E:E;Cache!A:G;7;0)',after:'=IF($E5="";"";E5)'},
    {row:6,column:14,before:'=VLOOKUP(E:E;Cache!A:G;7;0)',after:'=IF($E6="";"";E6)'},
    {row:8,column:14,before:'=VLOOKUP(E:E;Cache!A:G;7;0)',after:'=IF($E8="";"";E8)'},
  ]};
  assert.deepEqual(catalogCacheGroups(plan).map(g=>[g.startRow,g.endRow]),[[5,6],[8,8]]);
});
test('local FBO aliases preserve the rest of a formula, including marketplace fallback', () => {
  const old="=IFERROR(VLOOKUP(E7;'БДО'!B:O;5;0);VLOOKUP(E7;'_RITM_WB_SOURCE'!A:E;2;0))";
  assert.equal(f(old),old.replace("'БДО'!","'Cache FBO'!"));
});
test('availability keeps the explicit ready checkbox and source availability check', () => {
  const result=f('=VLOOKUP(E:E;Cache!A:U;21;0)', {column:3,header:'Наличие макета'});
  assert.match(result, /'_RITM_МАКЕТЫ'!\$A\$2:\$K;11;FALSE/);
  assert.match(result,/Проверить источник макетов/);assert.match(result,/Макет не готов/);
});
test('machine lookup uses the FBO machine field',()=>assert.match(f('=VLOOKUP(E:E;Cache!A:D;4;0)',{column:4,header:'Станок'}), /\$B:\$O;14;FALSE/));
test('unrelated formulas and current cache are unchanged; unexpected schemas stop migration',()=>{
  for(const formula of ['=G973*I973*J973*P973',"=VLOOKUP(E:E;'Cache FBO'!B:Q;16;0)"])assert.equal(f(formula),formula);
  assert.throws(()=>f('=VLOOKUP(E:E;Cache!A:D;4;0)'));
  assert.throws(()=>f('=VLOOKUP(E:E;Cache!A:G;6;0)'));
  assert.throws(()=>f('=INDIRECT("Cache!A1")'));
});
test('migration preserves manual overrides, row offsets, plans and IDs and only writes formula contents',()=>{
  const value=x=>({userEnteredValue:typeof x==='number'?{numberValue:x}:{stringValue:x}});
  const formula={userEnteredValue:{formulaValue:'=VLOOKUP(E:E;Cache!A:G;7;0)'}};
  const sheet={properties:{sheetId:119710351,title:'OZON МОСКВА 10_10'},data:[{startRow:3,startColumn:13,rowData:[{values:[value('Кратность')]}]},{startRow:972,startColumn:13,rowData:[{values:[formula,value(0),value(30)]},{values:[value(15)]}]}]};
  const original=structuredClone(sheet);const plan=planCatalogCacheSheet(sheet,'roll');
  assert.equal(plan.changes.length,1);assert.equal(plan.changes[0].row,973);
  const requests=catalogCacheRequests(plan);assert.equal(requests[0].updateCells.fields,'userEnteredValue');
  assert.ok(requests.every(request=>request.updateCells&&!request.repeatCell&&!request.copyPaste), 'explicit cell writes must include rows hidden by employee filters');
  assert.equal(requests[0].updateCells.start.columnIndex,13);assert.deepEqual(sheet,original);
  assert.match(plan.changes[0].after,/\$E973/);
});
