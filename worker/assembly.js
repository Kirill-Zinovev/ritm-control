import { inspectAssemblyRows } from "./assemblyDiagnostics.js";

export const FBO_SOURCE_ID = "1AuPraufSNHwEQHsVEwKR3dtiuEAqUgRrtZJDIQ9I5uo";
export const FBO_HISTORY_GID = 2070043218;

export function parseAssemblyRows(csv) {
  return inspectAssemblyRows(csv).records;
}

function periodStart_(date, period) {
  const [year, month, day] = date.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day, 12));
  if (period === "month") start.setUTCDate(1);
  else if (period === "week") {
    const offset = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - offset);
  }
  return start.toISOString().slice(0, 10);
}

function validDate_(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return false;
  const parsed = new Date(date + "T12:00:00Z");
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function summarizeAssembly(records, date, period = "day") {
  if (!validDate_(date)) throw new Error("Invalid assembly date");
  if (!["day", "week", "month"].includes(period))
    throw new Error("Invalid assembly period");

  const start = periodStart_(date, period);
  const employees = new Map();
  records.forEach((record) => {
    if (record.date < start || record.date > date) return;
    const entry = employees.get(record.employee) || {
      employee: record.employee,
      coefficient: 0,
      machineCut: 0,
      manualCut: 0,
      cut: 0,
      packed: 0,
      total: 0,
      days: 0,
      cutTypes: new Map(),
      packTypes: new Map(),
    };
    entry.coefficient += record.coefficient;
    entry.machineCut += record.machineCut;
    entry.manualCut += record.manualCut;
    entry.cut += record.cut;
    entry.packed += record.packed;
    entry.total += record.total;
    entry.days += 1;
    [
      [entry.cutTypes, record.cutTypes],
      [entry.packTypes, record.packTypes],
    ].forEach(([target, types]) => {
      types.forEach((type) => {
        const key = type.name.toLocaleLowerCase("ru-RU");
        const existing = target.get(key) || { name: type.name, quantity: 0 };
        existing.quantity += type.quantity;
        target.set(key, existing);
      });
    });
    employees.set(record.employee, entry);
  });

  return [...employees.values()].map((entry) => ({
    ...entry,
    coefficient:
      Math.round((entry.coefficient + Number.EPSILON) * 1000000) / 1000000,
    cutTypes: [...entry.cutTypes.values()],
    packTypes: [...entry.packTypes.values()],
  }));
}

export function summarizeAssemblyDays(records) {
  const days = new Map();
  records.forEach((record) => {
    const key = record.date + "|" + record.employee;
    let entry = days.get(key);
    if (!entry) {
      entry = {
        date: record.date,
        employee: record.employee,
        coefficient: 0,
        machineCut: 0,
        manualCut: 0,
        cut: 0,
        packed: 0,
        total: 0,
        days: 1,
        cutTypes: new Map(),
        packTypes: new Map(),
      };
      days.set(key, entry);
    }
    entry.coefficient += record.coefficient;
    entry.machineCut += record.machineCut;
    entry.manualCut += record.manualCut;
    entry.cut += record.cut;
    entry.packed += record.packed;
    entry.total += record.total;
    [
      [entry.cutTypes, record.cutTypes],
      [entry.packTypes, record.packTypes],
    ].forEach(([target, types]) => {
      types.forEach((type) => {
        const typeKey = type.name.toLocaleLowerCase("ru-RU");
        const existing = target.get(typeKey) || {
          name: type.name,
          quantity: 0,
        };
        existing.quantity += type.quantity;
        target.set(typeKey, existing);
      });
    });
  });
  return [...days.values()]
    .map((entry) => ({
      ...entry,
      coefficient:
        Math.round((entry.coefficient + Number.EPSILON) * 1000000) / 1000000,
      cutTypes: [...entry.cutTypes.values()],
      packTypes: [...entry.packTypes.values()],
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.employee.localeCompare(b.employee, "ru-RU"),
    );
}

function todayMoscow_() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function loadAssembly(date, period, fetcher = fetch) {
  const selectedDate = date || todayMoscow_();
  const selectedPeriod = period || "day";
  const response = await fetcher(
    "https://docs.google.com/spreadsheets/d/" +
      FBO_SOURCE_ID +
      "/export?format=csv&gid=" +
      FBO_HISTORY_GID,
    { signal: AbortSignal.timeout(20000) },
  );
  if (!response.ok) throw new Error("FBO source unavailable");
  const { records, issues, quality, sourceUpdatedAt } = inspectAssemblyRows(
    await response.text(),
  );
  return {
    ok: true,
    schemaVersion: 1,
    source: FBO_SOURCE_ID,
    date: selectedDate,
    period: selectedPeriod,
    updatedAt: new Date().toISOString(),
    sourceUpdatedAt,
    issues,
    quality,
    rows: summarizeAssembly(records, selectedDate, selectedPeriod),
    history: summarizeAssemblyDays(records),
  };
}
