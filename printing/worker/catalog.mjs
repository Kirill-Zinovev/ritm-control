const origin = 'https://assembly-v2.zinovevkirill234.chatgpt.site';
const pageSize = 30;
const age = 60 * 60_000;
const earlyRefresh = 5 * 60_000;
let session = {};

const clean = value => typeof value==='string' && !value.trim().startsWith('#') ? value.trim() : '';
const sku = value => clean(value).normalize('NFC').toLocaleUpperCase('ru-RU');
export const skuKey = (market,value) => market==='OZON' ? sku(value).replace(/\(OZ\)$/u,'') : sku(value);

function shopFromSupply(name = '') {
  const matches=Array.from(name.matchAll(/(?:магазин\s*([12])(?!\d)|(?<!\d)([12])\s*(?:[-‑–]\s*)?(?:й|ый)?\s*магазин)/giu));
  const values=new Set(matches.map(match=>match[1]||match[2]));
  return values.size===1 ? values.values().next().value : '';
}

function validPhoto(value) {
  try {
    const url=new URL(value);
    if (url.protocol==='https:' && !url.port && !url.username && !url.password &&
        /^(basket-\d+\.wbbasket\.ru|mow-basket-cdn-\d+\.geobasket\.ru)$/.test(url.hostname) &&
        /^\/vol\d+\/part\d+\/\d+\/images\//.test(url.pathname)) return url.href;
  } catch { /* A card can have no photo. */ }
  return '';
}

export async function decorateRows(db, group, rows) {
  if (!group.market || !rows.length) return rows;
  const keys=[...new Set(rows.map(row=>skuKey(group.market,row.article)))];
  const {results}=await db.prepare(`SELECT sku,sku_key,store,name,extension,photo FROM printing_catalog_cards
    WHERE market=? AND sku_key IN (SELECT value FROM json_each(?))`).bind(group.market,JSON.stringify(keys)).all();
  const index=new Map();
  for (const row of results) {
    if (!index.has(row.sku_key)) index.set(row.sku_key,[]);
    index.get(row.sku_key).push(row);
  }
  const groupStore=shopFromSupply(group.name);
  return rows.map(row=>{
    const store=clean(row.catalogStore)||(group.name ? groupStore : shopFromSupply(row.supplyName));
    const candidates=index.get(skuKey(group.market,row.article))??[];
    const scoped=store ? candidates.filter(card=>card.store===store) : candidates;
    if (!store && new Set(scoped.map(card=>card.store)).size>1) return row;
    const exact=scoped.filter(card=>card.sku===sku(row.article));
    const card=exact.length===1 ? exact[0] : scoped.length===1 ? scoped[0] : null;
    return card ? {...row,name:card.name||row.name,photo:validPhoto(card.photo)||row.photo,extension:row.extension||card.extension} : row;
  });
}

async function remote(path,init) {
  return fetch(origin+path,{...init,redirect:'error',signal:AbortSignal.timeout(6500)});
}

function readSession(token) {
  if (session.token!==token) session={token};
  const current=session;
  if (!current.pending) {
    current.pending=remote('/api/access/collector',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),
    }).then(async response=>{
      const cookie=(response.headers.getSetCookie?.()??[response.headers.get('Set-Cookie')??''])
        .map(value=>value.split(';',1)[0]).find(value=>value.startsWith('__Host-av2-workplace='));
      await response.body?.cancel();
      if (!response.ok || !cookie) throw new Error('Assembly catalog authorization failed');
      return cookie;
    }).catch(error=>{current.pending=undefined;throw error;});
  }
  return current.pending;
}

async function catalogPage(token, market, page) {
  const path='/api/catalog?'+new URLSearchParams({market,page});
  let response=await remote(path,{headers:{cookie:await readSession(token)}});
  if (response.status===401) {
    await response.body?.cancel();
    session={};
    response=await remote(path,{headers:{cookie:await readSession(token)}});
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error('Assembly catalog page unavailable'); }
  const value=await response.json();
  const id=value.active?.id;
  const total=value.total;
  if (typeof id!=='string' || !id || !Number.isSafeInteger(total) || total<0 || total>300000 ||
      value.page!==Math.min(page,Math.max(0,Math.ceil(total/pageSize)-1)) || !Array.isArray(value.items)) {
    throw new Error('Assembly catalog page invalid');
  }
  const cards=value.items.map(item=>{
    const article=sku(item.sku);
    if (item.market!==market || item.importId!==id || typeof item.id!=='string' || !article) {
      throw new Error('Assembly catalog card invalid');
    }
    return [item.id,market,article,skuKey(market,article),clean(item.store),clean(item.name),
      clean(item.printExtension),validPhoto(item.photoUrl),clean(item.photoId),id];
  });
  return {id,total,cards};
}

