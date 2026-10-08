import { loadAssembly } from "../worker/assembly.js";
import { loadPrinting, parseCsv } from "../worker/printing.js";
import { parseNonnegative, parseDay } from "../worker/assemblyDiagnostics.js";
import { sourceTimestamp } from "../worker/timestamps.js";
export function todayMoscow(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function columnIndex(column) {
  return (
    [...column].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1
  );
}
export function inspectGeneric(rows, sheet) {
  const issues = [],
    active = rows.slice(sheet.dataStartRow - 1);
  for (const check of sheet.checks) {
    const col = columnIndex(check.column);
    if (check.header && rows[sheet.headerRow - 1]?.[col] !== check.header) {
      const error = new Error("CSV schema changed");
      error.issue = {
        code: "schema_changed",
        source: sheet.name,
        cell: check.column + sheet.headerRow,
        found: rows[sheet.headerRow - 1]?.[col] || "",
        expected: check.header,
        message: "Изменился утверждённый заголовок",
      };
      throw error;
    }
    const counts = new Map();
    if (check.type === "unique")
      for (const row of active) {
        const key = String(row[col] || "").trim();
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
      }
    active.forEach((row, index) => {
      if (row.every((v) => !String(v).trim())) return;
      const raw = String(row[col] ?? "").trim();
      const bad =
        check.type === "required"
          ? !raw
          : check.type === "unique"
            ? !raw || counts.get(raw) > 1
            : check.type === "date"
              ? !parseDay(raw)
              : parseNonnegative(raw, check.type === "integer") === null;
      if (bad)
        issues.push({
          code:
            check.type === "unique"
              ? raw
                ? "duplicate_uid"
                : "missing_uid"
              : "invalid_" + check.type,
          source: sheet.name,
          row: sheet.dataStartRow + index,
          cell: check.column + (sheet.dataStartRow + index),
          found: raw.slice(0, 500),
          expected: check.expected || check.type,
          message: "Нарушено утверждённое правило столбца " + check.column,
        });
    });
  }
  return issues;
}
export async function loadSource(source, fetcher, now = new Date()) {
  if (source.adapter === "assembly")
    return loadAssembly(todayMoscow(now), "day", fetcher);
  if (source.adapter === "printing") return loadPrinting(fetcher);
  const exports = await Promise.all(
    source.sheets
      .filter((s) => s.status !== "not_configured")
      .map(async (sheet) => {
        const response = await fetcher(
          "https://docs.google.com/spreadsheets/d/" +
            source.documentId +
            "/export?format=csv&gid=" +
            sheet.gid,
        );
        if (!response.ok) throw new Error("CSV source unavailable");
        const rows = parseCsv(await response.text());
        return { sheet, rows, issues: inspectGeneric(rows, sheet) };
      }),
  );
  const issues = exports.flatMap((s) => s.issues);
  const times = exports.flatMap(({ sheet, rows }) =>
    sheet.updatedAtColumn
      ? rows
          .slice(sheet.dataStartRow - 1)
          .map((r) => sourceTimestamp(r[columnIndex(sheet.updatedAtColumn)]))
          .filter(Boolean)
      : [],
  );
  return {
    ok: true,
    updatedAt: now.toISOString(),
    sourceUpdatedAt: times.sort().at(-1) || null,
    issues,
    quality: { status: issues.length ? "partial" : "valid" },
    recordCount: exports.reduce(
      (n, s) => n + s.rows.length - s.sheet.dataStartRow + 1,
      0,
    ),
  };
}
export function validateApi(payload, kind) {
  if (
    !payload ||
    payload.ok !== true ||
    !Number.isFinite(Date.parse(payload.updatedAt))
  )
    throw new Error("API schema changed");
  const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (kind === "assembly") {
    if (
      payload.schemaVersion !== 1 ||
      !Array.isArray(payload.rows) ||
      !Array.isArray(payload.history)
    )
      throw new Error("API schema changed");
    for (const row of [...payload.rows, ...payload.history]) {
      if (
        !row ||
        typeof row.employee !== "string" ||
        !row.employee.trim() ||
        ![
          "coefficient",
          "machineCut",
          "manualCut",
          "cut",
          "packed",
          "total",
          "days",
        ].every((k) => finite(row[k])) ||
        !Array.isArray(row.cutTypes) ||
        !Array.isArray(row.packTypes) ||
        [...row.cutTypes, ...row.packTypes].some(
          (x) => !x || typeof x.name !== "string" || !finite(x.quantity),
        )
      )
        throw new Error("API numeric/schema violation");
    }
    if (payload.history.some((r) => !parseDay(r.date)))
      throw new Error("API date violation");
    if (
      new Set(payload.history.map((r) => r.date + "|" + r.employee)).size !==
      payload.history.length
    )
      throw new Error("API duplicate daily records");
  } else {
    if (
      payload.schemaVersion !== 2 ||
      !Array.isArray(payload.events) ||
      !Array.isArray(payload.supplies) ||
      !Array.isArray(payload.issues) ||
      !Array.isArray(payload.sheets)
    )
      throw new Error("API schema changed");
    const ids = new Set();
    for (const e of payload.events) {
      if (
        !e?.id ||
        ids.has(e.id) ||
        !e.uid ||
        !e.employee ||
        !parseDay(e.date) ||
        !finite(e.area) ||
        e.area <= 0 ||
        !Number.isSafeInteger(e.quantity) ||
        e.quantity <= 0
      )
        throw new Error("API invalid or duplicate printing event");
      ids.add(e.id);
    }
    if (
      payload.supplies.some(
        (r) =>
          !r?.uid ||
          !Number.isSafeInteger(r.quantity) ||
          r.quantity < 0 ||
          !finite(r.plannedArea),
      )
    )
      throw new Error("API order schema violation");
  }
  return payload;
}
