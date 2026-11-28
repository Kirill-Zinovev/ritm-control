import { createHash, randomUUID } from 'node:crypto';
import { MAX_ROLLS, normalize } from '../src/printing-workflow.mjs';
import { validSupplyId } from '../src/workspace-write.mjs';
import { decorateRows } from './catalog.mjs';
import { json, readJson, sameOriginJson } from './http.mjs';
import { finishRollCut, progressFacts } from './workflow.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const count = value => Number.isSafeInteger(value) && value >= 0;
const compareText = (left, right) => left.localeCompare(right, 'ru', {numeric:true});
const reject = (message, status=409) => json({rejected:true,message},status);

function supplyOf(id) {
  if (typeof id!=='string') return null;
  const [supply,key,...extra]=id.split('/');
  return !extra.length && validSupplyId(supply) && hex.test(key??'') ? supply : null;
}

async function loadSupplies(db, ids) {
  const projection=ids ? 'p.payload' : `json_object('id',p.row_id,'article',json_extract(p.payload,'$.article'),
    'name',json_extract(p.payload,'$.name'),'catalogStore',json_extract(p.payload,'$.catalogStore'),
    'rolls',json_extract(p.payload,'$.rolls')) AS payload`;
  const positionFilter=ids ? '' : "AND json_array_length(p.payload,'$.rolls')>0";
  const supplyFilter=ids ? 'AND s.id IN (SELECT value FROM json_each(?))' : '';
  const selection=db.prepare(`
    SELECT s.id,s.name,s.status,s.market,p.row_id AS rowId,p.revision,${projection}
    FROM printing_supplies s LEFT JOIN printing_positions p ON p.supply_id=s.id ${positionFilter}
    WHERE s.department='roll' ${supplyFilter}
    ORDER BY s.sort_order,p.sort_order`);
  const {results}=await (ids ? selection.bind(JSON.stringify(ids)) : selection).all();
  const supplies=new Map();
  for (const value of results) {
    if (!supplies.has(value.id)) supplies.set(value.id,{id:value.id,name:value.name,status:value.status,market:value.market,rows:[],revision:0});
    const supply=supplies.get(value.id);
    if (value.rowId!=null) {
      supply.rows.push({row:JSON.parse(value.payload),revision:value.revision});
      supply.revision+=value.revision;
    }
  }
  return supplies;
}

function supplyRolls(supply) {
  const rolls=new Map();
  for (const position of supply.rows) {
    const {row}=position;
    for (const roll of row.rolls??[]) {
      const name=normalize(roll.name);
      if (!name || !roll.id) continue;
      const number=Math.max(1,Number(roll.number)||1);
      const key=JSON.stringify([name,number]);
      if (!rolls.has(key)) rolls.set(key,{name:String(roll.name).trim(),number,positions:[]});
      const group=rolls.get(key);
      // The same imported legacy entry can be mapped into more than one order row.
      if (roll.legacyOnly && group.positions.some(item=>item.roll.id===roll.id)) continue;
      group.positions.push({position,roll});
    }
  }
  return [...rolls].flatMap(([key,group])=>{
    if (group.positions.some(({roll})=>!count(roll.quantity) || roll.quantity===0)) return [];
    const completed=group.positions.every(({roll})=>count(roll.cut) && roll.cut>=roll.quantity);
    const ready=supply.status==='open' && group.positions.every(({roll})=>
      count(roll.printed) && roll.printed>=roll.quantity && count(roll.cut) &&
      (!roll.legacyOnly || roll.cut>=roll.quantity));
    if (!completed && !ready) return [];
    const items=group.positions.map(({position:{row},roll})=>{
      const cut=Math.min(roll.quantity,roll.cut);
      return {article:row.article,name:row.name,quantity:roll.quantity,cut,remaining:roll.quantity-cut};
    });
    const quantity=items.reduce((sum,item)=>sum+item.quantity,0);
    const cut=items.reduce((sum,item)=>sum+item.cut,0);
    const revision=digest(group.positions.map(({position:{row},roll})=>
      [row.id,roll.id,roll.quantity,roll.printed,roll.cut]).sort((left,right)=>
      compareText(left[0],right[0]) || compareText(left[1],right[1])));
    const summary={
      id:supply.id+'/'+digest(key),revision,name:group.name,number:group.number,
      supplyId:supply.id,supplyName:supply.name,quantity,cut,remaining:quantity-cut,items,completedAt:null,
    };
    return [{summary,completed,positions:group.positions}];
  });
}

