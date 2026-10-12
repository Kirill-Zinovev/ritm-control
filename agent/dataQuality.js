import { cellAddress, formulaReferences } from "./formulaReferences.js";
import { doctorColumnIndex } from "./doctorRegistry.js";

const scalar = (cell) =>
  cell?.effectiveValue?.numberValue ??
  cell?.effectiveValue?.stringValue ??
  cell?.effectiveValue?.boolValue ??
  cell?.userEnteredValue?.numberValue ??
  cell?.userEnteredValue?.stringValue ??
  cell?.userEnteredValue?.boolValue ??
  null;

const entered = (cell) => {
  const value = cell?.userEnteredValue;
  if (!value || value.formulaValue !== undefined) return null;
  if (value.stringValue !== undefined)
    return { stringValue: value.stringValue };
  if (value.numberValue !== undefined)
    return { numberValue: value.numberValue };
  if (value.boolValue !== undefined) return { boolValue: value.boolValue };
  return null;
};

const isBlank = (cell) => {
  // Formula cells have no entered scalar. Use their evaluated value before
  // calling them blank; an unevaluated formula is unknown, not empty.
  if (cell?.effectiveValue?.errorValue) return false;
  const value = scalar(cell);
  if (value === null) return cell?.userEnteredValue?.formulaValue === undefined;
  return typeof value === "string" && value.trim() === "";
};

function scalarRecord(value) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return null;
}

function sourceObservation(cell) {
  const literal = entered(cell);
  if (literal) return { value: literal, origin: "entered" };
  if (cell?.userEnteredValue?.formulaValue !== undefined)
    return { value: scalarRecord(scalar(cell)), origin: "formula_result" };
  return { value: null, origin: "entered" };
}

function snapshotValueIsBlank(value, origin) {
  if (value === null || value === undefined) return origin !== "formula_result";
  return value.stringValue !== undefined && value.stringValue.trim() === "";
}

function updateSourceSnapshot(snapshot, address, cell, at, key) {
  const observation = sourceObservation(cell),
    entries = historyEntries(snapshot, address),
    last = entries.at(-1);
  if (
    observation.value &&
    !isBlank(cell) &&
    (JSON.stringify(last?.value) !== JSON.stringify(observation.value) ||
      last?.origin !== observation.origin)
  )
    entries.push({
      value: observation.value,
      origin: observation.origin,
      at: at.toISOString(),
    });
  snapshot.cells[address] = {
    current: observation.value,
    currentAt: at.toISOString(),
    currentOrigin: observation.origin,
    history: entries.slice(-20),
    ...(key === undefined ? {} : { key }),
  };
}

const addressParts = (address) => {
  const match = String(address).match(/^([A-Z]+)([1-9][0-9]*)$/);
  if (!match) return null;
  return {
    column: doctorColumnIndex(match[1]),
    row: Number(match[2]),
  };
};

const usefulOperation = (cell) => {
  const value = scalar(cell);
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "boolean") return value;
  return typeof value === "string" && value.trim() !== "";
};

function viewsFor(spreadsheet) {
  const views = new Map();
  for (const sheet of spreadsheet?.sheets || []) {
    const cells = new Map();
    for (const block of sheet.data || [])
      for (const [ri, row] of (block.rowData || []).entries())
        for (const [ci, cell] of (row.values || []).entries()) {
          const rowNumber = (block.startRow || 0) + ri + 1;
          const column = (block.startColumn || 0) + ci;
          cells.set(rowNumber + ":" + column, cell);
        }
    views.set(sheet.properties.sheetId, {
      gid: sheet.properties.sheetId,
      title: sheet.properties.title,
      sheet,
      cell: (column, row) =>
        cells.get(row + ":" + doctorColumnIndex(column)) || {},
      byAddress(address) {
        const point = addressParts(address);
        return point ? cells.get(point.row + ":" + point.column) || {} : {};
      },
    });
  }
  return views;
}

function activeProductionRow(rule, view, row) {
  const key = scalar(view.cell(rule.production.articleColumn, row));
  return (
    typeof key === "string" &&
    key.trim() !== "" &&
    rule.production.operationColumns.some((column) =>
      usefulOperation(view.cell(column, row)),
    )
  );
}

function sourceMatchesKey(
  rule,
  sourceView,
  row,
  productionView,
  productionRow,
) {
  const productKey = scalar(
    productionView.cell(rule.production.articleColumn, productionRow),
  );
  const sourceKey = scalar(sourceView.cell(rule.source.keyColumn, row));
  return (
    typeof productKey === "string" &&
    typeof sourceKey === "string" &&
    productKey.trim().toLocaleLowerCase("ru-RU") ===
      sourceKey.trim().toLocaleLowerCase("ru-RU")
  );
}

