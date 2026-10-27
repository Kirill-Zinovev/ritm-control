import { CloudError } from "./access.js";
import { cloudConfig, sourceId } from "./config.js";
import { digest } from "./store.js";
import { ensureWarehouseDispatchSchema } from "./warehouseDispatch.js";
import { validateApi } from "../../agent/adapters.js";

const fail = (message) => { throw new CloudError("migration_rejected", message, 409); };
const uuid = /^[a-f0-9-]{36}$/i;
const text = (value) => {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > 900000) fail("Одна запись истории превышает разрешённый размер.");
  return serialized;
};

export async function validateMigration(envelope, bindings) {
  if (envelope?.format !== "ritm-sites-migration" || envelope.version !== 1 || !uuid.test(envelope.id || "") || !/^[a-f0-9]{64}$/.test(envelope.digest || "") || !envelope.payload) fail("Неизвестный формат снимка переноса.");
  const payload = envelope.payload;
  if (await digest(JSON.stringify(payload)) !== envelope.digest) fail("Контрольная сумма снимка не совпала.");
  for (const key of ["seasonalPrintingId", "rollPrintingId", "boxPrintingId", "catalogId", "fboSourceId", "assemblyDatabaseId"])
    if (!sourceId(bindings, key) || payload.sources?.[key] !== sourceId(bindings, key)) fail("Снимок относится к другому набору Google-таблиц.");
  if (!payload.metadata || Object.keys(payload.metadata).some((key) => !["productionSupplies", "productionSupplyOperations", "rollPrintingAdditionalSheets"].includes(key))) fail("Снимок содержит неподдерживаемые настройки.");
  for (const value of Object.values(payload.metadata)) if (!Array.isArray(value)) fail("Реестр поставок имеет неверный формат.");
  for (const key of ["rollOperations", "syncEvents", "transferPreviews", "pendingWrites", "snapshots"]) if (!Array.isArray(payload[key]) || payload[key].length > 100000) fail("Некорректный размер истории переноса.");
  const cartonDispatch = payload.warehouseCartonDispatch ?? [];
  if (!Array.isArray(cartonDispatch) || cartonDispatch.length > 100000) fail("Некорректный размер статусов коробов.");
  const cartonIds = new Set();
  for (const row of cartonDispatch) {
    if (!row || typeof row.cartonId !== "string" || !row.cartonId.trim() || row.cartonId.length > 160 || cartonIds.has(row.cartonId) || typeof row.shipmentId !== "string" || !row.shipmentId.trim() || !["sent", "pending"].includes(row.status) || !Number.isFinite(Date.parse(row.changedAt)) || typeof row.changedBy !== "string" || !row.changedBy.trim() || (row.sentAt !== null && row.sentAt !== undefined && !Number.isFinite(Date.parse(row.sentAt)))) fail("Обнаружен повреждённый статус короба.");
    cartonIds.add(row.cartonId); text(row);
  }
  const operations = [...(payload.metadata.productionSupplyOperations || []).map((value) => ({ kind: "production", value })), ...payload.rollOperations.map((value) => ({ kind: "roll", value }))];
  const identities = new Set();
  for (const row of operations) {
    const key = row.kind + ":" + row.value?.id;
    if (!uuid.test(row.value?.id || "") || identities.has(key) || typeof row.value.status !== "string") fail("Обнаружен повторный или повреждённый ID операции.");
    identities.add(key); text(row.value);
  }
  const eventIds = new Set();
  for (const row of payload.syncEvents) {
    if (!uuid.test(row.id || "") || eventIds.has(row.id) || !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.next_attempt_at) || !Number.isInteger(row.attempts) || row.attempts < 0 || typeof row.action !== "string") fail("Повреждена история синхронизации с Assembly.");
    if (row.payload) JSON.parse(row.payload);
    if (row.receipt) JSON.parse(row.receipt);
    eventIds.add(row.id); text(row);
  }
  const previewIds = new Set();
  for (const row of payload.transferPreviews) {
    if (!uuid.test(row.id || "") || previewIds.has(row.id) || !Number.isSafeInteger(row.expires_at) || typeof row.payload !== "string") fail("Повреждена история проверки состава.");
    JSON.parse(row.payload); previewIds.add(row.id); text(row);
  }
  const snapshotKinds = new Set();
  for (const row of payload.snapshots) {
    if (!["printing", "assembly"].includes(row.kind) || snapshotKinds.has(row.kind) || !Number.isFinite(Date.parse(row.at))) fail("Повреждён снимок рабочих показателей.");
    validateApi(row.value, row.kind); snapshotKinds.add(row.kind);
  }
  return operations;
}

