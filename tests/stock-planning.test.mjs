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
 const applied=applyStockRounding(p.changes,[{article:'A',direction:'up'},{article:'B',direction:'up'}]);
 assert.equal(applied[0].newQuantity,8);
 assert.equal(applied[1].newQuantity,5);
 assert.equal(applied[1].xeroxRoundingProof,undefined);
 assert.deepEqual(p.changes[1].rounding.choices.map(choice=>choice.newQuantity),[0,5]);
 assert.equal(p.changes[1].stockMultiplicity,5);
 const conflict=planStockAddition({destination:'urgent',lines:[lines[0]],catalog:entries,
   existing:{roll:[],box:[{row:5,article:'A',quantity:8,xerox:{factor:1,multiplicity:2}}]}});
 assert.equal(conflict.changes[0].action,'skip');
 assert.match(conflict.changes[0].issue,/отличаются/);
});

test('Xerox previews describe the sheet multiple and finished-piece step even for an aligned plan', () => {
 const article = 'KS0013.A7986';
 const catalog = [{article, machine:'XEROX', printExtension:'X', sheetsPerUnit:'20', xeroxMultiplicity:'8'}];
 const existing = {roll:[], box:[{row:5, article, quantity:200, xerox:{factor:20, multiplicity:8}}]};
 const preview = quantity => planStockAddition({destination:'urgent', lines:[{article, quantity}], catalog, existing}).changes;

 const aligned = preview(60);
 assert.equal(aligned[0].newQuantity, 260);
 assert.equal(aligned[0].rounding, undefined);
 assert.deepEqual(aligned[0].quantityRule, {kind:'xerox', multiplicity:8, step:2, sheets:650});
 assert.equal(applyStockRounding(aligned)[0].quantityRule, undefined);

 const unaligned = preview(61);
 assert.equal(unaligned[0].newQuantity, 261);
 assert.deepEqual(unaligned[0].quantityRule, {kind:'xerox', multiplicity:8, step:2, sheets:null});
 assert.deepEqual(unaligned[0].rounding.choices, [
   {direction:'down', quantity:60, newQuantity:260, sheets:650},
   {direction:'up', quantity:62, newQuantity:262, sheets:655},
 ]);
 assert.throws(() => applyStockRounding(unaligned), /Выберите округление/);
 const [confirmed] = applyStockRounding(unaligned, [{article, direction:'up'}]);
 assert.equal(confirmed.newQuantity, 262);
 assert.equal(confirmed.quantityRule, undefined);
 assert.deepEqual(confirmed.xeroxRoundingProof, {factor:20, multiplicity:8, sheets:655});
});

test('roll rounding respects the prior plan and non-Xerox box machines accept the requested quantity',()=>{
 const catalog=[
   {article:'ROLL',machine:'2-GO',printExtension:'CBI',rollMultiplicity:'5',name:'Наклейки',size:'22x16',printFolder:'Порезка'},
   {article:'DTF',machine:'DTF',printExtension:'DTF',xeroxMultiplicity:'8'},
   {article:'FLAT',machine:'УФ планшет',printExtension:'UF',xeroxMultiplicity:'8'},
   {article:'MISSING',machine:'2-GO',printExtension:'CBI'},
 ];
 const existing={roll:[{row:5,article:'ROLL',quantity:17}],box:[]};
 const lines=catalog.map(({article})=>({article,quantity:4}));
 const {changes}=planStockAddition({destination:'warehouse',lines,catalog,existing});
 assert.deepEqual(changes[0].quantityRule,{kind:'roll',multiplicity:5,step:5});
 assert.deepEqual(changes[0].rounding.choices.map(choice=>[choice.quantity,choice.newQuantity]),[[3,20],[8,25]]);
 assert.equal(changes[0].stockDetails.printFolder,'Порезка');
 assert.equal(changes[0].stockDetails.name,'Наклейки');
 for(const item of changes.slice(1,3)) {
   assert.equal(item.action,'insert');
   assert.equal(item.newQuantity,4);
   assert.equal(item.rounding,undefined);
   assert.equal(item.quantityRule,undefined);
 }
 assert.equal(changes[3].action,'skip');
 assert.match(changes[3].issue,/Укажите кратность/);
 assert.equal(applyStockRounding(changes,[{article:'ROLL',direction:'down'}])[0].newQuantity,20);
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
