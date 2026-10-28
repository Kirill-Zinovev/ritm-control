import { CloudError } from "./access.js";

const UUID = /^[a-f0-9-]{36}$/i;
const SHIPMENT_ID = /^[a-z0-9._:-]{1,120}$/i;
const CONTROL_KINDS = new Set(["quality_check", "notification", "instruction"]);
const PRIORITIES = new Set(["attention", "urgent"]);
const TRIGGERS = new Set(["shipment_received", "before_packing", "before_box_close"]);
const SCOPES = new Set(["shipment", "article"]);
const STATES = new Set(["active", "completed", "acknowledged", "cancelled"]);
const fail = (code, message, status = 400) => { throw new CloudError(code, message, status); };
const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const articleKey = (value) => text(value, 80).toLocaleUpperCase("ru-RU").replace(/ё/g, "е");

function records(scope) {
  if (!scope?.operations || typeof scope.operations.values !== "function") return [];
  return [...scope.operations.values()]
    .filter((row) => row.kind === "production-control" && row.value && typeof row.value === "object")
    .map((row) => row.value);
}

function requireShipmentId(value) {
  const shipmentId = text(value, 120);
  if (!SHIPMENT_ID.test(shipmentId)) fail("control_shipment_invalid", "Не удалось связать правило с поставкой.");
  return shipmentId;
}

function requireShipmentIds(values, fallback = "") {
  const source = Array.isArray(values) ? values : fallback ? [fallback] : [];
  const ids = [...new Set(source.map(requireShipmentId))];
  if (!ids.length || ids.length > 20) fail("control_shipment_invalid", "Не удалось связать правило с поставкой.");
  return ids;
}

function normalizedInput(input) {
  const requestId = String(input?.requestId || "").trim();
  if (!UUID.test(requestId)) fail("control_request_invalid", "Не удалось подтвердить запрос. Обновите форму и повторите.");
  const shipmentIds = requireShipmentIds(input?.shipmentIds, input?.shipmentId);
  const shipmentId = shipmentIds[0];
  const scope = input?.scope;
  if (!SCOPES.has(scope)) fail("control_scope_invalid", "Выберите поставку или артикул.");
  const article = scope === "article" ? articleKey(input?.article) : "";
  if (scope === "article" && !article) fail("control_article_required", "Выберите артикул.");
  const kind = input?.kind;
  if (!CONTROL_KINDS.has(kind)) fail("control_kind_invalid", "Выберите тип задачи.");
  const priority = input?.priority;
  if (!PRIORITIES.has(priority)) fail("control_priority_invalid", "Выберите важность.");
  const trigger = input?.trigger;
  if (!TRIGGERS.has(trigger)) fail("control_trigger_invalid", "Выберите момент показа задачи.");
  const title = text(input?.title, 90);
  if (title.length < 3) fail("control_title_invalid", "Добавьте короткое название задачи.");
  const note = text(input?.note, 320);
  const shipmentName = text(input?.shipmentName, 100);
  if (!shipmentName) fail("control_shipment_name_invalid", "У поставки не найдено название.");
  return { requestId, shipmentId, shipmentIds, shipmentName, scope, article, kind, priority, trigger, title, note };
}

