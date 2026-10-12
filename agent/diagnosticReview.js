import {
  gridViews,
  cellEvidence,
  digest,
  scalar,
  numeric,
  offsetRow,
  productionDay,
} from "./diagnosticGrid.js";
const specs = [
  {
    id: "fbo-sum",
    sourceId: "doctor-fbo",
    gid: 0,
    title: "Итоговый коэффициент сотрудника",
    range: "E2:E10",
    first: 2,
    last: 10,
    target: "E",
    key: "A",
    inputs: ["B", "C", "D"],
    template: "=SUM(B{row}:D{row})",
    condition:
      "A содержит имя (текст с буквами); строки 2–10. Числовые и специальные строки не включаются.",
    exceptions:
      "Пустые имена и числовая строка A10 исключены. Ручные итоги и индивидуальные формулы требуют точечного исключения владельца.",
    impact:
      "Повреждение итога E может исказить готовый коэффициент сборщика. Внешние IMPORTRANGE этим правилом не аудируются.",
    clarification:
      "В источнике SUM(B:D), а не SUM(B). Утверждается полный диапазон B:D.",
  },
  {
    id: "supply-area",
    sourceId: "doctor-printing",
    gid: 437912546,
    title: "Плановая площадь заказа",
    range: "J4:J2000",
    first: 4,
    last: 2000,
    target: "J",
    key: "E",
    inputs: ["F", "H", "I", "O"],
    template: "=F{row}*H{row}*I{row}*O{row}",
    condition:
      "Заполнен артикул E и задано количество O. Нулевой план не требует обязательной формулы; повреждённые числа рассматриваются отдельно.",
    exceptions:
      "Пустые производственные строки исключены; ручная площадь и особые размеры — только точечное исключение с причиной.",
    impact:
      "Это план J. Фактический KPI печати остаётся суммой валидного выпуска L журнала.",
    clarification: "Плановая площадь не заменяет фактический выпуск.",
  },
  {
    id: "catalog-sum",
    sourceId: "doctor-shop-one",
    gid: 1335787439,
    title: "Количество в каталоге товаров",
    range: "K2:K3000",
    first: 2,
    last: 3000,
    target: "K",
    key: "A",
    inputs: ["G", "H", "I", "J"],
    template: "=SUM(G{row}:J{row})",
    condition:
      "Заполнен текстовый артикул A. Пустые G:J допускаются как пустые направления, непустой текст не считается числом.",
    exceptions:
      "Строки без артикула исключены. Ручная корректировка K требует исключения ровно для наблюдаемой ячейки и её содержимого.",
    impact:
      "Количество K используется рабочим листом через OFFSET; ошибка ввода может исказить план и остаток. Влияние на коэффициент зависит от норм и фактических операций.",
    clarification:
      "В источнике SUM(G:J), а не SUM(G). Утверждаются все четыре направления.",
  },
  {
    id: "daily-journal",
    sourceId: "doctor-printing",
    gid: 572942359,
    title: "Дневной выпуск соответствует журналу",
    range: "A5:D3000 ↔ Журнал выпуска A2:O3000",
    template: null,
    condition:
      "Полностью прочитаны зарегистрированные области журнала и сводки. Группировка по производственной дате B, сотруднику C и операции D, сумма L; Europe/Moscow.",
    exceptions:
      "Частичные выпуски одного рулона складываются. Печать и резка — отдельные группы. QUERY суммирует строки журнала без дедупликации; дубли ID расследуются отдельно.",
    impact:
      "Расхождение сводки с журналом может исказить отображаемые итоги; KPI RITM продолжает использовать существующий Worker с уникальными валидными событиями.",
    clarification:
      "Утверждение диагностики не разрешает запись или восстановление QUERY.",
  },
];
export const BASIC_RULE_IDS = specs.map((s) => s.id);
const formulaKey = (s) =>
  String(s || "")
    .replace(/\s/g, "")
    .toUpperCase();
