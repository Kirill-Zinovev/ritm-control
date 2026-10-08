import { sourceTimestamp } from "./timestamps.js";
export { sourceTimestamp } from "./timestamps.js";
import { parseCsv } from "./printing.js";

export const HISTORY_HEADERS = [
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
export function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const d = new Date(value + "T12:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function parseDay(value) {
  const raw = String(value ?? "").trim();
  if (validDay(raw)) return raw;
  const m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return "";
  const date = m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  return validDay(date) ? date : "";
}
export function parseNonnegative(value, integer = false) {
  const raw = String(value ?? "")
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(",", ".");
  const n = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && (!integer || Number.isSafeInteger(n))
    ? n
    : null;
}

function types(value) {
  const result = new Map();
  const invalid = [];
  for (const line of String(value ?? "")
    .split(/\r?\n/)
    .filter((s) => s.trim())) {
    const m = line.trim().match(/^(.*)\s+[—–-]\s+([\d\s\u00a0\u202f]+)$/);
    const n = m ? parseNonnegative(m[2], true) : null;
    if (!m || !m[1].trim() || n === null) {
      invalid.push(line);
      continue;
    }
    const name = m[1].trim(),
      key = name.toLocaleLowerCase("ru-RU");
    const item = result.get(key) || { name, quantity: 0 };
    item.quantity += n;
    result.set(key, item);
  }
  return { list: [...result.values()], invalid };
}
export function inspectAssemblyRows(csv) {
  const rows = parseCsv(csv);
  const headers = (rows[0] || []).map((v) =>
    String(v ?? "")
      .replace(/^\uFEFF/, "")
      .trim(),
  );
  if (HISTORY_HEADERS.some((v, i) => headers[i] !== v)) {
    const error = new Error("FBO history schema changed");
    error.issue = {
      code: "schema_changed",
      source: "История производства",
      row: 1,
      cell: "A1:L1",
      found: headers.join(" | "),
      expected: HISTORY_HEADERS.join(" | "),
      message: "Изменились заголовки истории FBO",
    };
    throw error;
  }
  const counts = new Map(),
    issues = [],
    records = [],
    affectedDates = new Set();
  for (const row of rows.slice(1)) {
    const id = String(row[11] ?? "").trim();
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  let sourceUpdatedAt = null;
  rows.slice(1).forEach((row, i) => {
    if (row.every((v) => !String(v).trim())) return;
    const date = parseDay(row[0]),
      employee = String(row[1] ?? "").trim(),
      id = String(row[11] ?? "").trim();
    const errors = [];
    const report = (code, col, expected, message) =>
      errors.push({
        code,
        source: "История производства",
        row: i + 2,
        cell: String.fromCharCode(65 + col) + (i + 2),
        found: String(row[col] ?? "").slice(0, 500),
        expected,
        message,
      });
    if (!date)
      report(
        "invalid_date",
        0,
        "Реальная календарная дата",
        "Некорректная производственная дата",
      );
    if (!employee)
      report("required_field", 1, "Имя сотрудника", "Не указан сотрудник");
    if (!id)
      report(
        "missing_uid",
        11,
        "Уникальный ключ исходной записи",
        "Отсутствует обязательный ключ FBO",
      );
    else if (counts.get(id) > 1)
      report(
        "duplicate_uid",
        11,
        "Уникальный ключ исходной записи",
        "Повторяющийся ключ FBO",
      );
    const nums = Array.from({ length: 6 }, (_, n) => {
      const value = parseNonnegative(row[n + 2], n < 5);
      if (value === null)
        report(
          "invalid_number",
          n + 2,
          n < 5 ? "Целое количество ≥ 0" : "Конечный коэффициент ≥ 0",
          "Повреждено числовое значение; строка не заменяется нулём",
        );
      return value;
    });
    const cut = types(row[8]),
      pack = types(row[9]);
    if (cut.invalid.length)
      report(
        "invalid_types",
        8,
        "Вид — целое количество",
        "Повреждена разбивка резки по видам",
      );
    if (pack.invalid.length)
      report(
        "invalid_types",
        9,
        "Вид — целое количество",
        "Повреждена разбивка упаковки по видам",
      );
    const stamp = sourceTimestamp(row[10]);
    if (String(row[10] ?? "").trim() && !stamp)
      report(
        "invalid_timestamp",
        10,
        "Дата обновления с временем",
        "Некорректное время обновления исходной записи",
      );
    if (stamp && (!sourceUpdatedAt || stamp > sourceUpdatedAt))
      sourceUpdatedAt = stamp;
    if (errors.length) {
      issues.push(...errors);
      if (date) affectedDates.add(date);
      return;
    }
    records.push({
      id,
      date,
      employee,
      machineCut: nums[0],
      manualCut: nums[1],
      cut: nums[2],
      packed: nums[3],
      total: nums[4],
      coefficient: nums[5],
      cutTypes: cut.list,
      packTypes: pack.list,
    });
  });
  return {
    records,
    issues,
    sourceUpdatedAt,
    quality: {
      status: issues.length ? "partial" : "valid",
      validRecords: records.length,
      invalidRecords: new Set(issues.map((x) => x.row)).size,
      affectedDates: [...affectedDates],
    },
  };
}