export function listProductionControls(scope, shipmentIds = "") {
  const selectedIds = Array.isArray(shipmentIds)
    ? shipmentIds.length ? requireShipmentIds(shipmentIds) : []
    : shipmentIds
      ? requireShipmentIds(String(shipmentIds).split(","))
      : [];
  return records(scope)
    .filter((row) => !selectedIds.length || (row.shipmentIds || [row.shipmentId]).some((id) => selectedIds.includes(id)))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export function createProductionControl(scope, input, { now = Date.now, owner = "" } = {}) {
  if (!scope?.lease) fail("control_lock_required", "Не удалось подтвердить сохранение. Повторите попытку.", 409);
  const clean = normalizedInput(input);
  const list = records(scope);
  const existing = list.find((row) => row.requestId === clean.requestId);
  if (existing) {
    const same = ["shipmentId", "scope", "article", "kind", "priority", "trigger", "title", "note"]
      .every((key) => existing[key] === clean[key]);
    const sameTargets = JSON.stringify(existing.shipmentIds || [existing.shipmentId]) === JSON.stringify(clean.shipmentIds);
    if (!same || !sameTargets) fail("control_request_conflict", "Номер запроса уже использован. Обновите страницу и повторите.", 409);
    return { control: structuredClone(existing), duplicate: true };
  }
  if (list.length >= 5000) fail("control_limit_reached", "Достигнут лимит истории задач RITM. Обратитесь к владельцу.", 409);
  const timestamp = new Date(now()).toISOString();
  const control = {
    id: clean.requestId,
    requestId: clean.requestId,
    shipmentId: clean.shipmentId,
    shipmentIds: clean.shipmentIds,
    shipmentName: clean.shipmentName,
    section: "assembly_packing",
    scope: clean.scope,
    article: clean.article || null,
    kind: clean.kind,
    priority: clean.priority,
    trigger: clean.trigger,
    title: clean.title,
    note: clean.note,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: text(owner, 120) || "RITM",
    completedAt: null,
    completedBy: null,
  };
  scope.putOperation("production-control", control);
  return { control: structuredClone(control), duplicate: false };
}

export function cancelProductionControl(scope, input, { now = Date.now } = {}) {
  if (!scope?.lease) fail("control_lock_required", "Не удалось подтвердить сохранение. Повторите попытку.", 409);
  const controlId = String(input?.controlId || "").trim();
  if (!UUID.test(controlId)) fail("control_id_invalid", "Задача не найдена. Обновите список.");
  const list = records(scope);
  const index = list.findIndex((row) => row.id === controlId);
  if (index < 0) fail("control_not_found", "Задача уже удалена или недоступна.", 404);
  const current = list[index];
  if (current.status === "cancelled") return { control: structuredClone(current), duplicate: true };
  if (current.status !== "active") fail("control_already_finished", "Завершённую задачу нельзя отменить.", 409);
  const next = { ...current, status: "cancelled", updatedAt: new Date(now()).toISOString() };
  list[index] = next;
  scope.putOperation("production-control", next);
  return { control: structuredClone(next), duplicate: false };
}

export function listAssemblyControls(scope, shipmentId) {
  const id = requireShipmentId(shipmentId);
  return records(scope)
    .filter((row) => (row.shipmentIds || [row.shipmentId]).includes(id) && row.section === "assembly_packing" && STATES.has(row.status) && row.status !== "cancelled")
    .sort((left, right) => (left.priority === "urgent" ? -1 : 1) - (right.priority === "urgent" ? -1 : 1) || String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(0, 250);
}

export function completeAssemblyControl(scope, input, { now = Date.now } = {}) {
  if (!scope?.lease) fail("control_lock_required", "Не удалось подтвердить отметку. Повторите попытку.", 409);
  const controlId = String(input?.controlId || "").trim();
  if (!UUID.test(controlId)) fail("control_id_invalid", "Задача не найдена. Обновите список.");
  const shipmentId = requireShipmentId(input?.shipmentId);
  const positionId = text(input?.positionId, 180);
  const article = articleKey(input?.article);
  const employeeId = text(input?.employeeId, 80);
  const employeeName = text(input?.employeeName, 100);
  if (!positionId || !article || !employeeId || !employeeName) fail("control_completion_invalid", "Не удалось проверить артикул или сотрудника.");
  const list = records(scope);
  const index = list.findIndex((row) => row.id === controlId);
  if (index < 0) fail("control_not_found", "Задача больше не найдена. Обновите данные.", 404);
  const current = list[index];
  if (!(current.shipmentIds || [current.shipmentId]).includes(shipmentId) || current.section !== "assembly_packing" || (current.scope === "article" && current.article !== article))
    fail("control_scope_mismatch", "Задача относится к другой поставке или артикулу.", 409);
  if (current.status === "completed" || current.status === "acknowledged") return { control: structuredClone(current), duplicate: true };
  if (current.status !== "active") fail("control_not_active", "Задача уже не активна.", 409);
  const timestamp = new Date(now()).toISOString();
  const next = {
    ...current,
    status: current.kind === "notification" ? "acknowledged" : "completed",
    updatedAt: timestamp,
    completedAt: timestamp,
    completedBy: { employeeId, employeeName, positionId, article },
  };
  list[index] = next;
  scope.putOperation("production-control", next);
  return { control: structuredClone(next), duplicate: false };
}
