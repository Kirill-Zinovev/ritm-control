import {
  parseAssemblyWorkCorrectionsRows,
  isRitmAssemblyShipmentId,
  RITM_ASSEMBLY_SOURCE_ID,
  RITM_ASSEMBLY_WORK_CORRECTIONS_GID,
  RITM_ASSEMBLY_WORK_CORRECTIONS_SHEET,
} from "../worker/assemblyWorkLog.js";

export const RITM_ASSEMBLY_WORKLOG = Object.freeze({
  documentId: RITM_ASSEMBLY_SOURCE_ID,
  sheetId: 1587688746,
  sheetName: "WorkLog",
  source: "WEB_APP_RITM",
  maxRows: 20000,
});

const requiredHeaders = [
  "eventId",
  "createdAt",
  "shipmentId",
  "directionId",
  "positionId",
  "Артикул",
  "operationId",
  "Количество, шт",
  "Источник",
  "idempotencyKey",
];

function cellValue(cell) {
  const value = cell?.userEnteredValue;
  return (
    value?.stringValue ??
    value?.numberValue ??
    value?.boolValue ??
    ""
  );
}

function workPositionId(order) {
  const shipmentId = workShipmentId(order);
  const identity = order.rawUid
    ? `uid:${String(order.rawUid)}`
    : `row:${order.row}`;
  return `${shipmentId}|${order.sourceId === "box-printing" ? `box:${order.sheetId}|` : ""}${identity}|${String(order.article || "")}`;
}

function workShipmentId(order) {
  return order.assemblyShipmentId || `RITM-${order.sourceId === "box-printing" ? "BOX" : "ROLL"}-${order.sheetId}`;
}

function sourceStatus(status, checkedAt, overrides = {}) {
  return {
    status,
    source: "RITM Assembly · WorkLog",
    sourceUrl:
      "https://docs.google.com/spreadsheets/d/" +
      RITM_ASSEMBLY_WORKLOG.documentId +
      "/edit#gid=" +
      RITM_ASSEMBLY_WORKLOG.sheetId,
    checkedAt,
    sourceUpdatedAt: null,
    eventCount: 0,
    invalidRecords: 0,
    reason: null,
    ...overrides,
  };
}

export function unavailableAssemblyPacking(printing, checkedAt, reason) {
  return {
    ...printing,
    packing: sourceStatus("unavailable", checkedAt, { reason }),
    supplies: (printing.supplies || []).map((order) => ({
      ...order,
      packed: null,
      packingRecords: null,
    })),
  };
}

