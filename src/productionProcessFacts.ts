import type { ForecastTask } from "./productionForecastModel";
export type ProcessFact = {
  plan: number;
  done: number;
  ready: number;
  remaining: number;
  unknownPlan: number;
  unknownCount: number;
  unconfirmedExcess: number;
  positions: number;
};
/** A rounded partial result must never look like a completed stage. */
export function processPercent(fact: ProcessFact): number {
  if (fact.plan <= 0) return 0;
  const rounded = Math.max(0, Math.round((fact.ready / fact.plan) * 100));
  return Math.min(fact.remaining > 0 || fact.unknownCount > 0 ? 99 : 100, rounded);
}
/** Confirmed output is independent of ETA availability; cap each position separately. */
export function processFact(
  tasks: ForecastTask[],
  phase: "print" | "cut" | "packing",
): ProcessFact {
  const result: ProcessFact = {
    plan: 0,
    done: 0,
    ready: 0,
    remaining: 0,
    unknownPlan: 0,
    unknownCount: 0,
    unconfirmedExcess: 0,
    positions: 0,
  };
  for (const task of tasks) {
    if (task.assemblyOnly && phase !== "packing") continue;
    if (task.packingExcluded && phase === "packing") continue;
    result.positions++;
    if (
      (phase === "print" && task.unconfirmedPrintExcess) ||
      (phase === "cut" && task.unconfirmedCutExcess)
    ) result.unconfirmedExcess++;
    const plan = Number.isFinite(task.plan) && task.plan >= 0 ? task.plan : 0;
    result.plan += plan;
    const value =
      phase === "print"
        ? task.printed
        : phase === "cut"
          ? task.cut
          : (task.packed ?? null);
    if (
      value === null ||
      !Number.isFinite(value) ||
      value < 0 ||
      !Number.isFinite(task.plan) ||
      task.plan < 0
    ) {
      result.unknownPlan += plan;
      result.unknownCount++;
      continue;
    }
    result.done += value;
    result.ready += Math.min(plan, value);
    result.remaining += Math.max(0, plan - value);
  }
  return result;
}
export function processGroups(tasks: ForecastTask[]) {
  const groups = new Map<string, ForecastTask[]>();
  for (const task of tasks) {
    if (task.assemblyOnly) continue;
    const key = `${task.department}:${task.machine || "unknown"}`;
    const list = groups.get(key) || [];
    list.push(task);
    groups.set(key, list);
  }
  return [...groups].map(([key, items]) => ({
    key,
    machine: items[0].machine,
    department: items[0].department,
    positions: items.length,
    print: processFact(items, "print"),
    cut: processFact(items, "cut"),
  }));
}
