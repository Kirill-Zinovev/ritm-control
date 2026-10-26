import { parseCsv } from "./printing.js";
import { privateGoogleSource } from "./privateGoogleConfig.js";

export const RITM_ASSEMBLY_SOURCE_ID =
  privateGoogleSource("assemblyDatabaseId");
export const RITM_ASSEMBLY_WORKLOG_GID = 1587688746;
export const RITM_ASSEMBLY_WORK_CORRECTIONS_GID = 1151154937;
export const RITM_ASSEMBLY_WORK_CORRECTIONS_SHEET = "WorkLogCorrections";
export const RITM_ASSEMBLY_CURRENT_CATALOG_GID = 651303867;
export const RITM_ASSEMBLY_WORKLOG_SOURCE = "WEB_APP_RITM";

export function isRitmAssemblyShipmentId(value) {
  if (typeof value !== "string") return false;
  const sheet = /^RITM-(?:ROLL|BOX)-(\d+)$/.exec(value);
  if (sheet) return Number.isSafeInteger(Number(sheet[1]));
  return /^RITM-SUPPLY-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

const WORKLOG_HEADERS = [
  "eventId",
  "createdAt",
  "shipmentId",
  "directionId",
  "positionId",
  "Артикул",
  "employeeId",
  "Сотрудник",
  "operationId",
  "Операция",
  "Количество, шт",
  "Норма, шт/чел",
  "Коэффициент",
  "Источник",
  "idempotencyKey",
];

const OPERATION_NAMES = Object.freeze({
  cut: "Резка на станке",
  assembly: "Ручная резка",
  packing: "Упаковка",
});

function parseNumber(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(",", ".");
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function moscowDay(value) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function parseGrid(csv, requiredHeaders) {
  const rows = parseCsv(csv);
  const headers = (rows[0] || []).map((header) =>
    String(header ?? "")
      .replace(/^\uFEFF/, "")
      .trim(),
  );
  if (requiredHeaders.some((header) => !headers.includes(header)))
    throw new Error("assembly_worklog_schema_changed");
  return { rows, headers, index: new Map(headers.map((name, i) => [name, i])) };
}

function optionalHeader(index, candidates) {
  return candidates.find((name) => index.has(name)) || "";
}

const CANCELLED_STATUSES = new Set([
  "cancelled",
  "canceled",
  "void",
  "voided",
  "отменено",
  "отменен",
  "отменена",
  "аннулировано",
  "аннулирован",
]);

// Cancellation facts are append-only and live in their own table. Optional
// inline status columns in WorkLog do not replace this source.
export function parseAssemblyWorkCorrectionsRows(rows) {
  const headers = (rows[0] || []).map((value) => String(value ?? "").replace(/^\uFEFF/, "").trim());
  const required = ["correctionId", "eventId", "action", "createdAt", "actor", "reason"];
  if (required.some((header) => !headers.includes(header)))
    throw new Error("assembly_corrections_schema_changed");
  const index = new Map(headers.map((header, i) => [header, i]));
  const eventIds = new Set();
  for (const row of rows.slice(1)) {
    if (!row.some((value) => String(value ?? "").trim())) continue;
    const read = (header) => String(row[index.get(header)] ?? "").trim();
    const eventId = read("eventId");
    if (!read("correctionId") || !eventId || eventId.length > 200 ||
        read("action").toUpperCase() !== "CANCEL" ||
        !Number.isFinite(Date.parse(read("createdAt"))))
      throw new Error("assembly_corrections_invalid_record");
    eventIds.add(eventId);
  }
  return eventIds;
}

export function parseAssemblyWorkLog(csv, correctionsCsv = null) {
  const { rows, index } = parseGrid(csv, WORKLOG_HEADERS);
  const read = (row, header) =>
    header && index.has(header) ? String(row[index.get(header)] ?? "").trim() : "";
  const statusHeader = optionalHeader(index, ["Статус", "status", "eventStatus"]);
  const supersedesHeader = optionalHeader(index, [
    "supersedesEventId",
    "correctsEventId",
    "correctionOfEventId",
    "reversesEventId",
    "Отменяет eventId",
  ]);
  const cancelTargetHeader = optionalHeader(index, [
    "cancelledEventId",
    "canceledEventId",
    "voidedEventId",
    "Отменённый eventId",
  ]);
  const candidates = [];
  const invalid = [];
  const supersededIds = new Set();
  const cancelledIds = correctionsCsv === null
    ? new Set()
    : parseAssemblyWorkCorrectionsRows(parseCsv(correctionsCsv));

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row.some((value) => String(value ?? "").trim())) continue;

    const source = read(row, "Источник");
    const shipmentId = read(row, "shipmentId");
    // The source allowlist and RITM shipment IDs exclude seeded and test rows.
    if (source !== RITM_ASSEMBLY_WORKLOG_SOURCE) continue;
    if (!isRitmAssemblyShipmentId(shipmentId)) {
      invalid.push({ row: rowIndex + 1, errors: ["untrusted_shipment"] });
      continue;
    }

    const eventId = read(row, "eventId");
    const status = read(row, statusHeader).toLocaleLowerCase("ru-RU");
    const supersedesId = read(row, supersedesHeader);
    const cancelTargetId = read(row, cancelTargetHeader);
    if (supersedesId) supersededIds.add(supersedesId);
    if (cancelTargetId) cancelledIds.add(cancelTargetId);
    if (CANCELLED_STATUSES.has(status)) {
      if (eventId && !cancelTargetId) cancelledIds.add(eventId);
      continue;
    }

    const directionId = read(row, "directionId");
    const positionId = read(row, "positionId");
    const article = read(row, "Артикул");
    const employeeId = read(row, "employeeId");
    const employee = read(row, "Сотрудник");
    const operationId = read(row, "operationId");
    const operation = OPERATION_NAMES[operationId] || "";
    const createdAtRaw = read(row, "createdAt");
    const createdAt = Date.parse(createdAtRaw);
    const quantity = parseNumber(read(row, "Количество, шт"));
    const norm = parseNumber(read(row, "Норма, шт/чел"));
    const storedCoefficient = parseNumber(read(row, "Коэффициент"));
    const idempotencyKey = read(row, "idempotencyKey");
    const errors = [];

    if (!eventId) errors.push("missing_event_id");
    if (!idempotencyKey) errors.push("missing_idempotency_key");
    if (directionId !== "ROLL") errors.push("wrong_direction");
    if (
      !positionId ||
      !article ||
      !positionId.startsWith(shipmentId + "|") ||
      !positionId.endsWith("|" + article)
    )
      errors.push("invalid_position");
    if (!employeeId || !employee) errors.push("missing_employee_identity");
    if (!operation) errors.push("unsupported_operation");
    if (!Number.isSafeInteger(quantity) || quantity <= 0)
      errors.push("invalid_quantity");
    if (!Number.isFinite(createdAt) || !moscowDay(createdAtRaw))
      errors.push("invalid_time");
    if (norm !== null && norm <= 0) errors.push("invalid_norm");
    if (storedCoefficient !== null && storedCoefficient < 0)
      errors.push("invalid_coefficient");
    if (errors.length) {
      invalid.push({ row: rowIndex + 1, shipmentId, errors });
      continue;
    }

    candidates.push({
      eventId,
      idempotencyKey,
      shipmentId,
      shipmentName: read(row, "Направление"),
      directionId,
      positionId,
      article,
      employeeId,
      employee,
      operationId,
      operation,
      quantity,
      norm,
      // Use the event's saved coefficient; never reconstruct it from today's norm.
      coefficient: norm === null ? null : storedCoefficient,
      createdAt: new Date(createdAt).toISOString(),
      date: moscowDay(createdAtRaw),
      source,
      productType: "",
    });
  }

  const eventIdCounts = new Map();
  const keyCounts = new Map();
  for (const event of candidates) {
    eventIdCounts.set(event.eventId, (eventIdCounts.get(event.eventId) || 0) + 1);
    keyCounts.set(
      event.idempotencyKey,
      (keyCounts.get(event.idempotencyKey) || 0) + 1,
    );
  }
  const duplicates = new Set();
  for (const event of candidates) {
    if (
      eventIdCounts.get(event.eventId) > 1 ||
      keyCounts.get(event.idempotencyKey) > 1
    )
      duplicates.add(event.eventId);
  }

  const events = candidates.filter((event) => {
    if (duplicates.has(event.eventId)) {
      invalid.push({ shipmentId: event.shipmentId, errors: ["duplicate_event"] });
      return false;
    }
    return !supersededIds.has(event.eventId) && !cancelledIds.has(event.eventId);
  });

  return {
    events,
    invalid,
    audit: {
      supportsCorrections: correctionsCsv !== null || Boolean(statusHeader || supersedesHeader || cancelTargetHeader),
      correctionsApplied: supersededIds.size,
      cancellationsApplied: cancelledIds.size,
    },
  };
}

