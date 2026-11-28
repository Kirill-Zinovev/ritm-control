import { createHash, randomUUID } from 'node:crypto';
import { matchesArticle, normalize } from '../src/printing-workflow.mjs';
import { BOX_GATEWAY_BATCH, prepareCloudWrite } from '../src/workspace-write.mjs';
import { boxTotals, correctionPlan, progressFacts, recordBox, rollPlan, summarize, workError, workPatch } from './workflow.mjs';
import { decorateRows } from './catalog.mjs';

const selectSupply='SELECT id,name,department,status,market FROM printing_supplies WHERE id=?';
const selectEmployees='SELECT id,name FROM printing_employees ORDER BY sort_order';
const selectPositions='SELECT row_id,payload,revision FROM printing_positions WHERE supply_id=?';
const idsSql='SELECT value FROM json_each(?)';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const one = value => value.results[0];
const response = (value,status=200) => ({value,status});
const reject = message => response({rejected:true,message},409);
const knownSupply = group => group && ['open','completed'].includes(group.status);

export async function searchPrintingPositions(db, department, excludedId, input) {
  const query = normalize(input);
  if (query.length > 160) return response({message:'Введите артикул или часть названия.'},400);
  if (!query) return response({hits:[],total:0});
  const {results} = await db.prepare(`
    SELECT p.supply_id AS supplyId,s.name AS supplyName,s.market,p.row_id AS rowId,
      json_extract(p.payload,'$.article') AS article,json_extract(p.payload,'$.name') AS name,
      json_extract(p.payload,'$.extension') AS extension,json_extract(p.payload,'$.catalogStore') AS catalogStore,
      p.plan,p.printed,p.cut,p.cut_available AS cutAvailable
    FROM printing_supplies s JOIN printing_positions p ON p.supply_id=s.id
    WHERE s.department=? AND s.id<>coalesce(?,'')
    ORDER BY s.sort_order,p.sort_order`).bind(department,excludedId).all();
  const exact = [], similar = [];
  for (const row of results) {
    if (normalize(row.article) === query) exact.push(row);
    else if (matchesArticle(row,query)) similar.push(row);
  }
  const hits = [...exact,...similar.slice(0, Math.max(0,50-exact.length))];
  const missingByMarket = new Map();
  for (const hit of hits) {
    if (!hit.market || hit.extension) continue;
    if (!missingByMarket.has(hit.market)) missingByMarket.set(hit.market,[]);
    missingByMarket.get(hit.market).push(hit);
  }
  const extensions = new Map();
  await Promise.all([...missingByMarket].map(async ([market, items]) => {
    const decorated = await decorateRows(db,{market},items);
    items.forEach((hit,index) => extensions.set(hit,decorated[index].extension));
  }));
  return response({
    hits:hits.map(hit => {
      const {market,catalogStore,extension,...position} = hit;
      return {...position,extension:extension || extensions.get(hit) || ''};
    }),
    total:exact.length+similar.length,
  });
}

export async function printingFeed(db, department, {id, journal=false, preview=false}={}) {
  if (journal) {
    const {results}=await db.prepare(`
      SELECT r.id,r.recorded_at,r.facts,s.name AS supplyName FROM printing_receipts r
      JOIN printing_supplies s ON s.id=r.supply_id
      WHERE s.department=? ORDER BY r.recorded_at DESC,r.rowid DESC`).bind(department).all();
    return response({work:results.flatMap(row=>JSON.parse(row.facts).map((fact,i)=>({
      id:row.id+':'+i,at:row.recorded_at,supplyName:row.supplyName,...fact,
    })))});
  }
  if (!id) {
    const [supplies, facts, meta, version] = await db.batch([
      db.prepare('SELECT id,name,department,status FROM printing_supplies WHERE department=? ORDER BY sort_order').bind(department),
      db.prepare(`SELECT p.supply_id,p.plan,p.printed,p.cut,p.cut_available AS cutAvailable
        FROM printing_positions p JOIN printing_supplies s ON s.id=p.supply_id WHERE s.department=?`).bind(department),
      db.prepare('SELECT captured_at,ready FROM printing_import WHERE singleton=1'),
      db.prepare('SELECT count(*) AS revision FROM printing_receipts'),
    ]);
    if (!one(meta)?.ready) return response({message:'Поставки ещё переносятся в облако.'},503);
    const bySupply=new Map(supplies.results.map(supply=>[supply.id,[]]));
    for (const item of facts.results) bySupply.get(item.supply_id).push(item);
    return response({
      supplies:supplies.results.map(supply=>summarize(supply,bySupply.get(supply.id))),
      at:one(meta).captured_at,revision:one(version).revision,
      cloud:true,stale:false,working:true,readOnly:false,supportsSupplyPreview:false,
    });
  }
  const statements=[
    db.prepare(selectSupply).bind(id),
    db.prepare(selectPositions+' ORDER BY sort_order').bind(id),
  ];
  if (department==='box') statements.push(db.prepare(selectEmployees));
  const [selection, positions, employees] = await db.batch(statements);
  const group=one(selection);
  if (group?.department!==department) return response({message:'Поставка отсутствует на этом участке.'},404);
  const rows=positions.results.map(value=>({...JSON.parse(value.payload),workRevision:value.revision}));
  const complete=summarize(group,rows.map(row=>progressFacts(row,department))).status!=='open';
  return response({
    id,rows:await decorateRows(db,group,rows),employees:employees?.results??[],
    delivery:{market:group.market},detailsAvailable:true,cloud:true,partial:preview,correctionReady:!preview && knownSupply(group),
    writeReady:!preview && !complete && rows.some(row=>department==='roll' ? Array.isArray(row.rolls) : !!row.fingerprint),
  });
}

