import { isXerox, newRolls, normalize, rollDraft, rollEmployee, takeRemaining, unitFactor, workRemaining } from '../src/printing-workflow.mjs';
import { rollCutAvailable, summarizeShipment } from '../src/shipment-progress.mjs';
import { rollBatchQuantity } from '../src/roll-batch-work.mjs';

const epsilon = 1e-8;
const fields = {take:'taken',print:'printed',cut:'cut'};
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const sum = (rolls,key) => rolls.reduce((total,roll)=>total+roll[key],0);

function clearCutterStart(roll) {
  delete roll.cutterStart;
  return roll;
}

export const workError = message => Object.assign(new Error(message),{workRejected:true});

export function progressFacts(row, department) {
  const plan=number(row.plan), printed=number(row.printed), cut=number(row.cut);
  const cutAvailable=department==='roll'
    ? rollCutAvailable(row.rolls,printed,cut)
    : printed!=null && cut!=null ? Math.max(0,printed-cut) : null;
  return {plan,printed,cut,cutAvailable};
}

export function summarize(group, positions) {
  const progress=summarizeShipment(positions);
  const completed=group.status==='open' && progress.total>0 &&
    progress.printed===progress.total && (group.department==='roll' || progress.cut===progress.total);
  return {
    id:group.id, name:group.name, department:group.department, sourceUrl:'',
    status:completed?'completed':group.status, count:progress.total, progress,
  };
}

function fact(row, operation, employee, pieces, sheets, {unit='pieces',quantity=pieces,roll}={}) {
  return {
    operation,employee,pieces,sheets,unit,quantity,rollId:roll?.id??null,rollName:roll?.name??'',
    area:operation!=='take' && number(row.areaPerPiece)!=null ? row.areaPerPiece*pieces : null,
    article:row.article,
  };
}

export function boxTotals(row) {
  const factor=isXerox(row) ? unitFactor(row,'sheets') : 1;
  return Object.fromEntries(Object.values(fields).map(key=>[key,row[key]/factor]));
}

export function recordBox(position, item, employee) {
  const row=position?.row;
  if (!row?.fingerprint || row.fingerprint!==item.fingerprint || !employee) {
    throw workError('Обновите поставку и подтвердите сотрудника.');
  }
  const factor=unitFactor(row,item.unit);
  const sheets=isXerox(row) ? unitFactor(row,'sheets') : null;
  const remaining=item.action==='take' ? takeRemaining(row,[]) : workRemaining(item.action,row.plan,row.printed,row.cut);
  const pieces=item.quantity*factor;
  if (!factor || (isXerox(row) && !sheets) || number(remaining)==null || pieces-remaining>epsilon) {
    throw workError('Количество превышает доступный остаток.');
  }
  const key=fields[item.action];
  const next={...row,[key]:row[key]+pieces};
  return {
    changes:[{row:next,revision:position.revision}],
    result:{ok:true,rowId:row.id,article:row.article,totals:boxTotals(next),workRevision:position.revision+1},
    facts:[fact(row,item.action,employee,pieces,sheets?pieces/sheets:null,item)],
  };
}

function allocate(group, items, positions) {
  return items.map(item=>{
    const position=positions.get(item.rowId);
    const row=position?.row;
    if (!Array.isArray(row?.rolls) || row.plan!==item.expectedPlan || sum(row.rolls,'quantity')!==item.expectedAllocated) {
      throw workError('План или распределение рулонов изменились. Обновите поставку.');
    }
    const draft=rollDraft(row,item);
    if (draft.error) throw workError(draft.error);
    const added=newRolls(row,draft,group.id).map(({id,name,number,quantity,printed,cut})=>({id,name,number,quantity,printed,cut}));
    return {row:{...row,rolls:[...row.rolls,...added]},revision:position.revision};
  });
}

