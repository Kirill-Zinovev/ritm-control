import { offsetRow, productionDay } from "./diagnosticGrid.js";
import { doctorColumnIndex } from "./doctorRegistry.js";
const scalar = (c) =>
  c?.effectiveValue?.numberValue ??
  c?.effectiveValue?.stringValue ??
  c?.effectiveValue?.boolValue ??
  c?.userEnteredValue?.numberValue ??
  c?.userEnteredValue?.stringValue ??
  null;
const numeric = (v) => typeof v === "number" && Number.isFinite(v);
const day = productionDay;
export function businessPreview(
  document,
  spreadsheet,
  now = new Date(),
  { printingSnapshot = null } = {},
) {
  const views = new Map();
  for (const sheet of spreadsheet.sheets) {
    const cells = new Map();
    let last = 0;
    for (const grid of sheet.data || [])
      for (const [ri, row] of (grid.rowData || []).entries())
        for (const [ci, cell] of (row.values || []).entries()) {
          const n = (grid.startRow || 0) + ri + 1,
            col = (grid.startColumn || 0) + ci;
          cells.set(n + ":" + col, cell);
          if (cell.userEnteredValue || cell.effectiveValue)
            last = Math.max(last, n);
        }
    views.set(sheet.properties.sheetId, {
      sheet,
      get: (col, row) => scalar(cells.get(row + ":" + doctorColumnIndex(col))),
      cell: (col, row) => cells.get(row + ":" + doctorColumnIndex(col)) || {},
      last,
    });
  }
  const results = [];
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const issue = (cell, observed, expected, reason) => ({
    cell,
    observed,
    expected,
    reason,
    classification: "requires_review",
  });
  for (const schema of document.sheets) {
    const view = views.get(schema.gid);
    for (const rule of schema.businessChecks || []) {
      const findings = [];
      let checked = 0;
      const metrics = {};
      let status = view ? "preview" : "unavailable";
      const add = (...args) => findings.push(issue(...args));
      const get = view?.get;
      if (view) {
        if (["fbo-sum", "catalog-sum", "supply-area"].includes(rule.id)) {
          const catalog = rule.id === "catalog-sum",
            area = rule.id === "supply-area";
          const start = area ? 4 : 2,
            last = Math.min(schema.maxRows, view.last);
          const key = area ? "E" : "A",
            target = area ? "J" : catalog ? "K" : "E",
            inputs = area
              ? ["F", "H", "I", "O"]
              : catalog
                ? ["G", "H", "I", "J"]
                : ["B", "C", "D"];
          for (let row = start; row <= last; row++) {
            if (!String(get(key, row) || "").trim()) continue;
            const source = inputs.map((c) => get(c, row));
            if (catalog) {
              for (let i = 0; i < source.length; i++)
                if (source[i] === null || source[i] === "") source[i] = 0;
            }
            if (!source.every(numeric) || !numeric(get(target, row))) continue;
            checked++;
            const expected = area
              ? source.reduce((a, b) => a * b, 1)
              : source.reduce((a, b) => a + b, 0);
            if (Math.abs(get(target, row) - expected) > 1e-6)
              add(
                target + row,
                get(target, row),
                expected,
                "Расхождение результата со структурой вычисления; ручные исключения ещё не утверждены",
              );
          }
        }
        if (["fbo-current", "fbo-team", "fbo-trend"].includes(rule.id)) {
          const dash = views.get(605337763),
            totals = views.get(0);
          if (!dash) status = "unavailable";
          else {
            const currentCol = Array.from({ length: 21 }, (_, i) =>
              String.fromCharCode(66 + i),
            ).find((col) => day(dash.get(col, 6)) === today);
            if (rule.id === "fbo-current") {
              if (!totals || !currentCol) status = "insufficient_context";
              else
                for (let row = 7; row <= 15; row++) {
                  const name = String(dash.get("A", row) || "").replace(
                    /\s/g,
                    "",
                  );
                  const sourceRow = Array.from(
                    { length: 9 },
                    (_, i) => i + 2,
                  ).find(
                    (r) =>
                      String(totals.get("A", r) || "").replace(/\s/g, "") ===
                      name,
                  );
                  if (!sourceRow) {
                    metrics.missingEmployees =
                      (metrics.missingEmployees || 0) + 1;
                    add(
                      currentCol + row,
                      {
                        employee: dash.get("A", row),
                        value: dash.get(currentCol, row),
                      },
                      null,
                      "Сотрудник отсутствует в текущем списке Все коэффициенты; XLOOKUP возвращает 0. Состав команды и допустимое отсутствие требуют утверждения, ноль не доказывает отсутствие работы",
                    );
                    continue;
                  }
                  const a = totals.get("E", sourceRow),
                    b = dash.get(currentCol, row);
                  if (!numeric(a)) continue;
                  checked++;
                  if (!numeric(b))
                    add(
                      currentCol + row,
                      b,
                      a,
                      "В сводке нет числового показателя для сопоставимого текущего сотрудника",
                    );
                  else if (Math.abs(a - b) > 1e-6)
                    add(
                      currentCol + row,
                      b,
                      a,
                      "Сводка текущего дня отличается от Все коэффициенты; источники не прибавляются друг к другу",
                    );
                }
              metrics.date = today;
            }
            if (rule.id === "fbo-team")
              for (let n = 1; n <= 21; n++) {
                const col = String.fromCharCode(65 + n),
                  date = day(dash.get(col, 6));
                if (!date || date > today) continue;
                const values = Array.from({ length: 9 }, (_, i) =>
                  dash.get(col, i + 7),
                ).filter((v) => numeric(v) && v > 0);
                if (!values.length) continue;
                const actual = dash.get(col, 17);
                if (!numeric(actual)) continue;
                checked++;
                const average =
                  values.reduce((a, b) => a + b, 0) / values.length;
                if (Math.abs(actual - average) > 1e-6)
                  add(
                    col + "17",
                    actual,
                    average,
                    "Сверка наблюдаемой AVERAGEIF(>0); состав команды и исключения ожидают утверждения",
                  );
              }
            if (rule.id === "fbo-trend") {
              const days = [];
              for (let n = 1; n <= 21; n++) {
                const col = String.fromCharCode(65 + n),
                  date = day(dash.get(col, 6)),
                  value = dash.get(col, 17);
                if (date && date < today && numeric(value) && value > 0)
                  days.push({ date, value });
              }
              metrics.completedDays = days;
              checked = days.length;
              metrics.alertsEnabled = false;
              metrics.reason =
                "Нет утверждённого календаря, завершения смены и порога аномалии; текущая смена исключена";
            }
          }
        }
        if (
          [
            "daily-journal",
            "journal-coverage",
            "printing-trend",
            "supply-balance",
          ].includes(rule.id)
        ) {
          const journal = views.get(725126844),
            summary = views.get(572942359),
            supply = views.get(437912546);
          if (!journal) status = "unavailable";
          else {
            const sums = new Map(),
              quantities = new Map(),
              ids = new Map(),
              completed = new Map();
            let invalid = 0;
            for (let row = 2; row <= journal.last; row++) {
              const id = String(journal.get("A", row) || ""),
                date = day(journal.get("B", row)),
                employee = String(journal.get("C", row) || ""),
                operation = String(journal.get("D", row) || ""),
                area = journal.get("L", row),
                quantity = journal.get("J", row),
                uid = String(journal.get("H", row) || "");
              if (!id && !operation) continue;
              ids.set(id, (ids.get(id) || 0) + 1);
              if (!date || !numeric(area) || !employee || !operation) {
                invalid++;
                continue;
              }
              const key = [date, employee, operation].join("|");
              sums.set(key, (sums.get(key) || 0) + area);
              if (operation === "Печать" && id && uid && numeric(quantity)) {
                quantities.set(uid, (quantities.get(uid) || 0) + quantity);
                completed.set(date, (completed.get(date) || 0) + area);
              }
            }
            metrics.invalidRows = invalid;
            metrics.duplicateRecordIds = [...ids].filter(
              ([id, n]) => id && n > 1,
            ).length;
            if (rule.id === "daily-journal") {
              if (!summary || invalid) status = "insufficient_context";
              else {
                const seen = new Set();
                for (let row = 5; row <= summary.last; row++) {
                  const date = day(summary.get("A", row)),
                    employee = summary.get("B", row),
                    op = summary.get("C", row),
                    actual = summary.get("D", row);
                  if (!date || !employee || !op) continue;
                  const key = [date, employee, op].join("|");
                  if (seen.has(key))
                    add(
                      "D" + row,
                      actual,
                      "Единственная строка группы",
                      "Повтор группы в сводке",
                    );
                  seen.add(key);
                  if (!sums.has(key)) {
                    add(
                      "D" + row,
                      actual,
                      null,
                      "Группа сводки не найдена в прочитанном журнале",
                    );
                    continue;
                  }
                  checked++;
                  if (
                    !numeric(actual) ||
                    Math.abs(actual - sums.get(key)) > 1e-6
                  )
                    add(
                      "D" + row,
                      actual,
                      sums.get(key),
                      "Сводка отличается от QUERY sum(L), операции разделены",
                    );
                }
                for (const [key, area] of sums)
                  if (!seen.has(key))
                    add(
                      "A5",
                      null,
                      { group: key, area },
                      "Группа журнала отсутствует в сводке; проверить границы чтения",
                    );
              }
              metrics.journalGroups = sums.size;
              metrics.queryIncludesDuplicates = true;
              metrics.note =
                "QUERY суммирует журнал без дедупликации; это отдельная сверка, KPI по-прежнему использует Worker";
            }
            if (rule.id === "journal-coverage") {
              checked = ids.size;
              for (const [id, n] of ids)
                if (!id || n > 1)
                  add(
                    "A2",
                    id,
                    n,
                    "Проверить ID записи; повтор UID заказа/рулона при частичном выпуске допустим",
                  );
              metrics.linkValidation =
                "Записи других поставок остаются в журнале; исключение поставок из инцидентов не удаляет их выпуск";
            }
            if (rule.id === "printing-trend") {
              const verified = new Map();
              if (
                !printingSnapshot ||
                now.getTime() - Date.parse(printingSnapshot.at) > 1200000
              )
                status = "insufficient_context";
              else
                for (const event of printingSnapshot.value.events || [])
                  if (event.date < today && numeric(event.area))
                    verified.set(
                      event.date,
                      (verified.get(event.date) || 0) + event.area,
                    );
              metrics.completedDays = [...verified]
                .sort()
                .map(([date, area]) => ({ date, area }));
              checked = verified.size;
              metrics.metric =
                "Фактический KPI: уникальные валидные события существующего worker/printing.js";
              metrics.snapshotAt = printingSnapshot?.at || null;
              metrics.alertsEnabled = false;
              metrics.reason =
                "Нет нормы м² и рабочего календаря; сравнение частичной сегодняшней смены заблокировано";
            }
            if (rule.id === "supply-balance") {
              if (!supply || metrics.duplicateRecordIds || invalid)
                status = "insufficient_context";
              else
                for (let row = 4; row <= supply.last; row++) {
                  const uid = String(supply.get("AF", row) || ""),
                    plan = supply.get("O", row),
                    remain = supply.get("P", row);
                  if (!uid || !numeric(plan) || !quantities.has(uid)) continue;
                  checked++;
                  const produced = quantities.get(uid);
                  if (produced > plan + 1e-6)
                    add(
                      "O" + row,
                      { plan, produced },
                      null,
                      "В журнале больше плана: возможны перепечатка, брак или корректировка",
                    );
                  if (
                    numeric(remain) &&
                    Math.abs(remain - Math.max(0, plan - produced)) > 1e-6
                  )
                    add(
                      "P" + row,
                      remain,
                      Math.max(0, plan - produced),
                      "P зависит от текста статуса «Готов», журнал может быть неполным; это гипотеза рассогласования, не эталон исправления",
                    );
                }
              metrics.journalCoverageApproved = false;
            }
          }
        }
        if (
          ["shop-links", "shop-status", "catalog-identities"].includes(rule.id)
        ) {
          const orders = views.get(1580315960),
            catalog = views.get(1335787439);
          if (!orders || !catalog) status = "unavailable";
          else {
            const byArticle = new Map();
            for (let row = 2; row <= catalog.last; row++) {
              const article = String(catalog.get("A", row) || "").trim();
              if (article)
                byArticle.set(article, [
                  ...(byArticle.get(article) || []),
                  row,
                ]);
            }
            if (rule.id === "shop-links")
              for (let row = 3; row <= orders.last; row++) {
                const article = String(orders.get("J", row) || "").trim();
                if (!article) continue;
                checked++;
                const candidates = byArticle.get(article);
                if (!candidates) {
                  add(
                    "J" + row,
                    article,
                    null,
                    "Артикул рабочей строки не найден в выбранном каталоге",
                  );
                  continue;
                }
                const referencedRow = offsetRow(
                  orders.cell("J", row).userEnteredValue?.formulaValue,
                  row,
                  orders.get("N", row),
                  catalog.sheet.properties.title,
                  "A",
                );
                const quantityRow = offsetRow(
                  orders.cell("AA", row).userEnteredValue?.formulaValue,
                  row,
                  orders.get("N", row),
                  catalog.sheet.properties.title,
                  "K",
                );
                if (
                  referencedRow &&
                  quantityRow === referencedRow &&
                  String(catalog.get("A", referencedRow) || "").trim() ===
                    article
                ) {
                  const actual = orders.get("AA", row),
                    reference = catalog.get("K", referencedRow);
                  if (
                    numeric(actual) &&
                    numeric(reference) &&
                    Math.abs(actual - reference) > 1e-6
                  )
                    add(
                      "AA" + row,
                      actual,
                      reference,
                      "Расхождение с конкретной позицией OFFSET; ручная корректировка требует согласования",
                    );
                  continue;
                }
                if (candidates.length !== 1) {
                  add(
                    "J" + row,
                    article,
                    candidates,
                    "Неоднозначное соответствие: сначала утвердить ключ и ручные исключения",
                  );
                  continue;
                }
                const quantity = orders.get("AA", row),
                  reference = catalog.get("K", candidates[0]);
                if (
                  numeric(quantity) &&
                  numeric(reference) &&
                  Math.abs(quantity - reference) > 1e-6
                )
                  add(
                    "AA" + row,
                    quantity,
                    reference,
                    "Количество отличается от каталога; OFFSET, N и ручные корректировки требуют проверки",
                  );
              }
            if (rule.id === "shop-status")
              for (let row = 3; row <= orders.last; row++) {
                if (!String(orders.get("J", row) || "").trim()) continue;
                const statusValue = orders.get("P", row),
                  remaining = orders.get("Q", row);
                if (!numeric(remaining)) continue;
                checked++;
                if (
                  String(statusValue).toLowerCase() === "готово" &&
                  remaining > 0
                ) {
                  const raw =
                    orders.cell("S", row).userEnteredValue?.formulaValue || "";
                  const threshold = raw.match(
                    /^=IF\(Q(\d+)<=([0-9]+(?:[.,][0-9]+)?);"готово";"не готово"\)$/i,
                  );
                  const chain =
                    orders.cell("P", row).userEnteredValue?.formulaValue ===
                    "=IF(S" + row + '="готово";"готово";"не готово")';
                  if (
                    threshold &&
                    Number(threshold[1]) === row &&
                    chain &&
                    orders.get("S", row) === "готово" &&
                    remaining <= Number(threshold[2].replace(",", "."))
                  ) {
                    metrics.expectedStatusRows =
                      (metrics.expectedStatusRows || 0) + 1;
                    continue;
                  }
                  add(
                    "P" + row,
                    { status: statusValue, remaining },
                    null,
                    "Готовность расходится с остатком; назначение статусов требует проверки",
                  );
                }
              }
            metrics.partialRows =
              "Остаток Q использует диапазоны AR/AU, а не одну строку; группы сотрудников не считаются дублями";
            if (rule.id === "catalog-identities") {
              checked = byArticle.size;
              for (const [article, rows] of byArticle)
                if (rows.length > 1)
                  add(
                    "A" + rows[0],
                    article,
                    rows,
                    "Дубликат ключа каталога требует анализа вариантов товара",
                  );
              let emptyErrors = 0,
                filledErrors = 0;
              for (let row = 2; row <= catalog.last; row++)
                for (const col of ["R", "W", "X"])
                  if (catalog.cell(col, row).effectiveValue?.errorValue) {
                    if (String(catalog.get("A", row) || "").trim())
                      filledErrors++;
                    else emptyErrors++;
                  }
              metrics.lookupErrorsFilled = filledErrors;
              metrics.lookupErrorsEmpty = emptyErrors;
              metrics.reason =
                "Не считать ошибки Cash/старых вкладок доказательством повреждения: правила поиска и исключения не утверждены";
            }
          }
        }
      }
      results.push({
        id: rule.id,
        title: rule.title,
        approval: rule.approval,
        gid: schema.gid,
        sheet: schema.name,
        status,
        rowsChecked: checked,
        observations: findings.length,
        allSamples: findings.map((f) => ({
          ...f,
          gid: rule.id === "fbo-current" ? 605337763 : schema.gid,
          sheet: rule.id === "fbo-current" ? "По дням · Дашборд" : schema.name,
        })),
        samples: findings.slice(0, 8).map((f) => ({
          ...f,
          gid: rule.id === "fbo-current" ? 605337763 : schema.gid,
          sheet: rule.id === "fbo-current" ? "По дням · Дашборд" : schema.name,
        })),
        metrics,
        limitations: rule.limitations,
      });
    }
  }
  return { at: now.toISOString(), checks: results, findings: [] }; // Pending proposals never enter incident reconciliation.
}
