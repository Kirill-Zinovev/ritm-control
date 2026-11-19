import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseWarehouseNumbers, parseWarehouseWorkbook, matchWarehouseNumbers } from '../src/warehouseImport.js';
import { warehouseCartonFingerprint } from '../src/warehouseFingerprint.js';

const boxes = [
  { id:'id-1', number:'1мос217', shipmentId:'s1', status:'closed', quantity:30, boxType:'M', contents:[{ article:'A', positionId:'p1', shipmentId:'s1', quantity:30 }] },
  { id:'id-2', number:'1мос218', shipmentId:'s1', status:'open', quantity:5, boxType:'M', contents:[] },
  { id:'id-3', number:'1мос219', shipmentId:'s1', status:'closed', dispatchStatus:'sent', quantity:5, boxType:'M', contents:[] },
];
test('matches exact box numbers and highlights repeats, sent, open and missing', () => {
  const rows = matchWarehouseNumbers(parseWarehouseNumbers(' 1МОС217\n1мос217;1мос218\n1мос219\nнеизвестен'), boxes);
  assert.deepEqual(rows.map(r => r.status), ['ready','duplicate','open','sent','missing']);
  assert.equal(matchWarehouseNumbers(['1мос217'], [...boxes, {...boxes[0],id:'other'}])[0].status, 'ambiguous');
});
test('matches visually identical keyboard layouts but refuses visually ambiguous or unconfirmed cartons', () => {
  const archived = {...boxes[0], id:'archive', number:'2мос19', archivedOrigin:true};
  const [found, duplicate] = matchWarehouseNumbers(['2moc19','2МОС19'], [archived]);
  assert.equal(found.status, 'ready'); assert.equal(found.box.id, 'archive'); assert.equal(found.corrected, true);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(matchWarehouseNumbers(['2мос19'], [archived, {...archived,id:'other',number:'2moc19'}])[0].status, 'ambiguous');
  assert.equal(matchWarehouseNumbers(['2мос19'], [{...archived,dispatchBlocked:true}])[0].status, 'unconfirmed');
  assert.equal(matchWarehouseNumbers(['2мос19'], [{...archived,reserved:true}])[0].status, 'unconfirmed');
  assert.equal(matchWarehouseNumbers(['2мос19'], [{...archived,status:'unknown'}])[0].status, 'unconfirmed');
});
test('reads Excel column by header, preserving box numbers', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Отгрузка');
  sheet.addRow(['Комментарий','Номер короба']); sheet.addRow(['ок','1мос217']); sheet.addRow(['ок','2спб62']);
  const bytes = await workbook.xlsx.writeBuffer();
  assert.deepEqual(await parseWarehouseWorkbook(bytes), ['1мос217','2спб62']);
});
test('rejects Excel formulas and oversized lists', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Sheet');
  sheet.addRow(['Номер короба']); sheet.addRow([{formula:'1+1',result:2}]);
  const bytes = await workbook.xlsx.writeBuffer();
  await assert.rejects(() => parseWarehouseWorkbook(bytes), /формулы/);
  assert.throws(() => parseWarehouseNumbers(Array(501).fill('1мос1').join('\n')), /500/);
});
test('fingerprint detects changed contents but ignores content order', () => {
  const box = boxes[0]; const reordered = {...box,contents:[...box.contents]};
  assert.equal(warehouseCartonFingerprint(box), warehouseCartonFingerprint(reordered));
  assert.notEqual(warehouseCartonFingerprint(box), warehouseCartonFingerprint({...box,contents:[{...box.contents[0],quantity:31}]}));
});
