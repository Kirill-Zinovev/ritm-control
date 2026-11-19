import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {accountWorkbook,exportSnapshot,templateWorkbook} from '../src/warehouseExcel.ts';
const value={id:'00000000-0000-4000-8000-000000000001',createdAt:'2026-11-14T06:00:00Z',cartons:[{id:'av2:one',number:'1мос1',shipmentId:'RITM-ROLL-10',shipment:'OZON Москва',market:'OZON',store:'1',quantity:12,closedAt:'2026-11-14T06:00:00Z',contents:[{article:'000123',productName:'Товар',barcode:'0012345678901',quantity:12,positionId:'RITM-ROLL-10|uid:one|000123',shipmentId:'RITM-ROLL-10'}]}]};
test('Excel РИТМ сохраняет короб, ведущие нули и точный источник; шаблон не затирает заполненные ячейки',async()=>{
 const snapshot=exportSnapshot(value),book=accountWorkbook(snapshot),opened=new ExcelJS.Workbook();await opened.xlsx.load(await book.xlsx.writeBuffer());assert.equal(opened.worksheets.length,3);assert.equal(opened.getWorksheet('Состав').getCell('E2').value,'000123');assert.equal(opened.getWorksheet('Состав').getCell('G2').value,'0012345678901');assert.equal(opened.getWorksheet('Состав').getCell('H2').value,12);
 const template=new ExcelJS.Workbook(),sheet=template.addWorksheet('Шаблон');sheet.addRow(['Короб','Штрихкод','Количество']);const buffer=await template.xlsx.writeBuffer();const filled=await templateWorkbook(buffer,'Шаблон',2,{carton:1,barcode:2,qty:3},snapshot);assert.equal(filled.getWorksheet('Шаблон').getCell('B2').value,'0012345678901');assert.equal(filled.getWorksheet('Шаблон').getCell('C2').value,12);
 sheet.getCell('A2').value='Занято';await assert.rejects(templateWorkbook(await template.xlsx.writeBuffer(),'Шаблон',2,{carton:1,barcode:2,qty:3},snapshot),/есть значение/);
 const missing=structuredClone(value);missing.cartons[0].contents[0].barcode='';await assert.rejects(templateWorkbook(buffer,'Шаблон',2,{carton:1,barcode:2,qty:3},exportSnapshot(missing)),/не подтверждено/);
});
