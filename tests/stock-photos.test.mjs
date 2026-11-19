import test from 'node:test';
import assert from 'node:assert/strict';
import {findProductPhotos} from '../worker/cloud/assemblyOnlyCatalog.js';

test('stock preview uses only uniquely confirmed safe product photos',async()=>{
 const rows=[['Артикул','ссылка'],['A','https://basket-01.wbbasket.ru/a.webp'],['A','https://basket-01.wbbasket.ru/a.webp'],['B','https://evil.example/photo'],['C','https://basket-01.wbbasket.ru/one.webp'],['C','https://basket-01.wbbasket.ru/two.webp']];
 const id='test_photos_123456789012345';
 const reader={request:async()=>new Response(JSON.stringify({spreadsheetId:id,valueRanges:[{values:rows}]}))};
 const result=await findProductPhotos(reader,{RITM_GOOGLE_ASSEMBLY_PHOTOS_ID:id},['a','b','c']);
 assert.equal(result.get('A'),'https://basket-01.wbbasket.ru/a.webp');assert.equal(result.has('B'),false);assert.equal(result.get('C'),'');
});
