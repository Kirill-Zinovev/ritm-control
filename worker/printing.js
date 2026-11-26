import { sourceTimestamp } from "./timestamps.js";
import { privateGoogleSource } from "./privateGoogleConfig.js";
const RITM_BRIDGE = { timezone: "Europe/Moscow" };
function ritmBridgeNumber_(v) {
  var n =
    typeof v === "number"
      ? v
      : Number(
          String(v || "")
            .replace(/\s/g, "")
            .replace(",", "."),
        );
  return Number.isFinite(n) ? n : 0;
}
export function ritmBridgeEmployee_(v, operation, sourceId) {
  var s = String(v || "")
    .trim()
    .toLowerCase();
  // Lukman is a cutter, not a printer. Keep the role scoped to cutting rows.
  if (operation === "Резка" && s === "лукман") return "Лукман";
  if (/^(дмитрий|дима)$/.test(s) || /^[дd](?:\d|$)/.test(s)) return "Дмитрий";
  if (s === "андрей" || /^[аa](?:\d|$)/.test(s)) return "Андрей";
  if (
    operation === "Печать" &&
    sourceId === "roll-printing" &&
    (/^(павел|паша)$/.test(s) || /^[пp](?:\d|$)/.test(s))
  ) return "Паша";
  if (/^(павел|паша)$/.test(s) || /^[пp](?:\d|$)/.test(s)) return "Павел";
  return "";
}
function ritmBridgeDay_(v) {
  if (v instanceof Date && !isNaN(v.getTime()))
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: RITM_BRIDGE.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(v);
  var s = String(v || "").trim(),
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:\s|$)/);
  if (m)
    s =
      (Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3])) +
      "-" +
      m[2].padStart(2, "0") +
      "-" +
      m[1].padStart(2, "0");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  var d = new Date(s + "T12:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : "";
}
function ritmBridgeResolve_(index, uid, sheetName) {
  uid = String(uid || "").trim();
  var direct = index.byUid[uid];
  const matchesSheet = (order) =>
    !sheetName ||
    order.sheetName === sheetName ||
    order.journalAliases?.includes(sheetName);
  if (direct && matchesSheet(direct)) return direct;
  var list = (index.byRaw[uid] || []).filter(function (o) {
    return matchesSheet(o);
  });
  return list.length === 1 ? list[0] : null;
}
// The daily summary is QUERY(group by B, C, D; sum L) over this journal.
// Completed rolls outside the journal are not production facts for this KPI.
function collectJournalOperation(index, journal, options, operation) {
  const events = [],
    issues = operation === "Печать" ? index.issues.slice() : [],
    eventCounts = {},
    journalName = options.name || "Журнал выпуска",
    eventIdPrefix =
      options.eventIdPrefix ||
      (operation === "Печать" ? "journal:" : "journal:cut:");
  journal.forEach((r) => {
    const id = String(r[0] || "").trim();
    if (String(r[3]).trim() === operation && id)
      eventCounts[id] = (eventCounts[id] || 0) + 1;
  });
  journal.forEach((r, i) => {
    if (String(r[3]).trim() !== operation) return;
    const id = String(r[0] || "").trim(),
      resolvedOrder = ritmBridgeResolve_(index, r[7], String(r[4] || "")),
      journalSheetName = String(r[4] || "").trim(),
      // The journal stores the historical article and area at completion time.
      // A transfer/removal from today's plan must not erase that production fact.
      // Only explicitly configured source sheets qualify; ambiguous identities do not.
      fallbacks = (options.orderFallbacks || [options.orderFallback]).filter(Boolean),
      matchingFallbacks = fallbacks.filter(candidate => candidate.journalAliases?.includes(journalSheetName)),
      fallback = matchingFallbacks.length === 1 ? matchingFallbacks[0]
        : matchingFallbacks.length === 0 && journalSheetName && options.journalOrderFallback
          ? {...options.journalOrderFallback, sheetName:journalSheetName}
          : null,
      matchingCurrentOrders = (index.byRaw[String(r[7] || '').trim()] || []).filter(candidate => candidate.sheetName === journalSheetName || candidate.journalAliases?.includes(journalSheetName)),
      historicalOrder =
        !resolvedOrder &&
        fallback && matchingCurrentOrders.length === 0 &&
        String(r[6] || "").trim() &&
        String(r[7] || "").trim()
          ? { ...fallback, uid: String(r[7]).trim(), article: String(r[6]).trim(), historical: true }
          : null,
      order = resolvedOrder || historicalOrder,
      employee = ritmBridgeEmployee_(r[2], operation, options.sourceId || order?.sourceId || options.orderFallback?.sourceId),
      date = ritmBridgeDay_(r[1]),
      quantity = ritmBridgeNumber_(r[9]),
      area = ritmBridgeNumber_(r[11]),
      errors = [];
    if (!id || eventCounts[id] > 1) errors.push("Нет уникального ID записи");
    if (!order) errors.push("Заказ не найден");
    if (!employee) errors.push("Неизвестный сотрудник");
    if (!date) errors.push("Нет даты");
    if (operation === "Печать") {
      if (!Number.isInteger(quantity) || quantity <= 0 || area <= 0)
        errors.push("Нет количества или площади");
    } else if (!Number.isInteger(quantity) || quantity <= 0) {
      errors.push("Нет корректного количества порезки");
    }
    if (errors.length) {
      issues.push({
        source: journalName,
        row: i + 2,
        cell:
          !id || eventCounts[id] > 1
            ? "A" + (i + 2)
            : !order
              ? "H" + (i + 2)
              : !employee
                ? "C" + (i + 2)
                : !date
                  ? "B" + (i + 2)
              : operation === "Печать"
                ? "J" + (i + 2) + ":L" + (i + 2)
                : "J" + (i + 2),
        code: !id
          ? "missing_uid"
          : eventCounts[id] > 1
            ? "duplicate_uid"
            : !order
              ? "missing_order"
              : "invalid_record",
        found: JSON.stringify({
          id,
          productionDate: r[1],
          employee: r[2],
          orderUid: r[7],
          quantity: r[9],
          area: r[11],
        }).slice(0, 500),
        expected:
          "Уникальная валидная запись «" + operation + "», связанная с заказом",
        message: errors.join("; "),
      });
      return;
    }
    events.push({
      id: eventIdPrefix + id,
      uid: order.uid,
      roll: String(r[8] || ""),
      employee,
      date,
      machine: order.historical ? null : order.machine || null,
      quantity,
      area: area > 0 ? area : 0,
      article: order.article,
      sheetId: order.sheetId,
      sheetName: order.sheetName,
      source: journalName,
      site: order.site || "Красное здание",
      sourceId: order.sourceId || "seasonal-printing",
      spreadsheetId: order.spreadsheetId || SHEET_ID,
      sourceUrl: order.sourceUrl || sheetUrl(SHEET_ID, order.sheetId),
      ...(order.historical ? { historical: true } : {}),
    });
  });
  return { events, issues };
}
export function collectJournalPrinting(index, journal, options = {}) {
  return collectJournalOperation(index, journal, options, "Печать");
}
export function collectJournalCutting(index, journal, options = {}) {
  return collectJournalOperation(index, journal, options, "Резка");
}