export function parseAssemblyArticleCatalog(csv) {
  const required = [
    "shipmentId",
    "directionId",
    "positionId",
    "Артикул",
    "Вид товара",
    "Источник",
  ];
  const { rows, index } = parseGrid(csv, required);
  const products = new Map();
  for (const row of rows.slice(1)) {
    const source = String(row[index.get("Источник")] ?? "").trim();
    const shipmentId = String(row[index.get("shipmentId")] ?? "").trim();
    const directionId = String(row[index.get("directionId")] ?? "").trim();
    const positionId = String(row[index.get("positionId")] ?? "").trim();
    const article = String(row[index.get("Артикул")] ?? "").trim();
    const productType = String(row[index.get("Вид товара")] ?? "").trim();
    if (
      !["RITM_ROLL_PRINTING", "RITM_BOX_PRINTING"].includes(source) ||
      !isRitmAssemblyShipmentId(shipmentId) ||
      directionId !== "ROLL" ||
      !positionId.startsWith(shipmentId + "|") ||
      !positionId.endsWith("|" + article) ||
      !article ||
      !productType
    )
      continue;
    products.set(shipmentId + "|" + positionId + "|" + article, productType);
  }
  return products;
}

export function attachAssemblyProductTypes(workLog, catalog) {
  const events = workLog.events.map((event) => ({
    ...event,
    productType:
      catalog.get(event.shipmentId + "|" + event.positionId + "|" + event.article) ||
      "",
  }));
  const missing = events.filter((event) => !event.productType).length;
  return {
    ...workLog,
    events,
    catalog: {
      status: missing ? "partial" : "available",
      missingRecords: missing,
    },
  };
}
