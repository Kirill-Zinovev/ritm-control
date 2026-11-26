import { createHash } from 'node:crypto';
import { routeAssemblyCatalogLines, routeSupplyLines } from './productionSupplies.js';
import { quantityRounding } from './quantityRounding.js';
import { xeroxPlanRounding, xeroxSheetCount, xeroxUnits } from './xeroxQuantity.js';

const keyOf = value => String(value || '').trim().toUpperCase().replace(/\(OZ\)$/u, '').trim();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function stockRounding(rounding, previousQuantity) {
  return rounding && {...rounding,choices:rounding.choices.map(({quantity,...option})=>({
    ...option,quantity:quantity-previousQuantity,newQuantity:quantity,
  }))};
}

const roundingError = message => Object.assign(new Error(message), {code:'stock_rounding_required',status:409});

export function applyStockRounding(changes, decisions = []) {
  if (!Array.isArray(decisions) || decisions.length > changes.length)
    throw roundingError('Проверьте выбранное округление ещё раз.');
  const byArticle = new Map();
  for (const decision of decisions) {
    const article = typeof decision?.article === 'string' ? keyOf(decision.article) : '';
    if (!article || byArticle.has(article) || !['up','down'].includes(decision.direction))
      throw roundingError('Проверьте выбранное округление ещё раз.');
    byArticle.set(article, decision.direction);
  }
  const result = changes.map(({quantityRule, ...change}) => {
    if (!change.rounding) return change;
    const {rounding, ...item} = change;
    const key = keyOf(item.article);
    const chosen = rounding.choices.find(option => option.direction === byArticle.get(key));
    if (!chosen) throw roundingError(`Выберите округление для «${item.article}».`);
    byArticle.delete(key);
    if (chosen.quantity === 0)
      return {...item, quantity:0, newQuantity:chosen.newQuantity, action:'skip', issue:'По выбранному округлению добавление равно нулю.'};
    return {...item, quantity:chosen.quantity, newQuantity:chosen.newQuantity, ...(rounding.kind!=='roll' && {xeroxRoundingProof:{
      factor:rounding.factor, multiplicity:rounding.multiplicity, sheets:chosen.sheets,
    }})};
  });
  if (byArticle.size) throw roundingError('Состав округления изменился. Проверьте список заново.');
  return result;
}

// Only confirmed quantities can be used to recalculate a changed plan. Keep
// source event dates untouched; completion dates are derived projections.
export function recalculateStockReadiness({department, planPieces, xerox=false, factor=1, multiplicity=1, printed, cut, printDate='', cutDate='', printRolls=null, cutRolls=null}) {
  if(!['box','roll'].includes(department)||!Number.isSafeInteger(planPieces)||planPieces<=0||!Number.isFinite(printed)||printed<0||!Number.isFinite(cut)||cut<0)
    throw new Error('Не подтверждены план или фактическая выработка.');
  if(department==='box') {
    if(xerox&&(!Number.isSafeInteger(factor)||factor<=0||!Number.isSafeInteger(multiplicity)||multiplicity<=0))throw new Error('Не подтверждена кратность Xerox.');
    const plan=xerox?xeroxSheetCount(planPieces,factor,multiplicity):planPieces;
    if(plan===null)throw roundingError('План Xerox не соответствует целому числу листов. Проверьте кратность и количество.');
    const printing=printed>=plan, cutting=cut>=plan;
    return {plan,printing,cutting,printDate:printing?printDate:'',cutDate:cutting?cutDate:'',printRatio:Math.min(1,printed/plan),cutRatio:Math.min(1,cut/plan)};
  }
  function stage(actual,rolls,date){
    if(!rolls||!Number.isSafeInteger(rolls.total)||!Number.isSafeInteger(rolls.ready)||rolls.total<0||rolls.ready<0||rolls.ready>rolls.total)throw new Error('Не подтверждены состояния рулонов.');
    const complete=rolls.total>0&&rolls.ready===rolls.total&&actual>=planPieces&&!!date;
    const quantityFraction=Math.min(1,actual/planPieces),readyFraction=rolls.total?rolls.ready/rolls.total:0;
    return {actual,complete,percent:complete?100:Math.min(99,Math.floor(Math.min(quantityFraction,readyFraction)*100)),date:complete?date:''};
  }
  return {plan:planPieces,printing:stage(printed,printRolls,printDate),cutting:stage(cut,cutRolls,cutDate),remainingPrint:planPieces-printed};
}