function lookupSourceRow(rule, sourceView, productionView, productionRow) {
  const productionKey = scalar(
    productionView.cell(rule.production.articleColumn, productionRow),
  );
  if (typeof productionKey !== "string" || !productionKey.trim()) return null;
  const count = Math.min(
    rule.source.maxRows ||
      sourceView.sheet.properties.gridProperties?.rowCount ||
      3000,
    sourceView.sheet.properties.gridProperties?.rowCount || 3000,
  );
  const key = productionKey.trim().toLocaleLowerCase("ru-RU");
  const matches = [];
  for (let row = 1; row <= count; row++)
    if (
      String(scalar(sourceView.cell(rule.source.keyColumn, row)) ?? "")
        .trim()
        .toLocaleLowerCase("ru-RU") === key
    )
      matches.push(row);
  return matches.length === 1 ? matches[0] : null;
}

function referencesFor(
  rule,
  currentView,
  formula,
  productionView,
  productionRow,
  views,
) {
  const parsed = formulaReferences(formula, currentView.title),
    references = [];
  for (const reference of parsed.ranges) {
    const targetView = [...views.values()].find(
      (view) => view.title === reference.sheet,
    );
    if (!targetView) continue;
    if (
      targetView.gid === rule.source.gid &&
      reference.startColumn <= doctorColumnIndex(rule.source.fieldColumn) &&
      reference.endColumn >= doctorColumnIndex(rule.source.fieldColumn) &&
      reference.startRow === 1 &&
      reference.endRow === 10000000 &&
      /\b(?:INDEX|MATCH|VLOOKUP|HLOOKUP|XLOOKUP|FILTER|LOOKUP)\s*\(/i.test(
        formula,
      ) &&
      parsed.ranges.some(
        (candidate) =>
          candidate.sheet === rule.source.sheet &&
          candidate.startColumn <= doctorColumnIndex(rule.source.keyColumn) &&
          candidate.endColumn >= doctorColumnIndex(rule.source.keyColumn),
      )
    ) {
      const sourceRow = lookupSourceRow(
        rule,
        targetView,
        productionView,
        productionRow,
      );
      if (sourceRow)
        references.push({
          view: targetView,
          address: rule.source.fieldColumn + sourceRow,
        });
      continue;
    }
    const height = Math.abs(reference.endRow - reference.startRow) + 1;
    const width = Math.abs(reference.endColumn - reference.startColumn) + 1;
    if (height * width > 300) {
      const wholeColumn =
        reference.startRow === 1 && reference.endRow === 10000000;
      if (wholeColumn && targetView.title === currentView.title) {
        const row = productionRow - 1;
        for (
          let column = Math.min(reference.startColumn, reference.endColumn);
          column <= Math.max(reference.startColumn, reference.endColumn);
          column++
        )
          references.push({
            view: targetView,
            address: cellAddress(column, row + 1),
          });
      }
      continue;
    }
    for (
      let row = Math.min(reference.startRow, reference.endRow);
      row <= Math.max(reference.startRow, reference.endRow);
      row++
    )
      for (
        let column = Math.min(reference.startColumn, reference.endColumn);
        column <= Math.max(reference.startColumn, reference.endColumn);
        column++
      )
        references.push({
          view: targetView,
          address: cellAddress(column, row),
        });
  }
  return references;
}

function outputNotApplicable(rule, productionView, row, outputCell) {
  const guardColumn = rule.production.outputGuardColumn,
    formula = outputCell?.userEnteredValue?.formulaValue;
  if (
    !guardColumn ||
    !formula ||
    outputCell.effectiveValue?.errorValue ||
    !isBlank(productionView.cell(guardColumn, row))
  )
    return false;
  const guardIndex = doctorColumnIndex(guardColumn),
    references = formulaReferences(formula, productionView.title).ranges;
  return references.some(
    (reference) =>
      reference.sheet === productionView.title &&
      reference.startColumn <= guardIndex &&
      reference.endColumn >= guardIndex &&
      row >= Math.min(reference.startRow, reference.endRow) &&
      row <= Math.max(reference.startRow, reference.endRow),
  );
}

function traceFormula(
  rule,
  views,
  productionView,
  productionRow,
  startView,
  startAddress,
) {
  const nodes = new Map(),
    roots = new Set(),
    pending = [{ view: startView, address: startAddress, depth: 0 }],
    visited = new Set();
  while (pending.length) {
    const current = pending.pop(),
      key = current.view.gid + ":" + current.address;
    if (visited.has(key) || current.depth > 12) continue;
    visited.add(key);
    const cell = current.view.byAddress(current.address),
      point = addressParts(current.address);
    nodes.set(key, {
      gid: current.view.gid,
      sheet: current.view.title,
      cell: current.address,
      error: cell.effectiveValue?.errorValue?.type || null,
    });
    if (
      point &&
      current.view.gid === rule.source.gid &&
      point.column === doctorColumnIndex(rule.source.fieldColumn) &&
      sourceMatchesKey(
        rule,
        current.view,
        point.row,
        productionView,
        productionRow,
      )
    ) {
      roots.add(current.address);
      continue;
    }
    const formula = cell.userEnteredValue?.formulaValue;
    if (!formula || current.depth === 12) continue;
    for (const reference of referencesFor(
      rule,
      current.view,
      formula,
      productionView,
      productionRow,
      views,
    ))
      pending.push({
        view: reference.view,
        address: reference.address,
        depth: current.depth + 1,
      });
  }
  return { nodes: [...nodes.values()], roots: [...roots] };
}

function historyEntries(history, address) {
  const cell = history?.cells?.[address];
  return Array.isArray(cell?.history) ? cell.history : [];
}

function candidateFromHistory(history, address) {
  const entries = historyEntries(history, address),
    unique = new Map();
  for (const item of entries)
    if (
      item.value &&
      item.origin !== "formula_result" &&
      !snapshotValueIsBlank(item.value, item.origin)
    )
      unique.set(JSON.stringify(item.value), item);
  if (unique.size !== 1)
    return {
      status: "needs_review",
      value: null,
      observedAt: null,
      reason: unique.size
        ? "В истории найдено несколько значений; требуется ручной выбор"
        : "Подтверждённое предыдущее значение не найдено",
    };
  const item = [...unique.values()][0];
  return {
    status: "candidate",
    value: item.value,
    observedAt: item.at,
    confirmation:
      "Подтверждаю " +
      address +
      ": " +
      String(
        item.value.stringValue ??
          item.value.numberValue ??
          item.value.boolValue ??
          "",
      ),
    evidence: "Успешное полное чтение Google Sheets до исчезновения значения",
    reason: "Кандидат требует отдельного подтверждения владельца",
  };
}

export function diagnoseDataQuality(
  document,
  spreadsheet,
  history = null,
  at = new Date(),
) {
  const rules = document.dataQuality || [];
  if (!rules.length)
    return {
      findings: [],
      snapshot: history || { version: 1, cells: {} },
      complete: true,
    };
  const views = viewsFor(spreadsheet),
    nextSnapshot = structuredClone(history || { version: 1, cells: {} }),
    grouped = new Map();
  let complete = true;
  for (const rule of rules) {
    const productionView = views.get(rule.production.gid),
      sourceView = views.get(rule.source.gid);
    if (!productionView || !sourceView) {
      complete = false;
      continue;
    }
    const maxRow = Math.min(
      rule.production.maxRows ||
        productionView.sheet.properties.gridProperties?.rowCount ||
        0,
      productionView.sheet.properties.gridProperties?.rowCount || 0,
    );
    for (let row = rule.production.startRow || 1; row <= maxRow; row++) {
      if (!activeProductionRow(rule, productionView, row)) continue;
      for (const outputColumn of rule.production.errorColumns) {
        const outputAddress = outputColumn + row,
          outputCell = productionView.byAddress(outputAddress),
          formula = outputCell.userEnteredValue?.formulaValue;
        if (!formula) continue;
        if (outputNotApplicable(rule, productionView, row, outputCell))
          continue;
        const trace = traceFormula(
          rule,
          views,
          productionView,
          row,
          productionView,
          outputAddress,
        );
        if (outputCell.effectiveValue?.errorValue && !trace.roots.length)
          complete = false;
        for (const address of trace.roots) {
          const sourceCell = sourceView.byAddress(address),
            sourcePoint = addressParts(address);
          if (!sourcePoint) continue;
          const priorCandidate = candidateFromHistory(history, address),
            missing = isBlank(sourceCell),
            hasRelevantError = trace.nodes.some((node) => node.error),
            outputReady =
              rule.production.outputType !== "number" ||
              typeof scalar(outputCell) === "number",
            wasMissing =
              history?.cells?.[address] &&
              snapshotValueIsBlank(
                history.cells[address].current,
                history.cells[address].currentOrigin,
              );
          if (!missing && !hasRelevantError && outputReady) {
            updateSourceSnapshot(nextSnapshot, address, sourceCell, at);
            continue;
          }
          const rootKey = rule.source.gid + ":" + address;
          let finding = grouped.get(rootKey);
          if (!finding) {
            const dependencyError = !missing && hasRelevantError,
              resultUnknown = !missing && !hasRelevantError && !outputReady,
              sourceState = missing
                ? "missing"
                : dependencyError
                  ? "dependent_formula_error"
                  : wasMissing
                    ? "restored_pending_recalculation"
                    : "insufficient_data",
              keyValue = scalar(
                sourceView.cell(rule.source.keyColumn, sourcePoint.row),
              );
            finding = {
              kind: "table_doctor",
              sourceId: document.id,
              sourceName: document.name,
              department: document.department,
              sheet: rule.source.sheet,
              gid: rule.source.gid,
              cell: address,
              row: sourcePoint.row,
              type: "data_quality_root_cause",
              severity:
                sourceState === "missing"
                  ? "critical"
                  : sourceState === "dependent_formula_error"
                    ? "high"
                    : "medium",
              title:
                sourceState === "dependent_formula_error"
                  ? "Источник заполнен, но зависимый расчёт возвращает ошибку"
                  : sourceState === "insufficient_data" ||
                      sourceState === "restored_pending_recalculation"
                    ? "Источник заполнен, результат расчёта не подтверждён"
                    : `Отсутствует обязательное поле «${rule.source.fieldLabel}»`,
              observed: {
                entered: entered(sourceCell),
                effective: scalar(sourceCell),
                formula: sourceCell.userEnteredValue?.formulaValue || null,
                field: rule.source.fieldLabel,
                fieldColumn: rule.source.fieldColumn,
                relatedField: rule.source.relatedFieldColumn
                  ? {
                      label: rule.source.relatedFieldLabel,
                      cell: rule.source.relatedFieldColumn + sourcePoint.row,
                      value: scalar(
                        sourceView.cell(
                          rule.source.relatedFieldColumn,
                          sourcePoint.row,
                        ),
                      ),
                    }
                  : null,
                productKey: keyValue,
              },
              expected: `Заполненное поле «${rule.source.fieldLabel}» для активного товара`,
              cause:
                sourceState === "dependent_formula_error"
                  ? `Значение источника ${rule.source.sheet}!${address} заполнено, но зависимые формулы возвращают ошибку в ${trace.nodes
                      .filter((node) => node.error)
                      .map(
                        (node) => `${node.sheet}!${node.cell} (#${node.error})`,
                      )
                      .join(
                        ", ",
                      )}. Исходные формулы не объявляются повреждёнными.`
                  : sourceState === "insufficient_data" ||
                      sourceState === "restored_pending_recalculation"
                    ? `Значение источника ${rule.source.sheet}!${address} заполнено, но числовой результат зависимого расчёта не получен. По этому чтению нельзя определить, ожидается ли пересчёт или данных недостаточно.`
                    : `Активные производственные строки ссылаются на пустое обязательное поле «${rule.source.fieldLabel}» в каталоге. Сами формулы не считаются повреждёнными.`,
              impact:
                sourceState === "dependent_formula_error"
                  ? "Ошибка зависимого расчёта подтверждена; числовое влияние на KPI не измерено."
                  : sourceState === "insufficient_data" ||
                      sourceState === "restored_pending_recalculation"
                    ? "Результат расчёта не подтверждён; влияние на KPI не измерено."
                    : "Обязательное исходное значение отсутствует; влияние на KPI не измерено.",
              recommendation:
                sourceState === "dependent_formula_error"
                  ? "Проверьте указанные ячейки расчёта и их источники. Не переписывайте формулы; повторная успешная проверка закроет инцидент после восстановления расчёта."
                  : sourceState === "insufficient_data" ||
                      sourceState === "restored_pending_recalculation"
                    ? "Проверьте значение коэффициента и зависимые расчёты в Google Sheets. По текущему чтению нельзя отличить задержку пересчёта от нехватки исходных данных; формулы не изменять."
                    : priorCandidate.status === "candidate"
                      ? `В предыдущем успешном снимке найден кандидат ${JSON.stringify(priorCandidate.value)} для ${rule.source.sheet}!${address}. Сначала проверьте точное значение и адрес; запись возможна только после отдельного подтверждения владельца.`
                      : `Предыдущее значение для ${rule.source.sheet}!${address} не подтверждено. Статус: «Требует проверки». Сверьте товар с утверждённым источником; формулы не изменять.`,
              verification: "rule_confirmed",
              initialStatus: "confirmed",
              lifecycleState:
                sourceState === "missing"
                  ? "detected"
                  : sourceState === "restored_pending_recalculation"
                    ? "restored_checking_kpi"
                    : sourceState === "dependent_formula_error"
                      ? "needs_intervention"
                      : "awaiting_recheck",
              category: "source_data_quality",
              sourceField: rule.source.fieldLabel,
              sourceFieldColumn: rule.source.fieldColumn,
              sourceCell: address,
              sourceState,
              affectedCells: [],
              errorCells: [],
              dependencyPaths: [],
              recoveryCandidate:
                sourceState === "missing" &&
                priorCandidate.status === "candidate"
                  ? priorCandidate
                  : null,
              recoveryStatus:
                sourceState === "dependent_formula_error"
                  ? "calculation_error"
                  : sourceState === "restored_pending_recalculation"
                    ? "checking_kpi"
                    : resultUnknown
                      ? "needs_review"
                      : priorCandidate.status,
              recoveryNote:
                sourceState === "dependent_formula_error"
                  ? "Источник заполнен; зависимые формулы возвращают ошибку"
                  : sourceState === "restored_pending_recalculation"
                    ? "Источник восстановлен; проверяется пересчёт зависимых KPI"
                    : resultUnknown
                      ? "Источник заполнен; результат расчёта не подтверждён"
                      : priorCandidate.reason,
              sourceUrl:
                "https://docs.google.com/spreadsheets/d/" +
                document.documentId +
                "/edit#gid=" +
                rule.source.gid +
                "&range=" +
                address,
              rootIncidentKey: rootKey,
              dataQualityRule: rule.id,
            };
            grouped.set(rootKey, finding);
          }
          const errorNodes = trace.nodes.filter((node) => node.error);
          for (const node of trace.nodes) {
            const id = node.gid + ":" + node.cell;
            if (
              !finding.affectedCells.some(
                (item) => item.gid + ":" + item.cell === id,
              )
            )
              finding.affectedCells.push({
                gid: node.gid,
                sheet: node.sheet,
                cell: node.cell,
                error: node.error,
              });
          }
          for (const node of errorNodes)
            if (
              !finding.errorCells.some(
                (item) => item.gid === node.gid && item.cell === node.cell,
              )
            )
              finding.errorCells.push({
                gid: node.gid,
                sheet: node.sheet,
                cell: node.cell,
                error: node.error,
              });
          finding.dependencyPaths.push({
            outputCell: outputAddress,
            cells: trace.nodes.map((node) => `${node.sheet}!${node.cell}`),
          });
          finding.affectedCells.sort(
            (a, b) => a.gid - b.gid || a.cell.localeCompare(b.cell, "en"),
          );
          finding.errorCells.sort(
            (a, b) => a.gid - b.gid || a.cell.localeCompare(b.cell, "en"),
          );
        }
      }
    }
  }
  for (const finding of grouped.values()) {
    const rule = rules.find((item) => item.id === finding.dataQualityRule),
      sourceView = views.get(rule.source.gid),
      sourcePoint = addressParts(finding.sourceCell),
      sourceCell = sourceView.byAddress(finding.sourceCell);
    updateSourceSnapshot(
      nextSnapshot,
      finding.sourceCell,
      sourceCell,
      at,
      scalar(sourceView.cell(rule.source.keyColumn, sourcePoint.row)),
    );
    if (finding.sourceState === "missing") {
      const priorCandidate = candidateFromHistory(history, finding.sourceCell);
      finding.recoveryCandidate =
        priorCandidate.status === "candidate" ? priorCandidate : null;
      finding.recoveryStatus = priorCandidate.status;
      finding.recoveryNote = priorCandidate.reason;
      finding.recommendation =
        priorCandidate.status === "candidate"
          ? `В предыдущем успешном снимке найден кандидат ${JSON.stringify(priorCandidate.value)} для ${finding.sheet}!${finding.cell}. Сначала проверьте точное значение и адрес; запись возможна только после отдельного подтверждения владельца.`
          : `Предыдущее значение для ${finding.sheet}!${finding.cell} не подтверждено. Статус: «Требует проверки». Сверьте товар с утверждённым источником; формулы не изменять.`;
    }
  }
  return {
    findings: [...grouped.values()],
    snapshot: nextSnapshot,
    complete,
  };
}
