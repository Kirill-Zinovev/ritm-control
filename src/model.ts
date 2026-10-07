export type Page =
  | "overview"
  | "assembly"
  | "printing"
  | "production"
  | "stock"
  | "supplies"
  | "sources";
export type Kind = "assembly" | "printing" | "stock";
export type Period = "day" | "week" | "month";
export type Operation = "Резка" | "Ручная работа" | "Упаковка";
export interface Employee {
  id: string;
  name: string;
}
export interface Work {
  id: string;
  employee: string;
  date: string;
  time: string;
  article: string;
  operation: Operation;
  quantity: number;
  norm: number;
  source: string;
}
export interface Roll {
  id: string;
  roll?: string;
  employee: string;
  date: string;
  time: string;
  article: string;
  quantity: number;
  area: number;
  site: string;
  source: string;
}
export interface Stock {
  article: string;
  cell: string;
  quantity: number;
  date: string;
}
export interface Shift {
  employee: string;
  date: string;
  working: boolean;
  closed: boolean;
}
export interface Line {
  article: string;
  plan: number;
  printed: number;
  cut: number;
  packed: number;
  shipped: number;
  reserved: number;
}
export interface Supply {
  id: string;
  name: string;
  market: "Ozon" | "WB";
  store: string;
  destination: string;
  arrival: string;
  ready: string;
  owner: string;
  lines: Line[];
}
export interface Dataset {
  employees: Employee[];
  work: Work[];
  rolls: Roll[];
  stock: Stock[];
  shifts: Shift[];
  supplies: Supply[];
}
export interface Source {
  id: Kind;
  name: string;
  url: string;
  state: "prepared" | "imported";
  importedAt?: string;
  rows?: number;
}
export const ANCHOR = "2026-10-07";
export const num = (n: number, digits = 0) =>
  new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
export const shortDate = (date: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Moscow",
  }).format(new Date(date + "T12:00:00Z"));
export const fullDate = (date: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Moscow",
  }).format(new Date(date + "T12:00:00Z"));
export function inPeriod(value: string, date: string, period: Period) {
  if (period === "day") return value === date;
  if (period === "month")
    return value.slice(0, 7) === date.slice(0, 7) && value <= date;
  const start = new Date(date + "T12:00:00Z");
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return value >= start.toISOString().slice(0, 10) && value <= date;
}
export const coefficient = (row: Work) => row.quantity / row.norm;
export function employeeResult(
  data: Dataset,
  employee: string,
  date: string,
  period: Period,
) {
  const work = data.work.filter(
    (r) => r.employee === employee && inPeriod(r.date, date, period),
  );
  const shifts = data.shifts.filter(
    (r) =>
      r.employee === employee && r.working && inPeriod(r.date, date, period),
  );
  const total = work.reduce((s, r) => s + coefficient(r), 0);
  const hasData =
    work.length > 0 || (period === "day" && shifts.some((s) => s.closed));
  const value = !hasData
    ? null
    : period === "day"
      ? total
      : shifts.length
        ? total / shifts.length
        : null;
  return {
    work,
    shifts,
    total,
    value,
    hasData,
    working: shifts.length,
    complete: shifts.filter(
      (s) =>
        data.work
          .filter((r) => r.employee === employee && r.date === s.date)
          .reduce((sum, r) => sum + coefficient(r), 0) >= 1,
    ).length,
  };
}
export const lineTotals = (s: Supply) =>
  s.lines.reduce(
    (a, l) => ({
      plan: a.plan + l.plan,
      printed: a.printed + l.printed,
      cut: a.cut + l.cut,
      packed: a.packed + l.packed,
      shipped: a.shipped + l.shipped,
      reserved: a.reserved + l.reserved,
    }),
    { plan: 0, printed: 0, cut: 0, packed: 0, shipped: 0, reserved: 0 },
  );
export function stockByArticle(data: Dataset) {
  const map = new Map<string, number>();
  for (const r of data.stock)
    map.set(r.article, (map.get(r.article) || 0) + r.quantity);
  return map;
}
export function freeStock(data: Dataset, article: string) {
  const stock = stockByArticle(data).get(article) || 0;
  const reserved = data.supplies
    .flatMap((s) => s.lines)
    .filter((l) => l.article === article)
    .reduce((s, l) => s + l.reserved, 0);
  return Math.max(0, stock - reserved);
}
export function reserveSupply(data: Dataset, id: string): Dataset {
  const copy = structuredClone(data);
  const target = copy.supplies.find((s) => s.id === id);
  if (!target) return copy;
  for (const line of target.lines) {
    const needed = Math.max(0, line.plan - line.packed - line.reserved);
    line.reserved += Math.min(needed, freeStock(copy, line.article));
  }
  return copy;
}
export function validateSupply(
  name: string,
  arrival: string,
  ready: string,
  text: string,
) {
  const errors: Record<string, string> = {};
  const lines: Line[] = [];
  if (!name.trim()) errors.name = "Укажи название поставки.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival))
    errors.arrival = "Укажи дату прибытия.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ready))
    errors.ready = "Укажи срок готовности.";
  if (ready && arrival && ready > arrival)
    errors.ready = "Готовность должна быть не позже прибытия.";
  const seen = new Set<string>();
  for (const raw of text.trim().split(/\r?\n/)) {
    const parts = raw.trim().split(/[;\t]+|\s+(?=\d+\s*$)/);
    const article = parts[0]?.trim().toUpperCase();
    const plan = Number(parts[1]?.replace(/\s/g, ""));
    if (
      !article ||
      !Number.isSafeInteger(plan) ||
      plan <= 0 ||
      seen.has(article)
    ) {
      errors.lines =
        "Каждая строка: артикул; целое количество больше нуля. Артикулы не должны повторяться.";
      break;
    }
    seen.add(article);
    lines.push({
      article,
      plan,
      printed: 0,
      cut: 0,
      packed: 0,
      shipped: 0,
      reserved: 0,
    });
  }
  return { errors, lines };
}
export const emptyDataset = (): Dataset => ({
  employees: [],
  work: [],
  rolls: [],
  stock: [],
  shifts: [],
  supplies: [],
});
