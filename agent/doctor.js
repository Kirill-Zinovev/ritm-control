import { createHash } from "node:crypto";
import { doctorColumnIndex } from "./doctorRegistry.js";
const scalar = (c) =>
  c?.effectiveValue?.numberValue ??
  c?.effectiveValue?.stringValue ??
  c?.effectiveValue?.boolValue ??
  c?.userEnteredValue?.numberValue ??
  c?.userEnteredValue?.stringValue ??
  c?.userEnteredValue?.boolValue ??
  "";
const empty = (v) => v === null || v === undefined || String(v).trim() === "";
function cellsFor(sheet) {
  const cells = new Map();
  for (const grid of sheet.data || [])
    (grid.rowData || []).forEach((row, ri) =>
      (row.values || []).forEach((value, ci) =>
        cells.set(
          (grid.startRow || 0) + ri + 1 + ":" + ((grid.startColumn || 0) + ci),
          value,
        ),
      ),
    );
  return (column, row) =>
    cells.get(row + ":" + doctorColumnIndex(column)) || {};
}
function matches(when, get, row) {
  return (
    !when ||
    (when.notEmpty
      ? !empty(scalar(get(when.column, row)))
      : String(scalar(get(when.column, row))) === when.equals)
  );
}
function formula(value, row) {
  return value.replaceAll("{row}", String(row)).trim();
}
function signature(rule) {
  return createHash("sha256").update(JSON.stringify(rule)).digest("hex");
}
export function parseDoctorDate(value) {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 1 &&
    value < 73416
  )
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000);
  const text = String(value || "").trim(),
    m = text.match(
      /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
    );
  if (m) {
    const parts = m.slice(1).map((x) => Number(x || 0));
    const d = new Date(
      Date.UTC(parts[2], parts[1] - 1, parts[0], parts[3], parts[4], parts[5]),
    );
    return d.getUTCFullYear() === parts[2] &&
      d.getUTCMonth() === parts[1] - 1 &&
      d.getUTCDate() === parts[0] &&
      parts[3] < 24 &&
      parts[4] < 60 &&
      parts[5] < 60
      ? d
      : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const d = new Date(text);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}
