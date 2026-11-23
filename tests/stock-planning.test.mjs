import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStockRounding, planStockAddition, recalculateStockReadiness } from '../agent/stockPlanning.js';

const catalog={OZON:[['Артикул','Артикул OZ','Станок'],['A','A','XEROX'],['B','B','2-GO']],WB:[['Артикул','Вид станка по умолчанию']],extensions:[['Артикул','Расширение печати'],['B','UF']]};
const existing={box:[{row:5,article:'A',quantity:20}],roll:[]};
const plan=lines=>planStockAddition({destination:'warehouse',lines,catalog,existing});
test('new Xerox stock is rounded from the Assembly catalog and images do not invalidate confirmation',()=>{
 const lines=[{article:'A',quantity:7},{article:'B',quantity:3}];
 const entries=[
  {article:'A',primary:true,store:'1',machine:'XEROX',printExtension:'X',sheetsPerUnit:'1',xeroxMultiplicity:'4',photoUrl:'photo'},
  {article:'B',primary:true,store:'2',machine:'2-GO',printExtension:'CBI',sheetsPerUnit:'6',rollMultiplicity:'5'},
 ];
 const preview=catalog=>planStockAddition({destination:'warehouse',lines,catalog,existing:{box:[],roll:[]}});
 const p=preview(entries);
 assert.equal(p.changes[0].photoUrl,'photo');
 assert.equal(p.fingerprint,preview([{...entries[0],photoUrl:'other'},entries[1]]).fingerprint);
 assert.deepEqual(p.changes[0].rounding.choices.map(x=>x.newQuantity),[4,8]);
 assert.equal(applyStockRounding(p.changes,[{article:'A',direction:'up'}])[0].newQuantity,8);
 assert.equal(p.changes[1].stockMultiplicity,5);
 const conflict=planStockAddition({destination:'urgent',lines:[lines[0]],catalog:entries,
   existing:{roll:[],box:[{row:5,article:'A',quantity:8,xerox:{factor:1,multiplicity:2}}]}});
 assert.equal(conflict.changes[0].action,'skip');
 assert.match(conflict.changes[0].issue,/отличаются/);
});
test('existing stock increments; duplicates in input are combined and new work is routed',()=>{
 const p=plan([{article:'A',quantity:5},{article:'a(OZ)',quantity:3},{article:'B',quantity:7}]);
 assert.equal(p.changes[0].action,'increase');assert.equal(p.changes[0].newQuantity,28);
 assert.equal(p.changes[1].department,'roll');assert.equal(p.changes[1].action,'insert');
 assert.equal(existing.box[0].quantity,20);
});
test('unconfirmed or conflicting existing rows cannot silently change the wrong plan',()=>{
 assert.throws(()=>planStockAddition({destination:'warehouse',lines:[{article:'A',quantity:1}],catalog,existing:{box:[...existing.box,...existing.box],roll:[]}}),/повторяется/);
 const p=planStockAddition({destination:'urgent',lines:[{article:'A',quantity:1}],catalog,existing:{box:[],roll:[{row:5,article:'A',quantity:2}]}});
 assert.equal(p.changes[0].action,'skip');assert.match(p.changes[0].issue,/другом участке/);
 assert.throws(()=>plan([{article:'A',quantity:0}]),/положительное/);
});
test('preview fingerprint changes if a plan changes',()=>{
 const lines=[{article:'A',quantity:1}];
 assert.notEqual(plan(lines).fingerprint,planStockAddition({destination:'warehouse',lines,catalog,existing:{box:[{...existing.box[0],quantity:21}],roll:[]}}).fingerprint);
});
test('an unknown OZON machine is not filled from WB',()=>{
 const c={...catalog,OZON:[...catalog.OZON,['C','C','']],WB:[['Артикул','Вид станка по умолчанию'],['C','XEROX']]};
 const p=planStockAddition({destination:'warehouse',lines:[{article:'C',quantity:1}],catalog:c,existing});
 assert.equal(p.changes[0].action,'skip');
});
test('increased box plan preserves facts and clears completion dates when work is incomplete',()=>{
 const box=recalculateStockReadiness({department:'box',planPieces:30,printed:20,cut:20,printDate:'old-print',cutDate:'old-cut'});
 assert.equal(box.printing,false);assert.equal(box.cutting,false);assert.equal(box.printDate,'');assert.equal(box.printRatio,20/30);
 const xerox=recalculateStockReadiness({department:'box',planPieces:40,xerox:true,factor:2,multiplicity:4,printed:10,cut:8});
 assert.equal(xerox.plan,20);assert.equal(xerox.printRatio,.5);assert.equal(xerox.cutRatio,.4);
});
test('roll readiness uses the existing roll rules after increasing the plan',()=>{
 const common={department:'roll',planPieces:40,printed:20,cut:10,printDate:'yesterday',cutDate:'yesterday',printRolls:{total:2,ready:2},cutRolls:{total:2,ready:1}};
 const result=recalculateStockReadiness(common);
 assert.equal(result.printing.percent,50);assert.equal(result.printing.complete,false);assert.equal(result.printing.date,'');assert.equal(result.cutting.percent,25);assert.equal(result.remainingPrint,20);
 assert.throws(()=>recalculateStockReadiness({...common,printRolls:null}),/состояния рулонов/);
});
