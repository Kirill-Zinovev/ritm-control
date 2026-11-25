import type { LiveOrder } from "./livePrinting";
import { supplyMarketplace } from "./liveSupplyMarketplace";
import { assemblyPackingTotal, supplyPrinted } from "./liveSupplyProgress";

export type DirectionJob = {
  id: string;
  name: string;
  orders: LiveOrder[];
  missingPositions: number;
  lock: "open" | "closed" | "partial" | "pending" | "unknown";
};
export type SupplyDirection = {
  id: string;
  city: string;
  marketplace: string | null;
  jobs: DirectionJob[];
};
export type DirectionProgressField =
  | "printed"
  | "assemblyMachineCut"
  | "assemblyManualCut"
  | "packed";
const cities: [string, RegExp][] = [
  ["Москва", /(?:^|[^А-ЯЁA-Z0-9])(?:МОСКВА|МОСКВЫ|МСК)(?=$|[^А-ЯЁA-Z0-9])/u],
  [
    "Санкт-Петербург",
    /(?:^|[^А-ЯЁA-Z0-9])(?:СПБ|САНКТ[ -]?ПЕТЕРБУРГ(?:А)?|ПИТЕР)(?=$|[^А-ЯЁA-Z0-9])/u,
  ],
  [
    "Екатеринбург",
    /(?:^|[^А-ЯЁA-Z0-9])(?:ЕКБ|ЕКАТЕРИНБУРГ)(?=$|[^А-ЯЁA-Z0-9])/u,
  ],
  [
    "Новосибирск",
    /(?:^|[^А-ЯЁA-Z0-9])(?:НОВОСИБ|НОВОСИБИРСК)(?=$|[^А-ЯЁA-Z0-9])/u,
  ],
  ["Ростов", /(?:^|[^А-ЯЁA-Z0-9])(?:РОСТОВ|РОСТОВА)(?=$|[^А-ЯЁA-Z0-9])/u],
  ["Казань", /(?:^|[^А-ЯЁA-Z0-9])(?:КАЗАНЬ|КАЗАНИ)(?=$|[^А-ЯЁA-Z0-9])/u],
  ["Кострома", /(?:^|[^А-ЯЁA-Z0-9])(?:КОСТРОМА|КОСТРОМЫ)(?=$|[^А-ЯЁA-Z0-9])/u],
];
export function buildSupplyDirections(jobs: DirectionJob[]): SupplyDirection[] {
  const groups = new Map<string, SupplyDirection>();
  const seenJobs = new Set<string>();
  for (const job of jobs) {
    if (seenJobs.has(job.id)) continue;
    seenJobs.add(job.id);
    const marketplace = supplyMarketplace(job.name);
    const matches = cities.filter(([, pattern]) =>
      pattern.test(job.name.toLocaleUpperCase("ru-RU")),
    );
    const city = matches.length === 1 ? matches[0][0] : job.name;
    // Unknown or conflicting cities remain separate. No physical job is merged.
    const id =
      marketplace && matches.length === 1
        ? `${marketplace}:${city}`
        : `job:${job.id}`;
    if (!groups.has(id)) groups.set(id, { id, city, marketplace, jobs: [] });
    groups.get(id)!.jobs.push(job);
  }
  return [...groups.values()];
}
export function orderStore(order: LiveOrder): string {
  if (order.shopCatalogStatus !== "matched") return "";
  const match = String(order.shop || "").match(/^(?:магазин\s*)?([1-9]\d*)$/iu);
  return match?.[1] || "";
}
export function directionProgress(
  orders: LiveOrder[],
  field: DirectionProgressField,
) {
  let plan = 0,
    done = 0,
    known = 0;
  if (field === "packed") {
    const packing = assemblyPackingTotal(orders);
    plan = packing.plan;
    done = packing.total ?? 0;
    known = packing.known;
  } else {
    for (const order of orders) {
      if (!Number.isFinite(order.quantity) || order.quantity <= 0) continue;
      plan += order.quantity;
      const value = field === "printed" ? supplyPrinted(order) : order[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        done += Math.min(value, order.quantity);
        known++;
      }
    }
  }
  const complete = orders.length > 0 && known === orders.length;
  const percentLimit = field === "printed" && done < plan ? 99 : 100;
  return {
    plan,
    done,
    known,
    complete,
    percent: complete && plan > 0
      ? Math.min(percentLimit, Math.round((done / plan) * 100))
      : null,
    lowerPercent: !complete && plan > 0 && done > 0 ? Math.floor((done / plan) * 100) : null,
  };
}
export function directionJobReady(job: DirectionJob) {
  const progress = directionProgress(job.orders, "packed");
  return (
    job.missingPositions === 0 &&
    progress.complete &&
    progress.plan > 0 &&
    progress.done >= progress.plan
  );
}
