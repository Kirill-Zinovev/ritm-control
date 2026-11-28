const EPSILON = 1e-8;
export const MAX_ROLLS = 500;
export const normalize = value => String(value ?? '').trim().toLocaleLowerCase('ru');
export function rollSizeLabel(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu,' ')
    .replace(/(\d)\s*[xх×]\s*(?=\d)/giu,'$1 × ') : '';
}

export const operationNames = {take:'В работу',print:'Печать',cut:'Порезка'};

export function matchesArticle(row, query) {
  return normalize(row.article + ' ' + (row.name || '')).includes(query);
}

export function printEmployee(value) {
  const prefix = normalize(value).charAt(0);
  if (prefix === 'д' || prefix === 'd') return 'Дмитрий';
  if (prefix === 'а' || prefix === 'a') return 'Андрей';
  if (prefix === 'п' || prefix === 'p') return 'Паша';
  return '';
}

export function rollEmployee(roll, row, operation) {
  if (!roll) return '';
  if (operation === 'print') return printEmployee(roll.name) || printEmployee(roll.printEmployee);
  if (operation !== 'cut' || row.cutEmployeeCode == null) return '';
  const code = normalize(row.cutEmployeeCode).replace(/[^a-zа-я0-9]/gu,'');
  return !code || ['luk','lukman','лукман'].includes(code) ? 'Лукман' : '';
}

export function rollTitle(roll) {
  return [roll.name, Number(roll.number) > 1 ? '№' + roll.number : ''].filter(Boolean).join(' ');
}

export function matchesRoll(roll, query) {
  const value = normalize(query);
  if (!value) return false;
  if (normalize(roll.name) === value) return true;
  const spacingAroundNumber = /\s*№\s*/gu;
  return value.includes('№') &&
    normalize(rollTitle(roll)).replace(spacingAroundNumber,'№') === value.replace(spacingAroundNumber,'№');
}

export const isXerox = row => /^(xerox|ксерокс|x|х)$/iu.test(normalize(row.machine));

export function unitFactor(row, unit) {
  if (unit === 'pieces') return 1;
  if (unit !== 'sheets' || !isXerox(row)) return null;
  const {sheetsInProduct, multiplicity} = row;
  return Number.isSafeInteger(sheetsInProduct) && sheetsInProduct > 0 &&
    Number.isSafeInteger(multiplicity) && multiplicity > 0 ? multiplicity / sheetsInProduct : null;
}

export function localTotal(records, operation, rollId = '') {
  return records
    .filter(record => record.operation === operation && (record.rollId || '') === rollId)
    .reduce((sum, record) => sum + record.pieces, 0);
}

export function workRemaining(operation, plan, printed, cut) {
  if (!Number.isFinite(printed)) return null;
  if (operation === 'print' && Number.isFinite(plan)) return Math.max(0, plan - printed);
  if (operation === 'cut' && Number.isFinite(cut)) return Math.max(0, printed - cut);
  return null;
}

export function boxWorkEntry(row, records, operation, working) {
  if (working && !row.fingerprint) return {error:'Строка не подтверждена журналом'};
  const printed = row.printed == null ? null : row.printed + localTotal(records,'print');
  const cut = row.cut == null ? null : row.cut + localTotal(records,'cut');
  const remaining = workRemaining(operation,row.plan,printed,cut);
  if (remaining == null) return {error:'Остаток не подтверждён'};
  if (remaining <= EPSILON) return {error:operation === 'cut' ? 'Нет напечатанного остатка для порезки' : 'Весь тираж напечатан'};
  const sheetFactor = isXerox(row) ? unitFactor(row,'sheets') : 1;
  if (sheetFactor == null) return {error:'Количество листов не подтверждено'};
  const useSheets = isXerox(row) && (remaining + EPSILON >= sheetFactor || remaining + EPSILON < 1);
  const unit = useSheets ? 'sheets' : 'pieces';
  const factor = useSheets ? sheetFactor : 1;
  const quantity = Math.floor(remaining / factor + EPSILON);
  if (quantity < 1 || quantity > 1000000) return {error:'Количество нужно указать отдельно в карточке артикула'};
  return {quantity,unit,pieces:quantity * factor};
}

function printPlanComplete(row, records) {
  return Number.isSafeInteger(row.plan) && row.plan > 0 && Number.isFinite(row.printed) &&
    row.printed + localTotal(records,'print') >= row.plan - EPSILON;
}

