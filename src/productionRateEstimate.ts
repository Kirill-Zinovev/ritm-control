import type { LivePrinting } from "./livePrinting";
import type { LiveAssembly } from "./liveAssembly";
import { resolveMachine } from "./machineWorkloadData";
import type { Planning, Resource } from "../shared/productionPlanning";

const DAY = 86400000,
  OFFSET = 10800000;
export const RATE_WINDOW_DAYS = 28;
export const RATE_MIN_DAYS = 3;
type Sample = {
  id: string;
  resource: string;
  date: string;
  quantity: number | null;
  area: number | null;
  sheets: number | null;
};
export type ProductionRateHistory = {
  samples: Sample[];
  updatedAt: number;
  available: Record<"roll" | "box" | "packing", boolean>;
  unavailableReason?: Record<"roll" | "box" | "packing", string>;
  packingUpdatedAt: number;
};
export type ProductionRateEstimate = {
  rate: number | null;
  days: number;
  records: number;
  excludedDays: number;
  firstDay: string | null;
  lastDay: string | null;
  reason: string;
};
const positive = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

/** Only validated active journal events, including stock. Never sum plan/summary rows. */
export function productionRateHistory(
  live: LivePrinting | null,
  assembly: LiveAssembly | null = null,
): ProductionRateHistory {
  const candidates: Sample[] = [];
  const add = (
    event: {
      id: string;
      date: string;
      quantity: number;
      area: number | null;
      sheets?: number | null;
      machine?: string | null;
      spreadsheetId?: string;
    },
    phase: "print" | "cut",
    department: "roll" | "box",
  ) => {
    const machine = resolveMachine(
      /^(x|х|ксерокс)$/i.test(event.machine?.trim() || "")
        ? "XEROX"
        : event.machine,
    );
    const resource =
      phase === "cut"
        ? `cut-${department}`
        : machine?.department === department
          ? machine.id
          : null;
    if (!resource || !event.id) return;
    candidates.push({
      id: `${department}:${phase}:${event.spreadsheetId || ""}:${event.id}`,
      resource,
      date: event.date,
      quantity: positive(event.quantity),
      area: positive(event.area),
      sheets: positive(event.sheets),
    });
  };
  for (const e of live?.events || [])
    if (e.sourceId === "roll-printing") add(e, "print", "roll");
  for (const e of live?.cutEvents || [])
    if (e.sourceId === "roll-printing") add(e, "cut", "roll");
  for (const e of live?.boxPrinting?.events || []) add(e, "print", "box");
  for (const e of live?.boxPrinting?.cutEvents || []) add(e, "cut", "box");
  for (const e of assembly?.events || []) {
    if (e.operationId !== "packing" || !e.eventId) continue;
    candidates.push({
      id: `assembly:packing:${e.eventId}`,
      resource: "packing",
      date: e.date,
      quantity: positive(e.quantity),
      area: null,
      sheets: null,
    });
  }
  const byId = new Map<string, Sample[]>();
  for (const e of candidates) {
    const list = byId.get(e.id) || [];
    list.push(e);
    byId.set(e.id, list);
  }
  const samples: Sample[] = [];
  for (const group of byId.values()) {
    if (group.every((e) => JSON.stringify(e) === JSON.stringify(group[0])))
      samples.push(group[0]);
    // Conflicting IDs invalidate affected days rather than quietly losing quantity.
    else
      for (const e of group)
        samples.push({ ...e, quantity: null, area: null, sheets: null });
  }
  return {
    samples,
    updatedAt: Date.parse(live?.snapshotAt || live?.updatedAt || ""),
    packingUpdatedAt: Date.parse(
      assembly?.snapshotAt || assembly?.updatedAt || "",
    ),
    available: {
      roll:
        !!live?.ok &&
        !live.stale &&
        live.stockRoll?.status === "available" &&
        !live.quality?.invalidRecords,
      box:
        !!live?.ok &&
        !live.stale &&
        live.boxPrinting?.status === "available" &&
        live.stockBox?.status === "available" &&
        live.boxPrinting?.stockStatus === "available",
      packing:
        !!assembly?.ok &&
        !assembly.stale &&
        !assembly.staleSnapshot &&
        !assembly.refreshInProgress &&
        assembly.sources?.assembly.status === "available" &&
        !assembly.sources.assembly.invalidRecords,
    },
    unavailableReason: {
      roll: !live?.ok
        ? "Данные печати ещё не загружены."
        : live.stale
          ? "Снимок печати устарел. Обновите данные."
          : live.stockRoll?.status !== "available"
            ? "Не подтверждён журнал запасов рулонной печати."
            : live.quality?.invalidRecords
              ? `В журнале печати есть непроверенные записи: ${live.quality.invalidRecords}.`
              : "",
      box: !live?.ok
        ? "Данные печати ещё не загружены."
        : live.stale
          ? "Снимок печати устарел. Обновите данные."
          : live.boxPrinting?.status !== "available"
            ? "Не подтверждён журнал бокса."
            : live.stockBox?.status !== "available"
              ? "Не подтверждён список запасов бокса."
              : live.boxPrinting?.stockStatus !== "available"
                ? "Не подтверждён журнал запасов бокса."
                : "",
      packing: !assembly?.ok
        ? "Данные «RITM Сборка» ещё не загружены."
        : assembly.stale || assembly.staleSnapshot || assembly.refreshInProgress
          ? "Снимок «RITM Сборка» устарел или обновляется."
          : assembly.sources?.assembly.status !== "available"
            ? "Не подтверждён журнал «RITM Сборка»."
            : assembly.sources.assembly.invalidRecords
              ? `В журнале «RITM Сборка» есть непроверенные записи: ${assembly.sources.assembly.invalidRecords}.`
              : "",
    },
  };
}

