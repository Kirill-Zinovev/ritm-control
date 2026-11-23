import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fingerprint } from '../worker/import-data.mjs';
import { skuKey } from '../worker/catalog.mjs';
import { progressFacts } from '../worker/workflow.mjs';

const byteLimit=165_000;
const chunkLength=100;

function chunks(rows) {
  const result=[];
  let bytes=2, chunk=[];
  for (const row of rows) {
    const size=Buffer.byteLength(JSON.stringify(row))+1;
    if (size>byteLimit) throw new Error('Одна запись превышает допустимый размер пакета.');
    if (chunk.length && (chunk.length===chunkLength || bytes+size>byteLimit)) {
      result.push(chunk);
      chunk=[];
      bytes=2;
    }
    chunk.push(row);
    bytes+=size;
  }
  if (chunk.length) result.push(chunk);
  return result;
}

export function readPrintingSnapshot(filename) {
  const db=new DatabaseSync(filename,{readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=4000; BEGIN');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
    const writableRows=db.prepare(`SELECT count(*) AS total FROM row_state w
      LEFT JOIN printing_positions p ON p.supply_id=w.supply_id AND p.row_id=w.row_id
      WHERE p.row_id IS NULL`).get().total;
    assert.equal(writableRows,0,'The current state refers to a missing position.');
    const departments=new Map();
    const data={};
    data.supplies=db.prepare('SELECT id,name,department,status,sort_order,market FROM printing_supplies ORDER BY sort_order,id')
      .all().map(({id,name,department,status,sort_order,market})=>{
        departments.set(id,department);
        return [id,name,department,status,sort_order,market];
      });
    data.positions=db.prepare(`SELECT p.supply_id,p.row_id,p.sort_order,p.payload,w.payload AS saved
      FROM printing_positions p LEFT JOIN row_state w ON w.supply_id=p.supply_id AND w.row_id=p.row_id
      ORDER BY p.supply_id,p.sort_order,p.row_id`).all().map(record=>{
      const row=JSON.parse(record.payload);
      const current=record.saved ? {...row,...JSON.parse(record.saved)} : row;
      assert.equal(current.id,record.row_id);
      assert.ok(departments.has(record.supply_id));
      const {plan,printed,cut,cutAvailable}=progressFacts(current,departments.get(record.supply_id));
      return [record.supply_id,record.row_id,record.sort_order,JSON.stringify(current),plan,printed,cut,cutAvailable];
    });
    data.employees=db.prepare('SELECT id,name,sort_order FROM printing_employees ORDER BY sort_order,id')
      .all().map(({id,name,sort_order})=>[id,name,sort_order]);
    data.receipts=db.prepare('SELECT id,fingerprint,recorded_at,payload,outcome,facts FROM work_receipts ORDER BY recorded_at,rowid')
      .all().map(row=>{
        const payload=JSON.parse(row.payload);
        const supplyId=payload[0];
        assert.ok(departments.has(supplyId));
        assert.equal(fingerprint(payload),row.fingerprint);
        return [row.id,supplyId,row.fingerprint,row.recorded_at,row.payload,row.outcome,row.facts,'sqlite-import'];
      });
    data.catalog=db.prepare('SELECT id,market,sku,store,name,extension,photo,photo_id,import_id FROM printing_catalog_cards ORDER BY id')
      .all().map(row=>[row.id,row.market,row.sku,skuKey(row.market,row.sku),row.store,row.name,row.extension,row.photo,row.photo_id,row.import_id]);
    const snapshotId=db.prepare('SELECT snapshot_id FROM workspace_copy WHERE singleton=1').get().snapshot_id;
    const capturedAt=db.prepare('SELECT captured_at FROM printing_import WHERE singleton=1').get().captured_at;
    const catalogAt=db.prepare('SELECT updated_at FROM printing_catalog_sync WHERE singleton=1').get()?.updated_at??null;
    const parts=Object.fromEntries(Object.entries(data).map(([key,rows])=>[key,chunks(rows)]));
    const manifest=Object.fromEntries(Object.entries(parts).map(([key,sets])=>[key,{count:data[key].length,chunks:sets.map(fingerprint)}]));
    const manifestHash=fingerprint([snapshotId,capturedAt,catalogAt,manifest]);
    db.exec('COMMIT');
    return {snapshotId,capturedAt,catalogAt,manifest,manifestHash,parts};
  } finally {db.close();}
}

export async function transferPrinting(snapshot, send, verifySource) {
  const {snapshotId,capturedAt,catalogAt,manifest,manifestHash,parts}=snapshot;
  const start=await send({action:'begin',snapshotId,capturedAt,catalogAt,manifest});
  assert.equal(start.manifestHash,manifestHash);
  if (!start.ready) {
    for (const [kind,sets] of Object.entries(parts)) {
      for (const [part,rows] of sets.entries()) {
        const result=await send({action:'chunk',manifestHash,kind,part,rows});
        assert.equal(result.accepted,true);
      }
    }
    await verifySource?.();
  }
  const result=await send({action:'finish',manifestHash});
  assert.equal(result.ready,true);
  assert.equal(result.manifestHash,manifestHash);
  assert.equal(result.pinRuntime,true);
  for (const [kind,item] of Object.entries(manifest)) {
    if (start.ready && kind==='receipts') assert.ok(result.counts[kind]>=item.count);
    else assert.equal(result.counts[kind],item.count);
  }
  return result;
}

function sender({origin,siteToken,importKey}) {
  const url=new URL(origin);
  if (url.origin!==origin || url.protocol!=='https:' || !url.hostname.endsWith('.chatgpt.site') ||
      typeof siteToken!=='string' || !siteToken || /[\r\n]/.test(siteToken) ||
      !/^[a-f0-9]{64}$/.test(importKey??'')) throw new Error('Проверьте разрешение на перенос в новый проект Sites.');
  const headers={'Content-Type':'application/json','OAI-Sites-Authorization':'Bearer '+siteToken,'X-Ritm-Printing-Import':importKey};
  return async input=>{
    const body=JSON.stringify(input);
    for (let attempt=0; attempt<3; attempt++) {
      const response=await fetch(new URL('/api/printing-import',url),{method:'POST',headers,body,
        redirect:'manual',signal:AbortSignal.timeout(30000)}).catch(()=>null);
      const status=response?.status??0;
      if (response?.ok) return response.json();
      await response?.body?.cancel().catch(()=>{});
      if (attempt===2 || (status>0 && status<500 && status!==429)) {
        throw new Error('Перенос остановился на шаге '+input.action+(input.kind?' '+input.kind+'/'+input.part:'')+' (HTTP '+status+').');
      }
      await sleep((attempt+1)*750);
    }
  };
}

async function readConfig() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const input=createInterface({input:process.stdin,terminal:false});
  process.stdout.write('Готов принять параметры переноса через stdin.\n');
  try {
    for await (const line of input) if (line.trim()) return JSON.parse(line);
  } finally {
    input.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  throw new Error('Параметры переноса недоступны.');
}

async function main() {
  const config=await readConfig();
  if (config.verifyOnly===true) {
    console.log(JSON.stringify(await sender(config)({action:'verify'})));
    return;
  }
  if (!path.isAbsolute(config.filename??'')) throw new Error('Укажите абсолютный путь базы печати.');
  const snapshot=readPrintingSnapshot(config.filename);
  const verified=await transferPrinting(snapshot,sender(config),()=>{
    if (readPrintingSnapshot(config.filename).manifestHash!==snapshot.manifestHash) {
      throw new Error('В SQLite появились новые данные во время переноса.');
    }
  });
  console.log(JSON.stringify(verified));
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {await main();} catch(error){console.error(error.message);process.exitCode=1;}
}
