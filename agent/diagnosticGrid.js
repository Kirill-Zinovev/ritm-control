import { parseDoctorDate } from "./doctor.js";
import { createHash } from "node:crypto";
import { doctorColumnIndex } from "./doctorRegistry.js";
export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const scalar = (c) =>
  c?.effectiveValue?.numberValue ??
  c?.effectiveValue?.stringValue ??
  c?.effectiveValue?.boolValue ??
  c?.userEnteredValue?.numberValue ??
  c?.userEnteredValue?.stringValue ??
  null;
export const numeric = (v) => typeof v === "number" && Number.isFinite(v);
export function gridViews(spreadsheet) {
  const views = new Map();
  for (const sheet of spreadsheet.sheets || []) {
    const cells = new Map();
    let last = 0;
    for (const block of sheet.data || [])
      for (const [ri, row] of (block.rowData || []).entries())
        for (const [ci, c] of (row.values || []).entries()) {
          const n = (block.startRow || 0) + ri + 1;
          cells.set(n + ":" + ((block.startColumn || 0) + ci), c);
          if (c.userEnteredValue || c.effectiveValue) last = Math.max(last, n);
        }
    const cell = (col, row) =>
      cells.get(row + ":" + doctorColumnIndex(col)) || {};
    views.set(sheet.properties.sheetId, {
      sheet,
      last,
      cell,
      get: (col, row) => scalar(cell(col, row)),
    });
  }
  return views;
}
export function cellEvidence(document, view, col, row) {
  const cell = col + row,
    native = view.cell(col, row);
  return {
    sheet: view.sheet.properties.title,
    gid: view.sheet.properties.sheetId,
    cell,
    value: scalar(native),
    formula: native.userEnteredValue?.formulaValue || null,
    error: native.effectiveValue?.errorValue || null,
    url:
      "https://docs.google.com/spreadsheets/d/" +
      document.documentId +
      "/edit#gid=" +
      view.sheet.properties.sheetId +
      "&range=" +
      cell,
  };
}
export function offsetRow(formula, row, shift, title, column) {
  // Only this fully understood, source-observed OFFSET form; no arbitrary evaluation.
  if (!numeric(shift) || !Number.isInteger(shift)) return null;
  const m = String(formula || "").match(
    /^=OFFSET\('((?:[^']|'')+)'!([A-Z]+)(\d+);-N(\d+);(?:0)?\)$/i,
  );
  if (
    !m ||
    m[1].replaceAll("''", "'") !== title ||
    m[2] !== column ||
    Number(m[4]) !== row
  )
    return null;
  const target = Number(m[3]) - shift;
  return target > 0 ? target : null;
}

export function productionDay(value) {
  const date = parseDoctorDate(value);
  if (!date) return null;
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  )
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value))
    return value.slice(0, 10);
  return date.toISOString().slice(0, 10);
}