// Pure preview: caller must re-read and compare fingerprint immediately before
// writing. No source rows, work history or readiness flags are changed here.
export function planStockAddition({ destination, lines, catalog, existing }) {
  if (!['warehouse', 'urgent'].includes(destination)) throw new Error('Выберите назначение запасов.');
  if (!Array.isArray(lines) || !lines.length || lines.length > 500) throw new Error('Добавьте от 1 до 500 артикулов.');
  const combined = new Map();
  for (const line of lines) {
    const article = String(line.article || '').trim(), key = keyOf(article), quantity = Number(line.quantity);
    if (!key || !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Укажите артикул и целое положительное количество.');
    const prior = combined.get(key);
    const total = (prior?.quantity || 0) + quantity;
    if (!Number.isSafeInteger(total)) throw new Error('Количество слишком велико.');
    combined.set(key, { article: prior?.article || article, quantity: total });
  }
  const byDepartment = { roll: new Map(), box: new Map() };
  for (const department of ['roll', 'box']) {
    if (!Array.isArray(existing?.[department])) throw new Error('Не удалось проверить текущие запасы участка.');
    for (const row of existing[department]) {
      const key = keyOf(row.article);
      if (!key) continue;
      const map = byDepartment[department];
      if (map.has(key)) throw new Error(`Артикул «${row.article}» повторяется на листе ${department}. Нужна сверка.`);
      if (!Number.isSafeInteger(row.row) || row.row < 5 || !Number.isSafeInteger(row.quantity) || row.quantity < 0)
        throw new Error(`Не подтверждён план артикула «${row.article}».`);
      map.set(key, row);
    }
  }
  // Stocks are OZON-only: an absent OZON machine must not silently use WB.
  const routed = Array.isArray(catalog) ? routeAssemblyCatalogLines([...combined.values()], catalog, 'OZON', {stock:true}) : routeSupplyLines([...combined.values()], 'OZON', {
    ...catalog, WB: [['Артикул', 'Вид станка по умолчанию']],
  });
  const changes = routed.map(line => {
    if (!line.department) return {...line, action:'skip'};
    const key = keyOf(line.article), other = line.department === 'box' ? 'roll' : 'box';
    if (byDepartment[other].has(key)) return {...line, action:'skip', issue:'Артикул уже есть в другом участке; нужна сверка станка.'};
    const current = byDepartment[line.department].get(key);
    const previousQuantity = current?.quantity ?? 0;
    const newQuantity = previousQuantity + line.quantity;
    if (!Number.isSafeInteger(newQuantity)) throw new Error(`Сумма количества «${line.article}» слишком велика.`);
    const bounds={minimum:previousQuantity,maximum:Number.MAX_SAFE_INTEGER};
    let format=current?.xerox, rounding, quantityRule;
    if(line.assemblyCatalog && line.department==='roll') {
      const multiplicity=line.stockMultiplicity;
      if(!multiplicity)
        return {...line,action:'skip',issue:'Укажите кратность рулонной печати в справочнике Assembly и проверьте список заново.'};
      quantityRule = {kind:'roll',multiplicity,step:multiplicity};
      const choices=quantityRounding(newQuantity,multiplicity,bounds);
      if(choices)rounding={kind:'roll',multiplicity,choices};
    } else if(line.assemblyCatalog && /^XEROX$/i.test(line.machine)) {
      const factor=line.sheetsPerUnit,multiplicity=line.stockMultiplicity;
      if(!factor || !multiplicity)
        return {...line,action:'skip',issue:'Укажите листы на изделие и кратность Xerox в справочнике Assembly.'};
      if(current && (!format || format.factor!==factor || format.multiplicity!==multiplicity))
        return {...line,action:'skip',issue:'Параметры Xerox в рабочей строке отличаются от справочника Assembly. Нужна сверка.'};
      format={factor,multiplicity};
    } else if(line.assemblyCatalog && format) {
      return {...line,action:'skip',issue:'Станок в рабочей строке отличается от справочника Assembly. Нужна сверка.'};
    }
    if(format) {
      const {factor, multiplicity} = format;
      const units = xeroxUnits(factor, multiplicity);
      if (units) quantityRule = {kind:'xerox',multiplicity,step:units.pieceStep,sheets:xeroxSheetCount(newQuantity,factor,multiplicity)};
      const xerox=xeroxPlanRounding(newQuantity,factor,multiplicity,bounds);
      if(xerox)rounding={...xerox,kind:'xerox'};
    }
    return {...line, action:current?'increase':'insert', ...(current && {row:current.row}), previousQuantity, newQuantity,
      ...(quantityRule && {quantityRule}),
      ...(rounding && {rounding:stockRounding(rounding,previousQuantity)})};
  });
  // Worksheet norms enter the fingerprint through the shown choices. Keep
  // signatures for unaffected lists compatible with the existing form.
  const sourcePlans = Object.fromEntries(Object.entries(existing).map(([department, rows]) =>
    [department, rows.map(({row, article, quantity}) => ({row, article, quantity}))]));
  return { destination, marketplace:'OZON', changes, fingerprint:digest({
    destination, existing:sourcePlans, changes:changes.map(({photoUrl,quantityRule,...change})=>change),
  }) };
}
