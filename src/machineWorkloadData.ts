import type { LiveOrder, LivePrinting } from "./livePrinting";
import {
  buildProductionGroups,
  productionFact,
  productionStoreName,
  type Fact,
} from "./productionData";
import { rollPrinted, rollCut } from "./liveSupplyProgress";

export type Department = "roll" | "box";
export function countWord(count: number, one: string, few: string, many: string) {
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
};
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
    cut: productionFact(orders.map(rollCut)),
  };
}
export function buildMachineWorkload(
  live: LivePrinting | null,
): WorkloadSupply[] {
  return buildProductionGroups(live)
    .map((supply) => {
      const machines: WorkloadMachine[] = [];
      for (const department of supply.departments) {
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
                  : "",
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
        articleCount: supply.rows.length,
      };
    })
    .filter((supply) => supply.machines.length > 0);
}
