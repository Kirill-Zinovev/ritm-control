import type { LiveOrder, LivePrinting } from "./livePrinting";
import {
  buildProductionGroups,
  productionFact,
  productionStoreName,
  type Fact,
} from "./productionData";
import { rollPrinted, rollCut, supplyPrintRemaining } from "./liveSupplyProgress";

export type Department = "roll" | "box";
export function countWord(
  count: number,
  one: string,
  few: string,
  many: string,
) {
  const rule = new Intl.PluralRules("ru-RU").select(count);
  return rule === "one" ? one : rule === "few" ? few : many;
}
export const MACHINES = [
  { id: "2-go", label: "2-GO", department: "roll" },
  { id: "uv", label: "УФ", department: "roll" },
  { id: "uv-white", label: "УФ белый", department: "roll" },
  { id: "uv-double", label: "УФ двусторонний", department: "roll" },
  { id: "uv-flatbed", label: "УФ-планшет", department: "box" },
  { id: "dtf", label: "DTF", department: "box" },
  { id: "xerox", label: "XEROX", department: "box" },
] as const;
export function resolveMachine(value: unknown) {
  const key = String(value || "")
    .normalize("NFKC")
    .trim()
    .toLocaleUpperCase("ru-RU")
    .replace(/[‐‑–—]/g, "-")
    .replace(/[.\s-]+/g, "");
  const ids: Record<string, string> = {
    "2GO": "2-go",
    УФ: "uv",
    УФБЕЛ: "uv-white",
    УФБЕЛЫЙ: "uv-white",
    УФДВУСТОРОННИЙ: "uv-double",
    УФПЛАНШЕТ: "uv-flatbed",
    DTF: "dtf",
    XEROX: "xerox",
  };
  return MACHINES.find((machine) => machine.id === ids[key]) || null;
}
export type WorkloadArticle = {
  key: string;
  article: string;
  store: string;
  productName: string;
  photoUrl: string;
  supplyName: string;
  supplyKey: string;
  plan: number;
  printed: Fact;
  cut: Fact;
  issue: string;
  orders: LiveOrder[];
};
export type WorkloadMachine = {
  key: string;
  id: string;
  label: string;
  department: Department;
  rows: WorkloadArticle[];
  plan: number;
  printed: Fact;
  printRemaining: Fact;
  cut: Fact;
};
export type WorkloadSupply = {
  key: string;
  name: string;
  market: "Ozon" | "WB" | null;
  sourceId: string;
  sheetId: number;
  machines: WorkloadMachine[];
  plan: number;
  printed: Fact;
  articleCount: number;
  stock?: boolean;
};

export function workloadCutWaitsForPrint(order: LiveOrder) {
  return (
    rollPrinted(order) === 0 &&
    (order.planningPrinted ?? 0) <= 0 &&
    (order.planningCut ?? 0) <= 0 &&
    (rollCut(order) ?? 0) === 0
  );
}

export function workloadMissingCut(order: LiveOrder) {
  return rollCut(order) === null && !workloadCutWaitsForPrint(order);
}

export function workloadNeedsReview(row: WorkloadArticle) {
  return !row.printed.complete || row.orders.some(workloadMissingCut);
}

export function workloadCutCoverage(orders: LiveOrder[]) {
  return productionFact(
    orders.flatMap((order) => {
      const cut = rollCut(order);
      return cut === null && workloadCutWaitsForPrint(order) ? [] : [cut];
    }),
  );
}

