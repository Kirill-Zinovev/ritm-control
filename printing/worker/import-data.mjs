import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { checkPinRuntime } from './access.mjs';
import { isJson, json, readJson } from './http.mjs';
import { printingFeed } from './database.mjs';

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value==='string' && Number.isFinite(Date.parse(value));
const whole = value => Number.isSafeInteger(value) && value>=0;

const definitions = {
  supplies: ['printing_supplies',['id','name','department','status','sort_order','market']],
  positions: ['printing_positions',['supply_id','row_id','sort_order','payload','plan','printed','cut','cut_available']],
  employees: ['printing_employees',['id','name','sort_order']],
  receipts: ['printing_receipts',['id','supply_id','fingerprint','recorded_at','payload','outcome','facts','commit_token']],
  catalog: ['printing_catalog_cards',['id','market','sku','sku_key','store','name','extension','photo','photo_id','import_id']],
};
const kinds=Object.keys(definitions);
const currentImport='SELECT * FROM printing_import WHERE singleton=1';

function authorized(request,env) {
  const key=env.PRINTING_IMPORT_KEY, candidate=request.headers.get('X-Ritm-Printing-Import')??'';
  return hex(key) && hex(candidate) && timingSafeEqual(Buffer.from(key,'hex'),Buffer.from(candidate,'hex'));
}

async function counts(db) {
  const rows=await db.batch(kinds.map(kind=>db.prepare('SELECT count(*) AS items FROM '+definitions[kind][0])));
  return Object.fromEntries(kinds.map((kind,i)=>[kind,rows[i].results[0].items]));
}

function validateManifest(manifest) {
  return manifest && Object.keys(manifest).length===kinds.length && kinds.every(kind=>{
    const part=manifest[kind];
    return whole(part?.count) && Array.isArray(part.chunks) && part.chunks.every(hex)
      && (part.chunks.length===0)===(part.count===0);
  });
}

function result(value,status=200) {return json(value,status);}

async function verify(db, env, meta) {
  const quantities=await counts(db);
  const samples={};
  if (meta?.ready===1) {
    for (const dept of ['box','roll']) {
      const list=(await printingFeed(db,dept)).value;
      const open=list.supplies.find(supply=>supply.status==='open');
      const detail=open ? (await printingFeed(db,dept,{id:open.id})).value : null;
      const journal=(await printingFeed(db,dept,{journal:true})).value;
      samples[dept]={supplies:list.supplies.length,open:list.supplies.filter(s=>s.status==='open').length,
        rows:detail?.rows.length??0,canWrite:!!detail?.writeReady,work:journal.work.length};
    }
  }
  return result({ready:meta?.ready===1,snapshotId:meta?.snapshot_id,manifestHash:meta?.manifest_hash,
    counts:quantities,pinRuntime:await checkPinRuntime(env),samples});
}

export async function importPrinting(db, request, env) {
  if (request.method!=='POST' || !isJson(request) || !authorized(request,env)) return result({message:'Маршрут недоступен.'},404);
  const input=await readJson(request,380_000);
  if (!input) return result({message:'Неверный пакет переноса.'},400);
  const meta=await db.prepare(currentImport).first();
  if (input.action==='verify') return verify(db,env,meta);
  if (input.action==='begin') {
    const {snapshotId,capturedAt,catalogAt,manifest}=input;
    if (!hex(snapshotId) || !date(capturedAt) || (catalogAt!=null && !date(catalogAt)) || !validateManifest(manifest)) {
      return result({message:'Неверное описание базы.'},400);
    }
    const signature=fingerprint([snapshotId,capturedAt,catalogAt??null,manifest]);
    if (!meta) {
      await db.prepare(`INSERT INTO printing_import(singleton,snapshot_id,captured_at,catalog_at,manifest,manifest_hash)
        VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO NOTHING`)
        .bind(snapshotId,capturedAt,catalogAt??null,JSON.stringify(manifest),signature).run();
    }
    const current=await db.prepare(currentImport).first();
    if (current.manifest_hash!==signature) return result({message:'Начат перенос другого снимка.'},409);
    return result({ready:current.ready===1,manifestHash:signature});
  }
  if (!meta || meta.manifest_hash!==input.manifestHash) return result({message:'Проверьте идентификатор переноса.'},409);
  const manifest=JSON.parse(meta.manifest);
  if (input.action==='chunk') {
    const {kind,part,rows}=input;
    if (!kinds.includes(kind) || !whole(part) || !Array.isArray(rows) || !rows.length ||
        !rows.every(row=>Array.isArray(row) && row.length===definitions[kind][1].length) ||
        manifest[kind].chunks[part]!==fingerprint(rows)) return result({message:'Контрольная сумма пакета не совпадает.'},400);
    const previous=await db.prepare('SELECT digest FROM printing_import_parts WHERE kind=? AND part=?').bind(kind,part).first();
    const digest=manifest[kind].chunks[part];
    if (previous) return previous.digest===digest ? result({accepted:true}) : result({message:'Пакет уже сохранён с другим содержимым.'},409);
    if (meta.ready===1) return result({message:'Перенос завершён.'},409);
    const token=randomUUID();
    const [table,columns]=definitions[kind];
    const fields=columns.map((_,i)=>"json_extract(r.value,'$["+i+"]')").join(',');
    const [saved]=await db.batch([
      db.prepare(`INSERT INTO printing_import_parts(kind,part,digest,insert_token)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM printing_import WHERE singleton=1 AND ready=0 AND manifest_hash=?)
        ON CONFLICT(kind,part) DO NOTHING`).bind(kind,part,digest,token,meta.manifest_hash),
      db.prepare(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${fields} FROM json_each(?) r
        WHERE EXISTS (SELECT 1 FROM printing_import_parts WHERE kind=? AND part=? AND insert_token=?)`)
        .bind(JSON.stringify(rows),kind,part,token),
    ]);
    if (saved.meta.changes!==1) {
      const settled=await db.prepare('SELECT digest FROM printing_import_parts WHERE kind=? AND part=?').bind(kind,part).first();
      if (settled?.digest!==digest) return result({message:'Пакет не сохранён.'},409);
    }
    return result({accepted:true});
  }
  if (input.action==='finish') {
    if (meta.ready===1) return verify(db,env,meta);
    const quantities=await counts(db);
    const {results}=await db.prepare('SELECT kind,part,digest FROM printing_import_parts').all();
    const expected=kinds.reduce((sum,key)=>sum+manifest[key].chunks.length,0);
    if (expected!==results.length || kinds.some(kind=>quantities[kind]!==manifest[kind].count) ||
        results.some(part=>manifest[part.kind]?.chunks[part.part]!==part.digest)) {
      return result({message:'Проверьте полноту переноса.',counts:quantities},409);
    }
    await db.batch([
      db.prepare('UPDATE printing_catalog_sync SET updated_at=? WHERE singleton=1').bind(meta.catalog_at),
      db.prepare('UPDATE printing_import SET ready=1 WHERE singleton=1 AND manifest_hash=?').bind(meta.manifest_hash),
    ]);
    return verify(db,env,{...meta,ready:1});
  }
  return result({message:'Команда переноса недоступна.'},400);
}
