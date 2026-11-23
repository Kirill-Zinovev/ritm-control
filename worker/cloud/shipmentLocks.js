import { CloudError } from "./access.js";

const KIND = "production-shipment-lock";
const SHIPMENT_ID = /^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i;
const UUID = /^[a-f0-9-]{36}$/i;
const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const fail = (code, message, status = 400) => { throw new CloudError(code, message, status); };

function recordFor(scope, shipmentId) {
  const row = scope.operations.get(`${KIND}:${shipmentId}`)?.value;
  return row && typeof row === "object" ? row : null;
}

export function normalizeShipmentIds(values) {
  if (!Array.isArray(values)) fail("shipment_lock_ids_invalid", "Выберите поставку для управления замком.");
  const ids = [...new Set(values.map((value) => text(value, 120)))];
  if (!ids.length || ids.length > 20 || ids.some((id) => !SHIPMENT_ID.test(id)))
    fail("shipment_lock_ids_invalid", "Не удалось подтвердить выбранную поставку.");
  return ids;
}

export function activeShipmentIds(printing) {
  if (printing?.ok !== true || !Array.isArray(printing.sheets)) return null;
  const ids = new Set();
  for (const sheet of printing.sheets) {
    const source = text(sheet?.sourceId, 40);
    if (source !== "roll-printing" && source !== "box-printing") continue;
    const sheetId = Number(sheet?.sheetId);
    if (!Number.isSafeInteger(sheetId) || sheetId <= 0) return null;
    const id = text(sheet.assemblyShipmentId, 120) || `RITM-${source === "roll-printing" ? "ROLL" : "BOX"}-${sheetId}`;
    if (!SHIPMENT_ID.test(id)) return null;
    ids.add(id);
  }
  return ids;
}

function isLocked(record) {
  return !!record && record.status !== "unlocked";
}

const supplyPrefix = "RITM-SUPPLY-";

export function shipmentLock(scope, shipmentId) {
  const canonical = recordFor(scope, shipmentId);
  const operationId = shipmentId.startsWith(supplyPrefix) ? shipmentId.slice(supplyPrefix.length) : null;
  // Earlier creations stored the lock on each physical sheet.
  const inherited = !canonical && operationId ? [...scope.operations.values()]
    .filter(row => row.kind === KIND && row.value?.sourceOperationId === operationId && isLocked(row.value))
    .map(row => row.value)
    .sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)))[0] : null;
  const record = canonical || inherited;
  const status = record?.status || "unlocked";
  return {
    shipmentId,
    locked: isLocked(record),
    status,
    pending: status === "locking" || status === "unlocking",
    changedAt: record?.changedAt || null,
    changedBy: record?.changedBy || null,
    eventId: record?.eventId || null,
    name: record?.name || null,
  };
}

export function listShipmentLocks(scope, shipmentIds = []) {
  const ids = Array.isArray(shipmentIds) ? shipmentIds : [];
  if (ids.length > 20) fail("shipment_lock_ids_invalid", "Слишком много выбранных поставок.");
  const clean = [...new Set(ids.map((value) => text(value, 120)))];
  if (clean.some((id) => !SHIPMENT_ID.test(id))) fail("shipment_lock_ids_invalid", "Не удалось подтвердить выбранную поставку.");
  const recorded = [...scope.operations.values()].filter(row => row.kind === KIND && row.value);
  const activeSupplies = new Set((scope.meta?.("productionSupplies") || []).map(row => row.id));
  const recordedIds = recorded.flatMap(({value}) => {
    const canonicalId = supplyPrefix + value.sourceOperationId;
    return value.sourceOperationId && activeSupplies.has(canonicalId) ? [value.shipmentId, canonicalId] : [value.shipmentId];
  });
  const selected = (clean.length ? clean : [...new Set(recordedIds)]).map(id => shipmentLock(scope, id));
  return selected.sort((a, b) => a.shipmentId.localeCompare(b.shipmentId));
}

export async function setShipmentLocks(scope, {
  shipmentIds,
  locked,
  requestId = "",
  name = "",
  changedBy = "RITM",
  sourceOperationId = null,
  now = Date.now,
}) {
  if (!scope?.lease) fail("shipment_lock_lease_required", "Не удалось подтвердить изменение замка. Повторите попытку.", 409);
  if (typeof locked !== "boolean") fail("shipment_lock_action_invalid", "Выберите, закрыть или открыть поставку.");
  const ids = normalizeShipmentIds(shipmentIds);
  const cleanRequestId = text(requestId, 36);
  if (cleanRequestId && !UUID.test(cleanRequestId)) fail("shipment_lock_request_invalid", "Обновите страницу и повторите изменение замка.");

  const current = ids.map((shipmentId) => recordFor(scope, shipmentId));
  const pending = current.filter((row) => row && ["locking", "unlocking"].includes(row.status));
  if (pending.length) {
    const pendingIds = new Set(pending.map((row) => row.eventId));
    if (pending.some((row) => row.targetLocked !== locked) || pendingIds.size !== 1 || current.some((row) => row && !pending.includes(row) && row.status !== (locked ? "locked" : "unlocked")))
      fail("shipment_lock_pending", "Предыдущее изменение замка ещё подтверждается. Сначала обновите его состояние.", 409);
  }
  if (!pending.length && current.every((row) => row?.status === (locked ? "locked" : "unlocked"))) {
    return { confirmed: true, unchanged: true, shipmentIds: ids, locks: ids.map((id) => shipmentLock(scope, id)) };
  }

  const eventId = pending[0]?.eventId || cleanRequestId || crypto.randomUUID();
  const nowValue = Math.max(now(), ...ids.map(id => (Date.parse(shipmentLock(scope, id).changedAt) || 0) + 1));
  const shipmentName = text(name, 100) || current.find(Boolean)?.name || "";
  const actor = text(changedBy, 100) || "RITM";
  const priorRequest = cleanRequestId
    ? [...scope.operations.values()].find((row) => row.kind === KIND && row.value?.eventId === cleanRequestId)
    : null;
  if (priorRequest && (priorRequest.value.targetLocked !== locked || JSON.stringify(priorRequest.value.shipmentIds) !== JSON.stringify(ids)))
    fail("shipment_lock_request_conflict", "Этот запрос уже использован для другого замка.", 409);

  for (const shipmentId of ids) {
    const previous = recordFor(scope, shipmentId);
    scope.putOperation(KIND, {
      id: shipmentId,
      shipmentId,
      shipmentIds: ids,
      name: shipmentName || previous?.name || "",
      status: locked ? "locked" : "unlocked",
      targetLocked: locked,
      eventId,
      requestId: cleanRequestId || previous?.requestId || eventId,
      sourceOperationId: sourceOperationId || previous?.sourceOperationId || null,
      deferDelivery: Boolean(sourceOperationId),
      changedAt: new Date(nowValue).toISOString(),
      confirmedAt: new Date(nowValue).toISOString(),
      changedBy: actor,
    });
  }
  await scope.checkpoint();

  return { confirmed: true, unchanged: false, shipmentIds: ids, locks: ids.map((id) => shipmentLock(scope, id)) };
}