export function remaining(machine: { plan: number; printed: Fact }) {
  return machine.printed.complete && machine.printed.value !== null
    ? machine.plan - machine.printed.value
    : null;
}
export function workloadState(machine: { plan: number; printed: Fact }) {
  if (!machine.printed.complete || machine.printed.value === null)
    return "unknown";
  return machine.printed.value >= machine.plan
    ? "done"
    : machine.printed.value === 0
      ? "pending"
      : "remaining";
}
export function workloadStateLabel(machine: { plan: number; printed: Fact }) {
  return {
    unknown: "Готовность не подтверждена",
    done: "Печать выполнена",
    pending: "Нет отметок печати",
    remaining: "Есть остаток печати",
  }[workloadState(machine)];
}
const uniqueText = (values: (string | null | undefined)[]) => {
  const distinct = [
    ...new Set(values.map((v) => String(v || "").trim()).filter(Boolean)),
  ];
  return distinct.length === 1 ? distinct[0] : "";
};
export function summarizeMachines(
  rows: WorkloadArticle[],
  id: string,
  label: string,
  department: Department,
): WorkloadMachine {
  const orders = rows.flatMap((row) => row.orders);
  return {
    key: `${department}:${id}`,
    id,
    label,
    department,
    rows,
    plan: orders.reduce((sum, order) => sum + order.quantity, 0),
    printed: productionFact(orders.map(rollPrinted)),
    printRemaining: productionFact(orders.map((order) => {
      const value = supplyPrintRemaining(order);
      return value === null ? null : Math.max(0, value);
    })),
    cut: productionFact(orders.map(rollCut)),
  };
}
function sourceMismatch(
  items: LiveOrder[],
  target: Department,
  machineId: string,
) {
  const conflicts = items.filter(
    (item) =>
      item.machineSource === "catalog" &&
      (item.sourceId === "box-printing" ? "box" : "roll") !== target,
  );
  if (!conflicts.length) return "";
  const sources = [
    ...new Set(
      conflicts.map((item) => {
        const department =
          item.sourceId === "box-printing" ? "боксе" : "рулонной печати";
        return `${department}${item.sourceMachine ? ` (в листе: ${item.sourceMachine})` : ""}`;
      }),
    ),
  ];
  const machine =
    MACHINES.find((item) => item.id === machineId)?.label || machineId;
  return `Задание в ${sources.join(", ")}. По базе: ${machine} · ${target === "box" ? "бокс" : "рулонная печать"}. Переноса не было.`;
}
type WorkloadGroup = Omit<WorkloadSupply, "machines"> & {
  departments: { id: Department; orders: LiveOrder[] }[];
};

function stockOutput(order: LiveOrder, phase: "print" | "cut") {
  const recorded =
    phase === "print" ? order.planningPrinted : order.planningCut;
  const fallback = phase === "print" ? rollPrinted(order) : rollCut(order);
  if (recorded === undefined) return fallback;
  if (
    typeof recorded !== "number" ||
    !Number.isFinite(recorded) ||
    recorded < 0
  )
    return fallback === order.quantity ? fallback : null;
  if (recorded === 0) return fallback === order.quantity ? null : 0;
  if (
    !order.planningPhysicalUnits ||
    !/^(?:xerox|ксерокс|x|х)$/i.test(
      (order.sourceMachine || order.machine || "").trim(),
    )
  )
    return recorded;
  const sheets = order.sheetsInProduct ?? 0;
  const multiplicity = order.multiplicity ?? 0;
  if (sheets <= 0 || multiplicity <= 0)
    return fallback === order.quantity ? fallback : null;
  const pieces = (recorded * multiplicity) / sheets;
  // Older box marks may use a different physical sheet unit. A completed
  // checkbox confirms the plan even when the historical counter is higher.
  return pieces <= order.quantity + 1e-6
    ? Math.min(order.quantity, pieces)
    : fallback === order.quantity
      ? fallback
      : null;
}

function stockWorkloadGroups(live: LivePrinting): WorkloadGroup[] {
  const groups = new Map<string, { id: Department; orders: LiveOrder[] }>();
  for (const [id, stock] of [
    ["roll", live.stockRoll],
    ["box", live.stockBox],
  ] as const) {
    if (stock?.status !== "available") continue;
    for (const order of stock.orders) {
      if (
        order.archived ||
        !order.article?.trim() ||
        !Number.isFinite(order.quantity) ||
        order.quantity <= 0
      )
        continue;
      const key = `stock:${order.spreadsheetId || id}:${order.sheetId}`;
      const group = groups.get(key) || { id, orders: [] };
      const candidates = [
        order.planningMachine || order.machine,
        order.sourceMachine || order.machine,
      ];
      const machine = candidates
        .map(resolveMachine)
        .find((candidate) => candidate?.department === id);
      const machineName =
        machine?.label ?? order.sourceMachine ?? order.machine;
      group.orders.push({
        ...order,
        sourceId: `${id}-printing`,
        machine: machineName,
        machineSource: "supply",
        ...(id === "box"
          ? {
              printProgress: stockOutput(order, "print"),
              cutProgress: stockOutput(order, "cut"),
              remainingPrint: null,
            }
          : {}),
      });
      groups.set(key, group);
    }
  }
  return [...groups].map(([key, group]) => {
    const first = group.orders[0];
    const department = group.id === "roll" ? "Рулонная печать" : "Бокс";
    return {
      key,
      stock: true,
      name: `Запасы · ${first.sheetName} · ${department}`,
      market: null,
      sourceId: first.sourceId!,
      sheetId: first.sheetId,
      departments: [group],
      plan: group.orders.reduce((total, order) => total + order.quantity, 0),
      printed: productionFact(group.orders.map(rollPrinted)),
      articleCount: new Set(
        group.orders.map((order) =>
          order.article.trim().toLocaleUpperCase("ru-RU"),
        ),
      ).size,
    };
  });
}

