import { parseCsv } from "./printing.js";

const REQUIRED_HEADERS = [
  "Имя",
  "Общий",
  "Резка станок, шт",
  "Ручная резка / прочее, шт",
  "Упаковано, шт",
  "Порезал по видам",
  "Упаковал по видам",
];

function unwrapGviz(text) {
  const marker = "google.visualization.Query.setResponse(";
  const start = text.indexOf(marker);
  const end = text.lastIndexOf(");");
  if (start < 0 || end < start) throw new Error("fbo_live_schema_changed");
  return JSON.parse(text.slice(start + marker.length, end));
}

function number(value) {
  if (typeof value === "number")
    return Number.isFinite(value) && value >= 0 ? value : null;
  const raw = String(value ?? "")
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(",", ".");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function cellValue(cell) {
  if (!cell) return "";
  return cell.v ?? cell.f ?? "";
}

function splitTypes(value) {
  const types = new Map();
  const invalid = [];
  for (const line of String(value ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    const match = line.match(/^(.*?)\s+[—–-]\s+([\d\s\u00a0\u202f.,]+)$/);
    const quantity = match ? number(match[2]) : null;
    if (!match || !match[1].trim() || quantity === null) {
      invalid.push(line);
      continue;
    }
    const name = match[1].trim();
    const key = name.toLocaleLowerCase("ru-RU");
    const item = types.get(key) || { name, quantity: 0 };
    item.quantity += quantity;
    types.set(key, item);
  }
  return { values: [...types.values()], invalid };
}

function parseTable(text) {
  const response = unwrapGviz(text);
  if (response.status !== "ok" || !Array.isArray(response.table?.rows))
    throw new Error("fbo_live_unavailable");
  const rows = response.table.rows.map((row) =>
    (row.c || []).map((cell) => cellValue(cell)),
  );
  const gvizColumns = response.table.cols;
  const hasColumnLabels =
    Array.isArray(gvizColumns) &&
    gvizColumns.some((column) => String(column?.label ?? "").trim());
  const headers = hasColumnLabels
    ? gvizColumns.map((column) => String(column?.label ?? "").trim())
    : (rows[0] || []).map((item) => String(item ?? "").trim());
  const indexes = new Map(headers.map((header, index) => [header, index]));
  if (REQUIRED_HEADERS.some((header) => !indexes.has(header)))
    throw new Error("fbo_live_schema_changed");
  const rawRows = hasColumnLabels ? rows : rows.slice(1);
  const updateLabel =
    rawRows
      .flat()
      .map((value) => String(value ?? ""))
      .find((value) => /Обновляется автоматически/i.test(value)) || "";
  const updateTime = updateLabel.match(/(\d{1,2}:\d{2})/i)?.[1] || null;
  return { headers, indexes, rows: rawRows, updateTime };
}

function isEmployeeName(value) {
  return (
    /[А-Яа-яЁё]/.test(value) && !/^(итого|командный|всего)$/i.test(value.trim())
  );
}

export function parseFboCurrent(text, date) {
  const table = parseTable(text);
  const at = (row, header) => row[table.indexes.get(header)];
  const records = [];
  const invalid = [];

  table.rows.forEach((row, index) => {
    const employee = String(at(row, "Имя") ?? "").trim();
    if (!isEmployeeName(employee)) return;
    const machineCut = number(at(row, "Резка станок, шт"));
    const manualCut = number(at(row, "Ручная резка / прочее, шт"));
    const packed = number(at(row, "Упаковано, шт"));
    const coefficient = number(at(row, "Общий"));
    const cutTypes = splitTypes(at(row, "Порезал по видам"));
    const packTypes = splitTypes(at(row, "Упаковал по видам"));
    const rowErrors = [];
    if (machineCut === null) rowErrors.push("invalid_machine_cut");
    if (manualCut === null) rowErrors.push("invalid_manual_cut");
    if (packed === null) rowErrors.push("invalid_packed");
    if (rowErrors.length) {
      invalid.push({ row: index + 2, employee, errors: rowErrors });
      return;
    }
    const cut = machineCut + manualCut;
    const total = cut + packed;
    records.push({
      id: `fbo-live:${date}:${employee}`,
      date,
      updatedAt: null,
      employee,
      employeeId: null,
      identityKey: `fbo:${employee}`,
      sourceKind: "fbo",
      reconciliationStatus: "needs_review",
      mappingStatus: "unmapped",
      coefficient,
      machineCut,
      manualCut,
      cut,
      packed,
      total,
      days: 1,
      cutTypes: cutTypes.values,
      packTypes: packTypes.values,
      events: [],
      sourceItems: [
        ...(cut > 0
          ? [
              {
                operationFamily: "cut",
                quantity: cut,
                types: cutTypes.values,
                typeBreakdownComplete:
                  cutTypes.invalid.length === 0 &&
                  cutTypes.values.reduce(
                    (sum, item) => sum + item.quantity,
                    0,
                  ) === cut,
              },
            ]
          : []),
        ...(packed > 0
          ? [
              {
                operationFamily: "packing",
                quantity: packed,
                types: packTypes.values,
                typeBreakdownComplete:
                  packTypes.invalid.length === 0 &&
                  packTypes.values.reduce(
                    (sum, item) => sum + item.quantity,
                    0,
                  ) === packed,
              },
            ]
          : []),
      ],
      sourceQuality: {
        typeBreakdownComplete:
          cutTypes.invalid.length === 0 &&
          packTypes.invalid.length === 0 &&
          (cut === 0 ||
            cutTypes.values.reduce((sum, item) => sum + item.quantity, 0) ===
              cut) &&
          (packed === 0 ||
            packTypes.values.reduce((sum, item) => sum + item.quantity, 0) ===
              packed),
      },
    });
  });

  return {
    records,
    invalid,
    updateTime: table.updateTime,
    status: invalid.length ? "partial" : "available",
  };
}

export function makeFboCurrentGvizFixture(rows) {
  const headers = [
    "Имя",
    "Кэф резки",
    "Кэф резки+упаковки",
    "Кэф упаковки",
    "Общий",
    "Статус",
    "Все коэффициенты",
    "",
    "Резка станок, шт",
    "Ручная резка / прочее, шт",
    "Порезано всего, шт",
    "Упаковано, шт",
    "Всего, шт",
    "Порезал по видам",
    "Упаковал по видам",
  ];
  const makeCell = (value) => ({ v: value });
  const columns = headers.map((label, index) => ({
    id: String.fromCharCode(65 + index),
    label,
    type: "string",
  }));
  const tableRows = rows.map((row) => ({
    c: row.map((value) => (value === null ? null : makeCell(value))),
  }));
  return `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify({
    status: "ok",
    table: { cols: columns, rows: tableRows },
  })});`;
}
