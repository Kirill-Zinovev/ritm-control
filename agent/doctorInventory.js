import { previewFormulaRule } from "./doctorPreview.js";
import { doctorColumnIndex } from "./doctorRegistry.js";
export function formulaInventory(document, spreadsheet) {
  return document.sheets.flatMap((schema) => {
    const sheet = spreadsheet.sheets.find(
      (s) => s.properties.sheetId === schema.gid,
    );
    const cells = new Map();
    for (const grid of sheet?.data || [])
      (grid.rowData || []).forEach((row, ri) =>
        (row.values || []).forEach((cell, ci) =>
          cells.set(
            `${(grid.startRow || 0) + ri + 1}:${(grid.startColumn || 0) + ci}`,
            cell,
          ),
        ),
      );
    const get = (col, row) =>
      cells.get(`${row}:${doctorColumnIndex(col)}`) || {};
    const value = (c) =>
      c.effectiveValue?.stringValue ??
      c.effectiveValue?.numberValue ??
      c.userEnteredValue?.stringValue ??
      c.userEnteredValue?.numberValue ??
      "";
    return schema.rules
      .filter((rule) => rule.kind === "formula")
      .map((rule) => {
        let applicable = 0,
          present = 0,
          candidateMatches = 0;
        const samples = [],
          imports = new Map();
        for (
          let row = rule.startRow;
          row <=
          Math.min(
            rule.endRow,
            sheet?.properties.gridProperties?.rowCount || 0,
          );
          row++
        ) {
          if (
            rule.when &&
            (rule.when.notEmpty
              ? String(value(get(rule.when.column, row))).trim() === ""
              : String(value(get(rule.when.column, row))) !== rule.when.equals)
          )
            continue;
          applicable++;
          const cell = get(rule.column, row),
            actual = cell.userEnteredValue?.formulaValue;
          if (actual) present++;
          const exception = (rule.exceptions || []).find(
            (e) =>
              (!e.rows || e.rows.includes(row)) &&
              (!e.when ||
                (e.when.notEmpty
                  ? String(value(get(e.when.column, row))).trim() !== ""
                  : String(value(get(e.when.column, row))) === e.when.equals)),
          );
          if (
            (exception?.templates || rule.templates || []).some(
              (t) =>
                t.replaceAll("{row}", String(row)).trim() === actual?.trim(),
            )
          )
            candidateMatches++;
          if (samples.length < 3)
            samples.push({
              cell: rule.column + row,
              formula: actual || null,
              result: cell.effectiveValue?.errorValue || value(cell),
            });
          if (actual?.includes("IMPORTRANGE")) {
            const refs = [
              ...actual.matchAll(
                /IMPORTRANGE\s*\(\s*"([^"]+)"\s*[,;]\s*"([^"]+)"/gi,
              ),
            ].map((m) => ({ documentId: m[1], range: m[2] }));
            imports.set(rule.column + row, {
              formula: actual,
              references: refs,
            });
          }
        }
        return {
          sheet: schema.name,
          gid: schema.gid,
          id: rule.id,
          range: `${rule.column}${rule.startRow}:${rule.column}${rule.endRow}`,
          approval: rule.approval,
          templates: rule.templates,
          when: rule.when || null,
          exceptions: rule.exceptions || [],
          impact: rule.impact,
          preview: previewFormulaRule(document, schema, rule, spreadsheet),
          applicable,
          present,
          candidateMatches,
          samples,
          importRows: [...imports].map(([cell, entry]) => ({ cell, ...entry })),
          note: rule.note || null,
          readVerified: !!sheet,
        };
      });
  });
}