export function takeRemaining(row, records) {
  if (printPlanComplete(row,records)) return 0;
  if (row.taken == null || !row.machine || !Number.isSafeInteger(row.plan) || row.plan < 1) return null;
  return Math.max(0, row.plan - row.taken - localTotal(records, 'take'));
}

export function boxTakeBlockReason(row, records, working) {
  if (printPlanComplete(row,records)) return 'План печати выполнен';
  const remaining = takeRemaining(row,records);
  if (remaining == null) return 'Остаток для взятия не подтверждён';
  if (remaining <= 1e-8) return 'Уже взято в работу';
  if (working && !row.fingerprint) return 'Строка не подтверждена журналом';
  return '';
}

const clipboardQuantity = new Intl.NumberFormat('ru-RU', {
  useGrouping:false, maximumFractionDigits:8,
});

export function boxSelectionText(rows, entryForRow) {
  const lines = [];
  for (const row of rows) {
    const entry = entryForRow(row);
    if (!Number.isFinite(entry?.pieces) || entry.pieces <= 0) {
      return {error:row.article+' — '+(entry?.error || 'Количество не подтверждено.')};
    }
    const article = String(row.article ?? '').trim();
    if (!article || /[\t\r\n]/u.test(article)) return {error:'Проверьте артикул выбранной позиции.'};
    const cell = /^[=+\-@]/u.test(article) ? "'"+article : article;
    lines.push(cell+'\t'+clipboardQuantity.format(entry.pieces));
  }
  return {text:lines.join('\n')};
}

export function takeEntry(row, records, draft = {}) {
  const remaining = takeRemaining(row, records);
  const valid = (quantity, unit, pieces) => ({quantity, unit, pieces});
  if (remaining == null) return {error:'Не подтверждён остаток для взятия в работу.'};
  const unit = isXerox(row) ? draft.unit || 'pieces' : 'pieces';
  const factor = unitFactor(row, unit);
  if (factor == null) return {error:'Нет кратности или количества листов на изделие.'};
  const raw = String(draft.quantity ?? '').trim();
  if (!raw) {
    if (remaining <= EPSILON) return {skip:true};
    const count = remaining / factor;
    if (Math.abs(count - Math.round(count)) <= EPSILON) return valid(Math.round(count), unit, remaining);
    const alternative = unit === 'sheets' ? 'pieces' : 'sheets';
    const alternativeFactor = unitFactor(row, alternative);
    const alternativeCount = alternativeFactor ? remaining / alternativeFactor : NaN;
    if (Math.abs(alternativeCount - Math.round(alternativeCount)) <= EPSILON) {
      return valid(Math.round(alternativeCount), alternative, remaining);
    }
    return {error:'Укажите целое количество листов или штук.'};
  }
  const quantity = Number(raw);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) {
    return {error:'Укажите целое количество от 1 до 1 000 000.'};
  }
  const pieces = quantity * factor;
  if (pieces - remaining > EPSILON) return {error:'Количество превышает доступный остаток.'};
  return valid(quantity, unit, pieces);
}

export function rollDraft(row, draft = {}, sharedName) {
  const assigned = row.rolls?.reduce((sum, roll) => sum + roll.quantity, 0);
  const name = String(sharedName ?? draft.name ?? '').trim();
  const quantity = String(draft.quantity ?? '').trim() ? Number(draft.quantity) : row.plan;
  const count = String(draft.count ?? '').trim() ? Number(draft.count) : 1;
  if (!Array.isArray(row.rolls)) return {error:'Список рулонов недоступен.'};
  if (!name || name.length > 60 || !printEmployee(name)) return {error:'Название должно начинаться с д, а или п.'};
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ROLLS ||
      !Number.isSafeInteger(quantity) || quantity < 1 || !Number.isSafeInteger(quantity * count)) {
    return {error:'Укажите целое количество штук и рулонов.'};
  }
  if (assigned + quantity * count > row.plan + EPSILON) {
    return {error:'Превышен остаток. Доступно ' + Math.max(0, row.plan - assigned) + ' шт.'};
  }
  return {name, quantity, count};
}

export function newRolls(row, {name, quantity, count}, supplyId) {
  const last = row.rolls
    .filter(roll => normalize(roll.name) === normalize(name))
    .reduce((max, roll) => Math.max(max, Number(roll.number) || 1), 0);
  return Array.from({length:count}, (_, index) => ({
    id:crypto.randomUUID(), supplyId, rowId:row.id, name, number:last + index + 1,
    quantity, printed:0, cut:0, local:true,
  }));
}
