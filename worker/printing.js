import { sourceTimestamp } from "./timestamps.js";
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
function ritmBridgeEmployee_(v, operation) {
  var s = String(v || "")
    .trim()
    .toLowerCase();
  // Lukman is a cutter, not a printer. Keep the role scoped to cutting rows.
  if (operation === "Резка" && s === "лукман") return "Лукман";
  if (/^(дмитрий|дима)$/.test(s) || /^[дd](?:\d|$)/.test(s)) return "Дмитрий";
  if (s === "андрей" || /^[аa](?:\d|$)/.test(s)) return "Андрей";
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
      fallback = options.orderFallback,
      historicalOrder =
        !resolvedOrder &&
        fallback?.journalAliases?.includes(journalSheetName) &&
        String(r[6] || "").trim() &&
        String(r[7] || "").trim()
          ? { ...fallback, uid: String(r[7]).trim(), article: String(r[6]).trim() }
          : null,
      order = resolvedOrder || historicalOrder,
      employee = ritmBridgeEmployee_(r[2], operation),
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
export const SHEET_ID = "1eNdUuk-2l83Pgv95LyqYKuOOfhAsEMm5tKLbhWBJiC4";
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
export const ROLL_PRINTING_SHEET_ID =
  "1hojhKS4Av_yy5sUMJcsoeJ_MQRU3V5g9P-fP61PO6Cs";
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
    } = sheet;
    const headers = rows[headerRow - 1] || [];
    if (
      normal(headers[4]) !== "артикул" ||
      normal(headers[14]) !== "кол-во"
    )
      throw Object.assign(new Error("Order schema changed"), {
        issue: {
          source: name,
          row: headerRow,
          cell: `E${headerRow}:O${headerRow}`,
          code: "schema_changed",
          message: "Изменились заголовки листа поставки",
          found: JSON.stringify(headers).slice(0, 500),
          expected: "Артикул в E3 и Кол-во в O3",
        },
      });
    const uidCol = (rows[uidHeaderRow - 1] || []).indexOf("UID");
    if (uidCol < 0)
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
      const article = String(r[4] || "").trim();
      if (!article) return;
      const raw = String(r[uidCol] || "").trim();
      if (!raw) {
        index.issues.push({
          source: name,
          row: i + dataStartRow,
          cell: columnName(uidCol + 1) + (i + dataStartRow),
          code: "missing_uid",
          found: "",
          expected: "UID заказа",
          message: "Нет UID заказа",
        });
        return;
      }
      const uid = raw.includes("::")
        ? raw
        : gid === 437912546
          ? raw
          : gid + "::" + raw;
      if (index.byUid[uid])
        throw Object.assign(new Error("Duplicate order UID"), {
          issue: {
            source: name,
            row: i + dataStartRow,
            cell: columnName(uidCol + 1) + (i + dataStartRow),
            code: "duplicate_uid",
            message: "Повторяется UID заказа",
            found: raw,
            expected: "Уникальный UID заказа",
          },
        });
      const quantity = ritmBridgeNumber_(r[14]),
        shownArea = ritmBridgeNumber_(r[9]);
      const calculated =
        ritmBridgeNumber_(r[5]) *
        ritmBridgeNumber_(r[7]) *
        ritmBridgeNumber_(r[8]) *
        quantity;
      // J is F*H*I*O on all inspected supply tabs. Restore its display rounding only when consistent.
      const plannedArea =
        Math.abs(calculated - shownArea) <= 0.00051 ? calculated : shownArea;
      const remainingPrint =
        sourceId === "roll-printing" ? optionalNonnegative(r[23]) : null;
      const printProgressValue =
        sourceId === "roll-printing"
          ? optionalProgress(r[19], quantity)
          : null;
      const o = {
        uid,
        rawUid: raw,
        sheetId: gid,
        sheetName: name,
        journalAliases,
        row: i + dataStartRow,
        article,
        quantity,
        plannedArea,
        // The roll-printing sheet carries live per-order progress in T/U and
        // the authoritative remaining print quantity in X. Keep empty cells
        // nullable so the UI can distinguish an unstarted row from bad data.
        printProgress:
          printProgressValue !== null
            ? printProgressValue
            : remainingPrint !== null && remainingPrint <= quantity
              ? Math.max(0, quantity - remainingPrint)
              : null,
        cutProgress:
          sourceId === "roll-printing"
            ? optionalProgress(r[20], quantity)
            : null,
        remainingPrint,
        shop: String(r[24] || ""),
        sourceId,
        sourceName,
        site,
        spreadsheetId,
        sourceUrl,
      };
      index.byUid[uid] = o;
      (index.byRaw[raw] || (index.byRaw[raw] = [])).push(o);
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
  const sources = printingSources(options.additionalSheets || []),
    descriptors = sources.flatMap((source) => [
    ...source.supplies.map((sheet) => ({
      ...sheet,
      source,
      kind: "supply",
    })),
    { ...source.journal, source, kind: "journal" },
  ]);
  const exports = await Promise.all(
    descriptors.map(async (sheet) => {
      const response = await fetcher(
        `https://docs.google.com/spreadsheets/d/${sheet.source.spreadsheetId}/export?format=csv&gid=${sheet.gid}`,
        { signal: AbortSignal.timeout(20000) },
      );
      if (!response.ok)
        throw new Error(
          `Source unavailable: ${sheet.source.name} · ${sheet.name}`,
        );
      return { ...sheet, rows: parseCsv(await response.text()) };
    }),
  );
    const supplies = [],
    sheets = [],
    events = [],
    cutEvents = [],
    issues = [],
    sourceTimes = [];
  for (const source of sources) {
    const sourceExports = exports.filter((sheet) => sheet.source.id === source.id),
      supplyExports = sourceExports.filter((sheet) => sheet.kind === "supply"),
      journalExport = sourceExports.find((sheet) => sheet.kind === "journal");
    if (!journalExport)
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
    const facts = collectJournalPrinting(sourceIndex, journal.slice(1), {
      name: journalExport.sourceName,
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
      name: journalExport.sourceName,
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
      })),
    );
    sourceTimes.push(
      ...journal
        .slice(1)
        .map((row) => sourceTimestamp(row[12]))
        .filter(Boolean),
    );
  }
  const sourceLinks = sources.map((source) => ({
    id: source.id,
    name: source.name,
    spreadsheetId: source.spreadsheetId,
    spreadsheetUrl: sheetUrl(source.spreadsheetId, source.supplies[0].gid),
    journalName: source.journal.sourceName,
    journalUrl: sheetUrl(source.spreadsheetId, source.journal.gid),
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
  };
}