function recordRoll(position, operation, item, batch) {
  const row=position?.row;
  const roll=row?.rolls?.find(value=>value.id===item.rollId);
  const employee=rollEmployee(roll,row,operation);
  const key=fields[operation];
  if (!roll || !employee || roll.quantity!==item.expectedQuantity || roll[key]!==item.expectedActual) {
    throw workError('Рулон или его остаток изменились. Обновите поставку.');
  }
  if (!(row.areaPerPiece>0) || number(row.areaPerPiece)==null) throw workError('Проверьте листы на изделие, ширину и высоту.');
  const remaining=batch ? rollBatchQuantity(row,roll,operation) : workRemaining(operation,roll.quantity,roll.printed,roll.cut);
  if (number(remaining)==null || item.quantity>remaining) throw workError('Количество превышает доступный остаток рулона.');
  const nextRoll=clearCutterStart({...roll,[key]:roll[key]+item.quantity});
  if (operation==='print') nextRoll.printEmployee=employee;
  const next={...row,[key]:(row[key]??sum(row.rolls,key))+item.quantity,
    rolls:row.rolls.map(value=>value.id===roll.id?nextRoll:value)};
  return {row:next,revision:position.revision,fact:fact(row,operation,employee,item.quantity,null,{roll})};
}

function recordRolls(request, positions) {
  const changes=new Map();
  const facts=[];
  for (const item of request.items) {
    const position=changes.get(item.rowId) ?? positions.get(item.rowId);
    const {fact,...change}=recordRoll(position,request.operation,item,request.command==='work-many');
    changes.set(item.rowId,change);
    facts.push(fact);
  }
  return {changes:[...changes.values()],facts};
}

export function rollPlan(group, request, positions) {
  const {command,items}=request;
  const change=command==='create'
    ? {changes:allocate(group,items,positions),facts:[]}
    : recordRolls(request,positions);
  return {...change,result:{rowIds:change.changes.map(({row})=>row.id)}};
}

export const workPatch = ({id,printed,cut,cutEmployeeCode,rolls},workRevision) =>
  ({id,printed,cut,cutEmployeeCode,rolls,workRevision});

function editedProgress(base, item, plan) {
  const printed=item.printed ?? base.printed;
  const cut=item.cut ?? base.cut;
  if (item.printed!==undefined && number(plan)!=null && printed-Math.max(plan,base.printed??0)>epsilon) {
    throw workError('Напечатанное количество превышает план.');
  }
  if ((printed!==base.printed || cut!==base.cut) && cut>0 &&
      (number(printed)==null || cut-printed>epsilon)) {
    throw workError('Укажите порезку в пределах напечатанного количества.');
  }
  return {printed,cut};
}

function correctionFacts(row, before, after, roll) {
  const factor=isXerox(row) ? unitFactor(row,'sheets') : null;
  return ['print','cut'].flatMap(operation=>{
    const field=fields[operation];
    const previous=number(before[field]), current=number(after[field]);
    if (previous===current) return [];
    const pieces=previous==null || current==null ? null : current-previous;
    return [{
      ...fact(row,operation,'',pieces,pieces==null || !factor ? null : pieces/factor,{roll}),
      area:pieces==null || number(row.areaPerPiece)==null ? null : row.areaPerPiece*pieces,
      correction:true,before:previous,after:current,
    }];
  });
}

function resetRollProgress(row, operation) {
  const key=fields[operation];
  const reset={[key]:0};
  const next={...row,...reset};
  const facts=correctionFacts(row,row,next);
  if (Array.isArray(row.rolls)) {
    next.rolls=row.rolls.map(roll=>roll.legacyOnly || roll[key]===0 ? roll : clearCutterStart({...roll,...reset}));
    const rollFacts=row.rolls.flatMap((roll,index)=>correctionFacts(row,roll,next.rolls[index],roll));
    for (const entry of facts) {
      entry.rolls=rollFacts.filter(roll=>roll.operation===entry.operation)
        .map(({rollId,rollName,before,after})=>({rollId,rollName,before,after}));
    }
    facts.push(...rollFacts.filter(roll=>!facts.some(entry=>entry.operation===roll.operation)));
  }
  return {row:next,facts};
}