export function readAssemblyPackingGrid(grid) {
  if (
    !grid ||
    grid.spreadsheetId !== RITM_ASSEMBLY_WORKLOG.documentId ||
    !Array.isArray(grid.sheets)
  )
    throw new Error("worklog_document_mismatch");

  const sheet = grid.sheets.find(
    (item) =>
      item.properties?.sheetId === RITM_ASSEMBLY_WORKLOG.sheetId &&
      item.properties?.title === RITM_ASSEMBLY_WORKLOG.sheetName,
  );
  const block = sheet?.data?.[0];
  if (
    !sheet ||
    !Array.isArray(sheet.data) ||
    sheet.data.length !== 1 ||
    (block?.startRow ?? 0) !== 0 ||
    (block?.startColumn ?? 0) !== 0 ||
    !Array.isArray(block.rowData) ||
    !block.rowData.length
  )
    throw new Error("worklog_grid_unavailable");

  const headers = (block.rowData[0].values || []).map((cell) =>
    String(cellValue(cell) || "").trim(),
  );
  const index = new Map(headers.map((header, i) => [header, i]));
  if (requiredHeaders.some((header) => !index.has(header)))
    throw new Error("worklog_schema_changed");

  const value = (row, name) => cellValue(row.values?.[index.get(name)]);
  const corrections = grid.sheets.find((item) =>
    item.properties?.sheetId === RITM_ASSEMBLY_WORK_CORRECTIONS_GID &&
    item.properties?.title === RITM_ASSEMBLY_WORK_CORRECTIONS_SHEET);
  const correctionBlock = corrections?.data?.[0];
  if (!corrections || corrections.data?.length !== 1 ||
      (correctionBlock?.startRow ?? 0) !== 0 ||
      (correctionBlock?.startColumn ?? 0) !== 0 ||
      !Array.isArray(correctionBlock?.rowData))
    throw new Error("assembly_corrections_unavailable");
  const cancelledEventIds = parseAssemblyWorkCorrectionsRows(
    correctionBlock.rowData.map((row) => (row.values || []).map(cellValue)),
  );
  const events = [];
  const invalid = [];
  const seenEventIds = new Set();
  const seenIdempotencyKeys = new Set();

  for (let i = 1; i < block.rowData.length; i++) {
    const row = block.rowData[i];
    if (!(row.values || []).some((cell) => cellValue(cell) !== "")) continue;
    const source = String(value(row, "Источник") || "").trim();
    const operationId = String(value(row, "operationId") || "").trim();
    const shipmentId = String(value(row, "shipmentId") || "").trim();
    if (
      source !== RITM_ASSEMBLY_WORKLOG.source ||
      operationId !== "packing" ||
      !isRitmAssemblyShipmentId(shipmentId)
    )
      continue;

    const eventId = String(value(row, "eventId") || "").trim();
    if (cancelledEventIds.has(eventId)) continue;
    const idempotencyKey = String(value(row, "idempotencyKey") || "").trim();
    const directionId = String(value(row, "directionId") || "").trim();
    const positionId = String(value(row, "positionId") || "").trim();
    const article = String(value(row, "Артикул") || "").trim();
    const employee = String(value(row, "Сотрудник") || "").trim();
    const createdAt = String(value(row, "createdAt") || "").trim();
    const quantityValue = value(row, "Количество, шт");
    const quantity =
      typeof quantityValue === "number"
        ? quantityValue
        : Number(String(quantityValue || "").replace(",", "."));
    const errors = [];

    if (!eventId) errors.push("missing_event_id");
    if (!idempotencyKey) errors.push("missing_idempotency_key");
    if (directionId !== "ROLL") errors.push("wrong_direction");
    if (!positionId || !article) errors.push("missing_position");
    if (!Number.isSafeInteger(quantity) || quantity <= 0)
      errors.push("invalid_quantity");
    if (!Number.isFinite(Date.parse(createdAt))) errors.push("invalid_time");
    if (eventId && seenEventIds.has(eventId)) errors.push("duplicate_event_id");
    if (
      idempotencyKey &&
      seenIdempotencyKeys.has(idempotencyKey)
    )
      errors.push("duplicate_idempotency_key");

    if (eventId) seenEventIds.add(eventId);
    if (idempotencyKey) seenIdempotencyKeys.add(idempotencyKey);
    if (errors.length) {
      invalid.push({ shipmentId, positionId: positionId || null, errors });
      continue;
    }
    events.push({
      eventId,
      idempotencyKey,
      shipmentId,
      directionId,
      positionId,
      article,
      employee,
      quantity,
      createdAt: new Date(createdAt).toISOString(),
    });
  }

  return { events, invalid };
}

