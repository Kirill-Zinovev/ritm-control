import test from 'node:test';
import assert from 'node:assert/strict';
import { assignWorkloadDetails } from '../worker/printing.js';
import { readWorkloadPhotos } from '../agent/adapters.js';
test('shared source photo is attached by article regardless of store or marketplace catalog',()=>{
 const catalog={OZON:[['Артикул','Артикул','','','','','','','','','','','','','Станок'],['KS0006.A8368(OZ)','KS0006.A8368','','','','','','','','','','','','','XEROX']]};
 const orders=[{sheetName:'OZON Тест',article:'KS0006.A8368',shop:'1'},{sheetName:'OZON Тест',article:'KS0006.A8368',shop:'2'},{sheetName:'WB Тест',article:'KS0006.A8368',shop:'9'}];
 assignWorkloadDetails(orders,catalog,[['KS0006.A8368',1,'','https://example.test/photo.webp']]);
 assert.equal(orders[0].machine,'XEROX');
 assert.deepEqual(orders.map(order=>order.photoUrl),Array(3).fill('https://example.test/photo.webp'));
});
test('shared source photo resolves by article even when marketplace catalog has no matching row',()=>{
 const orders=[{sheetName:'OZON Тест',article:'NS0004.A0024',shop:'1'}];
 assignWorkloadDetails(orders,{OZON:[['Артикул','Станок']]},[['NS0004.A0024','2','','https://example.test/ns0004.webp']]);
 assert.equal(orders[0].photoUrl,'https://example.test/ns0004.webp');
});
test('photo rows verified in the production catalog resolve by SKU even when the store differs',()=>{
 const rows=[
  ['NS0004.A0024','2','','https://basket-43.wbbasket.ru/vol11869/part1186995/1186995810/images/big/1.webp'],
  ['RT0001.A0050','2','','https://basket-45.wbbasket.ru/vol12719/part1271950/1271950023/images/big/1.webp'],
  ['NT0039.A8364','1','','https://basket-41.wbbasket.ru/vol9639/part963956/963956037/images/big/1.webp'],
  ['KS0002.A7854','2','','https://basket-44.wbbasket.ru/vol12530/part1253052/1253052089/images/big/1.webp'],
  ['RT0001.A0057','2','','https://basket-45.wbbasket.ru/vol12727/part1272792/1272792742/images/big/1.webp'],
 ];
 const orders=rows.map(([article],index)=>({sheetName:'OZON Москва',article,shop:index===2?'1':'1'}));
 assignWorkloadDetails(orders,null,rows);
 assert.deepEqual(orders.map(order=>order.photoUrl),rows.map(row=>row[3]));
});
test('first valid photo for the article is used across duplicate store rows; unsafe links are ignored',()=>{
 const orders=[{sheetName:'WB Тест',article:'SKU',shop:'1'}];
 assignWorkloadDetails(orders,{WB:[['Артикул','Вид станка по умолчанию'],['SKU','XEROX']]},[['SKU','2','','https://example.test/a'],['SKU','1','','https://example.test/b'],['SKU','3','','javascript:alert(1)']]);
 assert.equal(orders[0].photoUrl,'https://example.test/a');
});
test('photo reader reads only selected document and exact source range',async()=>{
 const id='SYNTHETIC_PHOTOS_000000000';let requests=0;
 const reader={request:async(url,options)=>{requests++;assert.equal(options.method,'GET');assert.deepEqual(url.searchParams.getAll('ranges'),["'Фото'!A:D"]);return Response.json({spreadsheetId:id,valueRanges:[{range:"'Фото'!A1:D100",values:[['Артикул','Магазин','Ссылки на фото','ссылка'],['SKU','1','','https://example.test/a']]}]});}};
 assert.equal((await readWorkloadPhotos(reader,id)).length,1);assert.equal(requests,1);
 await assert.rejects(readWorkloadPhotos({request:async()=>Response.json({spreadsheetId:'wrong',valueRanges:[]})},id),/invalid/);
});