function columnName(n) {
  let s = "";
  for (; n; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export const SHEET_ID = privateGoogleSource("seasonalPrintingId");
export const SUPPLY_SHEETS = [
  [1040552228, "первая поставка НОВЫЙ ГОД"],
  [1971379034, "Вторая поставка НОВЫЙ ГОД"],
  [1535173994, "Третья поставка НОВЫЙ ГОД"],
  [1770982797, "Четвертая поставка НОВЫЙ ГОД"],
  [437912546, "OZON НОВЫЙ ГОД"],
  [1805410704, "OZON Хэллоуин"],
  [1694219117, "Запас Хэллоуин"],
  [1308393486, "Первая поставка Хэллоуин"],
  [200381567, "Вторая поставка Хэллоуин"],
  [201413533, "Третья поставка Хэллоуин"],
  [614244252, "Четвертая поставка Хэллоуин"],
];
export const ROLL_PRINTING_SHEET_ID = privateGoogleSource("rollPrintingId");
export const BOX_PRINTING_SHEET_ID = privateGoogleSource("boxPrintingId");
export const CATALOG_ID = privateGoogleSource("catalogId");
export const ROLL_PRINTING_SHEET = {
  gid: 119710351,
  name: "OZON МОСКВА 10_10",
  headerRow: 4,
  dataStartRow: 5,
  uidHeaderRow: 1,
  journalAliases: ["OZON МОСКВА", "OZON МОСКВА 10_10"],
};
export const PRINTING_SOURCES = [
  {
    id: "seasonal-printing",
    name: "Сезонная печать · Красное здание",
    site: "Красное здание",
    spreadsheetId: SHEET_ID,
    eventIdPrefix: "journal:",
    supplies: SUPPLY_SHEETS.map(([gid, name]) => ({ gid, name })),
    journal: {
      gid: 725126844,
      name: "Журнал выпуска",
      sourceName: "Журнал выпуска · Красное здание",
      expectedHeaders: {
        0: "ID записи",
        1: "Дата",
        2: "Сотрудник",
        3: "Операция",
        7: "UID заказа",
        9: "Сделано, шт.",
        11: "Выпуск, м²",
      },
    },
  },
  {
    id: "roll-printing",
    name: "OZON РУЛОННАЯ ПЕЧАТЬ",
    site: "OZON РУЛОННАЯ ПЕЧАТЬ",
    spreadsheetId: ROLL_PRINTING_SHEET_ID,
    eventIdPrefix: "journal:roll-printing:",
    supplies: [ROLL_PRINTING_SHEET],
    journal: {
      gid: 126956215,
      name: "Журнал выпуска",
      sourceName: "Журнал выпуска · Рулонная печать",
      expectedHeaders: {
        0: "ID записи",
        1: "Дата",
        2: "Сотрудник",
        3: "Операция",
        7: "UID заказа",
        9: "Сделано",
        11: "Выпуск м²",
      },
    },
  },
];
function sheetUrl(spreadsheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`;
}
export function parseCsv(text) {
  if (text.trimStart().startsWith("<") || text.length > 2_000_000)
    throw new Error("Invalid sheet export");
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new Error("Incomplete CSV");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
function normal(v) {
  return String(v || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function optionalNonnegative(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const n =
    typeof v === "number"
      ? v
      : Number(raw.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function optionalProgress(v, plannedQuantity) {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  if (raw.endsWith("%")) {
    // Google CSV exports the progress bar's displayed text, including its
    // block characters (for example "█████░░░░░ 50%"), not just "50%".
    const match = raw.match(
      /^(?:[█▓▒░▉▊▋▌▍▎▏\s]*)(\d{1,3}(?:[.,]\d+)?)\s*%$/u,
    );
    if (!match) return null;
    const percent = Number(match[1].replace(",", "."));
    return Number.isFinite(percent) && percent >= 0 && percent <= 100
      ? (plannedQuantity * percent) / 100
      : null;
  }
  return optionalNonnegative(v);
}
export function indexOrders(sheets) {
  const index = { orders: [], byUid: {}, byRaw: {}, issues: [] };
  sheets.forEach((sheet) => {
    const {
      gid,
      name,
      rows,
      headerRow = 3,
      dataStartRow = 4,
      uidHeaderRow = 1,
      journalAliases = [],
      sourceId = "seasonal-printing",
      sourceName = "Сезонная печать · Красное здание",
      site = "Красное здание",
      spreadsheetId = SHEET_ID,
      sourceUrl = sheetUrl(SHEET_ID, gid),
      assemblyShipmentId = null,
      stockUidColumn = null,
      stockHistoryAllows = null,
    } = sheet;
    const headers = rows[headerRow - 1] || [];
    const shopColumn = headers.findIndex((header) => normal(header) === "магазин");
    const machineColumn = headers.findIndex((header) => normal(header) === "станок");
    const photoColumn = headers.findIndex((header) => normal(header) === "фото");
    const nameColumn = headers.findIndex((header) => ["наименование", "название", "название товара"].includes(normal(header)));
    const findColumn = (...names) => {
      const wanted = names.map((name) => normal(name).replace(/ё/g, "е"));
      const matches = headers.flatMap((header, i) => wanted.includes(normal(header).replace(/ё/g, "е")) ? [i] : []);
      if (matches.length > 1) throw Object.assign(new Error("Duplicate order column"), {
        issue: { source: name, row: headerRow, code: "schema_changed", message: `Повторяется заголовок: ${names[0]}` },
      });
      return matches[0] ?? -1;
    };
    const articleColumn = findColumn("Артикул");
    const quantityColumn = findColumn("Кол-во");
    const extensionColumn = ["roll-printing", "box-printing"].includes(sourceId)
      ? findColumn("Расширения", "Расширение печати", "Расширение")
      : -1;
    if (articleColumn < 0 || quantityColumn < 0)
      throw Object.assign(new Error("Order schema changed"), {
        issue: {
          source: name,
          row: headerRow,
          cell: `E${headerRow}:O${headerRow}`,
          code: "schema_changed",
          message: "Изменились заголовки листа поставки",
          found: JSON.stringify(headers).slice(0, 500),
          expected: "Однозначные заголовки «Артикул» и «Кол-во»",
        },
      });
    const legacyLayout = articleColumn === 4 && quantityColumn === 14;
    const fieldColumn = (fallback, ...names) => {
      const found = findColumn(...names);
      return found >= 0 ? found : legacyLayout ? fallback : -1;
    };
    const sheetsColumn = fieldColumn(5, "Кол-во листов");
    const multiplicityColumn = fieldColumn(-1, "Кратность");
    const widthColumn = fieldColumn(7, "Ширина");
    const heightColumn = fieldColumn(8, "Высота");
    const areaColumn = fieldColumn(9, "Объем на все кол-во скинули");
    const rollPrintColumn = fieldColumn(19, "Прогресс печати");
    const namedRollCutColumn = findColumn("Прогресс порезки");
    const rollCutColumn = namedRollCutColumn >= 0 ? namedRollCutColumn : legacyLayout ? 20 : -1;
    const rollRemainingColumn = fieldColumn(23, "Остаток по печати:", "Остаток по печати");
    // The stock-only header can occur more than once on unrelated seasonal
    // templates. Resolve it only when the stock history proof is available.
    const stockRemainingColumn = typeof stockHistoryAllows === 'function' ? findColumn("Кол-во осталось") : -1;
    const rollStartEvidenceColumns = [findColumn('Печать'),findColumn('Порезка'),findColumn('Дата готовности печати'),findColumn('Дата готовности порезки'),findColumn('Рулоны')];
    const boxPrintColumn = fieldColumn(
      17,
      "Готовность печати",
      "Завершил печать",
      "Печать завершена",
      "Завершена печать",
    );
    const namedBoxCutColumn = findColumn(
      "Готовность порезки",
      "Завершил порезку",
      "Порезка завершена",
      "Завершена порезка",
    );
    const boxCutColumn = namedBoxCutColumn >= 0 ? namedBoxCutColumn : legacyLayout ? 18 : -1;
    const planningPrintColumn=headers.findIndex(h=>normal(h).startsWith('напечатано годных'));
    const planningCutColumn=headers.findIndex(h=>normal(h).startsWith('порезано годных'));
    const uidHeaderCol = (rows[uidHeaderRow - 1] || []).indexOf("UID");
    // The dedicated stock-box template stores its UID in AD without a header.
    // Only its caller may supply that schema; ordinary box sheets keep their
    // existing UID/row identities.
    const uidCol = stockUidColumn !== null
      ? stockUidColumn
      : uidHeaderCol >= 0
      ? uidHeaderCol
      : sourceId === "box-printing" && legacyLayout
        ? 28
        : -1;
    // Existing box worksheets predate the UID column. Assembly transfer keys
    // for those rows use their stable source row and article instead.
    if (uidCol < 0 && sourceId !== "box-printing")
      throw Object.assign(new Error("UID column missing"), {
        issue: {
          source: name,
          row: uidHeaderRow,
          cell: `A${uidHeaderRow}`,
          code: "schema_changed",
          message: "Не найден столбец UID",
          found: "Заголовок UID отсутствует",
          expected: "Заголовок UID в первой строке рабочего листа",
        },
      });
    rows.slice(dataStartRow - 1).forEach((r, i) => {
      const article = String(r[articleColumn] || "").trim();
      if (!article) return;
      const row = i + dataStartRow;
      const raw = uidCol < 0 ? "" : String(r[uidCol] || "").trim();
      if (!raw && sourceId !== "box-printing") {
        index.issues.push({
          source: name,
          row,
          cell: columnName(uidCol + 1) + row,
          code: "missing_uid",
          found: "",
          expected: "UID заказа",
          message: "Нет UID заказа",
        });
        return;
      }
      const uid = raw
        ? raw.includes("::")
          ? raw
          : gid === 437912546
            ? raw
            : gid + "::" + raw
        : gid + "::row:" + row;
      if (index.byUid[uid])
        throw Object.assign(new Error("Duplicate order UID"), {
          issue: {
            source: name,
            row,
            cell: (uidCol < 0 ? columnName(articleColumn + 1) : columnName(uidCol + 1)) + row,
            code: "duplicate_uid",
            message: "Повторяется UID заказа",
            found: raw,
            expected: "Уникальный UID заказа",
          },
        });
      const quantity = ritmBridgeNumber_(r[quantityColumn]),
        sourceArea = optionalNonnegative(r[areaColumn]),
        shownArea = sourceArea ?? 0;
      const dimensionsKnown = [r[sheetsColumn], r[widthColumn], r[heightColumn]].every(
        (value) => optionalNonnegative(value) > 0,
      );
      // A positive value in J is a confirmed area even when dimensions are
      // maintained manually. An empty/error J is never a confirmed zero.
      const areaKnown = sourceArea !== null && (
        sourceArea > 0 || quantity === 0 || dimensionsKnown ||
        !["roll-printing", "box-printing"].includes(sourceId)
      );
      const areaCell = areaColumn < 0 ? "Площадь" : `${columnName(areaColumn + 1)}${i + dataStartRow}`;
      const areaIssue = areaKnown ? null : sourceArea === null
        ? String(r[areaColumn] ?? "").trim()
          ? `${areaCell}: ${String(r[areaColumn]).trim()}`
          : `${areaCell}: площадь не заполнена`
        : `${areaCell}: нет подтверждённых размеров для расчёта площади`;
      const calculated =
        ritmBridgeNumber_(r[sheetsColumn]) *
        ritmBridgeNumber_(r[widthColumn]) *
        ritmBridgeNumber_(r[heightColumn]) *
        quantity;
      // J is F*H*I*O on all inspected supply tabs. Restore its display rounding only when consistent.
      const plannedArea =
        dimensionsKnown && sourceArea !== null && Math.abs(calculated - shownArea) <= 0.00051
          ? calculated
          : shownArea;
      const boxProgress = value => /^(?:TRUE|Готов)$/iu.test(String(value).trim()) ? quantity : /^(?:FALSE)$/iu.test(String(value).trim()) ? 0 : null;
      const remainingPrint = sourceId === "box-printing"
        ? boxProgress(r[boxPrintColumn]) === null ? null : quantity - boxProgress(r[boxPrintColumn])
        : sourceId === "roll-printing" ? optionalNonnegative(r[rollRemainingColumn]) : null;
      const printProgressValue =
        sourceId === "roll-printing"
          ? optionalProgress(r[rollPrintColumn], quantity)
          : null;
      const readyStatus = value => /^(?:TRUE|Готов|Готово|Готова)$/iu.test(String(value ?? "").trim());
      const productionTabComplete = sourceId === "box-printing"
        ? readyStatus(r[boxPrintColumn]) && readyStatus(r[boxCutColumn])
        : sourceId === "roll-printing" && rollStartEvidenceColumns.slice(0, 2).every(column =>
          column >= 0 && readyStatus(r[column]));
      // A known, blank completion cell can prompt a check. Formula errors,
      // missing headers and conflicting roll completion marks stay unknown.
      const empty = column => column >= 0 && String(r[column] ?? "").trim() === "";
      const cutMarkMissing = sourceId === "box-printing" ? empty(namedBoxCutColumn)
        : sourceId === "roll-printing" && empty(namedRollCutColumn) &&
          empty(rollStartEvidenceColumns[1]) && empty(rollStartEvidenceColumns[3]);
      // Fresh RITM-created orders have an explicit full remaining-print plan,
      // but templates leave status/progress cells blank. Forecast zero work only
      // when every start-evidence column is present and empty. Legacy, started,
      // missing-column and error states remain unknown; no source cell changes.
      // The stock template has a separate remaining column. Accept it only
      // after all three stock histories were read and no trace of this order
      // exists. A blank/error or missing history remains unknown.
      const stockRemainingConfirmed = typeof stockHistoryAllows === 'function' &&
        rollRemainingColumn >= 0 && String(r[rollRemainingColumn] ?? '').trim() === '' &&
        stockRemainingColumn >= 0 && optionalNonnegative(r[stockRemainingColumn]) === quantity &&
        stockHistoryAllows(raw, name, article);
      const unstartedRitmRoll = sourceId === 'roll-printing' && quantity > 0 &&
        /^ritm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[1-9]\d*$/i.test(raw) &&
        (remainingPrint === quantity || stockRemainingConfirmed) && rollPrintColumn >= 0 && rollCutColumn >= 0 &&
        [rollPrintColumn,rollCutColumn,...rollStartEvidenceColumns].every(empty);
      const o = {
        uid,
        rawUid: raw || null,
        // A former roll UID can remain in AC after the UID column moved to AD.
        // Only accept an actual UUID from the unlabeled legacy column.
        legacyUid: sourceId === "roll-printing" && uidCol === 29 && !String((rows[uidHeaderRow - 1] || [])[28] || "").trim() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(r[28] || "").trim()) ? String(r[28]).trim() : null,
        sheetId: gid,
        sheetName: name,
        journalAliases,
        row,
        article,
        ...(extensionColumn >= 0 ? { extension: String(r[extensionColumn] || "").trim() } : {}),
        machine: machineColumn >= 0 ? String(r[machineColumn] || "").trim() : "",
        // Preserve the machine written on the actual source sheet even when
        // catalog enrichment changes the display grouping later.
        sourceMachine: machineColumn >= 0 ? String(r[machineColumn] || "").trim() : "",
        machineSource: machineColumn >= 0 && String(r[machineColumn] || "").trim() ? "supply" : null,
        productName: nameColumn >= 0 ? String(r[nameColumn] || "").trim() : "",
        photoUrl: safeWorkloadPhoto(photoColumn >= 0 ? r[photoColumn] : ""),
        assemblyShipmentId,
        quantity,
        productionTabComplete,
        plannedArea,
        // Extra planning facts preserve partial completion; existing readiness output is unchanged.
        ...(sourceId === 'box-printing' && planningPrintColumn >= 0 ? {planningPrinted:optionalNonnegative(r[planningPrintColumn]),planningCut:optionalNonnegative(r[planningCutColumn]),planningPhysicalUnits:true} : {}),
        ...(unstartedRitmRoll ? {planningPrinted:0,planningCut:0,planningPhysicalUnits:false} : {}),
        sheetsInProduct: optionalNonnegative(r[sheetsColumn]),
        multiplicity: optionalNonnegative(r[multiplicityColumn]),
        areaKnown,
        areaIssue,
        // The roll-printing sheet carries live per-order progress in T/U and
        // the authoritative remaining print quantity in X. Keep empty cells
        // nullable so the UI can distinguish an unstarted row from bad data.
        printProgress:
          remainingPrint !== null && remainingPrint <= quantity
            ? Math.max(0, quantity - remainingPrint)
            : printProgressValue,
        cutProgress:
          sourceId === "box-printing" ? boxProgress(r[boxCutColumn]) : sourceId === "roll-printing"
            ? optionalProgress(r[rollCutColumn], quantity)
            : null,
        ...(cutMarkMissing && {cutMarkMissing}),
        remainingPrint,
        shop: shopColumn >= 0 ? String(r[shopColumn] || "") : "",
        sourceId,
        sourceName,
        site,
        spreadsheetId,
        sourceUrl,
      };
      index.byUid[uid] = o;
      if (raw) (index.byRaw[raw] || (index.byRaw[raw] = [])).push(o);
      index.orders.push(o);
    });
  });
  return index;
}
function printingSources(additionalSheets = []) {
  const seen = new Set([ROLL_PRINTING_SHEET.gid]);
  const extras = [];
  for (const sheet of additionalSheets) {
    const gid = Number(sheet?.gid);
    const name = String(sheet?.name || "").trim();
    if (
      !Number.isSafeInteger(gid) ||
      gid <= 0 ||
      !name ||
      name.length > 100 ||
      /[:\\/?*\[\]]/.test(name) ||
      seen.has(gid)
    )
      continue;
    seen.add(gid);
    extras.push({
      gid,
      name,
      headerRow: ROLL_PRINTING_SHEET.headerRow,
      dataStartRow: ROLL_PRINTING_SHEET.dataStartRow,
      uidHeaderRow: ROLL_PRINTING_SHEET.uidHeaderRow,
      journalAliases: [],
    });
  }
  return PRINTING_SOURCES.map((source) =>
    source.id === "roll-printing"
      ? { ...source, supplies: [...source.supplies, ...extras] }
      : source,
  );
}
export async function loadPrinting(fetcher = fetch, options = {}) {
  const managed = (options.productionSupplies || []).flatMap(s => (s.parts || []).map(p => ({ ...p, shipmentId: s.id, name: s.name })));
  const managedRollSheets = managed
    .filter(part => part.department === "roll" && part.documentId === ROLL_PRINTING_SHEET_ID)
    .map(part => ({ gid: part.sheetId, name: part.name }));
  let sources = printingSources([...(options.additionalSheets || []), ...managedRollSheets]).map(source => ({ ...source,
    supplies: source.supplies.map(sheet => ({ ...sheet,
      assemblyShipmentId: managed.find(p => p.documentId === source.spreadsheetId && p.sheetId === sheet.gid)?.shipmentId,
    })),
  }));
  const boxes = new Map(managed
    .filter(p => p.department === "box" && p.documentId === BOX_PRINTING_SHEET_ID)
    .map(p => [p.sheetId, p]));
  for (const link of options.assemblyBoxLinks || []) {
    const gid = Number(link?.boxSheetId);
    const name = String(link?.name || "").trim();
    if (!Number.isSafeInteger(gid) || gid <= 0 || !name || name.length > 100) continue;
    const targetRollSheetId = Number.isSafeInteger(link.targetRollSheetId)
      ? link.targetRollSheetId
      : null;
    const linkedRoll = managed.find(p => p.department === "roll" &&
      p.documentId === ROLL_PRINTING_SHEET_ID && p.sheetId === targetRollSheetId);
    const current = boxes.get(gid);
    boxes.set(gid, {
      ...(current || {}),
      sheetId: gid,
      name,
      documentId: BOX_PRINTING_SHEET_ID,
      department: "box",
      shipmentId: targetRollSheetId === null
        ? current?.shipmentId || `RITM-BOX-${gid}`
        : linkedRoll?.shipmentId || `RITM-ROLL-${targetRollSheetId}`,
    });
  }
  if (boxes.size) sources.push({ id: "box-printing", name: "OZON БОКС", site: "Бокс", spreadsheetId: BOX_PRINTING_SHEET_ID,
    supplies: [...boxes.values()].map(p => ({ gid: p.sheetId, name: p.name, headerRow: 4, dataStartRow: 5, uidHeaderRow: 1, assemblyShipmentId: p.shipmentId })), journal: null });
  if (options.supplyTarget) {
    const { department, sheetId, name } = options.supplyTarget;
    const sourceId = department + "-printing";
    const candidates = sources.flatMap(source => source.supplies.map(sheet => ({source, sheet})));
    const selected = candidates.filter(({source,sheet}) =>
      source.id === sourceId && sheet.gid === sheetId && sheet.name === name);
    if (selected.length !== 1) throw new Error("Не подтверждён лист выбранной поставки.");
    const {source, sheet} = selected[0];
    const shipmentId = sheet.assemblyShipmentId || (department === "roll" ? `RITM-ROLL-${sheetId}` : `RITM-BOX-${sheetId}`);
    sources = sources.map(entry => ({...entry, supplies: entry.supplies.filter(item =>
      (entry.id === source.id && item.gid === sheet.gid) || item.assemblyShipmentId === shipmentId
    )})).filter(entry => entry.supplies.length);
  }
  const readSheet = async (sheet, source) => {
    const isProduction = sheet.kind === "supply" && ["roll-printing", "box-printing"].includes(source.id);
      const response = await fetcher(
        `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/export?format=csv&gid=${sheet.gid}`,
        { signal: AbortSignal.timeout(20000) },
      );
    if (!response.ok) {
      if (isProduction && options.readHiddenSupply) {
        await response.body?.cancel();
        const rows = await options.readHiddenSupply(source.spreadsheetId, sheet.gid, sheet.name);
        if (rows) return { ...sheet, source, rows };
      }
        throw new Error(
          `Source unavailable: ${source.name} · ${sheet.name}`,
        );
    }
      return { ...sheet, source, rows: parseCsv(await response.text()) };
  };
    const supplies = [],
    sheets = [],
    events = [],
    cutEvents = [],
    issues = [],
    sourceTimes = [];
  for (const source of sources) {
    // Keep only one workbook's raw grids alive and bound concurrent CSV
    // responses. The parsed order facts and original sheet row numbers stay
    // unchanged; journal rows still include every source entry.
    const descriptors = [
      ...source.supplies.map(sheet => ({...sheet, kind:"supply"})),
      ...(source.journal ? [{...source.journal, kind:"journal"}] : []),
    ];
    const sourceExports = new Array(descriptors.length);
    let nextSheet = 0;
    await Promise.all(Array.from({length:Math.min(4,descriptors.length)}, async () => {
      while (nextSheet < descriptors.length) {
        const index = nextSheet++;
        sourceExports[index] = await readSheet(descriptors[index], source);
      }
    }));
    const
      supplyExports = sourceExports.filter((sheet) => sheet.kind === "supply"),
      journalExport = sourceExports.find((sheet) => sheet.kind === "journal");
    if (!journalExport && source.journal)
      throw new Error(`Printing journal missing: ${source.name}`);
    const sourceIndex = indexOrders(
      supplyExports.map((sheet) => ({
        ...sheet,
        headerRow: sheet.headerRow || 3,
        dataStartRow: sheet.dataStartRow || 4,
        uidHeaderRow: sheet.uidHeaderRow || 1,
        journalAliases: sheet.journalAliases || [],
        sourceId: source.id,
        sourceName: source.name,
        site: source.site,
        spreadsheetId: source.spreadsheetId,
        sourceUrl: sheetUrl(source.spreadsheetId, sheet.gid),
      })),
    );
    for (const sheet of supplyExports) sheet.rows = null;
    if (!source.journal) {
      supplies.push(...sourceIndex.orders);
      issues.push(...sourceIndex.issues);
      sheets.push(...supplyExports.map(sheet => ({ sheetId: sheet.gid, name: sheet.name, sourceId: source.id, sourceName: source.name,
        spreadsheetId: source.spreadsheetId, spreadsheetUrl: sheetUrl(source.spreadsheetId, sheet.gid), assemblyShipmentId: sheet.assemblyShipmentId })));
      continue;
    }
    const journal = journalExport.rows,
      expected = source.journal.expectedHeaders;
    if (
      Object.entries(expected).some(
        ([col, header]) => journal[0]?.[col] !== header,
      )
    )
      throw Object.assign(
        new Error(`Printing schema changed: ${source.name}`),
        {
          issue: {
            source: journalExport.sourceName,
            row: 1,
            cell: "A1:L1",
            code: "schema_changed",
            message: "Изменились заголовки журнала выпуска",
            found: JSON.stringify(journal[0] || []).slice(0, 500),
            expected: JSON.stringify(expected),
          },
        },
      );
    const historicalOrders = supplyExports.map(sheet => ({
      sheetId: sheet.gid, sheetName: sheet.name, sourceId: source.id,
      sourceName: source.name, site: source.site, spreadsheetId: source.spreadsheetId,
      sourceUrl: sheetUrl(source.spreadsheetId, sheet.gid),
      journalAliases: [...new Set([sheet.name, ...(sheet.journalAliases || [])])],
    }));
    // The roll journal is the ledger of completed work, including sheets that
    // were deleted after completion. Link those facts to the actual journal;
    // never fabricate a current supply or add them back to today's plan.
    const journalOrderFallback = source.id === 'roll-printing' ? {
      sheetId: journalExport.gid, sourceId: source.id, sourceName: source.name,
      site: source.site, spreadsheetId: source.spreadsheetId,
      sourceUrl: sheetUrl(source.spreadsheetId,journalExport.gid),
    } : null;
    const facts = collectJournalPrinting(sourceIndex, journal.slice(1), {
      orderFallbacks: historicalOrders,
      journalOrderFallback,
      name: journalExport.sourceName,
      sourceId: source.id,
      eventIdPrefix: source.eventIdPrefix,
      orderFallback: {
        sheetId: supplyExports[0].gid,
        sheetName: supplyExports[0].name,
        sourceId: source.id,
        sourceName: source.name,
        site: source.site,
        spreadsheetId: source.spreadsheetId,
        sourceUrl: sheetUrl(source.spreadsheetId, supplyExports[0].gid),
        journalAliases: supplyExports[0].journalAliases || [],
      },
    });
    const cuts = collectJournalCutting(sourceIndex, journal.slice(1), {
      orderFallbacks: historicalOrders,
      journalOrderFallback,
      name: journalExport.sourceName,
      sourceId: source.id,
      eventIdPrefix: source.eventIdPrefix + "cut:",
      orderFallback: {
        sheetId: supplyExports[0].gid,
        sheetName: supplyExports[0].name,
        sourceId: source.id,
        sourceName: source.name,
        site: source.site,
        spreadsheetId: source.spreadsheetId,
        sourceUrl: sheetUrl(source.spreadsheetId, supplyExports[0].gid),
        journalAliases: supplyExports[0].journalAliases || [],
      },
    });
    events.push(...facts.events);
    cutEvents.push(...cuts.events);
    issues.push(...facts.issues);
    issues.push(...cuts.issues);
    supplies.push(...sourceIndex.orders);
    sheets.push(
      ...supplyExports.map((sheet) => ({
        sheetId: sheet.gid,
        name: sheet.name,
        sourceId: source.id,
        sourceName: source.name,
        spreadsheetId: source.spreadsheetId,
        spreadsheetUrl: sheetUrl(source.spreadsheetId, sheet.gid),
        assemblyShipmentId: sheet.assemblyShipmentId,
      })),
    );
    sourceTimes.push(
      ...journal
        .slice(1)
        .map((row) => sourceTimestamp(row[12]))
        .filter(Boolean),
    );
  }
  const shopCatalog = assignCatalogStores(supplies, options.shopCatalogRows);
  assignWorkloadDetails(supplies, options.shopCatalogRows, options.photoCatalogRows);
  const sourceLinks = sources.map((source) => ({
    id: source.id,
    name: source.name,
    spreadsheetId: source.spreadsheetId,
    spreadsheetUrl: sheetUrl(source.spreadsheetId, source.supplies[0].gid),
    journalName: source.journal?.sourceName || "",
    journalUrl: source.journal ? sheetUrl(source.spreadsheetId, source.journal.gid) : "",
  }));
  return {
    ok: true,
    schemaVersion: 2,
    source: SHEET_ID,
    sources: sourceLinks,
    timezone: "Europe/Moscow",
    updatedAt: new Date().toISOString(),
    sourceUpdatedAt: sourceTimes.sort().at(-1) || null,
    quality: {
      status: issues.length ? "partial" : "valid",
      invalidRecords: issues.length,
    },
    events,
    cutEvents,
    issues,
    supplies,
    sheets,
    shopCatalog,
  };
}

// Stock work is read independently of the shipment roster, so it never
// acquires an Assembly identity or enters the ordinary supply lists.
async function appendStockArchivedOrders(fetcher,index,{spreadsheetId,sheets,archiveId,sourceId}) {
  if(archiveId===undefined)return;
  if(!Number.isSafeInteger(archiveId))throw new Error('stock archive id');
  const response=await fetcher(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${archiveId}`,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('stock archive unavailable');
  const rows=parseCsv(await response.text()), expected=['Операция','Дата','Лист','Строка','UID','Артикул','План','Данные строки'];
  if(expected.some((x,i)=>String(rows[0]?.[i]||'').trim()!==x))throw new Error('stock archive schema');
  const seen=new Set();
  for(const row of rows.slice(1)) {
    if(!row.some(x=>String(x||'').trim()))continue;
    const [op,date,sheetName,,rawUid,article,quantity,raw]=row, sheet=sheets.find(s=>s.name===sheetName);
    if(!op||seen.has(op)||!Number.isFinite(Date.parse(date))||!sheet||!rawUid||!article||!(Number(quantity)>0))throw new Error('stock archive entry');
    seen.add(op);
    let data;try{data=JSON.parse(raw)}catch{throw new Error('stock archive data')}
    if(!Array.isArray(data?.values)||String(data.values[4]||'').trim()!==article||String(data.values[29]||'').trim()!==rawUid||Number(data.values[15])!==Number(quantity))throw new Error('stock archive mismatch');
    const uid=rawUid.includes('::')?rawUid:`${sheet.gid}::${rawUid}`;
    if(index.byUid[uid])throw new Error('duplicate archived stock uid');
    const order={uid,rawUid,article,sheetId:sheet.gid,sheetName,sourceId,spreadsheetId,site:sourceId==='box-printing'?'Бокс':'Запасы · рулонная печать',machine:String(data.values[3]||''),boxPositionId:data.boxPositionId||null,archived:true};
    index.byUid[uid]=order;(index.byRaw[rawUid]||= []).push(order);index.orders.push(order);
  }
}
export async function loadStockRollPrinting(fetcher, printing, {spreadsheetId, sheets, journalId, archiveId, historyIds} = {}) {
  if (!spreadsheetId || !Array.isArray(sheets) || !Number.isSafeInteger(journalId)) return printing;
  try {
    if (sheets.length !== 2 || sheets.some(s => !Number.isSafeInteger(s.gid) || !['Запасы склад','Срочные 2 этаж'].includes(s.name))) throw new Error('invalid stock sheets');
    const descriptors = [...sheets, {gid:journalId, name:'Журнал выпуска'}];
    const historyPromise = Array.isArray(historyIds) && historyIds.length === 2 && historyIds.every(Number.isSafeInteger)
      ? Promise.all(historyIds.map(async gid => {
          const response=await fetcher(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`,{signal:AbortSignal.timeout(5000)});
          if(!response.ok)throw new Error('stock history unavailable');
          return parseCsv(await response.text());
        })).catch(()=>null) : Promise.resolve(null);
    const exports = await Promise.all(descriptors.map(async s => {
      const response = await fetcher(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${s.gid}`, {signal:AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error('stock source unavailable');
      return {...s, rows:parseCsv(await response.text())};
    }));
    const journal=exports.pop().rows;
    const expected=PRINTING_SOURCES.find(s=>s.id==='roll-printing').journal.expectedHeaders;
    if(Object.entries(expected).some(([column,header])=>journal[0]?.[column]!==header))throw new Error('stock journal schema');
    const histories=await historyPromise;
    const historyHeaders=[
      ['ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','ROLL_NAME','ROLL_NUMBER','PRINT_READY','CUT_READY','CREATED_AT','UPDATED_AT','ROLL_QUANTITY','PRINT_DONE_AT','PRINT_EMPLOYEE','CUT_DONE_AT','CUT_EMPLOYEE','LEGACY_SOURCE'],
      ['EVENT_ID','ROLL_ID','ORDER_UID','SHEET_SOURCE','ORDER_ROW','ARTICLE','OPERATION','EMPLOYEE','DATE','QUANTITY','AREA_PER_ITEM','AREA','ENTERED_AT','COMMENT'],
    ];
    const historyValid=histories && historyHeaders.every((headers,i)=>headers.every((header,col)=>String(histories[i][0]?.[col]||'').trim()===header)) &&
      journal[0]?.[4]==='Лист-источник' && journal[0]?.[6]==='Артикул' && journal[0]?.[7]==='UID заказа';
    let stockHistoryAllows=null;
    if(historyValid){
      const uids=new Set(), pairs=new Set(), ambiguousArticles=new Set();
      let unidentifiable=false;
      for(const [rows,uidCol,sheetCol,articleCol] of [[journal,7,4,6],[histories[0],1,2,4],[histories[1],2,3,5]]){
        for(const row of rows.slice(1)){
          const values=row.map(value=>String(value??'').trim());
          if(!values.some(Boolean))continue;
          const uid=values[uidCol],sheet=values[sheetCol],article=values[articleCol];
          if(uid)uids.add(uid);
          if(sheet&&article)pairs.add(JSON.stringify([sheet,article]));
          else if(article)ambiguousArticles.add(article);
          else if(!uid)unidentifiable=true;
        }
      }
      if(!unidentifiable)stockHistoryAllows=(uid,sheetName,article)=>!uids.has(uid)&&!pairs.has(JSON.stringify([sheetName,article]))&&!ambiguousArticles.has(article);
    }
    const index=indexOrders(exports.map(sheet=>({...sheet,headerRow:4,dataStartRow:5,uidHeaderRow:1,journalAliases:[],sourceId:'roll-printing',sourceName:'Запасы · рулонная печать',site:'Запасы · рулонная печать',spreadsheetId,sourceUrl:sheetUrl(spreadsheetId,sheet.gid),stockHistoryAllows})));
    await appendStockArchivedOrders(fetcher,index,{spreadsheetId,sheets,archiveId,sourceId:'roll-printing'});
    const common={name:'Журнал запасов · рулонная печать',sourceId:'roll-printing'};
    const facts=collectJournalPrinting(index,journal.slice(1),{...common,eventIdPrefix:'journal:stock-roll:'});
    const cuts=collectJournalCutting(index,journal.slice(1),{...common,eventIdPrefix:'journal:stock-roll:cut:'});
    return {...printing,events:[...printing.events,...facts.events],cutEvents:[...printing.cutEvents,...cuts.events],issues:[...(printing.issues||[]),...facts.issues,...cuts.issues],stockRoll:{status:'available',orders:index.orders,reason:null}};
  } catch(error) {
    return {...printing,stockRoll:{status:'unavailable',orders:[],reason:'Журнал запасов рулонной печати недоступен или не подтверждён.'}};
  }
}

export async function loadStockBoxOrders(fetcher, printing, {spreadsheetId, sheets, archiveId} = {}) {
  if (!spreadsheetId || !Array.isArray(sheets)) return printing;
  try {
    if(sheets.length!==2 || sheets.some(s=>!Number.isSafeInteger(s.gid)||!['Запасы склад','Срочные 2 этаж'].includes(s.name)))throw new Error('invalid stock sheets');
    const exports=await Promise.all(sheets.map(async s=>{
      const response=await fetcher(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${s.gid}`,{signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('stock source unavailable');
      const rows = parseCsv(await response.text());
      const header = rows[3] || [], top = rows[0] || [];
      const uidHeader = top.indexOf('UID');
      // Match the stock adapter's E/P/AD layout. Never interpret another
      // populated header or a conflicting UID column as a stock UID.
      if (normal(header[4]) !== 'артикул' || normal(header[15]) !== 'кол-во' ||
          String(header[29] || '').trim() || (uidHeader >= 0 && uidHeader !== 29) ||
          (String(top[29] || '').trim() && String(top[29]).trim() !== 'UID'))
        throw new Error('stock uid schema changed');
      return {...s,rows,headerRow:4,dataStartRow:5,uidHeaderRow:1,stockUidColumn:29,journalAliases:[],sourceId:'box-printing',sourceName:'Запасы · бокс',site:'Бокс',spreadsheetId,sourceUrl:sheetUrl(spreadsheetId,s.gid)};
    }));
    const index=indexOrders(exports);
    if(index.issues.length)throw new Error('stock source invalid');
    await appendStockArchivedOrders(fetcher,index,{spreadsheetId,sheets,archiveId,sourceId:'box-printing'});
    return {...printing,stockBox:{status:'available',orders:index.orders,reason:null}};
  } catch(error) {return {...printing,stockBox:{status:'unavailable',orders:[],reason:'Планы запасов бокса недоступны или не подтверждены.'}};}
}

function safeWorkloadPhoto(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function photoUrlFromSourceRow(row) {
  const primary = safeWorkloadPhoto(row?.[3]);
  if (primary) return primary;
  return String(row?.[2] || "")
    .split(/[;\r\n]+/)
    .map((value) => safeWorkloadPhoto(value))
    .find(Boolean) || "";
}

// The selected marketplace catalog is authoritative for the workload machine.
// Supply columns can contain a broad print process rather than equipment.
// Never infer equipment from that broad label or modify source production rows.
export function assignWorkloadDetails(orders, catalog, photos = null, {preferCatalog = false} = {}) {
  const indices = new Map();
  const photoIndex = new Map();
  for (const row of Array.isArray(photos) ? photos : []) {
    const key = normalizeCatalogArticle(row[0]);
    if (key) photoIndex.set(key, [...(photoIndex.get(key) || []), row]);
  }
  for (const market of ["OZON", "WB"]) {
    const rows = catalog?.[market];
    if (!Array.isArray(rows)) continue;
    const headerIndex = rows.slice(0, 10).findIndex(row => row.some(h => ["артикул", "артикул (oz)"].includes(normal(h))));
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex].map(normal);
    const articleColumns = headers.flatMap((h, i) => ["артикул", "артикул (oz)"].includes(h) ? [i] : []);
    if (market === "OZON" && !articleColumns.includes(1)) articleColumns.push(1);
    const columns = {
      machine: headers.findIndex(h => h === (market === "WB" ? "вид станка по умолчанию" : "станок")),
      productName: headers.findIndex(h => ["наименование", "название", "название товара"].includes(h)),
      photoUrl: headers.findIndex(h => ["фото", "ссылка на фото", "ссылка на фотографию"].includes(h)),
      store: headers.findIndex(h => h === "магазин"),
      boxCapacity: headers.findIndex(h => h === "в коробке"),
    };
    const records = new Map();
    for (const row of rows.slice(headerIndex + 1)) {
      for (const key of new Set(articleColumns.map(i => normalizeCatalogArticle(row[i])).filter(v => v && !v.startsWith("#")))) {
        const entries = records.get(key) || [];
        entries.push(Object.fromEntries(Object.entries(columns).map(([field, col]) => {
          const raw = String(row[col] || "").trim();
          return [field, field === "photoUrl" ? safeWorkloadPhoto(raw) : raw.startsWith("#") ? "" : raw];
        })));
        records.set(key, entries);
      }
    }
    indices.set(market, records);
  }
  for (const order of orders) {
    order.catalogUnitsPerBox = null;
    if (preferCatalog) {
      order.productName = "";
      order.photoUrl = "";
    }
    const articleKey = normalizeCatalogArticle(order.article);
    const entries = indices.get(marketplaceForSupply(order.sheetName))?.get(articleKey);
    if (entries?.length) {
      if (order.shopCatalogStatus === "matched") {
        const scoped = entries.filter(entry => entry.store === String(order.shop));
        const capacities = scoped.map(entry => {
          const match = entry.boxCapacity.match(/^(\d+)(?:\s+[\p{L}]+)?$/u);
          return match ? Number(match[1]) : null;
        });
        if (capacities.length && capacities.every(n => Number.isSafeInteger(n) && n > 0 && n === capacities[0])) order.catalogUnitsPerBox = capacities[0];
      }
      for (const field of ["machine", "productName"]) {
        if (field === "productName" && !preferCatalog && order[field] && !String(order[field]).trim().startsWith("#")) continue;
        const values = new Set(entries.map(entry => entry[field]));
        if (values.size === 1) {
          const value = [...values][0];
          if (value || (field === "productName" && !preferCatalog)) order[field] = value;
          if (field === "machine" && value) {
            order.machineSource = "catalog";
            order.machineIssue = ["бокс", "рулонная печать", "не найдено в базе"].includes(normal(value))
              ? `В базе ${marketplaceForSupply(order.sheetName)} в поле «Станок» указано «${value}». Конкретный станок не указан.`
              : null;
          }
        } else if (field === "machine") {
          order.machine = "";
          order.machineSource = null;
          order.machineIssue = "В каталоге указаны разные станки";
        }
      }
    }
    // The photo register is keyed by article. A product image does not belong to
    // a store, and missing marketplace catalog rows must not suppress a photo.
    const sourcePhoto = (photoIndex.get(articleKey) || []).map(photoUrlFromSourceRow).find(Boolean) || "";
    const catalogPhoto = entries?.map(entry => entry.photoUrl).find(Boolean) || "";
    if (preferCatalog) order.photoUrl = catalogPhoto;
    else if (sourcePhoto) order.photoUrl = sourcePhoto;
    else if (!order.photoUrl) order.photoUrl = catalogPhoto;
  }
}

export function normalizeCatalogArticle(value) {
  return String(value || "")
    .trim()
    .toLocaleUpperCase("ru-RU")
    .replace(/\s+/g, "")
    .replace(/\(OZ\)$/i, "");
}

export function marketplaceForSupply(name) {
  const value = String(name || "").toLocaleUpperCase("ru-RU");
  const ozon = /(^|[^\p{L}\p{N}])(?:OZON|ОЗОН)([^\p{L}\p{N}]|$)/u.test(value);
  const wb = /(^|[^\p{L}\p{N}])(?:WB|ВБ|WILDBERRIES)([^\p{L}\p{N}]|$)/u.test(value);
  return ozon === wb ? "" : wb ? "WB" : "OZON";
}

export function assignCatalogStores(orders, catalog) {
  const index = buildShopIndex(catalog);
  let matched = 0, missing = 0, ambiguous = 0;
  for (const order of orders) {
    const market = marketplaceForSupply(order.sheetName);
    order.shopCatalogReason = null;
    if (!market) {
      order.shopCatalogStatus = "unknown_marketplace";
      order.shopCatalogReason = "marketplace_unknown";
      continue;
    }
    const key = `${market}:${normalizeCatalogArticle(order.article)}`;
    if (!catalog || !index.availableMarkets.has(market)) {
      order.shopCatalogStatus = "unavailable";
      order.shopCatalogReason = catalog ? "catalog_schema" : "catalog_unavailable";
      missing++;
    } else if (index.ambiguous.has(key)) {
      order.shopCatalogStatus = "ambiguous";
      order.shopCatalogReason = "conflicting_stores";
      ambiguous++;
    } else if (index.values.has(key)) {
      order.shop = index.values.get(key);
      order.shopCatalogStatus = "matched";
      matched++;
    } else {
      order.shopCatalogStatus = "missing";
      order.shopCatalogReason = index.reasons.get(key) || "article_missing";
      missing++;
    }
  }
  return {
    status: !catalog || !index.availableMarkets.size ? "unavailable" : missing || ambiguous ? "partial" : "available",
    matched, missing, ambiguous,
  };
}

function buildShopIndex(catalog) {
  const values = new Map();
  const ambiguous = new Set();
  const reasons = new Map();
  const availableMarkets = new Set();
  if (!catalog || typeof catalog !== "object") return { values, ambiguous, reasons, availableMarkets };
  for (const market of ["WB", "OZON"]) {
    const rows = catalog[market];
    if (!Array.isArray(rows)) continue;
    let headerIndex = -1;
    let shopColumn = -1;
    let articleColumns = [];
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const headers = (rows[i] || []).map(normal);
      const shop = headers.findIndex((header) => header === "магазин");
      const articles = headers.reduce((found, header, column) => {
        if (header === "артикул" || header === "артикул (oz)") found.push(column);
        return found;
      }, []);
      if (shop >= 0 && articles.length) {
        headerIndex = i;
        shopColumn = shop;
        articleColumns = market === "OZON"
          ? [...new Set([...articles, 1])]
          : articles;
        break;
      }
    }
    if (headerIndex < 0) continue;
    availableMarkets.add(market);
    for (const row of rows.slice(headerIndex + 1)) {
      const shop = String(row?.[shopColumn] || "").trim();
      for (const column of articleColumns) {
        const article = normalizeCatalogArticle(row?.[column]);
        if (!article || article.startsWith("#")) continue;
        const key = `${market}:${article}`;
        if (!/^\d+$/.test(shop)) {
          const reason = shop.startsWith("#") ? "store_error" : shop ? "store_invalid" : "store_empty";
          if (!reasons.has(key) || reason === "store_error") reasons.set(key, reason);
          continue;
        }
        const existing = values.get(key);
        if (existing && existing !== shop) {
          values.delete(key);
          ambiguous.add(key);
        } else if (!ambiguous.has(key)) {
          values.set(key, shop);
        }
      }
    }
  }
  return { values, ambiguous, reasons, availableMarkets };
}