const stateSql='SELECT * FROM printing_catalog_sync WHERE singleton=1';
const upsertCards=`
  INSERT INTO printing_catalog_cards(id,market,sku,sku_key,store,name,extension,photo,photo_id,import_id)
  SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),
    json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]'),
    json_extract(value,'$[6]'),json_extract(value,'$[7]'),json_extract(value,'$[8]'),json_extract(value,'$[9]')
  FROM json_each(?) WHERE EXISTS (SELECT 1 FROM printing_catalog_sync WHERE lease_until=?)
  ON CONFLICT(id) DO UPDATE SET market=excluded.market,sku=excluded.sku,sku_key=excluded.sku_key,
    store=excluded.store,name=excluded.name,extension=excluded.extension,
    photo=CASE WHEN excluded.photo<>'' THEN excluded.photo
      WHEN printing_catalog_cards.photo_id=excluded.photo_id AND printing_catalog_cards.import_id=excluded.import_id
      THEN printing_catalog_cards.photo ELSE '' END,photo_id=excluded.photo_id,import_id=excluded.import_id`;

async function advanceCatalog(db, token, initial) {
  const begun=Date.now(), lease=begun+26_000;
  const locked=await db.prepare('UPDATE printing_catalog_sync SET lease_until=? WHERE singleton=1 AND lease_until<=? AND retry_at<=? AND page=? AND market_offset=? AND updated_at IS ?')
    .bind(lease,begun,begun,initial.page,initial.market_offset,initial.updated_at).run();
  if (locked.meta.changes!==1) return;
  try {
    const {results}=await db.prepare("SELECT DISTINCT market FROM printing_supplies WHERE market IN ('OZON','WB') ORDER BY market").all();
    let {page,market_offset:offset,import_id:previous,total:previousTotal}=initial;
    for (let i=0; i<3 && offset<results.length && Date.now()-begun<15_000; i++) {
      const market=results[offset].market;
      const current=await catalogPage(token,market,page);
      if (page>0 && (current.id!==previous || current.total!==previousTotal)) {
        await db.prepare("UPDATE printing_catalog_sync SET page=0,import_id='',total=0 WHERE lease_until=?").bind(lease).run();
        break;
      }
      const next=page+1;
      const finished=next>=Math.ceil(current.total/pageSize);
      const finalMarket=finished && offset+1===results.length;
      const offsetAfter=finalMarket ? 0 : finished ? offset+1 : offset;
      await db.batch([
        db.prepare(upsertCards).bind(JSON.stringify(current.cards),lease),
        db.prepare(`UPDATE printing_catalog_sync SET page=?,market_offset=?,import_id=?,total=?,
          updated_at=coalesce(?,updated_at) WHERE singleton=1 AND lease_until=?`)
          .bind(finished?0:next,offsetAfter,finished?'':current.id,finished?0:current.total,
            finalMarket?new Date().toISOString():null,lease),
      ]);
      if (finalMarket) break;
      page=finished?0:next;
      offset=offsetAfter;
      previous=finished?'':current.id;
      previousTotal=finished?0:current.total;
    }
    await db.prepare('UPDATE printing_catalog_sync SET lease_until=0,retry_at=0 WHERE lease_until=?').bind(lease).run();
  } catch {
    await db.prepare('UPDATE printing_catalog_sync SET lease_until=0,retry_at=? WHERE lease_until=?')
      .bind(Date.now()+30_000,lease).run();
  }
}

export async function refreshCatalog(db, token, fresh, ctx) {
  if (!ctx?.waitUntil || !/^[a-f0-9]{64}$/.test(token??'')) return {refreshing:false};
  const state=await db.prepare(stateSql).first();
  if (!state) return {refreshing:false};
  const now=Date.now();
  const elapsed=state.updated_at ? now-Date.parse(state.updated_at) : Infinity;
  const due=state.page>0 || state.market_offset>0 || elapsed>age || (fresh && elapsed>earlyRefresh);
  if (!due || state.retry_at>now) return {refreshing:false,updatedAt:state.updated_at};
  if (state.lease_until<=now) ctx.waitUntil(advanceCatalog(db,token,state).catch(()=>{}));
  return {refreshing:true,updatedAt:state.updated_at};
}
