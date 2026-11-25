import type { LiveOrder } from "./livePrinting";

export const formatPrintQuantity = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2,
}).format;

export function printingUnitConversion(order: LiveOrder) {
  const machine = (order.sourceMachine || order.machine)?.trim() || "";
  const xerox = /^(xerox|ксерокс|x|х)$/i.test(machine);
  const factor = xerox
    ? order.sheetsInProduct &&
      order.multiplicity &&
      order.sheetsInProduct > 0 &&
      order.multiplicity > 0
      ? order.sheetsInProduct / order.multiplicity
      : null
    : 1;
  return { machine, xerox, factor };
}

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

export function supplyPrinted(order: LiveOrder) {
  const marked = rollPrinted(order);
  const recorded = order.planningPrinted;
  if (
    order.sourceId !== "box-printing" ||
    order.planningPhysicalUnits !== true ||
    marked === order.quantity ||
    typeof recorded !== "number" ||
    !Number.isFinite(recorded) ||
    recorded < 0
  ) return marked;
  if (recorded === 0) return marked ?? 0;

  const { machine, xerox, factor } = printingUnitConversion(order);
  const confirmed = marked !== null && marked > 0 ? marked : null;
  if (!machine || factor === null) return confirmed;
  const fromGoodOutput = recorded / factor;
  // Some older Xerox rows use another unit. The completion mark can
  // establish the plan. An unchecked row cannot establish excess output.
  if (xerox && fromGoodOutput > order.quantity + 0.000001) return confirmed;
  return Math.max(marked ?? 0, Math.min(order.quantity, fromGoodOutput));
}

export function supplyPrintRemaining(order: LiveOrder) {
  if (order.sourceId !== "box-printing") return rollPrintRemaining(order);
  const printed = supplyPrinted(order);
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

export function plannedAreaTotal(
  orders: Pick<LiveOrder, "areaKnown" | "plannedArea">[],
) {
  return observedTotal(
    orders.map((order) =>
      order.areaKnown === false ||
      !Number.isFinite(order.plannedArea) ||
      order.plannedArea < 0
        ? null
        : order.plannedArea,
    ),
  );
}

export type AssemblyBoxLink = {
  name: string;
  boxSheetId: number;
  targetRollSheetId: number | null;
  boxRows: number;
  boxQuantity: number | null;
  positionKeys?: string[];
};

export function assemblyTransferPositionKey(
  order: Pick<LiveOrder, "rawUid" | "row" | "article">,
) {
  const rawUid = String(order.rawUid || "").trim();
  const identity = rawUid ? `uid:${rawUid}` : `row:${order.row}`;
  return `${identity}|${order.article}`;
}

export function linkedAssemblyBoxSummary(
  summary: {
    sheet: { sourceId?: string; sheetId: number; name: string };
  },
  summaries: {
    sheet: { sourceId?: string; sheetId: number; name: string };
    orders: LiveOrder[];
  }[],
  links: AssemblyBoxLink[],
) {
  if (summary.sheet.sourceId !== "roll-printing") return null;
  const matched = links.filter(
    (link) =>
      link.name === summary.sheet.name &&
      (link.targetRollSheetId == null ||
        link.targetRollSheetId === summary.sheet.sheetId),
  );
  if (!matched.length) return null;
  const orders: LiveOrder[] = [];
  const seen = new Set<string>();
  let positions = 0;
  let missingPositions = 0;
  let quantity = 0;
  let quantityKnown = true;
  for (const link of matched) {
    positions += link.boxRows;
    const box = summaries.find(
      (candidate) =>
        candidate.sheet.sourceId === "box-printing" &&
        candidate.sheet.sheetId === link.boxSheetId,
    );
    if (!box) {
      missingPositions += link.boxRows;
      if (typeof link.boxQuantity === "number") quantity += link.boxQuantity;
      else quantityKnown = false;
      continue;
    }
    let selected: LiveOrder[] = [];
    if (link.positionKeys?.length) {
      const wanted = new Set(link.positionKeys);
      selected = box.orders.filter((order) =>
        wanted.has(assemblyTransferPositionKey(order)),
      );
      const resolved = new Set(selected.map(assemblyTransferPositionKey));
      missingPositions += Math.max(0, link.boxRows - resolved.size);
    } else if (box.orders.length === link.boxRows) {
      selected = box.orders;
    } else {
      missingPositions += link.boxRows;
    }
    for (const order of selected) {
      const key = `${order.sheetId}|${assemblyTransferPositionKey(order)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      orders.push(order);
    }
    const resolvedAll = selected.length === link.boxRows;
    const currentQuantity = resolvedAll
      ? selected.reduce((total, order) => total + order.quantity, 0)
      : link.boxQuantity;
    if (typeof currentQuantity === "number" && Number.isFinite(currentQuantity))
      quantity += currentQuantity;
    else quantityKnown = false;
    if (!resolvedAll && link.boxQuantity === null) quantityKnown = false;
  }
  return {
    positions,
    quantity: quantityKnown ? quantity : null,
    orders,
    missingPositions,
  };
}

export function assemblyAreaTotal(
  orders: Pick<LiveOrder, "areaKnown" | "plannedArea">[],
  missingPositions = 0,
) {
  return plannedAreaTotal([
    ...orders,
    ...Array.from({ length: Math.max(0, missingPositions) }, () => ({
      areaKnown: false,
      plannedArea: 0,
    })),
  ]);
}

export function assemblyPackingTotal(
  orders: Pick<LiveOrder, "quantity" | "packed" | "packedConfirmed">[],
  missingPositions = 0,
) {
  let plan = 0;
  let total = 0;
  let recorded = 0;
  let observed = 0;
  let known = 0;
  for (const { quantity, packed, packedConfirmed } of orders) {
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    plan += quantity;
    const exact = typeof packed === "number" && Number.isFinite(packed) && packed >= 0;
    const confirmed = exact ? packed : packedConfirmed;
    if (typeof confirmed !== "number" || !Number.isFinite(confirmed) || (!exact && confirmed <= 0)) continue;
    total += Math.min(confirmed, quantity);
    recorded += confirmed;
    observed++;
    if (exact) known++;
  }
  return {
    plan,
    total: observed > 0 ? total : null,
    recorded: observed > 0 ? recorded : null,
    observed,
    known,
    missing: orders.length - observed + Math.max(0, missingPositions),
  };
}