const dateKey = productionDay;
const filled = (v) => v !== null && v !== "";
export function reviewDocument(document, spreadsheet, draft, now = new Date()) {
  const views = gridViews(spreadsheet),
    observations = [],
    rules = [];
  const make = (
    ruleId,
    gid,
    cell,
    type,
    title,
    why,
    cause,
    impact,
    recommendation,
    confidence,
    evidence,
    expected = null,
    classification = "suspicious",
  ) => {
    const identity = {
      sourceId: document.id,
      documentId: document.documentId,
      ruleId,
      gid,
      cell,
      type,
      ...(expected?.group ? { group: expected.group } : {}),
    };
    const item = {
      ...identity,
      id: digest(identity),
      document: document.name,
      sheet: views.get(gid)?.sheet.properties.title || "",
      title,
      why,
      cause,
      impact,
      recommendation,
      confidence,
      evidence,
      expected,
      classification,
      sourceUrl:
        "https://docs.google.com/spreadsheets/d/" +
        document.documentId +
        "/edit#gid=" +
        gid +
        "&range=" +
        encodeURIComponent(cell),
    };
    item.evidenceVersion = digest({ identity, evidence, expected });
    observations.push(item);
    return item;
  };
  for (const spec of specs.filter((s) => s.sourceId === document.id)) {
    const view = views.get(spec.gid),
      schema = document.sheets.find((s) => s.gid === spec.gid);
    if (!view || !schema) continue;
    const contract = {
      revision: 1,
      ...spec,
      documentId: document.documentId,
      sheet: schema.name,
    };
    const rule = {
      ...contract,
      version: digest(contract),
      rowsChecked: 0,
      formulaMatches: 0,
      excludedRows: 0,
      deviations: 0,
      status: "ready",
      at: view.sheet.readAt || now.toISOString(),
      sampleFormulas: [],
      observations: [],
    };
    if (spec.template) {
      for (let row = spec.first; row <= Math.min(spec.last, view.last); row++) {
        const key = view.get(spec.key, row),
          input = spec.inputs.map((col) => view.get(col, row));
        const selected =
          typeof key === "string" &&
          !!key.trim() &&
          (spec.id !== "fbo-sum" || /[А-ЯЁA-Z]/i.test(key)) &&
          (spec.id !== "supply-area" || (filled(input[3]) && input[3] !== 0));
        if (!selected) {
          rule.excludedRows++;
          continue;
        }
        rule.rowsChecked++;
        const expected = spec.template.replaceAll("{row}", String(row)),
          native = view.cell(spec.target, row),
          actual = native.userEnteredValue?.formulaValue || null;
        const evidence = [
          cellEvidence(document, view, spec.key, row),
          ...spec.inputs.map((c) => cellEvidence(document, view, c, row)),
          cellEvidence(document, view, spec.target, row),
        ];
        if (rule.sampleFormulas.length < 3)
          rule.sampleFormulas.push({
            cell: spec.target + row,
            formula: actual,
            expected,
          });
        if (formulaKey(actual) !== formulaKey(expected)) {
          make(
            spec.id,
            spec.gid,
            spec.target + row,
            !actual
              ? filled(scalar(native))
                ? "formula_number"
                : "formula_missing"
              : "formula_mismatch",
            "Формула не соответствует предлагаемому эталону",
            "Правило требует точной формулы для подходящей строки; соседние ячейки не используются как эталон.",
            !actual
              ? "Возможно, формулу удалили или заменили вводом; история редактирования не проверена."
              : "Причина изменения неизвестна; возможна индивидуальная формула, которую нужно согласовать.",
            spec.impact,
            "Сначала подтвердить эталон и исключения. Разрешение на исправление требуется отдельно.",
            "Эталон пока не утверждён",
            evidence,
            expected,
          );
        } else rule.formulaMatches++;
        const values = input.map((v) =>
          !filled(v) && spec.id !== "supply-area" ? 0 : v,
        );
        if (!values.every(numeric)) {
          make(
            spec.id,
            spec.gid,
            spec.inputs[values.findIndex((v) => !numeric(v))] + row,
            "invalid_input",
            "Нечисловой ввод в расчётной строке",
            "Входной диапазон содержит непустой текст или ошибку. SUM может молча пропустить текстовые количества.",
            "Механизм пропуска текста подтверждён типом ячейки; кто и зачем ввёл текст, неизвестно.",
            spec.impact,
            "Проверить тип введённого количества и назначение строки; формулу не менять.",
            "Высокая: тип ячейки прочитан через API",
            evidence,
            null,
            "business_process",
          );
        } else {
          const expectedValue =
              spec.id === "supply-area"
                ? values.reduce((a, b) => a * b, 1)
                : values.reduce((a, b) => a + b, 0),
            actualValue = scalar(native);
          for (const o of observations.filter(
            (o) => o.ruleId === spec.id && o.cell === spec.target + row,
          ))
            o.expectedResult = expectedValue;
          if (
            !numeric(actualValue) ||
            Math.abs(actualValue - expectedValue) > 1e-6
          )
            make(
              spec.id,
              spec.gid,
              spec.target + row,
              "result_mismatch",
              "Результат расчёта расходится с входными данными",
              "Проверен текущий числовой результат, без изменения исходных коэффициентов.",
              "Возможны ручной ввод, пересчёт или изменения между чтениями; причина требует проверки.",
              spec.impact,
              "Повторить проверку и сверить входные данные. Совпадение формулы не доказывает корректность исходного ввода.",
              "Снимок подтверждает расхождение, причина не подтверждена",
              evidence,
              expectedValue,
              "business_process",
            );
        }
      }
    } else {
      const c = draft?.checks.find((c) => c.id === spec.id);
      rule.rowsChecked = c?.rowsChecked || 0;
      rule.status = c?.status === "preview" ? "ready" : "blocked";
      for (const s of c?.allSamples || c?.samples || [])
        make(
          spec.id,
          spec.gid,
          s.cell,
          "result_mismatch",
          "Сводка выпуска расходится с журналом",
          s.reason,
          "Границы чтения, пересчёт QUERY и параллельное внесение выпуска требуют проверки.",
          spec.impact,
          "Перепроверить сопоставимую группу; сводка и журнал читаются в разные моменты.",
          "Средняя: межлистовый снимок не атомарный",
          [
            {
              sheet: schema.name,
              gid: spec.gid,
              cell: s.cell,
              value: s.observed,
              formula: null,
              url:
                "https://docs.google.com/spreadsheets/d/" +
                document.documentId +
                "/edit#gid=" +
                spec.gid +
                "&range=" +
                s.cell,
            },
          ],
          s.expected,
          "business_process",
        );
      rule.metrics = c?.metrics || {};
    }
    rule.observations = observations
      .filter((o) => o.ruleId === spec.id)
      .map((o) => o.id);
    rule.deviations = rule.observations.length;
    rule.deviatingRows = new Set(
      observations
        .filter((o) => o.ruleId === spec.id)
        .map((o) => o.cell.match(/\d+/)?.[0]),
    ).size;
    rules.push(rule);
  }
  // Investigations use source formulas and actual dependencies, not inferred norms.
  const totals = views.get(0),
    dash = views.get(605337763);
  if (totals && dash) {
    const c = draft?.checks.find((c) => c.id === "fbo-current");
    for (const s of c?.allSamples || c?.samples || [])
      if (s.observed?.employee) {
        const m = s.cell.match(/^([A-Z]+)(\d+)$/),
          r = Number(m[2]);
        const evidence = [
          cellEvidence(document, dash, "A", r),
          cellEvidence(document, dash, m[1], r),
          ...Array.from({ length: 8 }, (_, i) =>
            cellEvidence(document, totals, "A", i + 2),
          ),
        ];
        make(
          "fbo-current",
          605337763,
          s.cell,
          "missing_employee",
          "Сотрудник дашборда отсутствует в текущей сводке",
          "XLOOKUP ищет имя в A2:A9 и возвращает 0 при отсутствии. IFERROR дополнительно скрывает ошибки поиска.",
          "Два списка сотрудников расходятся. Изменение состава, забытая строка или исторический сотрудник — гипотезы; история редакций недоступна.",
          "Текущий ноль не доказывает отсутствие работы; командный средний >0 исключает ноль. История RITM не дополняется этим нулём.",
          "Уточнить, должен ли сотрудник участвовать сегодня; согласовать список и диапазон, прежде чем предлагать изменение.",
          "Высокая для механизма поиска; причина отсутствия не установлена",
          evidence,
          null,
          "business_process",
        );
      }
  }
  const orders = views.get(1580315960),
    catalog = views.get(1335787439);
  if (orders && catalog) {
    const referenced = new Map();
    for (let row = 3; row <= orders.last; row++) {
      const article = orders.get("J", row);
      if (!filled(article)) continue;
      const target = offsetRow(
        orders.cell("J", row).userEnteredValue?.formulaValue,
        row,
        orders.get("N", row),
        catalog.sheet.properties.title,
        "A",
      );
      if (target)
        referenced.set(target, [...(referenced.get(target) || []), row]);
      const remaining = orders.get("Q", row),
        status = orders.get("P", row);
      if (
        String(status).toLowerCase() === "готово" &&
        numeric(remaining) &&
        remaining > 0
      ) {
        const raw = orders.cell("S", row).userEnteredValue?.formulaValue || "",
          match = raw.match(
            new RegExp(
              "^=IF\\(Q" +
                row +
                '<=([0-9]+(?:[.,][0-9]+)?);"готово";"не готово"\\)$',
              "i",
            ),
          );
        const threshold = match ? Number(match[1].replace(",", ".")) : null;
        const chain =
          orders.cell("P", row).userEnteredValue?.formulaValue ===
          `=IF(S${row}="готово";"готово";"не готово")`;
        const explained =
          threshold !== null &&
          chain &&
          remaining <= threshold &&
          orders.get("S", row) === "готово";
        let quantity = 0;
        const group = [];
        for (let r = row; r <= row + 7; r++)
          for (const col of ["AR", "AU"]) {
            const v = orders.get(col, r);
            if (numeric(v)) quantity += v;
            if (filled(v)) group.push(cellEvidence(document, orders, col, r));
          }
        make(
          "shop-status",
          1580315960,
          "P" + row,
          "status_remaining",
          explained
            ? "Готовность объясняется действующей формулой"
            : "Готовность требует проверки",
          explained
            ? `S использует допуск ≤ ${threshold}; P повторяет S. Остаток ${remaining} укладывается в существующее условие.`
            : "Положительный остаток при статусе готово; объясняющее условие не распознано.",
          explained
            ? "Это наблюдаемая логика источника, а не повреждение формулы. Допуск ещё не утверждён как бизнес-норма."
            : "Назначение статуса и ручные корректировки неизвестны.",
          `План ${orders.get("AA", row)}, числовое выполнение группы ${quantity}, остаток ${remaining}. Изменение KPI не доказано; коэффициент от статуса не пересчитывается.`,
          explained
            ? "Согласовать допустимость порога 5. Не восстанавливать и не заменять формулы из-за остатка 1."
            : "Проверить статусы и группу выполнения; не менять производственные данные.",
          explained
            ? "Высокая: цепочка P → S → Q прочитана"
            : "Требует ручной проверки",
          [
            ...["J", "N", "P", "Q", "S", "AA"].map((c) =>
              cellEvidence(document, orders, c, row),
            ),
            ...group,
          ],
          null,
          explained ? "expected_behavior" : "business_process",
        );
      }
    }
    const by = new Map();
    for (let row = 2; row <= catalog.last; row++) {
      const a = catalog.get("A", row);
      if (typeof a === "string" && a.trim())
        by.set(a, [...(by.get(a) || []), row]);
    }
    for (const [article, rows] of by)
      if (rows.length > 1) {
        const evidence = rows.flatMap((r) =>
            ["A", "F", "G", "H", "I", "J", "K"].map((c) =>
              cellEvidence(document, catalog, c, r),
            ),
          ),
          refs = rows.flatMap((r) =>
            (referenced.get(r) || []).map((orderRow) => ({
              catalogRow: r,
              orderRow,
            })),
          );
        const quantities = rows.map((r) => catalog.get("K", r)),
          pack = rows.map((r) => catalog.get("F", r));
        const different =
          new Set(quantities.map((v) => JSON.stringify(v))).size > 1 ||
          new Set(pack.map((v) => JSON.stringify(v))).size > 1;
        make(
          "catalog-identities",
          1335787439,
          "A" + rows[0],
          "duplicate_article",
          article + " — повтор артикула",
          "Повторён текстовый артикул, но рабочие строки могут адресовать отдельные позиции через OFFSET.",
          different
            ? "Различаются количества или упаковка: возможны разные партии/варианты; это не подтверждает допустимость повторов."
            : "Количества и упаковка совпадают: возможны копия или повторная партия; назначение не доказано.",
          refs.length
            ? `Рабочие строки используют позиции: ${refs.map((v) => v.orderRow + " → " + v.catalogRow).join(", ")}. Сам повтор не доказывает двойное начисление KPI.`
            : "Связь с рабочей строкой не найдена; влияние на KPI не установлено.",
          "Утвердить назначение конкретных повторов и ключ «артикул + позиция/партия». Не удалять строки автоматически.",
          "Высокая для фактов и адресов OFFSET; назначение требует владельца",
          evidence,
          null,
          "business_process",
        );
      }
  }
  const supply = views.get(437912546),
    journal = views.get(725126844);
  if (supply && journal) {
    const records = new Map(),
      ids = new Set();
    let unsafe = false;
    for (let r = 2; r <= journal.last; r++) {
      const id = journal.get("A", r);
      if (!filled(id) && !filled(journal.get("D", r))) continue;
      if (!id || ids.has(id)) unsafe = true;
      ids.add(id);
      if (journal.get("D", r) !== "Печать") continue;
      const uid = journal.get("H", r),
        q = journal.get("J", r),
        source = journal.get("E", r);
      if (!numeric(q) || !dateKey(journal.get("B", r))) {
        unsafe = true;
        continue;
      }
      if (source && source !== supply.sheet.properties.title) continue;
      if (uid) records.set(uid, [...(records.get(uid) || []), r]);
    }
    if (!unsafe)
      for (let row = 4; row <= supply.last; row++) {
        const uid = supply.get("AF", row),
          rr = records.get(uid),
          plan = supply.get("O", row),
          remain = supply.get("P", row);
        if (!rr || !numeric(plan) || !numeric(remain)) continue;
        const qty = rr.reduce((n, r) => n + journal.get("J", r), 0),
          candidate = Math.max(0, plan - qty);
        if (Math.abs(remain - candidate) < 1e-6) continue;
        const status = supply.get("Q", row),
          actual = supply.cell("P", row).userEnteredValue?.formulaValue;
        const old = actual === `=IF(Q${row}="Готов";0;O${row})`;
        const count = String(status || "").match(/^(\d+)\s+из\s+(\d+)$/);
        make(
          "supply-balance",
          437912546,
          "P" + row,
          "remaining_journal",
          supply.get("E", row) + " — остаток и журнал",
          "План " +
            plan +
            ", записанный выпуск " +
            qty +
            ", остаток P " +
            remain +
            ". Разность плана и доступного журнала " +
            candidate +
            " — аналитический кандидат, не формула для записи.",
          old
            ? "P реагирует только на буквальный статус «Готов». " +
                (count
                  ? "Q содержит счётчик «" +
                    status +
                    "», поэтому P остаётся равен плану."
                  : "Текущий статус не включает вычитание частичного выпуска.") +
                " Это несовпадение представлений статуса; полнота исторического журнала не подтверждена."
            : "Формула остатка индивидуальная; связь и полнота истории требуют проверки.",
          "Отображаемый остаток P и площадь K могут не отражать частичный выпуск. Фактический KPI печати берётся из L журнала и здесь не заменяется.",
          "Согласовать единый смысл статуса и остатка, период покрытия журнала. Не записывать «план − журнал» без отдельного утверждения.",
          old
            ? "Высокая для механизма P/Q; средняя для полного остатка"
            : "Требует анализа",
          [
            ...["E", "O", "P", "Q", "K", "AF"].map((c) =>
              cellEvidence(document, supply, c, row),
            ),
            ...rr.flatMap((r) =>
              ["A", "B", "D", "E", "H", "J", "L"].map((c) =>
                cellEvidence(document, journal, c, r),
              ),
            ),
          ],
          candidate,
          "business_process",
        );
      }
  }
  for (const c of draft?.checks || []) {
    if (
      [
        ...BASIC_RULE_IDS,
        "shop-status",
        "catalog-identities",
        "supply-balance",
      ].includes(c.id)
    )
      continue;
    for (const s of c.allSamples || c.samples || []) {
      if (c.id === "fbo-current" && s.observed?.employee) continue;
      const gid = s.gid ?? c.gid,
        view = views.get(gid),
        m = s.cell.match(/^([A-Z]+)(\d+)$/);
      const native =
        view && m ? cellEvidence(document, view, m[1], Number(m[2])) : null;
      make(
        c.id,
        gid,
        s.cell,
        "business_comparison",
        c.title,
        s.reason,
        "Снимок подтверждает наблюдение; причина и допустимые ручные корректировки требуют проверки. Чтения Google не атомарны.",
        "Влияние зависит от фактических операций и связей источника; отсутствие данных не заменяется нулевым KPI.",
        "Сверить исходные ячейки и назначение строки; не менять данные автоматически.",
        "Средняя: факт снимка, причина не установлена",
        native
          ? [native]
          : [
              {
                sheet: s.sheet || c.sheet,
                gid,
                cell: s.cell,
                value: s.observed,
                formula: null,
                url:
                  "https://docs.google.com/spreadsheets/d/" +
                  document.documentId +
                  "/edit#gid=" +
                  gid +
                  "&range=" +
                  s.cell,
              },
            ],
        s.expected,
        "business_process",
      );
    }
  }
  return {
    at: now.toISOString(),
    sourceId: document.id,
    document: document.name,
    rules,
    observations,
  };
}
