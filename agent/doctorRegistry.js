import { SHEET_ID, SUPPLY_SHEETS } from "../worker/printing.js";
import { FBO_SOURCE_ID } from "../worker/assembly.js";
export const DEFAULT_DOCTOR_DOCUMENTS = [
  {
    id: "doctor-fbo",
    documentId: FBO_SOURCE_ID,
    name: "FBO итого",
    department: "Сборка",
    enabled: true,
    adapter: "google",
    purpose:
      "Формулы исходных коэффициентов; история FBO остаётся источником KPI",
    freshness: null,
    sheets: [
      {
        gid: 0,
        name: "Все коэффициенты",
        maxRows: 10,
        lastColumn: "F",
        headers: [
          { cell: "B1", value: "Кэф резки" },
          { cell: "E1", value: "Общий" },
        ],
        rules: [
          ...["B", "C", "D"].map((column) => ({
            id: "coefficient-" + column,
            kind: "formula",
            column,
            startRow: 2,
            endRow: 10,
            when: { column: "A", notEmpty: true },
            approval: "pending",
            templates: [],
            exceptions: [],
            impact: "Искажение исходного коэффициента сборки",
            note: "Нужно утвердить точные IMPORTRANGE и разрешённые ссылки.",
          })),
          {
            id: "total-coefficient",
            kind: "formula",
            column: "E",
            startRow: 2,
            endRow: 10,
            when: { column: "A", notEmpty: true },
            approval: "pending",
            templates: ["=SUM(B{row}:D{row})"],
            exceptions: [
              {
                when: { column: "A", equals: "Итого" },
                templates: ["=SUM(E2:E9)"],
                reason:
                  "Итоговая строка проверяется отдельной формулой-кандидатом",
              },
            ],
            impact: "Искажение итогового коэффициента сборки",
          },
        ],
      },
    ],
  },
  {
    id: "doctor-printing",
    documentId: SHEET_ID,
    name: "СЕЗОННАЯ ПЕЧАТЬ КРАСНОЕ ЗДАНИЕ",
    department: "Печать",
    enabled: true,
    adapter: "google",
    purpose:
      "Плановая площадь, количества, UID и журнал; фактический KPI не пересчитывается",
    freshness: null,
    sheets: [
      ...SUPPLY_SHEETS.map(([gid, name]) => ({
        gid,
        name,
        maxRows: 2000,
        lastColumn: "AF",
        headers: [
          { cell: "E3", value: "Артикул" },
          { cell: "O3", value: "Кол-во" },
          { cell: "AF1", value: "UID" },
        ],
        rules: [
          {
            id: "planned-area",
            kind: "formula",
            column: "J",
            startRow: 4,
            endRow: 2000,
            when: { column: "E", notEmpty: true },
            approval: "pending",
            templates: ["=F{row}*H{row}*I{row}*O{row}"],
            exceptions: [],
            result: {
              kind: "product",
              columns: ["F", "H", "I", "O"],
              tolerance: 0.000001,
            },
            impact:
              "Искажение плановой площади поставки; факт KPI берётся из журнала",
          },
          {
            id: "pieces",
            kind: "integer",
            column: "O",
            startRow: 4,
            endRow: 2000,
            when: { column: "E", notEmpty: true },
            approval: "approved",
            minimum: 0,
            exceptions: [],
            impact: "Искажение планового количества",
          },
          {
            id: "order-uid",
            kind: "unique",
            column: "AF",
            startRow: 4,
            endRow: 2000,
            when: { column: "E", notEmpty: true },
            approval: "approved",
            exceptions: [],
            impact: "Нарушение связи заказа с журналом",
          },
        ],
      })),
      {
        gid: 725126844,
        name: "Журнал выпуска",
        maxRows: 3000,
        lastColumn: "M",
        headers: [
          { cell: "A1", value: "ID записи" },
          { cell: "D1", value: "Операция" },
          { cell: "L1", value: "Выпуск, м²" },
        ],
        rules: [
          ...[
            { id: "entry-id", kind: "unique", column: "A" },
            { id: "production-day", kind: "date", column: "B" },
            { id: "order-uid", kind: "required", column: "H" },
            { id: "pieces", kind: "integer", column: "J", minimum: 1 },
            { id: "actual-area", kind: "number", column: "L", minimum: 0 },
          ].map((r) => ({
            ...r,
            startRow: 2,
            endRow: 3000,
            when: { column: "D", equals: "Печать" },
            approval: "approved",
            exceptions: [],
            impact: "Невалидная запись может быть исключена из KPI печати",
          })),
        ],
      },
    ],
  },
];
const columns = /^[A-Z]{1,3}$/,
  cell = /^[A-Z]{1,3}[1-9]\d*$/;
export function doctorColumnIndex(value) {
  return [...value].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}