export async function importMigration(envelope, bindings, store) {
  if (bindings.RITM_CLOUD_IMPORT_ENABLED !== "true" || cloudConfig(bindings).writesEnabled) fail("Импорт разрешён только до включения облачной записи.");
  const operations = await validateMigration(envelope, bindings);
  const previous = await store.db.prepare("SELECT manifest FROM cloud_imports WHERE source_digest=?").bind(envelope.digest).first();
  if (previous) return { ...JSON.parse(previous.manifest), repeated: true };
  const lease = await store.acquire();
  try {
    const completed = await store.db.prepare("SELECT manifest FROM cloud_imports WHERE source_digest=?").bind(envelope.digest).first();
    if (completed) return { ...JSON.parse(completed.manifest), repeated: true };
    let scope = await store.scope(lease);
    const marker = scope.meta("migrationImportDigest");
    if ((marker && marker !== envelope.digest) || scope.meta("migrationReady") || (!marker && (scope.operations.size || scope.events.size || scope.values.size))) fail("В облачном хранилище уже есть другое рабочее состояние. Оно не будет перезаписано.");
    scope.meta("migrationImportDigest", envelope.digest);
    scope.meta("migrationReady", false);
    await scope.checkpoint();
    const payload = envelope.payload;
    await ensureWarehouseDispatchSchema(store.db);
    const statements = [];
    const condition = "EXISTS(SELECT 1 FROM cloud_leases WHERE name=? AND owner=? AND fence=? AND expires_at>?)";
    const insert = (sql, values) => statements.push(store.db.prepare(sql.replace("{lease}", condition)).bind(...values, lease.name, lease.owner, lease.fence, store.now()));
    const state = { ...payload.metadata, migrationPendingWrites: payload.pendingWrites };
    delete state.productionSupplyOperations;
    for (const [key, value] of Object.entries(state)) insert("INSERT INTO cloud_state(key,value,updated_at) SELECT ?,?,? WHERE {lease} ON CONFLICT(key) DO NOTHING", [key, text(value), store.now()]);
    for (let ordinal = 0; ordinal < operations.length; ordinal++) {
      const { kind, value } = operations[ordinal];
      insert("INSERT INTO cloud_operations(kind,id,payload,created_at,ordinal) SELECT ?,?,?,?,? WHERE {lease} ON CONFLICT(kind,id) DO NOTHING", [kind, value.id, text(value), value.createdAt || value.updatedAt || envelope.createdAt, ordinal + 1]);
    }
    for (const row of payload.transferPreviews) insert("INSERT INTO cloud_transfer_previews(id,expires_at,payload) SELECT ?,?,? WHERE {lease} ON CONFLICT(id) DO NOTHING", [row.id, row.expires_at, row.payload]);
    for (const row of payload.syncEvents) insert("INSERT INTO cloud_sync_events(id,action,created_at,attempts,next_attempt_at,delivered_at,last_error,payload,outcome,receipt) SELECT ?,?,?,?,?,?,?,?,?,? WHERE {lease} ON CONFLICT(id) DO NOTHING", [row.id, row.action, row.created_at, row.attempts, row.next_attempt_at, row.delivered_at ?? null, row.last_error ?? null, row.payload ?? null, row.outcome ?? null, row.receipt ?? null]);
    for (const row of payload.warehouseCartonDispatch || []) insert("INSERT INTO ritm_warehouse_carton_dispatch(carton_id,shipment_id,is_sent,sent_at,changed_at,changed_by) SELECT ?,?,?,?,?,? WHERE {lease} ON CONFLICT(carton_id) DO NOTHING", [row.cartonId, row.shipmentId, row.status === "sent" ? 1 : 0, row.sentAt ? Date.parse(row.sentAt) : null, Date.parse(row.changedAt), row.changedBy]);
    for (let index = 0; index < statements.length; index += 80) {
      await store.renew(lease);
      await store.db.batch(statements.slice(index, index + 80));
    }
    // Read back every operation/event/registry key. Counts alone cannot detect
    // a changed payload carrying an existing ID after an interrupted import.
    scope = await store.scope(lease);
    for (const [key, value] of Object.entries(state)) if (JSON.stringify(scope.meta(key)) !== JSON.stringify(value)) fail("Реестр не совпал после переноса.");
    if (scope.operations.size !== operations.length || scope.events.size !== payload.syncEvents.length || scope.previews.size !== payload.transferPreviews.length) fail("Количество записей после переноса не совпало.");
    const dispatchExpected = payload.warehouseCartonDispatch || [];
    const dispatchResult = await store.db.prepare("SELECT carton_id,shipment_id,is_sent,sent_at,changed_at,changed_by FROM ritm_warehouse_carton_dispatch").all();
    const dispatchActual = new Map((dispatchResult.results || []).map((row) => [String(row.carton_id), row]));
    if (dispatchActual.size !== dispatchExpected.length) fail("Количество статусов коробов после переноса не совпало.");
    for (const row of dispatchExpected) {
      const actual = dispatchActual.get(row.cartonId);
      if (!actual || actual.shipment_id !== row.shipmentId || Number(actual.is_sent) !== (row.status === "sent" ? 1 : 0) || (actual.sent_at ?? null) !== (row.sentAt ? Date.parse(row.sentAt) : null) || actual.changed_at !== Date.parse(row.changedAt) || actual.changed_by !== row.changedBy) fail("Статус короба после переноса не совпал.");
    }
    for (const { kind, value } of operations) if (JSON.stringify(scope.operations.get(kind + ":" + value.id)?.value) !== JSON.stringify(value)) fail("Содержимое операции не совпало после переноса.");
    for (const row of payload.syncEvents) {
      const actual = scope.syncEvent(row.id);
      for (const key of ["id", "action", "created_at", "attempts", "next_attempt_at", "delivered_at", "last_error", "payload", "outcome", "receipt"]) if ((actual?.[key] ?? null) !== (row[key] ?? null)) fail("Содержимое события синхронизации не совпало после переноса.");
    }
    for (const row of payload.transferPreviews) if (scope.transferPreview(row.id)?.payload !== row.payload || scope.transferPreview(row.id)?.expires_at !== row.expires_at) fail("Проверенный состав не совпал после переноса.");
    for (const row of payload.snapshots) await store.saveSnapshot(row.kind, row.value, lease, Date.parse(row.at));
    const receipt = { ok: true, id: envelope.id, digest: envelope.digest, importedAt: new Date(store.now()).toISOString(), counts: { productionOperations: operations.filter((row) => row.kind === "production").length, rollOperations: payload.rollOperations.length, syncEvents: payload.syncEvents.length, transferPreviews: payload.transferPreviews.length, snapshots: payload.snapshots.length, warehouseCartonDispatch: dispatchExpected.length }, writesEnabled: false };
    await store.renew(lease);
    const guard = "EXISTS(SELECT 1 FROM cloud_leases WHERE name=? AND owner=? AND fence=? AND expires_at>?)";
    const fence = [lease.name, lease.owner, lease.fence, store.now()];
    const final = await store.db.batch([
      store.db.prepare("UPDATE cloud_state SET value='true',updated_at=? WHERE key='migrationReady' AND " + guard).bind(store.now(), ...fence),
      store.db.prepare("INSERT INTO cloud_imports(id,source_digest,imported_at,manifest) SELECT ?,?,?,? WHERE " + guard).bind(envelope.id, envelope.digest, store.now(), JSON.stringify(receipt), ...fence),
      store.db.prepare("INSERT INTO cloud_audit(id,at,type,message,incident_id) SELECT ?,?,'cloud_migration_verified','Импорт реестра и событий сверен по ID и содержимому.',NULL WHERE " + guard).bind(crypto.randomUUID(), store.now(), ...fence),
    ]);
    if (final.some((row) => row.meta?.changes !== 1)) fail("Подтверждение импорта не сохранено. Повторите проверку того же снимка.");
    return receipt;
  } finally { await store.release(lease); }
}
