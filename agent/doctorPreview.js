import { inspectDocument } from "./doctor.js";
// Executes the existing detector against an in-memory candidate, never approves the registry.
export function previewFormulaRule(document, schema, rule, spreadsheet) {
  if (!spreadsheet.sheets.some((s) => s.properties?.sheetId === schema.gid))
    return {
      status: "blocked_structure",
      rowsChecked: null,
      wouldFlag: null,
      issues: [],
    };
  if (!rule.templates?.length)
    return {
      status: "blocked_template",
      rowsChecked: null,
      wouldFlag: null,
      issues: [],
    };
  const copy = structuredClone(document),
    candidate = structuredClone(schema);
  candidate.rules = [{ ...structuredClone(rule), approval: "approved" }];
  // Keep row semantics, but this preview reports only this rule, not independent error scans.
  if (candidate.context) candidate.context.errorColumns = [];
  copy.sheets = [candidate];
  const result = inspectDocument(copy, spreadsheet);
  if (!result.complete)
    return {
      status: "blocked_structure",
      rowsChecked: null,
      wouldFlag: null,
      issues: result.findings.map((f) => ({ cell: f.cell, type: f.type })),
    };
  return {
    status: "preview",
    rowsChecked: result.stats.checkedFormulas,
    wouldFlag: result.findings.length,
    issues: result.findings
      .slice(0, 20)
      .map((f) => ({
        cell: f.cell,
        type: f.type,
        observed: f.observed,
        expected: f.expected,
      })),
    issuesTruncated: result.findings.length > 20,
    unusedExceptions: (rule.exceptions || []).filter(
      (e) =>
        e.when &&
        !e.when.notEmpty &&
        !hasCondition(e.when, rule, schema, spreadsheet),
    ).length,
  };
}
function hasCondition(when, rule, schema, spreadsheet) {
  const sheet = spreadsheet.sheets.find(
    (s) => s.properties.sheetId === schema.gid,
  );
  let column = 0;
  for (const c of when.column) column = column * 26 + c.charCodeAt(0) - 64;
  return (sheet.data || []).some((grid) =>
    (grid.rowData || []).some((row, i) => {
      const n = (grid.startRow || 0) + i + 1;
      const cell = row.values?.[column - 1 - (grid.startColumn || 0)];
      const value =
        cell?.effectiveValue?.stringValue ??
        cell?.effectiveValue?.numberValue ??
        cell?.userEnteredValue?.stringValue ??
        cell?.userEnteredValue?.numberValue ??
        "";
      return (
        n >= rule.startRow && n <= rule.endRow && String(value) === when.equals
      );
    }),
  );
}
