import { doctorColumnIndex } from "./doctorRegistry.js";
const endpoint = (value) => {
  const match = value.replaceAll("$", "").match(/^([A-Z]+)?(\d+)?$/);
  return match
    ? {
        column: match[1] ? doctorColumnIndex(match[1]) : null,
        row: match[2] ? Number(match[2]) : null,
      }
    : null;
};
export function formulaReferences(formula, currentSheet) {
  const stripped = formula.replace(/"(?:[^"]|"")*"/g, (text) =>
    " ".repeat(text.length),
  );
  const pattern =
    /(^|[^A-Za-z0-9_\u0400-\u04ff])(?:(?:'((?:[^']|'')+)'|([A-Za-z_\u0400-\u04ff][A-Za-z0-9_\u0400-\u04ff]*))!)?(\$?[A-Z]{1,3}\$?\d*|\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d*|\$?\d+))?(?![A-Za-z0-9_])/g;
  const ranges = [];
  for (const match of stripped.matchAll(pattern)) {
    const first = endpoint(match[4]),
      last = endpoint(match[5] || match[4]);
    if (
      !first ||
      !last ||
      (!match[5] && (first.row === null || first.column === null))
    )
      continue;
    if (
      (first.row === null) !== (last.row === null) ||
      (first.column === null) !== (last.column === null)
    )
      continue;
    ranges.push({
      sheet: match[2]?.replaceAll("''", "'") || match[3] || currentSheet,
      startColumn: first.column ?? 0,
      endColumn: last.column ?? 18277,
      startRow: first.row ?? 1,
      endRow: last.row ?? 10000000,
    });
  }
  return { ranges, dynamic: /\b(?:INDIRECT|OFFSET)\s*\(/i.test(stripped) };
}
export function referencesCell(reference, sheet, cell) {
  const point = endpoint(cell);
  return (
    reference.sheet === sheet &&
    point?.row !== null &&
    point?.column !== null &&
    point.row >= Math.min(reference.startRow, reference.endRow) &&
    point.row <= Math.max(reference.startRow, reference.endRow) &&
    point.column >= Math.min(reference.startColumn, reference.endColumn) &&
    point.column <= Math.max(reference.startColumn, reference.endColumn)
  );
}
export function cellAddress(column, row) {
  let name = "";
  for (let n = column + 1; n; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name + row;
}
export function spreadsheetCells(spreadsheet) {
  return spreadsheet.sheets.flatMap((sheet) =>
    (sheet.data || []).flatMap((grid) =>
      (grid.rowData || []).flatMap((row, ri) =>
        (row.values || []).map((value, ci) => ({
          sheet: sheet.properties.title,
          gid: sheet.properties.sheetId,
          row: (grid.startRow || 0) + ri + 1,
          column: (grid.startColumn || 0) + ci,
          address: cellAddress(
            (grid.startColumn || 0) + ci,
            (grid.startRow || 0) + ri + 1,
          ),
          value,
        })),
      ),
    ),
  );
}
