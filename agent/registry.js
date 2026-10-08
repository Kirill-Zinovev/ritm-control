import { FBO_SOURCE_ID, FBO_HISTORY_GID } from "../worker/assembly.js";
import { SHEET_ID, SUPPLY_SHEETS } from "../worker/printing.js";
export const DEFAULT_SOURCES = [
  {
    id: "assembly-fbo",
    department: "Сборка",
    name: "FBO итого",
    documentId: FBO_SOURCE_ID,
    adapter: "assembly",
    enabled: true,
    purpose:
      "Коэффициенты и выпуск сборщиков из дневной истории; нормы не пересчитываются",
    sheets: [
      {
        gid: FBO_HISTORY_GID,
        name: "История производства",
        role: "facts",
        headerRow: 1,
        dataStartRow: 2,
        columns: {
          date: "A",
          employee: "B",
          machineCut: "C",
          manualCut: "D",
          cut: "E",
          packed: "F",
          total: "G",
          coefficient: "H",
          cutTypes: "I",
          packTypes: "J",
          updatedAt: "K",
          uid: "L",
        },
        rules: [
          "required_fields",
          "valid_dates",
          "valid_numbers",
          "unique_uid",
          "schema",
        ],
      },
      {
        gid: 605337763,
        name: "По дням · Дашборд",
        role: "cross-check",
        rules: [],
        status: "not_configured",
        limitation:
          "В заголовках нет года; требуется утверждённое сопоставление периода. Не добавляется к истории.",
      },
    ],
    freshness: null,
    formulaRules: [],
    formulaAccess: "not_configured",
  },
  {
    id: "printing-seasonal",
    department: "Печать",
    name: "СЕЗОННАЯ ПЕЧАТЬ КРАСНОЕ ЗДАНИЕ",
    documentId: SHEET_ID,
    adapter: "printing",
    enabled: true,
    purpose:
      "Фактическая площадь уникальных валидных записей операции Печать в Журнале выпуска",
    sheets: [
      {
        gid: 725126844,
        name: "Журнал выпуска",
        role: "facts",
        headerRow: 1,
        dataStartRow: 2,
        columns: {
          uid: "A",
          date: "B",
          employee: "C",
          operation: "D",
          supply: "E",
          orderUid: "H",
          roll: "I",
          quantity: "J",
          area: "L",
          recordedAt: "M",
        },
        rules: [
          "existing_printing_diagnostics",
          "unique_uid",
          "valid_dates",
          "valid_numbers",
        ],
      },
      ...SUPPLY_SHEETS.map(([gid, name]) => ({
        gid,
        name,
        role: "orders",
        headerRow: 3,
        dataStartRow: 4,
        columns: { article: "E", plannedArea: "J", quantity: "O", uid: "UID" },
        rules: ["schema", "required_uid", "unique_uid"],
      })),
    ],
    freshness: null,
    formulaRules: [],
    formulaAccess: "not_configured",
  },
];
export function cellLink(source, sheetName, cell) {
  const sheet = source.sheets.find((s) => s.name === sheetName);
  return (
    "https://docs.google.com/spreadsheets/d/" +
    source.documentId +
    "/edit" +
    (sheet
      ? "#gid=" + sheet.gid + (cell ? "&range=" + encodeURIComponent(cell) : "")
      : "")
  );
}
export function validateRegistry(sources) {
  if (!Array.isArray(sources) || !sources.length)
    throw new Error("Source registry must be a nonempty array");
  const ids = new Set();
  for (const source of sources) {
    if (!/^[a-z0-9-]{1,80}$/.test(source.id || "") || ids.has(source.id))
      throw new Error("Invalid or duplicate source ID");
    ids.add(source.id);
    if (
      !/^[A-Za-z0-9_-]{20,100}$/.test(source.documentId || "") ||
      !["assembly", "printing", "csv"].includes(source.adapter) ||
      !source.name ||
      !source.department ||
      !Array.isArray(source.sheets) ||
      !source.sheets.length
    )
      throw new Error("Invalid source registry entry");
    if (
      (source.adapter === "assembly" && source.documentId !== FBO_SOURCE_ID) ||
      (source.adapter === "printing" && source.documentId !== SHEET_ID)
    )
      throw new Error(
        "Business adapter is bound to its approved document; use csv for a new source",
      );
    const gids = new Set();
    for (const sheet of source.sheets) {
      if (
        !Number.isSafeInteger(sheet.gid) ||
        sheet.gid < 0 ||
        gids.has(sheet.gid) ||
        !sheet.name
      )
        throw new Error("Invalid or duplicate sheet");
      gids.add(sheet.gid);
      if (
        source.adapter === "csv" &&
        (!Number.isSafeInteger(sheet.headerRow) ||
          sheet.headerRow < 1 ||
          !Number.isSafeInteger(sheet.dataStartRow) ||
          sheet.dataStartRow <= sheet.headerRow ||
          !Array.isArray(sheet.checks) ||
          !sheet.checks.length)
      )
        throw new Error("CSV adapter needs explicit row and column rules");
      for (const check of sheet.checks || []) {
        if (
          !/^[A-Z]{1,3}$/.test(check.column || "") ||
          !["number", "integer", "date", "required", "unique"].includes(
            check.type,
          )
        )
          throw new Error("Unsupported column rule");
      }
    }
    if (
      source.freshness &&
      (!Number.isFinite(source.freshness.maximumAgeMinutes) ||
        source.freshness.maximumAgeMinutes < 1 ||
        !Array.isArray(source.freshness.activeWeekdays) ||
        source.freshness.activeWeekdays.some(
          (d) => !Number.isInteger(d) || d < 0 || d > 6,
        ) ||
        !Number.isInteger(source.freshness.startHour) ||
        !Number.isInteger(source.freshness.endHour) ||
        source.freshness.startHour < 0 ||
        source.freshness.endHour > 24 ||
        source.freshness.startHour >= source.freshness.endHour)
    )
      throw new Error("Freshness needs an approved calendar and age threshold");
  }
  return structuredClone(sources);
}
