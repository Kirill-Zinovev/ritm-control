import { doctorColumnIndex } from "./doctorRegistry.js";
export const DIAGNOSTIC_LABELS = {
  normal: "Нормальное ожидаемое поведение",
  suspicious: "Подозрительное значение",
  confirmed_formula: "Нарушение утверждённой формулы",
  business_review: "Бизнес-логика: ручная проверка",
};
const value = (c) =>
  c?.effectiveValue?.numberValue ??
  c?.effectiveValue?.stringValue ??
  c?.effectiveValue?.boolValue ??
  c?.userEnteredValue?.numberValue ??
  c?.userEnteredValue?.stringValue ??
  c?.userEnteredValue?.boolValue ??
  null;
const meaningful = (c) =>
  !!c?.effectiveValue?.errorValue ||
  (value(c) !== null &&
    String(value(c)).trim() !== "" &&
    value(c) !== 0 &&
    value(c) !== false);
function sameRowErrorDependencies(context, row, column, formula) {
  if (!formula) return [];
  const columns = new Set(),
    expression = formula.replace(/"(?:[^"]|"")*"/g, "");
  for (const match of expression.matchAll(
    /(^|[^A-Z0-9_!])\$?([A-Z]{1,3})\$?(\d+)(?![A-Z0-9_])/gi,
  )) {
    const dependency = match[2].toUpperCase();
    if (
      Number(match[3]) === row &&
      dependency !== column &&
      context?.cells?.[dependency]?.error
    )
      columns.add(dependency);
  }
  return [...columns];
}
export function rowContext(schema, get, row) {
  const policy = schema.context;
  if (!policy || row < policy.startRow) return null;
  const cells = Object.fromEntries(
    policy.columns.map((column) => {
      const c = get(column, row);
      return [
        column,
        {
          value: value(c),
          formula: c.userEnteredValue?.formulaValue || null,
          error: c.effectiveValue?.errorValue?.type || null,
        },
      ];
    }),
  );
  return {
    row,
    state: policy.activeColumns.some((col) => meaningful(get(col, row)))
      ? "filled"
      : "empty",
    cells,
  };
}
export function errorContext(schema, get, row, column, cell) {
  const context = rowContext(schema, get, row),
    error = cell.effectiveValue?.errorValue;
  const formula = cell.userEnteredValue?.formulaValue || "";
  if (!error) return { normal: false, context };
  if (
    context?.state === "empty" &&
    schema.context?.ignoreCalculationErrorsWhenInactive === true
  )
    return {
      normal: true,
      context,
      expectedNA: error.type === "N_A",
      reason:
        "Строка неактивна по настроенному признаку; ошибки расчёта в ней не требуют внимания.",
    };
  if (
    schema.context?.suppressErrorsWithSameRowErrorDependency === true
  ) {
    const dependencies = sameRowErrorDependencies(
      context,
      row,
      column,
      formula,
    );
    if (dependencies.length)
      return {
        normal: true,
        context,
        propagated: true,
        dependencies,
        reason:
          "Ошибка расчёта распространяется из " +
          dependencies.join(", ") +
          "; показывается первичная ячейка.",
      };
  }
  if (error.type === "REF" && formula.includes("#REF!"))
    return {
      normal: false,
      context,
      reason:
        "В формуле присутствует недействительная ссылка #REF!. Возможно, исходный диапазон удалён или перемещён; история редактирования не проверена, эталон восстановления не утверждён.",
    };
  const policy = schema.context;
  // A scoped owner-authorized exception, never a blanket suppression of N/A.
  if (
    context?.state === "empty" &&
    error.type === "N_A" &&
    policy?.emptyLookupNAColumns?.includes(column) &&
    !formula.includes("#REF!") &&
    /\b(?:VLOOKUP|HLOOKUP|XLOOKUP|MATCH|FILTER|INDEX|QUERY|NA)\s*\(/i.test(
      formula,
    )
  )
    return {
      normal: true,
      context,
      expectedNA: true,
      reason:
        "Пустая производственная строка: формула поиска возвращает ожидаемое #N/A; изменение не требуется.",
    };
  if (
    context?.state === "empty" &&
    error.type === "N_A" &&
    policy?.emptyRowPropagatedNAColumns?.includes(column) &&
    !formula.includes("#REF!")
  )
    return {
      normal: true,
      context,
      expectedNA: true,
      reason:
        "Пустая производственная строка: #N/A распространяется из зависимости поиска; изменение не требуется.",
    };
  return {
    normal: false,
    context,
    reason:
      context?.state === "empty"
        ? "Ошибка в незаполненной строке не входит в разрешённое исключение."
        : "Ошибка результата требует проверки назначения столбца, входных данных и допустимых исключений; повреждение формулы не доказано.",
  };
}
export function scanContextErrors(schema, sheet, get) {
  const observations = [],
    policy = schema.context;
  if (!policy) return observations;
  for (const grid of sheet.data || [])
    for (const [ri, row] of (grid.rowData || []).entries()) {
      const number = (grid.startRow || 0) + ri + 1;
      if (number < policy.startRow) continue;
      for (const column of policy.errorColumns) {
        const cell = get(column, number);
        if (cell.effectiveValue?.errorValue)
          observations.push({
            row: number,
            column,
            cell,
            ...errorContext(schema, get, number, column, cell),
          });
      }
    }
  return observations;
}
export function validateContext(policy, schema) {
  if (!policy) return;
  if (
    !Number.isInteger(policy.startRow) ||
    policy.startRow < 1 ||
    policy.startRow > schema.maxRows
  )
    throw new Error("Context requires bounded rows");
  for (const key of [
    "columns",
    "activeColumns",
    "errorColumns",
    "emptyLookupNAColumns",
  ]) {
    if (
      !Array.isArray(policy[key]) ||
      (key !== "emptyLookupNAColumns" && !policy[key].length) ||
      policy[key].some(
        (col) =>
          !/^[A-Z]{1,3}$/.test(col) ||
          doctorColumnIndex(col) > doctorColumnIndex(schema.lastColumn),
      )
    )
      throw new Error("Context requires explicit bounded columns");
  }
  if (
    policy.emptyRowPropagatedNAColumns !== undefined &&
    (!Array.isArray(policy.emptyRowPropagatedNAColumns) ||
      policy.emptyRowPropagatedNAColumns.some(
        (col) =>
          !/^[A-Z]{1,3}$/.test(col) ||
          !policy.errorColumns.includes(col) ||
          doctorColumnIndex(col) > doctorColumnIndex(schema.lastColumn),
      ))
  )
    throw new Error("Context propagated N/A columns must be explicitly bounded");
  if (
    policy.ignoreCalculationErrorsWhenInactive !== undefined &&
    typeof policy.ignoreCalculationErrorsWhenInactive !== "boolean"
  )
    throw new Error("Context inactive-row error policy must be boolean");
  if (
    policy.suppressErrorsWithSameRowErrorDependency !== undefined &&
    typeof policy.suppressErrorsWithSameRowErrorDependency !== "boolean"
  )
    throw new Error("Context propagated-error policy must be boolean");
  if (
    policy.activeColumns.some((col) => !policy.columns.includes(col)) ||
    policy.emptyLookupNAColumns.some(
      (col) => !policy.errorColumns.includes(col),
    )
  )
    throw new Error("Context columns must be declared");
}
