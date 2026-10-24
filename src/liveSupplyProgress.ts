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
  orders: Pick<LiveOrder, "packed">[],
  missingPositions = 0,
) {
  return observedTotal([
    ...orders.map((order) =>
      typeof order.packed === "number" ? order.packed : null,
    ),
    ...Array.from({ length: Math.max(0, missingPositions) }, () => null),
  ]);
}
