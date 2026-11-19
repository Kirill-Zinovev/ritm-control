import test from 'node:test';
import assert from 'node:assert/strict';
import {stockCellRequests} from '../agent/stockCells.js';
import {recalculateStockReadiness} from '../agent/stockPlanning.js';

test('increase emits only the plan and validated derived readiness cells',()=>{
 const readiness=recalculateStockReadiness({department:'box',planPieces:30,printed:20,cut:20,printDate:'old',cutDate:'old'});
 const req=stockCellRequests(7,[{row:5,article:'A',newQuantity:30,action:'increase',department:'box',readiness}]);
 const cells=req.map(x=>x.updateCells.start.columnIndex+1);
 assert.deepEqual(cells,[19,20,22,23,16]);assert.equal(req[0].updateCells.rows[0].values[0].userEnteredValue.boolValue,false);
 assert.ok(!cells.includes(28)&&!cells.includes(29));
 assert.throws(()=>stockCellRequests(7,[{row:5,article:'A',newQuantity:30,action:'increase',department:'box'}]),/пересчёт/);
});
test('new stock identity and article are set without touching previous rows',()=>{
 const req=stockCellRequests(7,[{row:6,article:'A',newQuantity:10,action:'insert',uid:'ritm-11111111-1111-4111-8111-111111111111-1',department:'box',layoutPresent:true}]);
 assert.deepEqual(req.map(x=>x.updateCells.start.columnIndex+1),[5,6,30,3,14,19,20,25,26,28,29,24,16]);
 assert.match(req.find(x=>x.updateCells.start.columnIndex===13).updateCells.rows[0].values[0].userEnteredValue.formulaValue,/Cache FBO/);
 assert.ok(req.every(x=>x.updateCells.start.rowIndex===5));
});
