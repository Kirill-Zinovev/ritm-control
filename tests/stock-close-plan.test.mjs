import test from 'node:test';
import assert from 'node:assert/strict';
import {stockClosePlan} from '../agent/stockClosePlan.js';
const entry={department:'box',destination:'urgent',sheetId:12,row:5,uid:'id-1',article:'CT001.A1'};
const row={row:5,article:'CT001.A1',quantity:32};
const data=Array.from({length:5},()=>({values:[]}));data[4].values[29]={userEnteredValue:{stringValue:'id-1'}};
const snapshot={sheetId:12,rows:[row],data};
test('close targets whole confirmed current plan',()=>assert.deepEqual(stockClosePlan({entry,snapshot,readiness:{print:'done',cut:'done'}}),{...entry,quantity:32}));
test('incomplete, missing and changed data cannot close a task',()=>{for(const readiness of [{print:'done',cut:'partial'},{print:'unknown',cut:'done'},null])assert.throws(()=>stockClosePlan({entry,snapshot,readiness}));assert.throws(()=>stockClosePlan({entry:{...entry,uid:'other'},snapshot,readiness:{print:'done',cut:'done'}}));assert.throws(()=>stockClosePlan({entry,snapshot:{...snapshot,rows:[row,{...row,row:6}]},readiness:{print:'done',cut:'done'}}));});