async function historicCutTimes(db, completed) {
  const missing=completed.flatMap(group=>group.positions.filter(({roll})=>!roll.cutAt)
    .map(({roll})=>[group.summary.supplyId,roll.id]));
  if (!missing.length) return new Map();
  const supplyIds=[...new Set(missing.map(([id])=>id))];
  const rollIds=[...new Set(missing.map(([,id])=>id))];
  const {results}=await db.prepare(`
    SELECT r.supply_id AS supplyId,json_extract(f.value,'$.rollId') AS rollId,max(r.recorded_at) AS at
    FROM printing_receipts r JOIN printing_supplies s ON s.id=r.supply_id, json_each(r.facts) f
    WHERE s.department='roll' AND json_extract(f.value,'$.operation')='cut'
      AND coalesce(json_extract(f.value,'$.correction'),0)=0 AND json_extract(f.value,'$.pieces')>0
      AND r.supply_id IN (SELECT value FROM json_each(?))
      AND json_extract(f.value,'$.rollId') IN (SELECT value FROM json_each(?))
    GROUP BY r.supply_id,rollId`).bind(JSON.stringify(supplyIds),JSON.stringify(rollIds)).all();
  return new Map(results.map(value=>[JSON.stringify([value.supplyId,value.rollId]),value.at]));
}

async function decorateRollItems(db, supplies, rolls) {
  const byMarket=new Map();
  for (const {summary,positions} of rolls) {
    const {market,name:supplyName}=supplies.get(summary.supplyId);
    if (!market) continue;
    if (!byMarket.has(market)) byMarket.set(market,new Map());
    const byRow=byMarket.get(market);
    positions.forEach(({position:{row}},index)=>{
      if (!byRow.has(row)) byRow.set(row,{article:row.article,name:row.name,catalogStore:row.catalogStore,supplyName,items:[]});
      byRow.get(row).items.push(summary.items[index]);
    });
  }
  await Promise.all([...byMarket].map(async ([market,byRow])=>{
    const rows=[...byRow.values()];
    const decorated=await decorateRows(db,{market},rows);
    decorated.forEach(({name,items})=>{ for (const item of items) item.name=name; });
  }));
}

async function cutterFeed(db) {
  const data=await loadSupplies(db);
  const supplies=[], ready=[], completed=[];
  for (const supply of data.values()) {
    const rolls=supplyRolls(supply);
    let remaining=0;
    for (const roll of rolls) {
      if (roll.completed) completed.push(roll);
      else {
        ready.push(roll);
        remaining++;
      }
    }
    if (supply.status==='open' || rolls.length) supplies.push({id:supply.id,name:supply.name,remaining});
  }
  const [times]=await Promise.all([historicCutTimes(db,completed),decorateRollItems(db,data,[...ready,...completed])]);
  const history=completed.map(({summary,positions})=>{
    const timesForRoll=positions.map(({roll})=>
      roll.cutAt || times.get(JSON.stringify([summary.supplyId,roll.id]))).filter(Boolean);
    return {...summary,completedAt:timesForRoll.sort().at(-1)??null};
  });
  const byName=(left,right)=>compareText(left.name,right.name) || left.number-right.number;
  history.sort((left,right)=>compareText(right.completedAt??'',left.completedAt??'') || byName(left,right));
  return {supplies,ready:ready.map(roll=>roll.summary).sort(byName),completed:history};
}

function validInput(body) {
  return typeof body?.requestId==='string' && uuid.test(body.requestId) && Array.isArray(body.rolls) &&
    body.rolls.length>0 && body.rolls.length<=MAX_ROLLS &&
    body.rolls.every(roll=>supplyOf(roll?.id) && typeof roll.revision==='string' && hex.test(roll.revision)) &&
    new Set(body.rolls.map(roll=>roll.id)).size===body.rolls.length;
}

function planCuts(selected, employee, at) {
  const changes=new Map(), facts=[];
  for (const {positions} of selected) {
    for (const {position,roll} of positions) {
      if (roll.cut>=roll.quantity) continue;
      const current=changes.get(position.row.id)??position.row;
      const {row,fact}=finishRollCut(current,roll,employee,at);
      changes.set(row.id,row);
      facts.push(fact);
    }
  }
  return {changes:[...changes.values()].map(row=>({
    id:row.id,payload:JSON.stringify(row),...progressFacts(row,'roll'),
  })),facts};
}

