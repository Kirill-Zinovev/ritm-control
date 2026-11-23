import { quantityRounding } from "./quantityRounding.js";

function xeroxUnits(factor, multiplicity) {
  if (![factor, multiplicity].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  let divisor = factor, remainder = multiplicity;
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
  return { pieceStep: multiplicity / divisor, sheetStep: factor / divisor };
}

export function xeroxSheetCount(pieces, factor, multiplicity) {
  const units = xeroxUnits(factor, multiplicity);
  if (!units || !Number.isSafeInteger(pieces) || pieces <= 0 || pieces % units.pieceStep) return null;
  const total = (pieces / units.pieceStep) * units.sheetStep;
  return Number.isSafeInteger(total) ? total : null;
}

export function xeroxPlanRounding(requestedTotal, factor, multiplicity, { minimum = 1, maximum = Infinity } = {}) {
  const units = xeroxUnits(factor, multiplicity);
  if (!units) return null;
  const quantities = quantityRounding(requestedTotal, units.pieceStep, { minimum, maximum });
  if (!quantities) return null;
  const choices = quantities.flatMap(({ direction, quantity }) => {
    const sheets = quantity === 0 ? 0 : xeroxSheetCount(quantity, factor, multiplicity);
    return sheets === null ? [] : [{ direction, quantity, sheets }];
  });
  return { factor, multiplicity, choices };
}
