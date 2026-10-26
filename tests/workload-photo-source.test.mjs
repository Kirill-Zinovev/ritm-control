import test from 'node:test';
import assert from 'node:assert/strict';
import { assignWorkloadDetails } from '../worker/printing.js';
import { readWorkloadPhotos } from '../agent/adapters.js';
test('catalog XEROX plus shared source photo is resolved for the correct store only',()=>{
 const catalog={OZON:[['Артикул','Артикул','','','','','','','','','','','','','Станок'],['KS0006.A8368(OZ)','KS0006.A8368','','','','','','','','','','','','','XEROX']]};
 const orders=[{sheetName:'OZON Тест',article:'KS0006.A8368',shop:'1'},{sheetName:'OZON Тест',article:'KS0006.A8368',shop:'2'},{sheetName:'WB Тест',article:'KS0006.A8368',shop:'1'}];
 assignWorkloadDetails(orders,catalog,[['KS0006.A8368',1,'','https://example.test/photo.webp']]);
 assert.equal(orders[0].machine,'XEROX');assert.equal(orders[0].photoUrl,'https://example.test/photo.webp');assert.ok(!orders[1].photoUrl);assert.equal(orders[2].photoUrl,undefined);
});
test('conflicting or unsafe photo links remain unassigned',()=>{
 const orders=[{sheetName:'WB Тест',article:'SKU',shop:'1'}];
 assignWorkloadDetails(orders,{WB:[['Артикул','Вид станка по умолчанию'],['SKU','XEROX']]},[['SKU','1','','https://example.test/a'],['SKU','1','','https://example.test/b'],['SKU','1','','javascript:alert(1)']]);assert.ok(!orders[0].photoUrl);
});
test('photo reader reads only selected document and exact source range',async()=>{
 const id='SYNTHETIC_PHOTOS_000000000';let requests=0;
 const reader={request:async(url,options)=>{requests++;assert.equal(options.method,'GET');assert.deepEqual(url.searchParams.getAll('ranges'),["'Фото'!A:D"]);return Response.json({spreadsheetId:id,valueRanges:[{range:"'Фото'!A1:D100",values:[['Артикул','Магазин','Ссылки на фото','ссылка'],['SKU','1','','https://example.test/a']]}]});}};
 assert.equal((await readWorkloadPhotos(reader,id)).length,1);assert.equal(requests,1);
 await assert.rejects(readWorkloadPhotos({request:async()=>Response.json({spreadsheetId:'wrong',valueRanges:[]})},id),/invalid/);
});

