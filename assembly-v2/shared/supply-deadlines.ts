import type { Supply } from "./model";

const timeZone = "Europe/Moscow";
const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const shortDate = new Intl.DateTimeFormat("ru-RU", { timeZone, day: "numeric", month: "short" });
const time = new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" });
const dayLength = 86_400_000;

export const longDeadlineDate = new Intl.DateTimeFormat("ru-RU", { timeZone, day: "numeric", month: "long" });
export const deadlineWeekday = new Intl.DateTimeFormat("ru-RU", { timeZone, weekday: "long" });
export const deadlineClock = (value: string) => time.format(Date.parse(value));
export const deadlineDate = (value: string) => shortDate.format(Date.parse(value));

export const deadlineStages = [
  ["print", "Печать"],
  ["cut", "Резка"],
  ["packing", "Упаковка"],
  ["shipping", "Отправка"],
] as const;

export type DeadlineState = "done" | "overdue" | "today" | "tomorrow" | "planned" | "missing";
export interface StageDeadline {
  id: typeof deadlineStages[number][0];
  label: string;
  at: string | null;
  state: DeadlineState;
}

export function deadlineStatus(value: string | null, complete: boolean, now: number): DeadlineState {
  if (complete) return "done";
  if (!value) return "missing";
  const at = Date.parse(value);
  if (at < now) return "overdue";
  if (day.format(at) === day.format(now)) return "today";
  if (day.format(at) === day.format(now + dayLength)) return "tomorrow";
  return "planned";
}

export function supplyDeadlines(supply: Supply, now: number) {
  const schedule = supply.schedule;
  const dates = [schedule?.readyAt, schedule?.readyAt, schedule?.packingAt, schedule?.shipAt];
  const complete = [schedule?.printed, schedule?.cut, supply.packingComplete, false];
  const stages: StageDeadline[] = deadlineStages.map(([id, label], index) => {
    const value = dates[index];
    const at = value && Number.isFinite(Date.parse(value)) ? value : null;
    return { id, label, at, state: deadlineStatus(at, !!complete[index], now) };
  });
  const next = stages.filter(stage => stage.at && stage.state !== "done")
    .sort((first, second) => Date.parse(first.at!) - Date.parse(second.at!))[0];
  const urgent = schedule?.urgent === true;
  const rank = next?.state === "overdue" ? 0 : urgent || next?.state === "today" ? 1
    : next?.state === "tomorrow" ? 2 : next ? 3 : 4;
  return { stages, next, urgent, rank, due: next ? Date.parse(next.at!) : Infinity };
}

export type SupplyDeadlines = ReturnType<typeof supplyDeadlines>;
export function compareDeadlines(first: SupplyDeadlines, second: SupplyDeadlines) {
  return first.rank - second.rank || first.due - second.due || 0;
}

export function compareShippingDates(first: SupplyDeadlines, second: SupplyDeadlines) {
  const firstAt = first.stages[3].at;
  const secondAt = second.stages[3].at;
  return (firstAt ? Date.parse(firstAt) : Infinity) -
    (secondAt ? Date.parse(secondAt) : Infinity) || compareDeadlines(first, second);
}

export function deadlineCaption(deadlines: SupplyDeadlines, exactTime = false) {
  const { next, urgent } = deadlines;
  if (next?.state === "overdue") {
    return next.id === "shipping" ? "Срок отправки прошёл" : `Просрочена ${next.label.toLowerCase()}`;
  }
  if (next?.at && (next.state === "today" || next.state === "tomorrow")) {
    return `${next.label} ${next.state === "today" ? "сегодня" : "завтра"}${exactTime ? ` · ${deadlineClock(next.at)}` : ""}`;
  }
  if (urgent) return "Срочная поставка";
  return next?.at ? `${next.label} · ${deadlineDate(next.at)}` : "";
}
