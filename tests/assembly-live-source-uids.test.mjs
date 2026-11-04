import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../apps-script/assembly-live/Code.gs',import.meta.url),'utf8');
const section=code.slice(code.indexOf('function ritmOrderColumns_('),code.indexOf('function ritmSupplyManifest_('));
const ctx=vm.createContext({toNumberOrNull_:v=>Number(v)});vm.runInContext(section,ctx);
function sheet(ac, values){const h=Array(31).fill('');h[0]='Артикул';h[11]='Кол-во';h[24]=ac;return {getMaxColumns:()=>35,getLastRow:()=>4+values.length,getRange:(row)=>({getDisplayValues:()=>[h],getValues:()=>values})};}
function row(sku,uid){const r=Array(31).fill('');r[0]=sku;r[11]=10;r[24]=uid;return r;}
test('box cut quantities in AC are not interpreted as identifiers',()=>{const s=sheet('Порезано годных, листы',[row('A',800),row('B',800)]);const out=ctx.readRitmOrders_(s);assert.equal(out.length,2);assert.equal(out[0].uid,'');assert.equal(out[1].uid,'');});
test('legacy UID columns retain duplicate detection',()=>{const s=sheet('',[row('A','old-id'),row('B','old-id')]);assert.throws(()=>ctx.readRitmOrders_(s),/Повторяется UID/);});
test('generated UID is read even when AC stores cut quantity',()=>{const r=row('A',800);r[25]='ritm-01234567-0123-0123-0123-0123456789ab-5';const s=sheet('Порезано годных, листы',[r]);assert.equal(ctx.readRitmOrders_(s)[0].uid,r[25]);});