function condition(c) {
  return (
    !c ||
    (columns.test(c.column || "") &&
      (c.notEmpty === true || typeof c.equals === "string"))
  );
}
export function validateDoctorDocuments(documents) {
  if (!Array.isArray(documents) || documents.length > 30)
    throw new Error("Invalid Table Doctor registry");
  const ids = new Set();
  for (const d of documents) {
    if (
      !/^[a-z0-9-]{1,80}$/.test(d.id || "") ||
      ids.has(d.id) ||
      !d.name ||
      !d.department ||
      !["google", "fixture"].includes(d.adapter) ||
      (d.adapter === "google" &&
        !/^[A-Za-z0-9_-]{20,100}$/.test(d.documentId || "")) ||
      !Array.isArray(d.sheets) ||
      !d.sheets.length
    )
      throw new Error("Invalid Table Doctor document");
    ids.add(d.id);
    const gids = new Set();
    for (const s of d.sheets) {
      if (
        !Number.isSafeInteger(s.gid) ||
        s.gid < 0 ||
        gids.has(s.gid) ||
        !s.name ||
        !Number.isSafeInteger(s.maxRows) ||
        s.maxRows < 1 ||
        s.maxRows > 10000 ||
        !columns.test(s.lastColumn) ||
        doctorColumnIndex(s.lastColumn) >= 18278 ||
        s.maxRows * (doctorColumnIndex(s.lastColumn) + 1) > 100000 ||
        !Array.isArray(s.rules) ||
        !Array.isArray(s.headers)
      )
        throw new Error("Invalid Table Doctor sheet");
      gids.add(s.gid);
      for (const h of s.headers)
        if (!cell.test(h.cell) || typeof h.value !== "string")
          throw new Error("Invalid approved header");
      const rules = new Set();
      for (const r of s.rules) {
        if (
          !r.id ||
          rules.has(r.id) ||
          ![
            "formula",
            "required",
            "unique",
            "date",
            "number",
            "integer",
          ].includes(r.kind) ||
          !columns.test(r.column) ||
          doctorColumnIndex(r.column) > doctorColumnIndex(s.lastColumn) ||
          !Number.isInteger(r.startRow) ||
          r.startRow < 1 ||
          !Number.isInteger(r.endRow) ||
          r.endRow < r.startRow ||
          r.endRow > s.maxRows ||
          !["approved", "pending"].includes(r.approval) ||
          !condition(r.when) ||
          (r.when &&
            doctorColumnIndex(r.when.column) > doctorColumnIndex(s.lastColumn))
        )
          throw new Error("Invalid Table Doctor rule");
        rules.add(r.id);
        if (
          r.kind === "formula" &&
          (!Array.isArray(r.templates) ||
            r.templates.some(
              (t) => typeof t !== "string" || !t.startsWith("="),
            ))
        )
          throw new Error("Formula templates required");
        for (const e of r.exceptions || [])
          if (
            !e.reason ||
            (!e.when && !e.rows?.length) ||
            !condition(e.when) ||
            (e.when &&
              doctorColumnIndex(e.when.column) >
                doctorColumnIndex(s.lastColumn)) ||
            !Array.isArray(e.rows || []) ||
            (e.rows || []).some(
              (n) => !Number.isInteger(n) || n < r.startRow || n > r.endRow,
            ) ||
            (e.templates &&
              e.templates.some(
                (t) => typeof t !== "string" || !t.startsWith("="),
              ))
          )
            throw new Error(
              "Exceptions require explicit conditions and reason",
            );
        if (
          r.allowedDocumentIds &&
          (!Array.isArray(r.allowedDocumentIds) ||
            r.allowedDocumentIds.some(
              (id) => !/^[A-Za-z0-9_-]{20,100}$/.test(id),
            ))
        )
          throw new Error("Invalid allowed document references");
        if (
          r.result &&
          (!["sum", "product", "ratio"].includes(r.result.kind) ||
            !Array.isArray(r.result.columns) ||
            !r.result.columns.length ||
            (r.result.kind === "ratio" && r.result.columns.length !== 2) ||
            r.result.columns.some(
              (c) =>
                !columns.test(c) ||
                doctorColumnIndex(c) > doctorColumnIndex(s.lastColumn),
            ) ||
            !Number.isFinite(r.result.tolerance) ||
            r.result.tolerance < 0)
        )
          throw new Error("Invalid business result rule");
        for (const n of [r.minimum, r.maximum])
          if (n !== undefined && !Number.isFinite(n))
            throw new Error("Invalid numeric boundary");
      }
    }
    if (
      d.freshness &&
      (!Number.isInteger(d.freshness.maximumAgeMinutes) ||
        d.freshness.maximumAgeMinutes < 1 ||
        !Array.isArray(d.freshness.activeWeekdays) ||
        d.freshness.activeWeekdays.some(
          (x) => !Number.isInteger(x) || x < 0 || x > 6,
        ) ||
        !Number.isInteger(d.freshness.startHour) ||
        !Number.isInteger(d.freshness.endHour) ||
        d.freshness.startHour < 0 ||
        d.freshness.endHour > 24 ||
        d.freshness.startHour >= d.freshness.endHour)
    )
      throw new Error("Freshness requires approved calendar");
    if (d.freshness) {
      const f = d.freshness,
        s = d.sheets.find((s) => s.gid === f.sheetId);
      if (
        !s ||
        !columns.test(f.column) ||
        doctorColumnIndex(f.column) > doctorColumnIndex(s.lastColumn) ||
        !Number.isInteger(f.startRow) ||
        f.startRow < 1 ||
        !Number.isInteger(f.endRow) ||
        f.endRow < f.startRow ||
        f.endRow > s.maxRows
      )
        throw new Error("Freshness requires a bounded timestamp range");
    }
  }
  return structuredClone(documents);
}