function updatedRollTotal(row, rolls, field) {
  const before=sum(row.rolls.filter(roll=>!roll.legacyOnly),field);
  const after=sum(rolls.filter(roll=>!roll.legacyOnly),field);
  if (before===after) return row[field];
  const total=row[field] ?? before;
  // Some imported article totals were capped at plan even when rolls exceeded it.
  return total===row.plan && before>row.plan ? Math.min(total,after) : Math.max(0,total+after-before);
}

export function finishRollCut(row, roll, employee, at) {
  const pieces=roll.quantity-roll.cut;
  const rolls=row.rolls.map(value=>value.id===roll.id ? clearCutterStart({...value,cut:roll.quantity,cutAt:at}) : value);
  const recorded=updatedRollTotal(row,rolls,'cut') ?? (row.cut??0)+pieces;
  const cut=Math.max(row.cut??0,Math.min(recorded,row.printed??recorded));
  return {row:{...row,rolls,cut},fact:fact(row,'cut',employee,pieces,null,{roll})};
}

function editRoll(row, item) {
  const roll=row.rolls?.find(value=>value.id===item.rollId);
  if (!roll || roll.legacyOnly) throw workError('Выберите назначенный рулон этого артикула.');
  const quantity=item.quantity ?? roll.quantity;
  const name=item.name ?? roll.name;
  const progress=editedProgress(roll,item,quantity);
  if (quantity!==roll.quantity) {
    const assigned=sum(row.rolls,'quantity');
    if (assigned-roll.quantity+quantity>Math.max(assigned,row.plan??assigned)) {
      throw workError('Количество на рулонах превысит план артикула.');
    }
    if (quantity<Math.max(progress.printed??0,progress.cut??0)) {
      throw workError('Укажите количество на рулоне не меньше выполненного объёма.');
    }
  }
  const sameGroup=normalize(name)===normalize(roll.name);
  const numberInGroup=sameGroup ? roll.number :
    1+row.rolls.reduce((max,value)=>value.id!==roll.id && normalize(value.name)===normalize(name)
      ? Math.max(max,Number(value.number)||1) : max,0);
  const nextRoll={...roll,...progress,name,quantity,number:numberInGroup};
  if (!sameGroup || quantity!==roll.quantity || nextRoll.printed!==roll.printed || nextRoll.cut!==roll.cut) {
    clearCutterStart(nextRoll);
  }
  const rolls=row.rolls.map(value=>value.id===roll.id ? nextRoll : value);
  const next={...row,rolls,printed:updatedRollTotal(row,rolls,'printed'),cut:updatedRollTotal(row,rolls,'cut')};
  const facts=correctionFacts(row,roll,nextRoll,roll);
  if (facts.length && number(next.printed)!=null && number(next.cut)!=null && next.cut-next.printed>epsilon) {
    throw workError('Исправьте порезку, чтобы она укладывалась в печать по артикулу.');
  }
  if (name!==roll.name || quantity!==roll.quantity) {
    facts.push({
      operation:'roll-edit',correction:true,article:row.article,employee:'',
      rollId:roll.id,rollName:name,beforeName:roll.name,afterName:name,
      unit:'pieces',quantity:quantity-roll.quantity,area:null,before:roll.quantity,after:quantity,
    });
  }
  return {row:next,facts};
}

export function correctionPlan(position, request) {
  const [item]=request.items;
  if (!position || position.revision!==item.revision) throw workError('Артикул изменился. Проверьте свежие данные перед сохранением.');
  const {row,revision}=position;
  let change;
  if (request.department==='box') {
    const next={...row,...editedProgress(row,item,row.plan)};
    change={row:next,facts:correctionFacts(row,row,next)};
  } else {
    if (item.reset==='print' && (row.cut>0 || row.rolls?.some(roll=>!roll.legacyOnly && roll.cut>0))) {
      throw workError('Печать нельзя отменить, когда порезка уже записана.');
    }
    change=item.reset ? resetRollProgress(row,item.reset) : editRoll(row,item);
  }
  if (!change.facts.length) throw workError('Количество и название уже сохранены.');
  return {changes:[{row:change.row,revision}],facts:change.facts,result:{rowId:row.id}};
}
