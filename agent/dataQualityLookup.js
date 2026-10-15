import { formulaReferences } from "./formulaReferences.js";
import { doctorColumnIndex } from "./doctorRegistry.js";
const sourceIndexes = new WeakMap();

// Resolve only the exact, scalar VLOOKUP used by the registered production
// contract. Do not guess the row for approximate lookups, expressions or keys
// containing Sheets wildcards. Exact VLOOKUP selects the first duplicate.
function argumentsAt(formula, open) {
  const args = [];
  let depth = 1,
    start = open + 1,
    quote = null;
  for (let i = start; i < formula.length; i++) {
    const char = formula[i];
    if (quote) {
      if (char === quote) {
        if (formula[i + 1] === quote) i++;
        else quote = null;
      }
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") {
      if (--depth === 0) {
        args.push(formula.slice(start, i).trim());
        return args;
      }
    } else if (depth === 1 && (char === ";" || char === ",")) {
      args.push(formula.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [];
}

function directRange(value, sheet) {
  if (
    !/^(?:(?:'(?:[^']|'')+'|[A-Za-z_\u0400-\u04ff][A-Za-z0-9_\u0400-\u04ff]*)!)?\$?[A-Z]{1,3}\$?\d*(?::\$?[A-Z]{1,3}\$?\d*)?$/.test(
      value,
    )
  )
    return null;
  const ranges = formulaReferences("=" + value, sheet).ranges;
  return ranges.length === 1 ? ranges[0] : null;
}

export function exactVlookupSource(
  rule,
  sourceView,
  productionView,
  row,
  currentView,
  formula,
  tableReference,
) {
  const masked = formula.replace(/"(?:[^"]|"")*"/g, (text) =>
    " ".repeat(text.length),
  );
  const key = productionView.cell(rule.production.articleColumn, row);
  const productKey =
    key.effectiveValue?.stringValue ?? key.userEnteredValue?.stringValue;
  if (typeof productKey !== "string" || /[?*~]/.test(productKey)) return null;
  for (const match of masked.matchAll(/\bVLOOKUP\s*\(/gi)) {
    const args = argumentsAt(formula, match.index + match[0].length - 1);
    if (
      args.length !== 4 ||
      !/^(?:0|FALSE(?:\(\))?)$/i.test(args[3]) ||
      !/^[1-9]\d*$/.test(args[2])
    )
      continue;
    const lookup = directRange(args[0], currentView.title),
      table = directRange(args[1], currentView.title);
    if (
      !lookup ||
      !table ||
      lookup.sheet !== productionView.title ||
      lookup.startColumn !== doctorColumnIndex(rule.production.articleColumn) ||
      lookup.endColumn !== lookup.startColumn ||
      !(
        (lookup.startRow === row && lookup.endRow === row) ||
        (lookup.startRow === 1 && lookup.endRow === 10000000)
      ) ||
      table.sheet !== sourceView.title ||
      table.startColumn !== doctorColumnIndex(rule.source.keyColumn) ||
      table.startColumn + Number(args[2]) - 1 !==
        doctorColumnIndex(rule.source.fieldColumn) ||
      table.endColumn < doctorColumnIndex(rule.source.fieldColumn) ||
      JSON.stringify(table) !== JSON.stringify(tableReference)
    )
      continue;
    const lastRow = Math.min(
      table.endRow,
      rule.source.maxRows || 3000,
      sourceView.sheet.properties.gridProperties?.rowCount || 0,
    );
    let indexes = sourceIndexes.get(sourceView);
    if (!indexes) {
      indexes = new Map();
      sourceIndexes.set(sourceView, indexes);
    }
    const indexKey = [rule.source.keyColumn, table.startRow, lastRow].join(":");
    let index = indexes.get(indexKey);
    if (!index) {
      index = new Map();
      for (let sourceRow = table.startRow; sourceRow <= lastRow; sourceRow++) {
        const cell = sourceView.cell(rule.source.keyColumn, sourceRow);
        const value =
          cell.effectiveValue?.stringValue ??
          cell.userEnteredValue?.stringValue;
        if (typeof value !== "string") continue;
        const key = value.toLocaleLowerCase("ru-RU");
        const rows = index.get(key) || [];
        rows.push(sourceRow);
        index.set(key, rows);
      }
      indexes.set(indexKey, index);
    }
    const matchingRows = index.get(productKey.toLocaleLowerCase("ru-RU")) || [];
    if (!matchingRows.length) return null;
    return {
      row: matchingRows[0],
      evidence: {
        function: "VLOOKUP",
        match: "exact",
        selection: "first_match",
        sourceCell: rule.source.fieldColumn + matchingRows[0],
        matchingRows,
      },
    };
  }
  return null;
}
