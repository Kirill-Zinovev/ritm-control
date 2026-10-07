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
export function reconcilePrinting(index, system, journal) {
  var events = [],
    issues = index.issues.slice(),
    eventCounts = {},
    rollCounts = {},
    coverage = {},
    invalidRolls = {};
  system.forEach(function (r) {
    if (r[8]) rollCounts[String(r[8])] = (rollCounts[String(r[8])] || 0) + 1;
  });
  journal.forEach(function (r) {
    if (String(r[3]).trim() === "Печать" && r[0])
      eventCounts[String(r[0])] = (eventCounts[String(r[0])] || 0) + 1;
  });
  function event(id, order, roll, employee, date, quantity, area, source) {
    return {
      id: id,
      uid: order.uid,
      roll: String(roll || ""),
      employee: employee,
      date: date,
      quantity: quantity,
      area: area,
      article: order.article,
      sheetId: order.sheetId,
      sheetName: order.sheetName,
      source: source,
    };
  }
  journal.forEach(function (r, i) {
    if (String(r[3]).trim() !== "Печать") return;
    var id = String(r[0] || ""),
      rollId = String(r[14] || ""),
      order = ritmBridgeResolve_(index, r[7], String(r[4] || "")),
      employee = ritmBridgeEmployee_(r[2]),
      date = ritmBridgeDay_(r[1]),
      quantity = ritmBridgeNumber_(r[9]),
      area = ritmBridgeNumber_(r[11]),
      errors = [];
    if (rollId) {
      var cov =
        coverage[rollId] || (coverage[rollId] = { quantity: 0, area: 0 });
      cov.quantity += Math.max(0, quantity);
      cov.area += Math.max(0, area);
    }
    if (!id || eventCounts[id] > 1) errors.push("Нет уникального ID записи");
    if (!rollId || rollCounts[rollId] > 1)
      errors.push("Нет уникального ID рулона");
    if (!order) errors.push("Заказ не найден");
    if (!employee) errors.push("Неизвестный сотрудник");
    if (!date) errors.push("Нет даты");
    if (!Number.isInteger(quantity) || quantity <= 0 || area <= 0)
      errors.push("Нет количества или площади");
    if (errors.length) {
      if (rollId) invalidRolls[rollId] = true;
      issues.push({
        source: "Журнал выпуска",
        row: i + 2,
        message: errors.join("; "),
      });
      return;
    }
    events.push(
      event(
        "journal:" + id,
        order,
        r[8],
        employee,
        date,
        quantity,
        area,
        "Журнал выпуска",
      ),
    );
  });
  system.forEach(function (r, i) {
    if (r[3] !== true) return;
    var id = String(r[8] || ""),
      order = ritmBridgeResolve_(index, r[0]),
      employee = ritmBridgeEmployee_(r[10]),
      date = ritmBridgeDay_(r[9]),
      quantity = ritmBridgeNumber_(r[7]),
      area = ritmBridgeNumber_(r[11]),
      errors = [];
    if (!id || rollCounts[id] > 1) errors.push("Нет уникального ID рулона");
    if (!order) errors.push("Заказ не найден");
    if (!employee) errors.push("Неизвестный сотрудник");
    if (!date) errors.push("Нет даты");
    if (!Number.isInteger(quantity) || quantity <= 0 || area <= 0)
      errors.push("Нет количества или площади");
    if (errors.length) {
      issues.push({
        source: "_SYSTEM_ROLLS",
        row: i + 2,
        message: errors.join("; "),
      });
      return;
    }
    var logged = coverage[id];
    if (invalidRolls[id]) return;
    // Automatic journal rows round to 3 decimals. Retain the original stored roll area at completion.
    if (
      logged &&
      logged.quantity === quantity &&
      Math.abs(logged.area - area) <= 0.001
    ) {
      var auto = events.find(function (e) {
        return (
          e.id === "journal:AUTO_PRINT_" + id &&
          e.uid === order.uid &&
          e.employee === employee &&
          e.date === date
        );
      });
      if (auto) {
        auto.area += area - logged.area;
        logged.area = area;
      }
    }
    if (logged) {
      if (logged.quantity > quantity || logged.area > area + 0.001) {
        issues.push({
          source: "_SYSTEM_ROLLS",
          row: i + 2,
          message: "В журнале выпуск больше полного рулона",
        });
        return;
      }
      quantity -= logged.quantity;
      area -= logged.area;
    }
    if (quantity > 0 && area > 0.0000001)
      events.push(
        event(
          "roll:" + id,
          order,
          r[1],
          employee,
          date,
          quantity,
          area,
          logged ? "Остаток выполненного рулона" : "_SYSTEM_ROLLS",
        ),
      );
  });
  return { events: events, issues: issues };
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
      throw new Error("Order schema changed");
    const uidCol = rows[0].indexOf("UID");
    if (uidCol < 0) throw new Error("UID column missing");
    rows.slice(3).forEach((r, i) => {
      const article = String(r[4] || "").trim();
      if (!article) return;
      const raw = String(r[uidCol] || "").trim();
      if (!raw) {
        index.issues.push({
          source: name,
          row: i + 4,
          message: "Нет UID заказа",
        });
        return;
      }
      const uid = raw.includes("::")
        ? raw
        : gid === 437912546
          ? raw
          : gid + "::" + raw;
      if (index.byUid[uid]) throw new Error("Duplicate order UID");
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
    { gid: 86586324, name: "_SYSTEM_ROLLS" },
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
  const index = indexOrders(exports.slice(0, 11)),
    system = exports[11].rows,
    journal = exports[12].rows;
  if (
    system[0]?.[8] !== "ROLL_ID" ||
    system[0]?.[11] !== "PRINT_AREA" ||
    journal[0]?.[14] !== "ID рулона"
  )
    throw new Error("Printing schema changed");
  const facts = reconcilePrinting(
    index,
    system
      .slice(1)
      .filter((r) => r[0])
      .map((r) => {
        const x = r.slice();
        x[3] = r[3] === "TRUE" || r[3] === "ИСТИНА";
        return x;
      }),
    journal.slice(1).filter((r) => r[0]),
  );
  return {
    ok: true,
    schemaVersion: 2,
    source: SHEET_ID,
    timezone: "Europe/Moscow",
    updatedAt: new Date().toISOString(),
    events: facts.events,
    issues: facts.issues,
    supplies: index.orders,
    sheets: SUPPLY_SHEETS.map(([sheetId, name]) => ({ sheetId, name })),
  };
}
