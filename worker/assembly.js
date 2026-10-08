import { parseCsv } from "./printing.js";

export const FBO_SOURCE_ID = "1AuPraufSNHwEQHsVEwKR3dtiuEAqUgRrtZJDIQ9I5uo";
export const FBO_HISTORY_GID = 2070043218;

const HISTORY_HEADERS = [
  "Дата",
  "Сотрудник",
  "Резка станок",
  "Ручная резка",
  "Порезано всего",
  "Упаковано",
  "Всего",
  "Коэффициент",
  "Порезал по видам",
  "Упаковал по видам",
  "Обновлено",
  "Ключ",
];

function number_(value) {
  const parsed = Number(
    String(value || "")
      .replace(/[\s\u00a0\u202f]/g, "")
      .replace(",", "."),
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey_(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return "";
  return (
    match[3] +
    "-" +
    match[2].padStart(2, "0") +
    "-" +
    match[1].padStart(2, "0")
  );
}

function typeList_(value) {
  const grouped = new Map();
  String(value || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const match = line
        .trim()
        .match(/^(.*)\s+[—–-]\s+([\d\s\u00a0\u202f]+)$/);
      if (!match) return;
      const name = match[1].trim();
      const quantity = number_(match[2]);
      if (!name || !Number.isInteger(quantity) || quantity < 0) return;
      const key = name.toLocaleLowerCase("ru-RU");
      const entry = grouped.get(key) || { name, quantity: 0 };
      entry.quantity += quantity;
      grouped.set(key, entry);
    });
  return [...grouped.values()];
}

export function parseAssemblyRows(csv) {
  const rows = parseCsv(csv);
  const headers = (rows[0] || []).map((value) =>
    String(value || "")
      .replace(/^\uFEFF/, "")
      .trim(),
  );
  if (HISTORY_HEADERS.some((header, index) => headers[index] !== header))
    throw new Error("FBO history schema changed");

  return rows.slice(1).flatMap((row) => {
    const date = dateKey_(row[0]);
    const employee = String(row[1] || "").trim();
    if (!date || !employee) return [];
    return [
      {
        id: String(row[11] || date + "__" + employee).trim(),
        date,
        employee,
        machineCut: number_(row[2]),
        manualCut: number_(row[3]),
        cut: number_(row[4]),
        packed: number_(row[5]),
        total: number_(row[6]),
        coefficient: number_(row[7]),
        cutTypes: typeList_(row[8]),
        packTypes: typeList_(row[9]),
      },
    ];
  });
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
    const key = record.date + '|' + record.employee;
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
    [[entry.cutTypes, record.cutTypes], [entry.packTypes, record.packTypes]].forEach(
      ([target, types]) => {
        types.forEach((type) => {
          const typeKey = type.name.toLocaleLowerCase('ru-RU');
          const existing = target.get(typeKey) || { name: type.name, quantity: 0 };
          existing.quantity += type.quantity;
          target.set(typeKey, existing);
        });
      },
    );
  });
  return [...days.values()]
    .map((entry) => ({
      ...entry,
      coefficient: Math.round((entry.coefficient + Number.EPSILON) * 1000000) / 1000000,
      cutTypes: [...entry.cutTypes.values()],
      packTypes: [...entry.packTypes.values()],
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.employee.localeCompare(b.employee, 'ru-RU'));
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
  const records = parseAssemblyRows(await response.text());
  return {
    ok: true,
    schemaVersion: 1,
    source: FBO_SOURCE_ID,
    date: selectedDate,
    period: selectedPeriod,
    updatedAt: new Date().toISOString(),
    rows: summarizeAssembly(records, selectedDate, selectedPeriod),
    history: summarizeAssemblyDays(records),
  };
}
