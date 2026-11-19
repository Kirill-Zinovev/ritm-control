import './cloud-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from '../agent/adapters.js';
import { DEFAULT_SOURCES } from '../agent/registry.js';
import { PRINTING_SOURCES, ROLL_PRINTING_SHEET_ID, BOX_PRINTING_SHEET_ID } from '../worker/printing.js';

const csv = rows => rows.map(row => row.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
const source = DEFAULT_SOURCES.find(s => s.adapter === 'printing');

test('configured stock books receive read-only auth and their journal work survives refresh without duplication', async () => {
  const rollId = 'configured-stock-roll', boxId = 'configured-stock-box', calls = [];
  const order = Array.from({length:5}, () => Array(30).fill(''));
  order[0][29] = 'UID'; order[3][4] = 'Артикул'; order[3][15] = 'Кол-во';
  order[4][4] = 'STOCK-ONLY'; order[4][15] = 10; order[4][29] = 'stock-position';
  const empty = order.slice(0,4).map(row => [...row]);
  const journalHeader = Array(15).fill('');
  for (const [col, header] of Object.entries(PRINTING_SOURCES.find(s => s.id === 'roll-printing').journal.expectedHeaders)) journalHeader[col] = header;
  journalHeader[4]='Лист-источник';journalHeader[6]='Артикул';
  const rollsHeader=['ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','ROLL_NAME','ROLL_NUMBER','PRINT_READY','CUT_READY','CREATED_AT','UPDATED_AT','ROLL_QUANTITY','PRINT_DONE_AT','PRINT_EMPLOYEE','CUT_DONE_AT','CUT_EMPLOYEE','LEGACY_SOURCE'];
  const progressHeader=['EVENT_ID','ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','OPERATION','EMPLOYEE','DATE','QUANTITY','AREA_PER_ITEM','AREA','ENTERED_AT','COMMENT'];
  const event = Array(15).fill('');
  Object.assign(event, {0:'stock-event',1:'12.11.2026',2:'Дмитрий',3:'Печать',4:'Запасы склад',6:'STOCK-ONLY',7:'stock-position',9:10,11:3.5});
  const fetcher = async (url, init) => {
    const u = new URL(url), id = u.pathname.split('/')[3], gid = Number(u.searchParams.get('gid'));
    assert.ok([source.documentId, ROLL_PRINTING_SHEET_ID, BOX_PRINTING_SHEET_ID, rollId, boxId].includes(id));
    assert.equal(init.headers.get('authorization'), 'Bearer read-only-test-token'); calls.push(id);
    if (id === rollId) return new Response(csv(gid === 3 ? [journalHeader,event] : gid === 4 ? [rollsHeader] : gid === 5 ? [progressHeader] : gid === 1 ? order : empty));
    if (id === boxId) return new Response(csv(empty));
    const main = PRINTING_SOURCES.find(s => s.spreadsheetId === id);
    if (main?.journal?.gid === gid) {
      const headers = Array(15).fill('');
      for (const [col,value] of Object.entries(main.journal.expectedHeaders)) headers[col] = value;
      return new Response(csv([headers]));
    }
    const headerRow = main.supplies.find(s => s.gid === gid)?.headerRow || 3;
    const mainEmpty = Array.from({length:headerRow}, () => Array(30).fill(''));
    mainEmpty[0][29]='UID'; mainEmpty[headerRow-1][4]='Артикул'; mainEmpty[headerRow-1][14]='Кол-во';
    return new Response(csv(mainEmpty));
  };
  const googleReader = {
    accessToken: async () => 'read-only-test-token',
    get: async () => { throw new Error('reference source unavailable in isolated test'); },
    metadata: async id => {
      assert.ok([rollId,boxId].includes(id));
      return {spreadsheetId:id,sheets:[{properties:{title:'Запасы склад',sheetId:1}},{properties:{title:'Срочные 2 этаж',sheetId:2}},...(id===rollId?[{properties:{title:'Журнал выпуска',sheetId:3}},{properties:{title:'ROLLS_V2',sheetId:4}},{properties:{title:'ROLLS_V2_PROGRESS',sheetId:5}}]:[])]};
    },
  };
  const options = {googleReader,stockRollPrintingId:rollId,stockBoxPrintingId:boxId};
  for (let i=0;i<2;i++) {
    const result = await loadSource(source,fetcher,new Date('2026-11-12T09:00:00Z'),options);
    assert.equal(result.stockRoll.status,'available'); assert.equal(result.stockBox.status,'available');
    const events = result.events.filter(e => e.id.startsWith('journal:stock-roll:'));
    assert.equal(events.length,1); assert.equal(events[0].quantity,10); assert.equal(events[0].area,3.5);
    assert.equal(result.supplies.some(o => o.article === 'STOCK-ONLY'),false);
    assert.equal(new Set(result.events.map(e=>e.id)).size,result.events.length);
  }
  assert.equal(calls.filter(id=>id===rollId).length,10);
  assert.equal(calls.filter(id=>id===boxId).length,4);
});