export function attachAssemblyPacking(printing, workLog, checkedAt) {
  const orders = printing.supplies || [];
  const activeShipmentIds = new Set(orders.filter(order => ["roll-printing", "box-printing"].includes(order.sourceId))
    .map(workShipmentId));
  const byPosition = new Map();
  const affectedShipments = new Set();
  const affectedPositions = new Set();
  let invalidRecords = 0;

  for (const issue of workLog.invalid || []) {
    if (!activeShipmentIds.has(issue.shipmentId)) continue;
    invalidRecords++;
    if (issue.positionId) affectedPositions.add(issue.positionId);
    else affectedShipments.add(issue.shipmentId);
  }

  const orderPositions = new Map();
  for (const order of orders) {
    if (!["roll-printing", "box-printing"].includes(order.sourceId)) continue;
    const key = workPositionId(order);
    orderPositions.set(key, order);
    byPosition.set(key, { quantity: 0, records: 0 });
  }

  let eventCount = 0;
  let sourceUpdatedAt = null;
  for (const event of workLog.events || []) {
    if (!activeShipmentIds.has(event.shipmentId)) continue;
    const order = orderPositions.get(event.positionId);
    if (!order || order.article !== event.article) {
      invalidRecords++;
      if (order) affectedPositions.add(event.positionId);
      else affectedShipments.add(event.shipmentId);
      continue;
    }
    const summary = byPosition.get(event.positionId);
    summary.quantity += event.quantity;
    summary.records++;
    eventCount++;
    if (!sourceUpdatedAt || Date.parse(event.createdAt) > Date.parse(sourceUpdatedAt))
      sourceUpdatedAt = event.createdAt;
  }

  const enrichedOrders = orders.map((order) => {
    if (!["roll-printing", "box-printing"].includes(order.sourceId)) return order;
    const shipmentId = workShipmentId(order);
    const positionId = workPositionId(order);
    if (
      affectedShipments.has(shipmentId) ||
      affectedPositions.has(positionId)
    )
      return { ...order, packed: null, packingRecords: null };
    const summary = byPosition.get(positionId);
    return {
      ...order,
      packed: summary?.quantity ?? 0,
      packingRecords: summary?.records ?? 0,
    };
  });

  return {
    ...printing,
    supplies: enrichedOrders,
    packing: sourceStatus(invalidRecords ? "partial" : "available", checkedAt, {
      sourceUpdatedAt,
      eventCount,
      invalidRecords,
      reason: invalidRecords
        ? "Часть записей WorkLog не удалось связать с артикулом. Для этих позиций точное количество скрыто."
        : null,
    }),
  };
}

export async function loadAssemblyPacking(
  reader,
  printing,
  { signal, checkedAt = new Date().toISOString() } = {},
) {
  try {
    const metadata = await reader.metadata(
      RITM_ASSEMBLY_WORKLOG.documentId,
      signal,
      5,
    );
    const workLog = metadata.sheets?.find(
      (sheet) =>
        sheet.properties?.sheetId === RITM_ASSEMBLY_WORKLOG.sheetId &&
        sheet.properties?.title === RITM_ASSEMBLY_WORKLOG.sheetName,
    );
    const rowCount = workLog?.properties?.gridProperties?.rowCount;
    const columnCount = workLog?.properties?.gridProperties?.columnCount;
    const corrections = metadata.sheets?.find((sheet) =>
      sheet.properties?.sheetId === RITM_ASSEMBLY_WORK_CORRECTIONS_GID &&
      sheet.properties?.title === RITM_ASSEMBLY_WORK_CORRECTIONS_SHEET);
    const correctionRows = corrections?.properties?.gridProperties?.rowCount;
    if (!corrections || !Number.isSafeInteger(correctionRows) || correctionRows < 1 ||
        correctionRows > RITM_ASSEMBLY_WORKLOG.maxRows ||
        corrections.properties.gridProperties.columnCount < 6)
      throw new Error("assembly_corrections_unavailable");
    if (
      metadata.spreadsheetId !== RITM_ASSEMBLY_WORKLOG.documentId ||
      !workLog ||
      !Number.isSafeInteger(rowCount) ||
      rowCount < 1 ||
      rowCount > RITM_ASSEMBLY_WORKLOG.maxRows ||
      !Number.isSafeInteger(columnCount) ||
      columnCount < 16
    )
      throw new Error("worklog_metadata_unavailable");

    const grid = await reader.grid(
      RITM_ASSEMBLY_WORKLOG.documentId,
      [
        `'${RITM_ASSEMBLY_WORKLOG.sheetName}'!A1:P${rowCount}`,
        `'${RITM_ASSEMBLY_WORK_CORRECTIONS_SHEET}'!A1:F${correctionRows}`,
      ],
      signal,
      5,
    );
    return attachAssemblyPacking(
      printing,
      readAssemblyPackingGrid(grid),
      checkedAt,
    );
  } catch (error) {
    const reason =
      String(error?.message || "").startsWith("assembly_corrections_")
        ? "Журнал отмен WorkLogCorrections недоступен или повреждён. Упаковка не пересчитана."
        : error?.message === "worklog_schema_changed"
        ? "Структура журнала упаковки изменилась; проверьте лист WorkLog."
        : "Журнал упаковки временно недоступен. Нажмите «Обновить» и повторите проверку.";
    return unavailableAssemblyPacking(printing, checkedAt, reason);
  }
}
