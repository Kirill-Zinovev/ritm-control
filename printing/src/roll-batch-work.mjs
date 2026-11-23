import { matchesRoll, rollEmployee, rollTitle, workRemaining } from './printing-workflow.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0;

export function rollUnassigned(row) {
  if (!Array.isArray(row.rolls) || !count(row.plan)) return 0;
  return Math.max(0, row.plan - row.rolls.reduce((sum, roll) => sum + roll.quantity, 0));
}

export function rollWorkChoice(row, query, working) {
  const unassigned = rollUnassigned(row);
  const needsAssignment = !query.trim() && unassigned > 0 && (!count(row.printed) || row.printed < row.plan);
  const matchingPrint = !query.trim() || row.rolls?.some(roll =>
    !roll.legacyOnly && roll.quantity > roll.printed && matchesRoll(roll,query));
  const printRemaining = working && matchingPrint && count(row.plan) && count(row.printed)
    ? Math.max(0,row.plan-row.printed) : 0;
  return {
    row, printRemaining, unassigned, needsAssignment,
    print:working ? rollBatchEntries(row,'print',query) : [],
    cut:working ? rollBatchEntries(row,'cut',query) : [],
  };
}

export function rollChoiceMatches(choice, operation = '') {
  const printing = choice.print.length > 0 || choice.printRemaining > 0 || choice.needsAssignment;
  const cutting = choice.cut.length > 0;
  if (operation === 'print') return printing;
  if (operation === 'cut') return cutting;
  return choice.unassigned > 0 || printing || cutting;
}

function rowRemaining(row, operation) {
  if (!Array.isArray(row.rolls) || !count(row.plan) ||
      !Number.isFinite(row.areaPerPiece) || row.areaPerPiece <= 0) return 0;
  const total = field => row[field] ?? row.rolls.reduce((sum, roll) => sum + (count(roll[field]) ? roll[field] : NaN), 0);
  const printed = total('printed'), cut = total('cut');
  if (!count(printed) || (operation === 'cut' && !count(cut))) return 0;
  return workRemaining(operation, row.plan, Math.min(row.plan, printed), cut) ?? 0;
}

export function rollBatchQuantity(row, roll, operation, budget = rowRemaining(row, operation)) {
  if (!budget || roll.legacyOnly || !count(roll.quantity) || !count(roll.printed) ||
      (operation === 'cut' && !count(roll.cut))) return 0;
  const remaining = workRemaining(operation, roll.quantity, Math.min(roll.quantity, roll.printed), roll.cut);
  return Math.min(budget, remaining ?? 0);
}

export function rollBatchEntries(row, operation, query = '') {
  let budget = rowRemaining(row, operation);
  if (budget <= 0) return [];
  const entries = [];
  for (const roll of row.rolls) {
    if (!budget) break;
    if (query.trim() && !matchesRoll(roll, query)) continue;
    const quantity = rollBatchQuantity(row, roll, operation, budget);
    const employee = rollEmployee(roll, row, operation);
    if (!quantity || !employee) continue;
    entries.push({
      rowId:row.id, rollId:roll.id, quantity, expectedQuantity:roll.quantity,
      expectedActual:operation === 'cut' ? roll.cut : roll.printed,
      name:rollTitle(roll), employee,
    });
    budget -= quantity;
  }
  return entries;
}
