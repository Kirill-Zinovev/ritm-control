import type { LiveOrder } from "./livePrinting";
import {
  assemblyPackingTotal,
  rollCut,
  supplyPrinted,
} from "./liveSupplyProgress";

type Observations = {
  confirmed: number | null;
  recorded: number | null;
  observed: number;
  exact: number;
};

export type ArkadyStageSummary = Observations & {
  stage: "print" | "cut" | "packing";
  plan: number | null;
  positions: number;
  complete: boolean;
};

type Options = {
  plan?: number | null;
  missingPositions?: number;
  packingAvailable?: boolean;
  snapshotStale?: boolean;
};

const noObservations: Observations = {
  confirmed: null,
  recorded: null,
  observed: 0,
  exact: 0,
};

function sheetObservations(
  orders: readonly LiveOrder[],
  read: (order: LiveOrder) => number | null,
): Observations {
  let confirmed = 0;
  let recorded = 0;
  let observed = 0;
  for (const order of orders) {
    const amount = read(order);
    if (amount === null || !Number.isFinite(amount) || amount < 0) continue;
    confirmed += Math.min(order.quantity, amount);
    recorded += amount;
    observed++;
  }
  return observed
    ? { confirmed, recorded, observed, exact: observed }
    : noObservations;
}

export function summarizeArkadySupply(
  orders: readonly LiveOrder[],
  {
    plan: fullPlan,
    missingPositions = 0,
    packingAvailable = true,
    snapshotStale = false,
  }: Options = {},
) {
  const valid = orders.filter(
    ({ quantity }) => Number.isFinite(quantity) && quantity > 0,
  );
  const missing = Number.isSafeInteger(missingPositions)
    ? Math.max(0, missingPositions)
    : 0;
  const positions = orders.length + missing;
  const packing = assemblyPackingTotal(valid);
  const planKnownFromRows = positions > 0 && positions === valid.length;
  const plan =
    fullPlan === undefined
      ? planKnownFromRows
        ? packing.plan
        : null
      : typeof fullPlan === "number" &&
          Number.isFinite(fullPlan) &&
          fullPlan > 0 &&
          fullPlan >= packing.plan &&
          (!planKnownFromRows || fullPlan === packing.plan)
        ? fullPlan
        : null;
  const stages: ArkadyStageSummary[] = [
    { stage: "print" as const, ...sheetObservations(valid, supplyPrinted) },
    { stage: "cut" as const, ...sheetObservations(valid, rollCut) },
    {
      stage: "packing" as const,
      ...(packingAvailable
        ? {
            confirmed: packing.total,
            recorded: packing.recorded,
            observed: packing.observed,
            exact: packing.known,
          }
        : noObservations),
    },
  ].map((stage) => ({
    ...stage,
    plan,
    positions,
    complete:
      !snapshotStale &&
      plan !== null &&
      valid.length === positions &&
      stage.confirmed === plan,
  }));
  return { positions, plan, observedPlan: packing.plan, stages };
}
