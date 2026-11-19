import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyArchivedStockClose} from '../worker/cloud/stockCloseRecovery.js';

const op={id:'op',department:'box',destination:'urgent',sheetId:7,row:5,uid:'u1',article:'A1',quantity:32};
const cell=v=>({userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:v}});
function reader({active=false,wrong=false}={}) {
 const archive=[['Операция','Дата','Лист','Строка','UID','Артикул','План'],['op','2026-11-09T07:00:00Z','Срочные 2 этаж',5,'u1','A1',wrong?33:32]];
 const headers=Array.from({length:30},(_,i)=>cell(i===4?'Артикул':i===15?'Кол-во':''));
 const data=Array.from({length:5},()=>({values:[]}));data[3]={values:headers};
 if(active){let row=Array.from({length:30},()=>({}));row[4]=cell('A1');row[15]=cell(32);row[29]=cell('u1');data[4]={values:row};}
 return {metadata:async()=>({spreadsheetId:'doc',sheets:[{properties:{title:'_RITM_STOCK_ARCHIVE',sheetId:8,gridProperties:{rowCount:2}}},{properties:{title:'Срочные 2 этаж',sheetId:7,gridProperties:{rowCount:5}}}]}),grid:async(_,ranges)=>ranges[0].includes('_RITM_STOCK_ARCHIVE')?{spreadsheetId:'doc',sheets:[{properties:{sheetId:8,title:'_RITM_STOCK_ARCHIVE'},data:[{rowData:archive.map(r=>({values:r.map(cell)}))}]}]}:{spreadsheetId:'doc',sheets:[{properties:{sheetId:7,title:'Срочные 2 этаж'},data:[{rowData:data}]}]}};
}
test('archive and absent UID confirm a close without writing',async()=>assert.ok(await verifyArchivedStockClose(reader(),'doc',op)));
test('still-active UID and mismatched archive remain uncertain',async()=>{assert.equal(await verifyArchivedStockClose(reader({active:true}),'doc',op),null);assert.equal(await verifyArchivedStockClose(reader({wrong:true}),'doc',op),null)});
