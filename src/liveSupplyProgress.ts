import type { LiveOrder } from "./livePrinting";

export function rollPrinted(order: LiveOrder) {
  if (typeof order.printProgress === "number") return order.printProgress;
  if (
    typeof order.remainingPrint === "number" &&
    order.remainingPrint <= order.quantity
  )
    return Math.max(0, order.quantity - order.remainingPrint);
  return null;
}

export function rollCut(order: LiveOrder) {
  return typeof order.cutProgress === "number" ? order.cutProgress : null;
}

export function rollPrintRemaining(order: LiveOrder) {
  if (typeof order.remainingPrint === "number") return order.remainingPrint;
  const printed = rollPrinted(order);
  return printed === null ? null : Math.max(0, order.quantity - printed);
}

export function completeTotal(values: (number | null)[]) {
  return values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

export function observedTotal(values: (number | null)[]) {
  const known = values.filter((value): value is number => value !== null);
  return {
    total: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
    observed: known.length,
    missing: values.length - known.length,
  };
}