export function inspectDocument(
  document,
  spreadsheet,
  { baseline = {}, now = new Date() } = {},
) {
  const findings = [],
    verifiedBaseline = {},
    stats = {
      checkedFormulas: 0,
      approvedFormulas: 0,
      checkedCells: 0,
      sheets: 0,
    },
    missingSheets = [];
  const add = (
    sheet,
    cell,
    type,
    observed,
    expected,
    rule,
    reason,
    recommendation,
    confirmed = true,
  ) => {
    const demo = document.adapter === "fixture";
    findings.push({
      kind: "table_doctor",
      demonstration: demo,
      sourceId: document.id,
      sourceName: document.name,
      department: document.department,
      sheet: sheet.name,
      cell,
      type,
      severity:
        type === "calculation_error" || type === "structure_changed"
          ? "critical"
          : "warning",
      title:
        {
          formula_missing: "Обязательная формула отсутствует",
          formula_number: "Формула заменена числом",
          formula_mismatch: "Формула отличается от правила",
          invalid_reference: "Некорректная ссылка формулы",
          calculation_error: "Ошибка вычисления Google Sheets",
          business_rule: "Результат противоречит правилу",
          structure_changed: "Структура листа изменилась",
          duplicate_uid: "Повтор обязательного идентификатора",
          missing_uid: "Обязательный идентификатор отсутствует",
          invalid_date: "Некорректная дата",
          invalid_number: "Некорректное количество или площадь",
          stale_data: "Данные не обновлялись в рабочем интервале",
        }[type] || type,
      observed,
      expected: expected ?? null,
      cause: reason,
      impact: rule?.impact || "Полнота контроля источника нарушена",
      recommendation,
      verification: confirmed ? "rule_confirmed" : "needs_review",
      initialStatus: confirmed ? "new" : "review",
      ruleId: rule?.id || null,
      sourceUrl: demo
        ? null
        : "https://docs.google.com/spreadsheets/d/" +
          document.documentId +
          "/edit#gid=" +
          sheet.gid +
          (cell ? "&range=" + encodeURIComponent(cell) : ""),
      previousFormula:
        rule &&
        baseline[sheet.gid + ":" + cell]?.ruleSignature === signature(rule)
          ? baseline[sheet.gid + ":" + cell].formula
          : null,
    });
  };
  let complete = true;
  for (const schema of document.sheets) {
    const sheet = (spreadsheet.sheets || []).find(
      (s) => s.properties?.sheetId === schema.gid,
    );
    if (!sheet) {
      complete = false;
      missingSheets.push(schema.name);
      add(
        schema,
        "",
        "structure_changed",
        "Лист не найден",
        schema.name,
        null,
        "Критичный лист удалён или изменён его ID",
        "Проверить структуру документа",
      );
      continue;
    }
    stats.sheets++;
    const get = cellsFor(sheet);
    let structureGood = true;
    if (sheet.properties.title !== schema.name) {
      structureGood = false;
      add(
        schema,
        "",
        "structure_changed",
        sheet.properties.title,
        schema.name,
        null,
        "Лист переименован",
        "Подтвердить новую структуру и обновить реестр",
      );
    }
    for (const h of schema.headers) {
      const [_, col, row] = h.cell.match(/^([A-Z]+)(\d+)$/);
      const value = String(scalar(get(col, Number(row))))
        .replace(/\s+/g, " ")
        .trim();
      if (value !== h.value.replace(/\s+/g, " ").trim()) {
        structureGood = false;
        add(
          schema,
          h.cell,
          "structure_changed",
          value,
          h.value,
          null,
          "Заголовок изменён или столбец перемещён",
          "Проверить расположение столбцов до диагностики формул",
        );
      }
    }
    if (!structureGood) {
      complete = false;
      continue;
    }
    for (const rule of schema.rules) {
      const seen = new Map(),
        hash = signature(rule);
      for (
        let row = rule.startRow;
        row <=
        Math.min(
          rule.endRow,
          sheet.properties.gridProperties?.rowCount || rule.endRow,
        );
        row++
      ) {
        if (!matches(rule.when, get, row)) continue;
        const exception = (rule.exceptions || []).find(
          (e) => (!e.rows || e.rows.includes(row)) && matches(e.when, get, row),
        );
        if (exception && !exception.templates) continue;
        const c = get(rule.column, row),
          address = rule.column + row,
          value = scalar(c),
          entered = c.userEnteredValue || {},
          actual = entered.formulaValue || "",
          error = c.effectiveValue?.errorValue,
          approved = rule.approval === "approved";
        stats.checkedCells++;
        if (rule.kind === "formula") {
          stats.checkedFormulas++;
          if (approved) stats.approvedFormulas++;
        }
        const templates = (exception?.templates || rule.templates || []).map(
          (t) => formula(t, row),
        );
        if (error) {
          add(
            schema,
            address,
            "calculation_error",
            error.type + ": " + (error.message || ""),
            templates[0],
            rule,
            "Подтверждена ошибка вычисления; причину ссылки или деления нужно проверить",
            "Проверить входные значения и ссылки",
          );
          continue;
        }
        if (actual.includes("#REF!")) {
          add(
            schema,
            address,
            "invalid_reference",
            actual,
            templates[0],
            rule,
            "В формуле есть недействительная ссылка",
            "Проверить удалённый диапазон",
          );
          continue;
        }
        if (rule.kind === "formula") {
          if (!actual) {
            add(
              schema,
              address,
              typeof entered.numberValue === "number"
                ? "formula_number"
                : "formula_missing",
              empty(value) ? "Пустая ячейка" : value,
              approved ? templates[0] : null,
              rule,
              empty(value)
                ? "Формула могла быть удалена; история редактирования не проверена"
                : "Вероятен ручной ввод вместо формулы; историю редактирования нужно проверить",
              approved
                ? "Подготовить восстановление по утверждённому правилу"
                : "Утвердить правило и проверить допустимость ручного значения",
              approved,
            );
            continue;
          }
          if (templates.length && !templates.includes(actual.trim())) {
            add(
              schema,
              address,
              "formula_mismatch",
              actual,
              approved ? templates.join(" или ") : null,
              rule,
              "Формула отличается от зарегистрированного шаблона; причина изменения неизвестна",
              approved
                ? "Проверить изменение и подготовить заявку"
                : "Проверить и утвердить шаблон; автоматическое исправление запрещено",
              approved,
            );
            continue;
          }
          if (rule.allowedDocumentIds) {
            const referenced = [
              ...actual.matchAll(/IMPORTRANGE\s*\(\s*"([^"]+)"/gi),
            ].map((m) => m[1].match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] || m[1]);
            if (
              referenced.some((id) => !rule.allowedDocumentIds.includes(id))
            ) {
              add(
                schema,
                address,
                "invalid_reference",
                actual,
                rule.allowedDocumentIds,
                rule,
                "Ссылка IMPORTRANGE не входит в разрешённый список",
                "Проверить источник ссылки",
                approved,
              );
              continue;
            }
          }
          if (approved && templates.length)
            verifiedBaseline[schema.gid + ":" + address] = {
              formula: actual,
              ruleSignature: hash,
              checkedAt: now.toISOString(),
            };
          if (rule.result) {
            const input = rule.result.columns.map((col) =>
              scalar(get(col, row)),
            );
            if (
              input.every((x) => typeof x === "number" && Number.isFinite(x)) &&
              typeof value === "number"
            ) {
              const target =
                rule.result.kind === "product"
                  ? input.reduce((a, b) => a * b, 1)
                  : rule.result.kind === "sum"
                    ? input.reduce((a, b) => a + b, 0)
                    : input[1] === 0
                      ? null
                      : input[0] / input[1];
              if (
                target !== null &&
                Math.abs(value - target) > rule.result.tolerance
              ) {
                delete verifiedBaseline[schema.gid + ":" + address];
                add(
                  schema,
                  address,
                  "business_rule",
                  value,
                  target,
                  rule,
                  "Вычисленный результат не совпадает с проверяемой зависимостью",
                  "Проверить пересчёт и исходные значения",
                  approved,
                );
              }
            }
          }
        } else if (rule.kind === "required" || rule.kind === "unique") {
          if (empty(value)) {
            add(
              schema,
              address,
              "missing_uid",
              "Пусто",
              "Непустой идентификатор",
              rule,
              "Идентификатор не записан или удалён",
              "Проверить связь записи с заказом",
              approved,
            );
          } else if (rule.kind === "unique") {
            const key = String(value).trim();
            if (seen.has(key))
              add(
                schema,
                address,
                "duplicate_uid",
                key,
                "Уникальный идентификатор; первое вхождение " + seen.get(key),
                rule,
                "Повторная запись или повторное использование идентификатора",
                "Проверить дубли без удаления производственных данных",
                approved,
              );
            else seen.set(key, address);
          }
        } else if (rule.kind === "date") {
          if (!parseDoctorDate(value))
            add(
              schema,
              address,
              "invalid_date",
              value,
              "Корректная производственная дата",
              rule,
              "Дата отсутствует или имеет неподдерживаемый формат",
              "Проверить дату источника",
              approved,
            );
        } else if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          (rule.kind === "integer" && !Number.isSafeInteger(value)) ||
          (rule.minimum !== undefined && value < rule.minimum) ||
          (rule.maximum !== undefined && value > rule.maximum)
        ) {
          add(
            schema,
            address,
            "invalid_number",
            value,
            {
              minimum: rule.minimum ?? null,
              maximum: rule.maximum ?? null,
              integer: rule.kind === "integer",
            },
            rule,
            "Числовое поле повреждено или не соответствует утверждённым ограничениям",
            "Проверить исходное значение; не подменять нулём",
            approved,
          );
        }
      }
    }
  }
  if (document.freshness) {
    const f = document.freshness,
      local = new Date(now.getTime() + 3 * 3600000);
    if (
      f.activeWeekdays.includes(local.getUTCDay()) &&
      local.getUTCHours() >= f.startHour &&
      local.getUTCHours() < f.endHour
    ) {
      const schema = document.sheets.find((s) => s.gid === f.sheetId),
        sheet = spreadsheet.sheets.find(
          (s) => s.properties.sheetId === f.sheetId,
        );
      if (schema && sheet) {
        const get = cellsFor(sheet);
        let latest = null;
        for (let r = f.startRow; r <= Math.min(f.endRow, schema.maxRows); r++) {
          const raw = scalar(get(f.column, r));
          let d = parseDoctorDate(raw);
          if (
            d &&
            (typeof raw === "number" || /^\d{1,2}[./-]/.test(String(raw)))
          )
            d = new Date(d.getTime() - 3 * 3600000);
          if (d && (!latest || d > latest)) latest = d;
        }
        if (!latest || now - latest > f.maximumAgeMinutes * 60000)
          add(
            schema,
            f.column + (f.startRow || 1),
            "stale_data",
            latest?.toISOString() || "Нет даты",
            f.maximumAgeMinutes + " минут",
            null,
            "Источник не обновился в утверждённом рабочем интервале",
            "Проверить синхронизацию; отсутствие записи не означает нулевой KPI",
          );
      } else complete = false;
    }
  }
  return {
    findings,
    stats,
    complete,
    missingSheets,
    baseline: verifiedBaseline,
  };
}
