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
function ritmBridgeEmployee_(v) {
  var s = String(v || "")
    .trim()
    .toLowerCase();
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
  if (direct && (!sheetName || direct.sheetName === sheetName)) return direct;
  var list = (index.byRaw[uid] || []).filter(function (o) {
    return !sheetName || o.sheetName === sheetName;
  });
  return list.length === 1 ? list[0] : null;
}
// The daily summary is QUERY(group by B, C, D; sum L) over this journal.
// Completed rolls outside the journal are not production facts for this KPI.
export function collectJournalPrinting(index, journal) {
  const events = [],
    issues = index.issues.slice(),
    eventCounts = {};
  journal.forEach((r) => {
    const id = String(r[0] || "").trim();
    if (String(r[3]).trim() === "Печать" && id)
      eventCounts[id] = (eventCounts[id] || 0) + 1;
  });
  journal.forEach((r, i) => {
    if (String(r[3]).trim() !== "Печать") return;
    const id = String(r[0] || "").trim(),
      order = ritmBridgeResolve_(index, r[7], String(r[4] || "")),
      employee = ritmBridgeEmployee_(r[2]),
      date = ritmBridgeDay_(r[1]),
      quantity = ritmBridgeNumber_(r[9]),
      area = ritmBridgeNumber_(r[11]),
      errors = [];
    if (!id || eventCounts[id] > 1) errors.push("Нет уникального ID записи");
    if (!order) errors.push("Заказ не найден");
    if (!employee) errors.push("Неизвестный сотрудник");
    if (!date) errors.push("Нет даты");
    if (!Number.isInteger(quantity) || quantity <= 0 || area <= 0)
      errors.push("Нет количества или площади");
    if (errors.length) {
      issues.push({
        source: "Журнал выпуска",
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
                  : "J" + (i + 2) + ":L" + (i + 2),
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
        expected: "Уникальная валидная запись печати, связанная с заказом",
        message: errors.join("; "),
      });
      return;
    }
    events.push({
      id: "journal:" + id,
      uid: order.uid,
      roll: String(r[8] || ""),
      employee,
      date,
      quantity,
      area,
      article: order.article,
      sheetId: order.sheetId,
      sheetName: order.sheetName,
      source: "Журнал выпуска",
    });
  });
  return { events, issues };
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
export function indexOrders(sheets) {
  const index = { orders: [], byUid: {}, byRaw: {}, issues: [] };
  sheets.forEach(({ gid, name, rows }) => {
    if (
      normal(rows[2]?.[4]) !== "артикул" ||
      normal(rows[2]?.[14]) !== "кол-во"
    )
      throw Object.assign(new Error("Order schema changed"), {
        issue: {
          source: name,
          row: 3,
          cell: "E3:O3",
          code: "schema_changed",
          message: "Изменились заголовки листа поставки",
          found: JSON.stringify(rows[2] || []).slice(0, 500),
          expected: "Артикул в E3 и Кол-во в O3",
        },
      });
    const uidCol = rows[0].indexOf("UID");
    if (uidCol < 0)
      throw Object.assign(new Error("UID column missing"), {
        issue: {
          source: name,
          row: 1,
          cell: "A1",
          code: "schema_changed",
          message: "Не найден столбец UID",
          found: "Заголовок UID отсутствует",
          expected: "Заголовок UID в первой строке рабочего листа",
        },
      });
    rows.slice(3).forEach((r, i) => {
      const article = String(r[4] || "").trim();
      if (!article) return;
      const raw = String(r[uidCol] || "").trim();
      if (!raw) {
        index.issues.push({
          source: name,
          row: i + 4,
          cell: columnName(uidCol + 1) + (i + 4),
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
            row: i + 4,
            cell: columnName(uidCol + 1) + (i + 4),
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
      const o = {
        uid,
        rawUid: raw,
        sheetId: gid,
        sheetName: name,
        row: i + 4,
        article,
        quantity,
        plannedArea,
        shop: String(r[24] || ""),
      };
      index.byUid[uid] = o;
      (index.byRaw[raw] || (index.byRaw[raw] = [])).push(o);
      index.orders.push(o);
    });
  });
  return index;
}
export async function loadPrinting(fetcher = fetch) {
  const descriptors = [
    ...SUPPLY_SHEETS.map(([gid, name]) => ({ gid, name })),
    { gid: 725126844, name: "Журнал выпуска" },
  ];
  const exports = await Promise.all(
    descriptors.map(async (s) => {
      const response = await fetcher(
        `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${s.gid}`,
        { signal: AbortSignal.timeout(20000) },
      );
      if (!response.ok) throw new Error("Source unavailable");
      return { ...s, rows: parseCsv(await response.text()) };
    }),
  );
  const index = indexOrders(exports.slice(0, SUPPLY_SHEETS.length)),
    journal = exports[SUPPLY_SHEETS.length].rows;
  const expected = {
    0: "ID записи",
    1: "Дата",
    2: "Сотрудник",
    3: "Операция",
    7: "UID заказа",
    9: "Сделано, шт.",
    11: "Выпуск, м²",
  };
  if (
    Object.entries(expected).some(
      ([col, header]) => journal[0]?.[col] !== header,
    )
  )
    throw Object.assign(new Error("Printing schema changed"), {
      issue: {
        source: "Журнал выпуска",
        row: 1,
        cell: "A1:L1",
        code: "schema_changed",
        message: "Изменились заголовки журнала выпуска",
        found: JSON.stringify(journal[0] || []).slice(0, 500),
        expected: JSON.stringify(expected),
      },
    });
  const facts = collectJournalPrinting(index, journal.slice(1));
  return {
    ok: true,
    schemaVersion: 2,
    source: SHEET_ID,
    timezone: "Europe/Moscow",
    updatedAt: new Date().toISOString(),
    sourceUpdatedAt:
      journal
        .slice(1)
        .map((r) => sourceTimestamp(r[12]))
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    quality: {
      status: facts.issues.length ? "partial" : "valid",
      invalidRecords: facts.issues.length,
    },
    events: facts.events,
    issues: facts.issues,
    supplies: index.orders,
    sheets: SUPPLY_SHEETS.map(([sheetId, name]) => ({ sheetId, name })),
  };
}
