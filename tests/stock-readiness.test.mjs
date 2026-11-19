import test from 'node:test';
import assert from 'node:assert/strict';
import {boxStockReadiness,rollStockReadiness} from '../agent/stockReadiness.js';

const cell=value=>({effectiveValue:typeof value==='number'?{numberValue:value}:{stringValue:value}});
test('box uses stored sheet facts and refuses unconfirmed totals',()=>{
 const values=Array(30).fill(null);values[3]=cell('XEROX');values[6]=cell(2);values[13]=cell(4);values[27]=cell(10);values[28]=cell(8);
 const input={current:{row:5,quantity:20},change:{newQuantity:40},snapshot:{data:[null,null,null,null,{values}]}};
 const result=boxStockReadiness(input);assert.equal(result.plan,20);assert.equal(result.printRatio,.5);assert.equal(result.cutRatio,.4);
 values[27]=null;assert.throws(()=>boxStockReadiness(input),/напечатано/);
});
test('box checks the confirmed rounding against the current sheet norms', () => {
  const values = Array(30).fill(null);
  Object.assign(values,{3:cell('XEROX'),6:cell(20),13:cell(8),27:cell(25),28:cell(15)});
  const input = {current:{row:5,quantity:200,article:'A'},
    change:{newQuantity:218,xeroxRoundingProof:{factor:20,multiplicity:8,sheets:545}},
    snapshot:{data:[null,null,null,null,{values}]}};
  const result = boxStockReadiness(input);
  assert.equal(result.plan,545);
  assert.equal(result.printRatio,25/545);
  values[6] = cell(12);
  assert.throws(() => boxStockReadiness(input),{code:'stock_rounding_changed'});
});
test('roll progress preserves journal and partial precedence after a plan change',()=>{
 const values=Array(30).fill(null);values[29]=cell('uid');values[22]=cell('2026-11-05');
 const r1=Array(17).fill('');Object.assign(r1,{0:'r1',1:'uid',2:'Запасы склад',4:'A',7:true,8:false,11:10});
 const r2=Array(17).fill('');Object.assign(r2,{0:'r2',1:'uid',2:'Запасы склад',4:'A',7:false,8:false,11:10});
 const j=Array(15).fill('');Object.assign(j,{0:'e1',3:'Печать',4:'Запасы склад',6:'A',7:'uid',9:8,14:'r1'});
 const p=Array(14).fill('');Object.assign(p,{0:'p1',1:'r2',2:'uid',3:'Запасы склад',5:'A',6:'Печать',9:3});
 const result=rollStockReadiness({current:{row:5,article:'A'},change:{newQuantity:20},snapshot:{data:[null,null,null,null,{values}]},sheetName:'Запасы склад',rolls:[r1,r2],progress:[p],journal:[j]});
 assert.equal(result.printing.actual,11);assert.equal(result.printing.percent,50);assert.equal(result.remainingPrint,9);assert.equal(result.printing.date,'');
});