export function buildMachineWorkload(
  live: LivePrinting | null,
  { includeStock = false } = {},
): WorkloadSupply[] {
  const groups: WorkloadGroup[] = buildProductionGroups(live).map((supply) => ({
    ...supply,
    articleCount: supply.rows.length,
  }));
  if (live && includeStock) groups.push(...stockWorkloadGroups(live));
  return groups
    .map((supply) => {
      const machines: WorkloadMachine[] = [];
      // This is a display grouping only: preserve original sheet identity and
      // source-specific progress facts, but show catalog equipment in its lane.
      const workloadDepartments = new Map<Department, LiveOrder[]>();
      for (const sourceDepartment of supply.departments) {
        for (const order of sourceDepartment.orders) {
          const catalogMachine =
            order.machineSource === "catalog"
              ? resolveMachine(order.machine)
              : null;
          const target = catalogMachine?.department || sourceDepartment.id;
          workloadDepartments.set(target, [
            ...(workloadDepartments.get(target) || []),
            order,
          ]);
        }
      }
      for (const [departmentId, departmentOrders] of workloadDepartments) {
        const department = { id: departmentId, orders: departmentOrders };
        const assigned = new Map<string, LiveOrder[]>();
        for (const order of department.orders) {
          const machine = resolveMachine(order.machine);
          const id =
            machine?.department === department.id ? machine.id : "unknown";
          assigned.set(id, [...(assigned.get(id) || []), order]);
        }
        for (const [id, orders] of assigned) {
          const articleGroups = new Map<string, LiveOrder[]>();
          for (const order of orders) {
            const key = `${order.article.trim().toLocaleUpperCase("ru-RU")}\0${productionStoreName(order)}`;
            articleGroups.set(key, [...(articleGroups.get(key) || []), order]);
          }
          const rows = [...articleGroups].map(
            ([key, items]): WorkloadArticle => ({
              key: `${supply.key}:${department.id}:${id}:${key}`,
              article: items[0].article,
              store: productionStoreName(items[0]),
              productName: uniqueText(items.map((item) => item.productName)),
              photoUrl: uniqueText(items.map((item) => item.photoUrl)),
              supplyKey: supply.key,
              supplyName: supply.name,
              plan: items.reduce((sum, item) => sum + item.quantity, 0),
              printed: productionFact(items.map(rollPrinted)),
              cut: productionFact(items.map(rollCut)),
              orders: items,
              issue:
                id === "unknown"
                  ? uniqueText(items.map((item) => item.machineIssue)) ||
                    (items.some((item) => item.machine)
                      ? `Станок не распознан или относится к другому участку: ${[...new Set(items.map((item) => item.machine).filter(Boolean))].join(", ")}`
                      : "Станок не указан в источнике")
                  : sourceMismatch(items, department.id, id),
            }),
          );
          const machine = summarizeMachines(
            rows,
            id,
            MACHINES.find((m) => m.id === id)?.label || "Станок не определён",
            department.id,
          );
          machines.push({ ...machine, key: `${supply.key}:${machine.key}` });
        }
      }
      machines.sort((a, b) => {
        const rank = (m: WorkloadMachine) =>
          m.id === "unknown"
            ? m.department === "roll"
              ? 4
              : 9
            : MACHINES.findIndex((x) => x.id === m.id);
        return rank(a) - rank(b);
      });
      return {
        key: supply.key,
        name: supply.name,
        market: supply.market,
        sourceId: supply.sourceId,
        sheetId: supply.sheetId,
        machines,
        plan: supply.plan,
        printed: supply.printed,
        articleCount: supply.articleCount,
        ...(supply.stock && { stock: true }),
      };
    })
    .filter((supply) => supply.machines.length > 0);
}
