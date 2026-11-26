import type { Planning } from "../shared/productionPlanning";
import type { LiveOrder, LivePrinting } from "./livePrinting";
import {
  formatPrintQuantity as qty,
  supplyPrinted,
} from "./liveSupplyProgress";
import { buildProductionGroups } from "./productionData";
import {
  applyConfirmedProductionCuts,
  forecastInput,
  type AssemblyOnlyForecastItem,
} from "./productionForecastData";
import type { ForecastTask } from "./productionForecastModel";

type Shipment = {
  key: string;
  name: string;
  sourceId: string;
  sheetId: number;
};
type AlertDetails = {
  confirmed: number | null;
  plan: number | null;
  detail: string;
};
type DeadlineAlert = Shipment &
  AlertDetails & {
    stage: "production" | "packing";
    status: "overdue" | "due-soon";
    deadline: string;
    deadlineMs: number;
    article?: undefined;
  };
type CatalogAlert = Shipment &
  AlertDetails & {
    stage: "catalog";
    status: "needs-check";
    deadline: null;
    deadlineMs: null;
    article: string;
  };
export type ArkadyAttentionItem = DeadlineAlert | CatalogAlert;
export type ArkadyAttentionReport = {
  state: "ready" | "stale" | "unavailable";
  items: ArkadyAttentionItem[];
  checked: number;
  unconfirmed: number;
};

type Options = {
  now?: number;
  stale?: boolean;
  cutConfirmations?: Planning["cutConfirmations"];
  extraItems?: AssemblyOnlyForecastItem[];
  extraItemsConfirmed?: boolean;
};
type Evidence = AlertDetails & { unfinished: boolean; unknown: boolean };
const day = 24 * 60 * 60 * 1000;

function noReport(state: "stale" | "unavailable"): ArkadyAttentionReport {
  return { state, items: [], checked: 0, unconfirmed: 0 };
}

function exactAmount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function taskKey(order: LiveOrder) {
  return [
    order.spreadsheetId || order.sourceId,
    order.sheetId,
    order.rawUid || order.uid || order.row,
  ].join(":");
}

function eligibleDeadline(value: string | null | undefined, now: number) {
  // Saved deadline metadata is normalized to an ISO timestamp with a timezone.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value)
  )
    return null;
  const deadlineMs = Date.parse(value);
  if (!Number.isFinite(deadlineMs) || deadlineMs > now + day) return null;
  const canonical = new Date(deadlineMs).toISOString();
  if (canonical !== value && canonical.replace(/\.000Z$/u, "Z") !== value)
    return null;
  return {
    deadline: value,
    deadlineMs,
    status: deadlineMs < now ? ("overdue" as const) : ("due-soon" as const),
  };
}

function productionEvidence(
  orders: readonly LiveOrder[],
  tasks: ReadonlyMap<string, ForecastTask | null> | undefined,
): Evidence {
  const departments = {
    roll: { print: 0, cut: 0 },
    box: { print: 0, cut: 0 },
  };
  let unknown = false;
  for (const order of orders) {
    const task = tasks?.get(taskKey(order));
    if (
      !task ||
      task.article !== order.article ||
      task.plan !== order.quantity ||
      !Number.isFinite(task.plan) ||
      task.plan <= 0
    ) {
      unknown = true;
      continue;
    }
    const contradictoryPrint = task.printed === 0 && (task.cut ?? 0) > 0;
    if (!contradictoryPrint && exactAmount(task.printed))
      departments[task.department].print += Math.max(
        0,
        task.plan - task.printed,
      );
    else unknown = true;
    if (exactAmount(task.cut))
      departments[task.department].cut += Math.max(0, task.plan - task.cut);
    else unknown = true;
  }
  const sections = Object.entries(departments).flatMap(
    ([department, { print, cut }]) => {
      const amounts = [
        ...(print > 0 ? ["напечатать " + qty(print) + " шт."] : []),
        ...(cut > 0 ? ["порезать " + qty(cut) + " шт."] : []),
      ];
      if (!amounts.length) return [];
      return [
        (department === "roll" ? "Рулонная печать" : "Бокс") +
          " — " +
          amounts.join(", "),
      ];
    },
  );
  return {
    unfinished: sections.length > 0,
    unknown,
    confirmed: null,
    plan: null,
    detail: sections.length
      ? sections.join(" ") + (unknown ? " Часть фактов уточняется." : "")
      : "",
  };
}

function packingEvidence(
  orders: readonly LiveOrder[],
  fresh: boolean,
  fullComposition: boolean,
): Evidence {
  if (!fresh)
    return {
      unfinished: false,
      unknown: true,
      confirmed: null,
      plan: null,
      detail: "",
    };
  let missing = 0;
  let plan = 0;
  let confirmed = 0;
  let unknown = !fullComposition;
  let exact = true;
  for (const order of orders) {
    const target = order.quantity;
    if (!Number.isFinite(target) || target <= 0) {
      unknown = true;
      continue;
    }
    plan += target;
    if (exactAmount(order.packed)) {
      confirmed += Math.min(order.packed, target);
      missing += Math.max(0, target - order.packed);
    } else if (
      (order.packedConfirmed ?? -1) < target ||
      !exactAmount(order.packedConfirmed)
    ) {
      // A lower bound proves completion only if it covers the whole position.
      // A lower bound below plan cannot establish a remaining quantity.
      unknown = true;
    } else {
      exact = false;
      confirmed += target;
    }
  }
  return {
    unfinished: missing > 0,
    unknown,
    confirmed: unknown || !exact ? null : confirmed,
    plan: unknown || !exact ? null : plan,
    detail:
      "Осталось упаковать " +
      (unknown ? "не менее " : "") +
      qty(missing) +
      " шт." +
      (unknown ? " Часть фактов уточняется." : ""),
  };
}

