import {
  DEFAULT_DOCTOR_DOCUMENTS,
  validateDoctorDocuments,
} from "./doctorRegistry.js";
import {
  ROLL_PRINTING_SHEET,
  ROLL_PRINTING_SHEET_ID,
} from "../worker/printing.js";
import { privateGoogleSource } from "../worker/privateGoogleConfig.js";
export const PRODUCTION_REPAIR_DOCUMENT_IDS = [
  "doctor-fbo",
  "doctor-shop-one",
  "doctor-printing",
];
const proposal = (
  id,
  title,
  parameters = {},
  limitations = "Ручные корректировки, календарь и пороги требуют утверждения",
) => ({ id, title, approval: "pending", parameters, limitations });
export const PRODUCTION_DOCTOR_DOCUMENTS = (() => {
  const fbo = structuredClone(DEFAULT_DOCTOR_DOCUMENTS[0]),
    printing = structuredClone(DEFAULT_DOCTOR_DOCUMENTS[1]);
  fbo.sheets[0].maxRows = 1000;
  fbo.sheets[0].lastColumn = "O";
  fbo.sheets[0].purpose =
    "Готовые коэффициенты B/C/D, сумма E, выпуск I:M и статус F; IMPORTRANGE остаётся зависимостью";
  fbo.sheets[0].businessChecks = [
    proposal("fbo-sum", "Сумма E = B + C + D"),
    proposal(
      "fbo-current",
      "Сверка текущего дня со сводкой",
      {},
      "Сравнивать только один день, не суммировать сводку с историей; 0 не доказывает отсутствие работы",
    ),
  ];
  fbo.sheets.push({
    gid: 605337763,
    name: "По дням · Дашборд",
    maxRows: 24,
    lastColumn: "W",
    headers: [
      { cell: "A6", value: "Имя" },
      { cell: "A17", value: "Командный" },
    ],
    rules: [],
    purpose:
      "Даты B6:V6, сотрудники A7:A15, коэффициенты B7:V15, командный средний B17:V17",
    businessChecks: [
      proposal("fbo-team", "Командный средний по ненулевым коэффициентам"),
      proposal(
        "fbo-trend",
        "Динамика только завершённых дней",
        {},
        "Без утверждённого рабочего календаря и порога показывать динамику, не создавать инцидент; отсутствие не равно нулю",
      ),
    ],
  });
  printing.sheets = printing.sheets.filter((s) =>
    [437912546, 725126844].includes(s.gid),
  );
  const supply = printing.sheets[0];
  supply.purpose =
    "J план м²; K остаток м²; O план шт.; P остаток шт.; Q статус; AF UID";
  supply.businessChecks = [
    proposal("supply-area", "План J = F × H × I × O"),
    proposal(
      "supply-balance",
      "Сопоставление плана, журнала и остатка",
      {},
      "Журнал может не содержать весь исторический выпуск; ручные статусы и частичные рулоны учитываются отдельно",
    ),
  ];
  const journal = printing.sheets[1];
  journal.lastColumn = "O";
  journal.purpose =
    "A ID записи, B производственная дата, D операция, H UID, J шт., L фактические м²; не требовать формулу J/L";
  journal.businessChecks = [
    proposal(
      "journal-coverage",
      "Уникальные записи, UID, валидные даты и связность",
      {},
      "Не считать один UID заказа/рулона дублем записи: допустимы частичные выпуски",
    ),
  ];
  printing.sheets.push({
    gid: 572942359,
    name: "Выпуск по дням",
    maxRows: 3000,
    lastColumn: "D",
    headers: [
      { cell: "A4", value: "Дата" },
      { cell: "D4", value: "Выпущено, м²" },
    ],
    rules: [],
    purpose:
      "A5 QUERY по журналу: дата A, сотрудник B, операция C, сумма фактической площади D",
    businessChecks: [
      proposal(
        "daily-journal",
        "Сверка QUERY со всеми операциями журнала",
        {},
        "Резка сверяется отдельно, в KPI печати не включается; неполное чтение блокирует вывод о пропусках",
      ),
      proposal(
        "printing-trend",
        "Динамика фактического выпуска за завершённые дни",
        {},
        "Без норм м², рабочего календаря и порога падение не считается неисправностью",
      ),
    ],
  });
  const shop = {
    id: "doctor-shop-one",
    documentId: privateGoogleSource("ozonCodesCatalogId"),
    name: "OZON Первый магазин",
    department: "Сборка",
    enabled: true,
    adapter: "google",
    freshness: null,
    purpose:
      "Связность выбранной рабочей вкладки и каталога; нормы не изменяются",
    sheets: [
      {
        gid: 1580315960,
        name: "Первый магазин НОВАЯ ПЕЧАТЬ 20.07.2026",
        maxRows: 6000,
        lastColumn: "AX",
        chunkRows: 250,
        headers: [
          { cell: "J2", value: "Артикул" },
          { cell: "AA2", value: "Кол-во всего" },
        ],
        rules: [],
        purpose:
          "J артикул, N сдвиг; W:Z направления, AA количество, P статус, Q остаток; AR/AU частичное выполнение",
        businessChecks: [
          proposal("shop-links", "Артикул и количество связаны с каталогом"),
          proposal(
            "shop-status",
            "Статус и остаток соответствуют частичным операциям",
            {},
            "Строки разных сотрудников, OFFSET и сдвиг N не считать дублями; ручные корректировки нуждаются в перечне исключений",
          ),
        ],
      },
      {
        gid: 1335787439,
        name: "Товары НОВАЯ ПЕЧАТЬ 20.07.2026",
        maxRows: 3000,
        lastColumn: "Z",
        chunkRows: 500,
        headers: [
          { cell: "A1", value: "ариткул" },
          { cell: "K1", value: "Временно" },
        ],
        rules: [],
        purpose:
          "A ключ артикула; G:J направления, K сумма; F упаковка; R листы из Cash, W/X другие вкладки — зависимости",
        businessChecks: [
          proposal(
            "catalog-sum",
            "K = сумма G:J и сопоставление с рабочим листом",
          ),
          proposal(
            "catalog-identities",
            "Неоднозначные ключи и контекст ошибок поиска",
            {},
            "Дубликат артикула или #N/A сначала требует анализа; Cash/Нормы/старые вкладки не создают самостоятельных инцидентов",
          ),
        ],
      },
    ],
    dataQuality: [
      {
        id: "shop-required-product-kind",
        title: "Вид обязателен для расчёта коэффициента упаковки",
        production: {
          gid: 1580315960,
          startRow: 3,
          maxRows: 6000,
          articleColumn: "A",
          operationColumns: ["W", "X", "Y", "Z", "AA", "AR", "AU"],
          errorColumns: ["AP"],
          dependencyColumns: ["B", "C"],
          outputType: "number",
          outputGuardColumn: "AN",
        },
        source: {
          gid: 1335787439,
          sheet: "Товары НОВАЯ ПЕЧАТЬ 20.07.2026",
          maxRows: 3000,
          keyColumn: "A",
          fieldColumn: "P",
          fieldLabel: "Вид",
          relatedFieldColumn: "Q",
          relatedFieldLabel: "Вид товара",
        },
      },
    ],
  };
  const rollPrinting = {
    id: "doctor-roll-printing",
    documentId: ROLL_PRINTING_SHEET_ID,
    name: "OZON РУЛОННАЯ ПЕЧАТЬ",
    department: "Печать",
    enabled: true,
    adapter: "google",
    freshness: null,
    purpose:
      "Только чтение трёх рабочих вкладок; факт выпуска считается по журналу, сводка не дублирует KPI",
    sheets: [
      {
        gid: ROLL_PRINTING_SHEET.gid,
        name: ROLL_PRINTING_SHEET.name,
        maxRows: 969,
        lastColumn: "AF",
        headers: [
          { cell: "E4", value: "Артикул" },
          { cell: "O4", value: "Кол-во" },
          { cell: "AC1", value: "UID" },
        ],
        context: {
          startRow: 5,
          columns: [
            "E",
            "F",
            "G",
            "H",
            "I",
            "J",
            "K",
            "L",
            "M",
            "O",
            "P",
            "Q",
            "R",
          ],
          activeColumns: ["E"],
          errorColumns: [
            "E",
            "F",
            "G",
            "H",
            "I",
            "J",
            "K",
            "L",
            "M",
            "O",
            "P",
            "Q",
            "R",
          ],
          emptyLookupNAColumns: [],
          emptyRowPropagatedNAColumns: ["J", "K", "P"],
          ignoreCalculationErrorsWhenInactive: true,
          suppressErrorsWithSameRowErrorDependency: true,
          impact:
            "Ошибка в активной строке рулонной печати может исказить план; влияние на выпуск сверяется с журналом",
        },
        rules: [
          {
            id: "roll-planned-area",
            kind: "formula",
            column: "J",
            startRow: 5,
            endRow: 969,
            when: { column: "E", notEmpty: true },
            approval: "pending",
            templates: ["=F{row}*H{row}*I{row}*O{row}"],
            exceptions: [],
            impact:
              "Искажение плановой площади; формула обнаружена при подключении и требует утверждения владельцем",
          },
          {
            id: "roll-order-uid",
            kind: "unique",
            column: "AC",
            startRow: 5,
            endRow: 969,
            when: { column: "E", notEmpty: true },
            approval: "approved",
            exceptions: [],
            impact: "Нарушение связи поставки с журналом выпуска",
          },
          {
            id: "roll-order-quantity",
            kind: "integer",
            column: "O",
            startRow: 5,
            endRow: 969,
            when: { column: "E", notEmpty: true },
            approval: "approved",
            minimum: 0,
            exceptions: [],
            impact: "Некорректное количество заказа",
          },
        ],
        businessChecks: [
          proposal(
            "roll-order-links",
            "Связность UID заказа с журналом выпуска",
            {},
            "Проверять только после полного чтения обоих листов; не выполнять запись",
          ),
        ],
      },
      {
        gid: 126956215,
        name: "Журнал выпуска",
        maxRows: 996,
        lastColumn: "Z",
        headers: [
          { cell: "A1", value: "ID записи" },
          { cell: "D1", value: "Операция" },
          { cell: "H1", value: "UID заказа" },
          { cell: "J1", value: "Сделано" },
          { cell: "L1", value: "Выпуск м²" },
        ],
        rules: [
          ...[
            { id: "roll-entry-id", kind: "unique", column: "A" },
            { id: "roll-production-date", kind: "date", column: "B" },
            { id: "roll-order-required", kind: "required", column: "H" },
            {
              id: "roll-completed-pieces",
              kind: "integer",
              column: "J",
              minimum: 1,
            },
            {
              id: "roll-actual-area",
              kind: "number",
              column: "L",
              minimum: 0.000001,
            },
          ].map((rule) => ({
            ...rule,
            startRow: 2,
            endRow: 996,
            when: { column: "D", equals: "Печать" },
            approval: "approved",
            exceptions: [],
            impact:
              "Невалидная запись может быть исключена из фактического KPI рулонной печати",
          })),
        ],
        businessChecks: [
          proposal(
            "roll-journal-order-match",
            "Связь записи печати с вкладкой заказа",
            {},
            "Учитывать исходное имя листа OZON МОСКВА как подтверждённый псевдоним; не считать QUERY отдельной записью",
          ),
        ],
      },
      {
        gid: 2053830156,
        name: "Выпуск по дням",
        maxRows: 1000,
        lastColumn: "Z",
        headers: [
          { cell: "A1", value: "Дата" },
          { cell: "B1", value: "Сотрудник" },
          { cell: "C1", value: "Операция" },
          { cell: "D1", value: "Сделано, шт." },
          { cell: "E1", value: "Выпуск, м²" },
        ],
        context: {
          startRow: 2,
          columns: ["A", "B", "C", "D", "E"],
          activeColumns: ["A", "B", "C"],
          errorColumns: ["A", "B", "C", "D", "E"],
          emptyLookupNAColumns: [],
          impact:
            "Сводка используется только для сверки с журналом и не суммируется повторно в KPI",
        },
        rules: [],
        businessChecks: [
          proposal(
            "roll-daily-summary",
            "Сверка дневной сводки с журналом выпуска",
            {},
            "Проверка остаётся информационной до подтверждения правил группировки; сводка не является источником факта",
          ),
        ],
      },
    ],
  };
  return validateDoctorDocuments([fbo, shop, printing, rollPrinting]);
})();
