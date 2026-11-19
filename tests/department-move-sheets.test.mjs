import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectDepartmentMove} from '../agent/departmentMoveSheets.js';
function fixture(){
 const cell=x=>({effectiveValue:typeof x==='number'?{numberValue:x}:typeof x==='boolean'?{boolValue:x}:{stringValue:x}});
 const header=Array(30).fill(null);header[20]=cell('Дата взятия в работу');header[27]=cell('Напечатано годных, листы');
 const data=Array(30).fill(null);data[4]=cell('SKU');data[15]=cell(32);data[29]=cell('position');
 const rows={box:[{},{},{},{values:header},{values:data}],roll:[{},{},{},{values:header}]};
 const manifest={id:'s',ready:true};
 const writers=Object.fromEntries(['box','roll'].map((d,i)=>[d,{documentId:d,layout:{uid:30},metadata:async()=>[{sheetId:i+1,title:'OZON Test',gridProperties:{rowCount:20}}],manifest:async()=>manifest,grid:async()=>({data:[{rowData:rows[d]}]})}]));
 const deps={input:{shipmentId:'s',uid:'1::position',article:'SKU',quantity:32},writers,registry:[{id:'s',name:'OZON Test',parts:[{department:'box',sheetId:1},{department:'roll',sheetId:2}]}],readBoxJournal:async()=>[]};
 return {deps,data,rows,cell};
}
test('fresh source proof identifies exact row and preserves its snapshot',async()=>{const f=fixture();const p=await inspectDepartmentMove(f.deps);assert.equal(p.source.uid,'position');assert.equal(p.source.quantity,32);assert.equal(p.source.row,5);});
test('stale identity, duplicates and recorded work are refused',async()=>{for(const kind of ['uid','quantity','duplicate','date','output','journal']){const f=fixture();if(kind==='uid')f.deps.input.uid='other';if(kind==='quantity')f.deps.input.quantity=33;if(kind==='duplicate')f.rows.roll.push({values:f.data});if(kind==='date')f.data[20]=f.cell('today');if(kind==='output')f.data[27]=f.cell(1);if(kind==='journal')f.deps.readBoxJournal=async()=>[['event','','','','box',1,'','SKU']];await assert.rejects(inspectDepartmentMove(f.deps),undefined,kind);}});
test('unavailable journal cannot be interpreted as no work',async()=>{const f=fixture();f.deps.readBoxJournal=async()=>null;await assert.rejects(inspectDepartmentMove(f.deps),/Журнал/);});

test('reverse transfer uses roll UID and rejects box duplicate',async()=>{const f=fixture();f.rows.roll.push(f.rows.box.pop());f.deps.input.sourceDepartment='roll';f.deps.input.uid='2::position';f.deps.readBoxJournal=async()=>{throw Error('box journal must not be read for roll source');};const p=await inspectDepartmentMove(f.deps);assert.equal(p.from,'roll');assert.equal(p.to,'box');assert.equal(p.source.uid,'position');f.rows.box.push({values:f.data});await assert.rejects(inspectDepartmentMove(f.deps),/уже есть/);});

function legacyFixture(){const f=fixture();f.deps.registry=[];f.deps.input.shipmentId='RITM-ROLL-2';f.data[29]=null;f.deps.input.uid='1::row:5';f.deps.legacyLinks=[{name:'OZON Test',boxSheetId:1,targetRollSheetId:2}];Object.values(f.deps.writers).forEach(w=>w.manifest=async()=>null);const row=Array(10).fill('');row[0]='RITM-ROLL-2';row[3]='RITM-ROLL-2|box:1|row:5|SKU';row[4]='SKU';row[9]=32;f.composition=[row];f.deps.readLegacyComposition=async()=>f.composition;return f;}
test('legacy link preserves the shipment and every Assembly position identity',async()=>{const f=legacyFixture();const p=await inspectDepartmentMove(f.deps);assert.equal(p.legacy,true);assert.equal(p.manifest.id,'RITM-ROLL-2');assert.equal(p.manifest.parts[1].sheetId,1);});
test('legacy adoption fails closed on missing, ambiguous or changed links and history',async()=>{for(const kind of ['missing','ambiguous','identity','quantity','manifest']){const f=legacyFixture();if(kind==='missing')f.deps.legacyLinks=[];if(kind==='ambiguous')f.deps.legacyLinks.push(f.deps.legacyLinks[0]);if(kind==='identity')f.composition[0][3]='other';if(kind==='quantity')f.composition[0][9]=33;if(kind==='manifest')f.deps.writers.box.manifest=async()=>({id:'foreign',ready:true});await assert.rejects(inspectDepartmentMove(f.deps),undefined,kind);}});
test('legacy box without UID keeps its exact row identity',async()=>{const f=legacyFixture();f.data[29]=null;f.deps.input.uid='1::row:5';f.composition[0][3]='RITM-ROLL-2|box:1|row:5|SKU';const p=await inspectDepartmentMove(f.deps);assert.equal(p.source.uid,'');assert.equal(p.source.row,5);});