function catalogAlert(
  shipment: Shipment,
  orders: readonly LiveOrder[],
): CatalogAlert | null {
  for (const order of orders) {
    if (
      !order.machineIssue?.trim() ||
      !order.uid ||
      !order.article ||
      !order.sourceId ||
      !Number.isSafeInteger(order.sheetId) ||
      !Number.isFinite(order.quantity) ||
      order.quantity <= 0
    )
      continue;
    const printed = supplyPrinted(order);
    if (
      !exactAmount(printed) ||
      printed >= order.quantity ||
      (printed === 0 &&
        ((order.planningPrinted ?? 0) > 0 ||
          (order.cutProgress ?? 0) > 0 ||
          (order.planningCut ?? 0) > 0))
    )
      continue;
    return {
      ...shipment,
      sourceId: order.sourceId,
      sheetId: order.sheetId,
      stage: "catalog",
      status: "needs-check",
      article: order.article,
      deadline: null,
      deadlineMs: null,
      confirmed: null,
      plan: null,
      detail: order.machineIssue.trim(),
    };
  }
  return null;
}

export function buildArkadyAttention(
  live: LivePrinting | null,
  deadlines: Planning["deadlines"] | null,
  {
    now = Date.now(),
    stale = false,
    cutConfirmations,
    extraItems,
    extraItemsConfirmed,
  }: Options = {},
): ArkadyAttentionReport {
  if (!live || !deadlines || !Number.isFinite(now))
    return noReport("unavailable");
  if (stale || live.stale || live.refreshFailed) return noReport("stale");
  const affectedSheets =
    live.quality?.status === "partial"
      ? new Set(live.issues.map((issue) => issue.source))
      : null;
  if (
    affectedSheets &&
    (!affectedSheets.size ||
      [...affectedSheets].some((source) => !source?.trim()))
  )
    return noReport("unavailable");
  const extras =
    extraItemsConfirmed === true && Array.isArray(extraItems)
      ? extraItems
      : null;
  const input = forecastInput(live, now, extras);
  if (!input.fresh) return noReport("stale");
  const groupsWithExtras = new Set(
    input.tasks
      .filter((task) => task.assemblyOnly && !task.stock)
      .map((task) => task.supplyKey),
  );
  const extraShipmentIds = new Set(
    (extras || [])
      .filter((item) => item.status === "active")
      .map((item) => item.shipmentId),
  );
  const bySupply = new Map<string, Map<string, ForecastTask | null>>();
  for (const task of applyConfirmedProductionCuts(input, cutConfirmations)
    .tasks) {
    if (task.stock || task.assemblyOnly) continue;
    const group =
      bySupply.get(task.supplyKey) ?? new Map<string, ForecastTask | null>();
    group.set(task.id, group.has(task.id) ? null : task);
    bySupply.set(task.supplyKey, group);
  }
  const report: ArkadyAttentionReport = {
    state: "ready",
    items: [],
    checked: 0,
    unconfirmed: 0,
  };
  for (const { key, name, sheetId, sourceId, orders } of buildProductionGroups(
    live,
  )) {
    const active = orders.filter((order) => !order.archived);
    if (!active.length) continue;
    report.checked++;
    const saved = Object.hasOwn(deadlines, key) ? deadlines[key] : undefined;
    const ready = eligibleDeadline(saved?.readyAt, now);
    const packing = eligibleDeadline(saved?.packingAt, now);
    if (
      affectedSheets &&
      (affectedSheets.has(name) ||
        active.some((order) => affectedSheets.has(order.sheetName)))
    ) {
      if (ready || packing) report.unconfirmed++;
      continue;
    }
    const shipment = { key, name, sheetId, sourceId };
    const noExtras =
      extras !== null &&
      !groupsWithExtras.has(key) &&
      !extraShipmentIds.has(key.replace(/^shipment:/u, "")) &&
      !active.some(
        (order) =>
          order.assemblyShipmentId &&
          extraShipmentIds.has(order.assemblyShipmentId),
      );
    const candidates = [
      {
        stage: "production" as const,
        deadline: ready,
        evidence: () => productionEvidence(active, bySupply.get(key)),
      },
      {
        stage: "packing" as const,
        deadline: packing,
        evidence: () => packingEvidence(active, !!input.packingFresh, noExtras),
      },
    ];
    let unconfirmed = false;
    for (const { stage, deadline, evidence } of candidates) {
      if (!deadline) continue;
      const { unfinished, unknown, ...details } = evidence();
      if (unfinished)
        report.items.push({ ...shipment, ...details, ...deadline, stage });
      else if (unknown) unconfirmed = true;
    }
    if (unconfirmed) report.unconfirmed++;
    const catalog = catalogAlert(shipment, active);
    if (catalog) report.items.push(catalog);
  }
  report.items.sort(
    (a, b) =>
      (a.deadlineMs ?? Number.MAX_SAFE_INTEGER) -
        (b.deadlineMs ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name, "ru-RU"),
  );
  return report;
}