/** Effective shift-hour throughput, not measured machine cycle time. */
export function estimateProductionRate(
  history: ProductionRateHistory,
  resource: Resource,
  now: number,
): ProductionRateEstimate {
  const empty = (reason: string): ProductionRateEstimate => ({
    rate: null,
    days: 0,
    records: 0,
    excludedDays: 0,
    firstDay: null,
    lastDay: null,
    reason,
  });
  const department =
    resource.id === "packing"
      ? "packing"
      : resource.id === "cut-box" ||
          ["xerox", "dtf", "uv-flatbed"].includes(resource.id)
        ? "box"
        : "roll";
  if (!history.available[department])
    return empty(
      history.unavailableReason?.[department] ||
        "Нужны свежие подтверждённые журналы участка и запасов.",
    );
  if (
    !Number.isFinite(
      department === "packing" ? history.packingUpdatedAt : history.updatedAt,
    ) ||
    (department === "packing" ? history.packingUpdatedAt : history.updatedAt) >
      now + 60000 ||
    now -
      (department === "packing"
        ? history.packingUpdatedAt
        : history.updatedAt) >
      15 * 60000
  )
    return empty(
      "Снимок журнала устарел или его время не подтверждено. Обновите данные.",
    );
  if (
    !resource.days.length ||
    !Number.isInteger(resource.start) ||
    !Number.isInteger(resource.end) ||
    resource.start < 0 ||
    resource.end > 1440 ||
    resource.end <= resource.start
  )
    return empty("Укажите рабочие дни и часы смены.");
  const today = Math.floor((now + OFFSET) / DAY) * DAY;
  const days = new Map<
    string,
    { units: number; records: number; valid: boolean }
  >();
  for (const e of history.samples) {
    if (e.resource !== resource.id || !/^\d{4}-\d{2}-\d{2}$/.test(e.date))
      continue;
    const time = Date.parse(e.date + "T00:00:00Z");
    if (
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== e.date ||
      time >= today ||
      time < today - RATE_WINDOW_DAYS * DAY ||
      !resource.days.includes(new Date(time).getUTCDay())
    )
      continue;
    const units =
      resource.unit === "area"
        ? e.area
        : resource.unit === "sheets"
          ? e.sheets
          : e.quantity;
    const bucket = days.get(e.date) || { units: 0, records: 0, valid: true };
    if (units === null || units <= 0 || !Number.isFinite(units))
      bucket.valid = false;
    else bucket.units += units;
    bucket.records++;
    days.set(e.date, bucket);
  }
  const usable = [...days.entries()]
    .filter(([, d]) => d.valid)
    .sort(([a], [b]) => a.localeCompare(b));
  const values = usable
    .map(([, d]) => (d.units * 60) / (resource.end - resource.start))
    .sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2),
    rate =
      values.length % 2
        ? values[middle]
        : (values[middle - 1] + values[middle]) / 2;
  return {
    rate:
      usable.length >= RATE_MIN_DAYS &&
      Number.isFinite(rate) &&
      rate > 0 &&
      rate <= 1e7
        ? rate
        : null,
    days: usable.length,
    records: usable.reduce((n, [, d]) => n + d.records, 0),
    excludedDays: days.size - usable.length,
    firstDay: usable[0]?.[0] || null,
    lastDay: usable.at(-1)?.[0] || null,
    reason:
      usable.length < RATE_MIN_DAYS
        ? `Нужно минимум ${RATE_MIN_DAYS} завершённых рабочих дня с выработкой; найдено ${usable.length}.`
        : !Number.isFinite(rate) || rate <= 0 || rate > 1e7
          ? "Расчёт скорости требует сверки журнала."
          : "",
  };
}

export function planningWithAutomaticRates(
  planning: Planning,
  history: ProductionRateHistory,
  now: number,
): Planning {
  return {
    ...planning,
    resources: planning.resources.map((r) =>
      r.rateMode === "auto"
        ? { ...r, rate: estimateProductionRate(history, r, now).rate || 0 }
        : r,
    ),
  };
}