async function currentState(db, request, receiptIds) {
  const {supplyId,items,department}=request;
  const queries=[
    db.prepare(selectSupply).bind(supplyId),
    db.prepare(selectPositions+' AND row_id IN ('+idsSql+')')
      .bind(supplyId,JSON.stringify(items.map(item=>item.rowId))),
    db.prepare('SELECT id,fingerprint,outcome FROM printing_receipts WHERE id IN ('+idsSql+')')
      .bind(JSON.stringify(receiptIds)),
  ];
  if (department==='box' && request.command!=='correct') queries.push(db.prepare(selectEmployees));
  const [groups, rows, receipts, employees]=await db.batch(queries);
  return {
    group:one(groups),
    positions:new Map(rows.results.map(row=>[row.row_id,{row:JSON.parse(row.payload),revision:row.revision}])),
    receipts:new Map(receipts.results.map(receipt=>[receipt.id,receipt])),
    people:new Map((employees?.results??[]).map(employee=>[employee.id,employee.name])),
  };
}

// D1 batches are transactions. The receipt is inserted only if every row is
// still at its read revision. Its token enables exactly this batch's updates.
async function commit(db, group, plans) {
  const token=randomUUID();
  const at=new Date().toISOString();
  const sql=[];
  for (const plan of plans) {
    const changes=JSON.stringify(plan.changes.map(({row,revision})=>({
      id:row.id,revision,payload:JSON.stringify(row),...progressFacts(row,group.department),
    })));
    sql.push(db.prepare(`
      INSERT INTO printing_receipts(id,supply_id,fingerprint,recorded_at,payload,outcome,facts,commit_token)
      SELECT ?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM printing_supplies WHERE id=? AND status=?)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) c
          WHERE NOT EXISTS (
            SELECT 1 FROM printing_positions p
            WHERE p.supply_id=? AND p.row_id=json_extract(c.value,'$.id')
              AND p.revision=json_extract(c.value,'$.revision')
          )
        )
      ON CONFLICT(id) DO NOTHING`).bind(plan.id,group.id,plan.signature,at,
      JSON.stringify(plan.payload),JSON.stringify(plan.result),JSON.stringify(plan.facts),token,
      group.id,group.status,changes,group.id));
    sql.push(db.prepare(`
      UPDATE printing_positions AS p SET
        payload=json_extract(c.value,'$.payload'), plan=json_extract(c.value,'$.plan'),
        printed=json_extract(c.value,'$.printed'), cut=json_extract(c.value,'$.cut'),
        cut_available=json_extract(c.value,'$.cutAvailable'), revision=p.revision+1
      FROM json_each(?) c
      WHERE p.supply_id=? AND p.row_id=json_extract(c.value,'$.id')
        AND EXISTS (SELECT 1 FROM printing_receipts WHERE id=? AND commit_token=?)`)
      .bind(changes,group.id,plan.id,token));
  }
  const applied=await db.batch(sql);
  return new Set(plans.filter((_,i)=>applied[i*2].meta.changes===1).map(plan=>plan.id));
}

