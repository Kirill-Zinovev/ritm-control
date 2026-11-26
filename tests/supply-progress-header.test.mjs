import test from 'node:test';import assert from 'node:assert/strict';import {boxSheetCountHeaderRepairs,supplyProgressHeaderRequests,supplyProgressFormulaRepairs} from '../agent/supplyProgressHeader.js';
import {BOX_SHEET_REPORT_LABEL} from '../agent/boxSheetReport.js';
const sheet=(box)=>{const rows=Array.from({length:4},()=>({values:Array.from({length:35},()=>({}))}));rows[0].values[29]={userEnteredValue:{stringValue:'UID'}};for(const [i,h]of [[3,'Станок'],[4,'Артикул'],[6,'Кол-во листов'],[13,'Кратность'],[15,'Кол-во'],[19,'Прогресс печати'],[20,'Прогресс порезки'],[27,'Напечатано годных, листы'],[28,'Порезано годных, листы']])rows[3].values[i]={userEnteredValue:{stringValue:h}};return {properties:{sheetId:7,title:'OZON Test',gridProperties:{rowCount:100,columnCount:35}},data:[{rowData:rows}]};};
test('header writes only first three rows and preserves UID column',()=>{for(const box of [true,false]){const requests=supplyProgressHeaderRequests(sheet(box),{box});for(const r of requests){if(r.updateCells)assert.ok(r.updateCells.start.rowIndex<3);if(r.repeatCell)assert.ok(r.repeatCell.range.endRowIndex<=3&&r.repeatCell.range.endColumnIndex<=29);if(r.mergeCells)assert.ok(r.mergeCells.range.endColumnIndex<=29);}assert.equal(requests.filter(r=>r.mergeCells).length,box?7:5);}});
test('box converts only Xerox counters to pieces, roll parses numeric and percentage facts',()=>{const formulas=box=>supplyProgressHeaderRequests(sheet(box),{box}).flatMap(r=>r.updateCells?.rows[0].values[0].userEnteredValue?.formulaValue ?? []).join('\n');assert.match(formulas(true),/N5:N\/G5:G/);assert.match(formulas(true),/xerox/);assert.match(formulas(false),/REGEXEXTRACT/);assert.match(formulas(false),/ISNUMBER/);assert.match(formulas(true),/SPARKLINE/);});
test('unknown quantity header blocks changes',()=>{const s=sheet(true);s.data[0].rowData[3].values[15]={};assert.throws(()=>supplyProgressHeaderRequests(s,{box:true}),/Колонка|колонка/);});

test('new Box supply has a blank manual count with integer validation', () => {
  const requests = supplyProgressHeaderRequests(sheet(true), { box: true, newSupply: true });
  const slot = requests.find(r => r.setDataValidation).setDataValidation;
  assert.deepEqual(slot.range, {sheetId:7, startRowIndex:2, endRowIndex:3, startColumnIndex:12, endColumnIndex:14});
  assert.equal(slot.rule.strict, true);
  assert.match(slot.rule.condition.values[0].userEnteredValue, /\$M\$3>=0;\$M\$3=INT\(\$M\$3\)/);
  const writes = requests.flatMap(r => r.updateCells ? [r.updateCells] : []);
  assert.equal(writes.find(w => w.start.columnIndex === 12 && w.start.rowIndex === 1)
    .rows[0].values[0].userEnteredValue.stringValue, BOX_SHEET_REPORT_LABEL);
  assert.equal(writes.find(w => w.start.columnIndex === 12 && w.start.rowIndex === 2).fields, 'note');
  assert.equal(supplyProgressHeaderRequests(sheet(false)).some(r => r.setDataValidation), false);
});

test('existing Box header splits only print merges and preserves an already entered count', () => {
  const supply = sheet(true), rows = supply.data[0].rowData;
  const formula = value => ({userEnteredValue:{formulaValue:value}});
  rows[1].values[0] = formula('="ПЕЧАТЬ"');
  rows[1].values[14] = formula('="ПОРЕЗКА"');
  rows[2].values[0] = formula('=SPARKLINE(1)');
  supply.merges = [1,2].map(row => ({
    sheetId:7, startRowIndex:row, endRowIndex:row+1, endColumnIndex:14,
  }));

  rows[2].values[12] = {userEnteredValue:{numberValue:825}};
  assert.throws(() => boxSheetCountHeaderRepairs(supply), /Не подтверждено/);
  rows[2].values[12] = {};
  const fixes = boxSheetCountHeaderRepairs(supply);
  assert.deepEqual(fixes.flatMap(r => r.unmergeCells ? [r.unmergeCells.range] : []), supply.merges);
  const writes = fixes.flatMap(r => r.updateCells ? [r.updateCells.start] : []);
  assert.deepEqual(writes.map(w => [w.rowIndex, w.columnIndex]), [[1,12],[2,12]]);
  assert.deepEqual(rows[1].values[0], formula('="ПЕЧАТЬ"'));
  assert.deepEqual(rows[1].values[14], formula('="ПОРЕЗКА"'));

  rows[1].values[12] = {userEnteredValue:{stringValue:BOX_SHEET_REPORT_LABEL}};
  rows[2].values[12] = {userEnteredValue:{numberValue:825}};
  assert.deepEqual(boxSheetCountHeaderRepairs(supply), []);
  assert.equal(rows[2].values[12].userEnteredValue.numberValue, 825);
});
test('new legacy box preserves explicitly configured service header column',()=>{const requests=supplyProgressHeaderRequests(sheet(true),{box:true,newSupply:true,uidColumn:28});for(const r of requests){if(r.repeatCell)assert.ok(r.repeatCell.range.endColumnIndex<=28);if(r.mergeCells)assert.ok(r.mergeCells.range.endColumnIndex<=28);}});
test('urgent shipment title appears in the top row on both printing sheets',()=>{for(const box of [true,false]){const requests=supplyProgressHeaderRequests(sheet(box),{box,newSupply:true,name:'OZON Москва 🔥'});assert.ok(requests.some(r=>r.updateCells?.start.rowIndex===0 && r.updateCells?.rows[0].values[0].userEnteredValue?.stringValue==='OZON Москва 🔥'));}});


test('progress ranges include appended rows beyond the former last row',()=>{for(const box of [true,false]){const text=JSON.stringify(supplyProgressHeaderRequests(sheet(box),{box}));assert.match(text,/P5:P/);assert.doesNotMatch(text,/[A-Z]+5:[A-Z]+100/);}});
test('existing banner repair touches only four actual formula anchors and preserves nonstandard merge boundaries',()=>{const s=sheet(false);for(const [col,label]of [[0,'ПЕЧАТЬ'],[16,'ПОРЕЗКА']])for(const row of [1,2])s.data[0].rowData[row].values[col]={formattedValue:row===1?label+' 100%':'',userEnteredValue:{formulaValue:'=SUM(P5:P100)/SUM($E$5:$E$100)'}};const repairs=supplyProgressFormulaRepairs(s);assert.equal(repairs.length,4);assert.deepEqual(repairs.map(r=>[r.updateCells.start.rowIndex,r.updateCells.start.columnIndex]),[[1,0],[2,0],[1,16],[2,16]]);assert.ok(repairs.every(r=>r.updateCells.fields==='userEnteredValue'));assert.ok(repairs.every(r=>r.updateCells.rows[0].values[0].userEnteredValue.formulaValue==='=SUM(P5:P)/SUM($E$5:$E)'));assert.equal(supplyProgressFormulaRepairs({...s,data:[{rowData:[]}]}).length,0);});
