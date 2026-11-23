import { isXerox, unitFactor } from './printing-workflow.mjs';

const epsilon = 1e-8;
const fact = value => Number.isFinite(value) && value >= 0 ? value : null;

export function shipmentOrderFacts(order) {
  const plan = fact(order.quantity);
  const table = {plan, printed:fact(order.printProgress ?? order.planningPrinted), cut:fact(order.cutProgress ?? order.planningCut)};
  if (!order.planningPhysicalUnits) return table;

  const machine = {...order, machine:order.machine || order.planningMachine};
  const factor = isXerox(machine) ? unitFactor(machine,'sheets') : 1;
  const physical = (value, fallback) => {
    if (value == null) return fallback;
    return factor == null || fact(value) == null ? null : value * factor;
  };
  return {...table, printed:physical(order.planningPrinted,table.printed), cut:physical(order.planningCut,table.cut)};
}

export function summarizeShipment(positions) {
  const progress = {
    total:0, printed:0, cut:0, printKnown:0, cutKnown:0,
    toPrint:0, canCut:0, cutAvailabilityUnknown:0,
  };
  for (const {plan,printed,cut,cutAvailable} of positions) {
    progress.total++;
    if (!(plan > 0)) { progress.cutAvailabilityUnknown++; continue; }

    if (fact(printed) != null) {
      progress.printKnown++;
      if (printed + epsilon >= plan) progress.printed++;
      else progress.toPrint++;
    }
    if (fact(cut) != null) {
      progress.cutKnown++;
      if (cut + epsilon >= plan) { progress.cut++; continue; }
    }

    const available = cutAvailable === undefined && fact(printed) != null && fact(cut) != null
      ? Math.min(plan,printed) - cut : cutAvailable;
    if (available == null) progress.cutAvailabilityUnknown++;
    else if (available > epsilon) progress.canCut++;
  }
  return progress;
}

export function rollCutAvailable(rolls, printed, cut) {
  if (!Array.isArray(rolls)) return null;
  if (!rolls.length) return printed != null && cut != null && printed <= cut ? 0 : null;
  const available = rolls.reduce((sum, roll) => roll.legacyOnly
    ? sum : sum + Math.max(0, Math.min(roll.quantity, roll.printed) - roll.cut), 0);
  return available > epsilon || (printed != null && cut != null && printed <= cut) ? available : null;
}