function priorResult(prior, signature) {
  if (prior.fingerprint!==signature) throw workError('Этот ID уже относится к другой записи.');
  return JSON.parse(prior.outcome);
}

function validGroup(group,request) {
  return group?.department===request.department && group.status==='open';
}

async function writeBox(db, request) {
  const ids=request.items.map(item=>item.requestId);
  if (ids.length>BOX_GATEWAY_BATCH || new Set(ids).size!==ids.length) {
    return reject('Проверьте идентификаторы выбранных записей.');
  }
  for (let attempt=0; attempt<3; attempt++) {
    const {group,positions,receipts,people}=await currentState(db,request,ids);
    if (!validGroup(group,request)) return reject('Проверьте участок и открытую поставку.');
    const plans=[];
    const results=request.items.map(item=>{
      const position=positions.get(item.rowId);
      const id=item.requestId;
      const payload=[group.id,item], signature=digest(payload);
      try {
        const prior=receipts.get(id);
        if (prior) {
          const result=priorResult(prior,signature);
          return {...result,repeated:true,totals:position ? boxTotals(position.row) : result.totals,
            workRevision:position?.revision ?? result.workRevision};
        }
        if (attempt===2) throw workError('Остаток изменился. Обновите поставку.');
        const plan=recordBox(position,item,people.get(item.employeeId));
        plans.push({...plan,payload,signature,id});
        return plan.result;
      } catch (error) {
        if (!error.workRejected) throw error;
        return {ok:false,notSaved:true,rowId:item.rowId,article:position?.row.article,error:error.message};
      }
    });
    if (!plans.length) return response({results});
    const applied=await commit(db,group,plans);
    if (applied.size===plans.length) return response({results});
  }
  return reject('Остаток изменился. Обновите поставку.');
}

function confirmedRoll(patches) {
  return response({message:'Запись сохранена в журнале РИТМ.',confirmed:patches.length,patches});
}

async function writeRoll(db, request) {
  const {requestId,command,operation,items}=request;
  try {
    for (let attempt=0; attempt<3; attempt++) {
      const {group,positions,receipts}=await currentState(db,request,[requestId]);
      if (!validGroup(group,request)) return reject('Проверьте участок и открытую поставку.');
      const payload=[group.id,command,operation,items], signature=digest(payload);
      const prior=receipts.get(requestId);
      if (prior) {
        const result=priorResult(prior,signature);
        return confirmedRoll(result.rowIds.map(id=>{
          const {row,revision}=positions.get(id);
          return workPatch(row,revision);
        }));
      }
      if (attempt===2) break;
      const plan=rollPlan(group,request,positions);
      const applied=await commit(db,group,[{...plan,id:requestId,payload,signature}]);
      if (applied.size) return confirmedRoll(plan.changes.map(({row,revision})=>workPatch(row,revision+1)));
    }
    return reject('Остаток изменился. Обновите поставку.');
  } catch (error) {
    if (!error.workRejected) throw error;
    return reject(error.message);
  }
}

async function writeCorrection(db, request) {
  const {requestId,items,supplyId,department}=request;
  const [item]=items;
  const payload=[supplyId,'correct',items], signature=digest(payload);
  const confirmed=(row,revision)=>response({
    message:'Исправление сохранено в журнале РИТМ.',
    patches:[workPatch(row,revision)],
  });
  try {
    for (let attempt=0;attempt<3;attempt++) {
      const {group,positions,receipts}=await currentState(db,request,[requestId]);
      if (group?.department!==department || !knownSupply(group)) return reject('Проверьте участок и статус поставки.');
      const position=positions.get(item.rowId);
      if (!position) return reject('Артикул отсутствует в этой поставке.');
      const prior=receipts.get(requestId);
      if (prior) {
        priorResult(prior,signature);
        return confirmed(position.row,position.revision);
      }
      const plan=correctionPlan(position,request);
      const applied=await commit(db,group,[{...plan,id:requestId,payload,signature}]);
      if (applied.size) return confirmed(plan.changes[0].row,position.revision+1);
    }
    return reject('Артикул изменился. Обновите поставку и проверьте количество.');
  } catch (error) {
    if (!error.workRejected) throw error;
    return reject(error.message);
  }
}

export async function printingWrite(db, input) {
  const request=prepareCloudWrite(input);
  if (!request) return reject('Проверьте параметры записи.');
  if (request.command==='correct') return writeCorrection(db,request);
  return request.department==='box' ? writeBox(db,request) : writeRoll(db,request);
}