async function commitCuts(db, requestId, signature, at, result, plans) {
  const token=randomUUID();
  const receipts=plans.map(({supply,facts},index)=>({
    supplyId:supply.id,id:index===0 ? requestId : requestId+':'+index,
    facts:JSON.stringify(facts),
  }));
  const expected=plans.map(({supply})=>({
    id:supply.id,revision:supply.revision,positions:supply.rows.length,
  }));
  const changes=plans.flatMap(({supply,changes})=>changes.map(change=>({...change,supplyId:supply.id})));
  // Guard every affected supply before recording any operation. The D1 batch keeps
  // receipts and position updates together even when the selection spans supplies.
  const [reservation]=await db.batch([
    db.prepare(`
      INSERT INTO printing_receipts(id,supply_id,fingerprint,recorded_at,payload,outcome,facts,commit_token)
      SELECT ?,?,?,?,'[]',?,?,?
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (
          SELECT 1 FROM printing_supplies s JOIN printing_positions p ON p.supply_id=s.id
          WHERE s.id=json_extract(e.value,'$.id') AND s.department='roll' AND s.status='open'
          GROUP BY s.id
          HAVING count(*)=json_extract(e.value,'$.positions') AND sum(p.revision)=json_extract(e.value,'$.revision')
        )
      )
      ON CONFLICT(id) DO NOTHING`).bind(requestId,receipts[0].supplyId,signature,at,JSON.stringify(result),
      receipts[0].facts,token,JSON.stringify(expected)),
    db.prepare(`
      INSERT INTO printing_receipts(id,supply_id,fingerprint,recorded_at,payload,outcome,facts,commit_token)
      SELECT json_extract(r.value,'$.id'),json_extract(r.value,'$.supplyId'),?,?,'[]','{}',
        json_extract(r.value,'$.facts'),?
      FROM json_each(?) r
      WHERE EXISTS (SELECT 1 FROM printing_receipts WHERE id=? AND commit_token=?)`)
      .bind(signature,at,token,JSON.stringify(receipts.slice(1)),requestId,token),
    db.prepare(`
      UPDATE printing_positions AS p SET
        payload=json_extract(c.value,'$.payload'),plan=json_extract(c.value,'$.plan'),
        printed=json_extract(c.value,'$.printed'),cut=json_extract(c.value,'$.cut'),
        cut_available=json_extract(c.value,'$.cutAvailable'),revision=p.revision+1
      FROM json_each(?) c
      WHERE p.supply_id=json_extract(c.value,'$.supplyId') AND p.row_id=json_extract(c.value,'$.id')
        AND EXISTS (SELECT 1 FROM printing_receipts WHERE id=? AND commit_token=?)`)
      .bind(JSON.stringify(changes),requestId,token),
  ]);
  return reservation.meta.changes===1;
}

async function writeCuts(db, body, employee) {
  const {requestId}=body;
  const selection=new Map(body.rolls.map(({id,revision})=>[id,revision]));
  const signature=digest(['cutter',[...selection].sort()]);
  const supplyIds=[...new Set([...selection.keys()].map(supplyOf))];
  for (let attempt=0;attempt<3;attempt++) {
    const prior=await db.prepare('SELECT fingerprint,outcome FROM printing_receipts WHERE id=?').bind(requestId).first();
    if (prior) return prior.fingerprint===signature ? json(JSON.parse(prior.outcome)) :
      reject('Этот ID уже относится к другой записи.');
    const supplies=await loadSupplies(db,supplyIds);
    const at=new Date().toISOString();
    const plans=[];
    let selectedCount=0,quantity=0;
    for (const supply of supplies.values()) {
      const selected=supplyRolls(supply).filter(({summary,completed})=>
        !completed && summary.revision===selection.get(summary.id));
      if (!selected.length) continue;
      selectedCount+=selected.length;
      quantity+=selected.reduce((sum,{summary})=>sum+summary.remaining,0);
      plans.push({supply,...planCuts(selected,employee,at)});
    }
    if (selectedCount!==selection.size) {
      // An identical in-flight request may have completed while the positions were read.
      const settled=await db.prepare('SELECT fingerprint,outcome FROM printing_receipts WHERE id=?').bind(requestId).first();
      if (settled?.fingerprint===signature) return json(JSON.parse(settled.outcome));
      break;
    }
    const result={message:'Порезка записана.',recorded:selectedCount,quantity};
    if (await commitCuts(db,requestId,signature,at,result,plans)) return json(result);
  }
  return reject('Состав или статус рулонов изменился. Обновите очередь и выберите рулоны снова.');
}

export async function printingCutter(db, request, employee) {
  if (request.method==='GET') return json(await cutterFeed(db));
  if (request.method!=='POST') return reject('Метод недоступен.',405);
  if (!sameOriginJson(request)) return reject('Откройте рабочее место резчика.',403);
  const body=await readJson(request,260_000);
  if (!validInput(body)) return reject('Проверьте выбранные рулоны.',400);
  return writeCuts(db,body,employee);
}
