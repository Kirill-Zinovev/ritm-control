import { CloudError } from "./access.js";
import {supplyDeliveryJob} from './assemblyV2Delivery.js';

const clone = (value) => value == null ? value : structuredClone(value);
const rows = (result) => result.results || [];
const MAX_RECORD_BYTES = 32000000;
const serialize = async (value) => {
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= 900000) return text;
  if (bytes.length > MAX_RECORD_BYTES) throw new CloudError("state_too_large", "План операции превышает безопасный объём. Запись остановлена до отправки в Google Sheets.");
  const packed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  let binary = "";
  for (let i = 0; i < packed.length; i += 16384) binary += String.fromCharCode(...packed.subarray(i, i + 16384));
  const result = JSON.stringify({ encoding: "ritm:gzip-json:v1", bytes: bytes.length, digest: await digest(text), data: btoa(binary) });
  if (result.length > 900000) throw new CloudError("state_too_large", "План операции превышает безопасный объём хранения. Запись остановлена до отправки в Google Sheets.");
  return result;
};

async function unpack(text) {
  const envelope = JSON.parse(text);
  if (envelope?.encoding !== "ritm:gzip-json:v1") return text;
  try {
    if (!Number.isSafeInteger(envelope.bytes) || envelope.bytes < 0 || envelope.bytes > MAX_RECORD_BYTES) throw new Error("size");
    const bytes = Uint8Array.from(atob(envelope.data), (c) => c.charCodeAt(0));
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const chunks = []; let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length;
        if (length > envelope.bytes) throw new Error("size");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const restored = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { restored.set(chunk, offset); offset += chunk.length; }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(restored);
    if (length !== envelope.bytes || await digest(decoded) !== envelope.digest) throw new Error("digest");
    return decoded;
  } catch { throw new CloudError("journal_corrupt", "Запись журнала не прошла проверку целостности. Повторная запись заблокирована."); }
}

// Synchronous domain methods operate only inside a leased, per-request unit of
// work. All external writes must checkpoint this journal before sending bytes.
// This preserves the existing production algorithms without emulating SQLite.
export class CloudScope {
  constructor(store, lease, data) {
    this.store = store;
    this.lease = lease;
    this.values = new Map(rows(data[0]).map((row) => [row.key, JSON.parse(row.value)]));
    this.operations = new Map(rows(data[1]).map((row) => [row.kind + ":" + row.id, { kind: row.kind, value: JSON.parse(row.payload), ordinal: row.ordinal, createdAt: row.created_at }]));
    this.operationOrdinal = Math.max(0, ...rows(data[1]).map((row) => row.ordinal));
    this.previews = new Map(rows(data[2]).map((row) => [row.id, row]));
    this.events = new Map(rows(data[3]).map((row) => [row.id, row]));
    this.dirtyValues = new Set();
    this.dirtyOperations = new Set();
    this.dirtyPreviews = new Set();
    this.dirtyEvents = new Set();
    this.logs = [];
  }
  meta(key, value) {
    if (key === "productionSupplyOperations") {
      if (arguments.length === 1) return [...this.operations.values()].filter((row) => row.kind === "production").map((row) => clone(row.value));
      // The domain saves the full history after changing one operation. Keep
      // unchanged rows out of the atomic checkpoint and Assembly delivery
      // outbox, while preserving the caller's order (including an old resume).
      const requested = new Set(value.map(operation => operation.id));
      let previousOrdinal = Number.NEGATIVE_INFINITY;
      for (const row of this.operations.values())
        if (row.kind === "production" && !requested.has(row.value.id))
          previousOrdinal = Math.max(previousOrdinal, row.ordinal);
      for (const operation of value) {
        const operationKey = "production:" + operation.id;
        const previous = this.operations.get(operationKey);
        if (!previous || previous.ordinal <= previousOrdinal || JSON.stringify(previous.value) !== JSON.stringify(operation))
          this.putOperation("production", operation);
        previousOrdinal = this.operations.get(operationKey).ordinal;
      }
      return;
    }
    if (arguments.length === 1) return clone(this.values.get(key));
    this.values.set(key, clone(value));
    this.dirtyValues.add(key);
  }
  putOperation(kind, operation) {
    const key = kind + ":" + operation.id;
    const createdAt = this.operations.get(key)?.createdAt || operation.createdAt || new Date(this.store.now()).toISOString();
    this.operations.delete(key);
    this.operations.set(key, { kind, value: clone(operation), ordinal: ++this.operationOrdinal, createdAt });
    this.dirtyOperations.add(key);
    if (["production", "roll", "production-department-move", "box-position-removal"].includes(kind) && ["verified", "verified_with_calculation_errors"].includes(operation.status))
      this.meta("productionSupplyRevision", this.store.now());
    return clone(operation);
  }
  productionSupplyOperations() {
    // Request-local history is read only to callers; writers save a cloned
    // selected operation. Do not clone every historical Sheets plan per read.
    return [...this.operations.values()].filter(row => row.kind === "production").map(row => row.value);
  }
  saveProductionSupplyOperation(operation) {
    return this.putOperation("production", operation);
  }
  rollSupplyOperation(id) { return clone(this.operations.get("roll:" + id)?.value) || null; }
  recentRollSupplyOperations(limit = 20) {
    return [...this.operations.values()].filter((row) => row.kind === "roll").map((row) => clone(row.value)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(100, limit));
  }
  beginRollSupplyOperation(id, action, requestHash, payload, at) {
    return this.rollSupplyOperation(id) || this.putOperation("roll", { id, action, requestHash, payload, status: "writing", createdAt: at, updatedAt: at, result: null });
  }
  updateRollSupplyOperation(id, status, result, at) {
    const operation = this.rollSupplyOperation(id);
    if (!operation) throw new CloudError("operation_missing", "Операция не найдена.", 404);
    return this.putOperation("roll", { ...operation, status, result: result || {}, updatedAt: at });
  }
  supplyWriteConflict(documentIds = []) {
    if ([...this.operations.values()].some((row) => row.kind === "roll" && ["writing", "checking", "uncertain", "written_unverified"].includes(row.value.status)))
      return "Предыдущая операция с поставкой требует сверки. Новая запись временно остановлена.";
    if (this.meta("migrationPendingWrites")?.some((row) => !row.documentId || documentIds.includes(row.documentId))) return "До включения записи нужно сверить незавершённые операции этой таблицы в прежнем RITM.";
    return null;
  }
  log(type, message, incidentId = null) { this.logs.push({ id: crypto.randomUUID(), at: this.store.now(), type, message, incidentId }); }
  transferPreview(id) { return clone(this.previews.get(id)) || null; }
  ensureSyncSchema() {} // Schema is provisioned only through migrations.
  ensureTransferSchema() {}
  recoverableRollOperations() { return [...this.operations.values()].filter((row) => row.kind === "roll" && ["verified", "verified_with_calculation_errors"].includes(row.value.status)).map((row) => clone(row.value)); }
  *assemblySyncOperations() {
    // Delivery needs identities and status, never the saved Sheets write plans.
    for (const row of this.operations.values()) if (["production", "roll"].includes(row.kind)) {
      const { id, action, status } = row.value;
      yield { id, action, status };
    }
  }
  saveSyncEvents(events) { for (const event of events) this.saveSyncEvent(event); }
  saveTransferPreview(id, expiresAt, payload) {
    this.previews.set(id, { id, expires_at: expiresAt, payload });
    this.dirtyPreviews.add(id);
  }
  expireTransferPreviews(before) {
    for (const [id, row] of this.previews) if (row.expires_at < before) { this.previews.delete(id); this.dirtyPreviews.add(id); }
  }
  syncEvent(id) { return clone(this.events.get(id)) || null; }
  syncEvents() { return [...this.events.values()].map(clone).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)); }
  saveSyncEvent(row) {
    const prior = this.events.get(row.id);
    if (prior?.payload && row.payload && prior.payload !== row.payload) {
      const before = JSON.parse(prior.payload), after = JSON.parse(row.payload);
      if (JSON.stringify([before.previewId, before.name, before.transfer]) !== JSON.stringify([after.previewId, after.name, after.transfer]))
        throw new CloudError("event_conflict", "ID синхронизации уже занят другим составом.", 409);
    }
    this.events.set(row.id, clone(row)); this.dirtyEvents.add(row.id);
  }
  async checkpoint() {
    if (!this.lease) throw new CloudError("lease_required", "Для изменения истории нужна блокировка.", 409);
    await this.store.checkpoint(this);
  }
}

export class CloudStore {
  constructor(db, { now = Date.now, leaseMs = 180000 } = {}) {
    if (!db?.prepare || !db?.batch) throw new CloudError("cloud_database_missing", "Облачное хранилище ещё не подключено.");
    this.db = db.withSession ? db.withSession("first-primary") : db;
    this.now = now; this.leaseMs = leaseMs;
  }
  async acquire(name = "production", requestedLeaseMs = this.leaseMs) {
    const owner = crypto.randomUUID(), at = this.now();
    const leaseMs = Number.isFinite(requestedLeaseMs)
      ? Math.max(1000, Math.min(this.leaseMs, requestedLeaseMs))
      : this.leaseMs;
    const row = await this.db.prepare("INSERT INTO cloud_leases(name,owner,expires_at,fence) VALUES(?,?,?,1) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at,fence=cloud_leases.fence+1 WHERE cloud_leases.expires_at<=? RETURNING fence").bind(name, owner, at + leaseMs, at).first();
    if (!row) throw new CloudError("cloud_operation_busy", "Другая операция ещё выполняется. Обновите её состояние.", 409);
    return { name, owner, fence: row.fence, ...(leaseMs === this.leaseMs ? {} : { leaseMs }) };
  }
  async release(lease) {
    await this.db.prepare("UPDATE cloud_leases SET expires_at=0 WHERE name=? AND owner=? AND fence=?").bind(lease.name, lease.owner, lease.fence).run();
  }
  async leaseIsActive(name = "production") {
    const row = await this.db.prepare("SELECT expires_at FROM cloud_leases WHERE name=?").bind(name).first();
    return Number(row?.expires_at) > this.now();
  }
  async productionSnapshotReadAllowed() {
    // Read both the lease and its delivery-only context in one DB snapshot.
    // A stale context cannot bless a later writer: owner and fence must match.
    const row = await this.db.prepare("SELECT l.owner,l.fence,l.expires_at,s.value AS delivery_context FROM cloud_leases l LEFT JOIN cloud_state s ON s.key='assemblyOutboxReadLease' WHERE l.name='production'").first();
    if (!row || Number(row.expires_at) <= this.now()) return true;
    try {
      const context = JSON.parse(row.delivery_context);
      return context?.version === 1 && context.sourceWrites === false
        && context.owner === row.owner && context.fence === row.fence;
    } catch { return false; }
  }
  async renew(lease) {
    const result = await this.db.prepare("UPDATE cloud_leases SET expires_at=? WHERE name=? AND owner=? AND fence=? AND expires_at>?").bind(this.now() + (lease.leaseMs || this.leaseMs), lease.name, lease.owner, lease.fence, this.now()).run();
    if (result.meta?.changes !== 1) throw new CloudError("cloud_lease_lost", "Операция потеряла блокировку. Нужна проверка результата.", 409);
  }
  async scope(lease = null) {
    const data = await this.db.batch([
      this.db.prepare("SELECT key,value FROM cloud_state"),
      this.db.prepare("SELECT kind,id,payload,ordinal,created_at FROM cloud_operations ORDER BY ordinal,created_at,id"),
      this.db.prepare("SELECT * FROM cloud_transfer_previews WHERE expires_at>? ").bind(this.now()),
      this.db.prepare("SELECT * FROM cloud_sync_events"),
    ]);
    for (const row of rows(data[0])) row.value = await unpack(row.value);
    for (const row of rows(data[1])) row.payload = await unpack(row.payload);
    return new CloudScope(this, lease, data);
  }
  async operationReadScope(kind, id = null) {
    const result = await this.db.prepare('SELECT kind,id,payload,ordinal,created_at FROM cloud_operations WHERE kind=?' + (id ? ' AND id=?' : '') + ' ORDER BY ordinal,created_at,id').bind(kind, ...(id ? [id] : [])).all();
    for (const row of rows(result)) row.payload = await unpack(row.payload);
    // Read-only status requests must not hydrate every historical write plan.
    return new CloudScope(this, null, [{results:[]}, result, {results:[]}, {results:[]}]);
  }
  async snapshotContext() {
    // Refresh only reads the registry, move guards and explicit transfer links.
    // Historical supply write plans and notification payloads can be much
    // larger than the report itself and do not belong in this read context.
    const data = await this.db.batch([
      this.db.prepare("SELECT key,value FROM cloud_state WHERE key IN ('migrationReady','printingMoveRevision','productionSupplyRevision','productionSupplies','rollPrintingAdditionalSheets','retiredProductionTabs')"),
      this.db.prepare("SELECT kind,id,payload,ordinal,created_at FROM cloud_operations WHERE kind IN ('production-department-move','box-position-removal') ORDER BY ordinal,created_at,id"),
      this.db.prepare("SELECT * FROM cloud_transfer_previews WHERE expires_at>?").bind(this.now()),
      this.db.prepare("SELECT * FROM cloud_sync_events WHERE action='transfer' AND outcome='synced' AND payload IS NOT NULL"),
    ]);
    for (const row of rows(data[0])) row.value = await unpack(row.value);
    for (const row of rows(data[1])) row.payload = await unpack(row.payload);
    return new CloudScope(this, null, data);
  }
  async assemblyFeedContext() {
    // A collector poll needs source identity and write guards, not warehouse,
    // notification, repair or historical Sheets write plans. Project plain
    // production journals in SQL; unpack old compressed rows one at a time.
    const data = await this.db.batch([
      this.db.prepare("SELECT key,value FROM cloud_state WHERE key IN ('migrationReady','printingMoveRevision','productionSupplyRevision','productionSupplies','productionPlanning')"),
      this.db.prepare(`SELECT kind,id,ordinal,created_at,
        CASE WHEN kind IN ('production','production-department-move') AND json_extract(payload,'$.encoding') IS NOT 'ritm:gzip-json:v1'
        THEN json_object('id',id,'status',json_extract(payload,'$.status'),'updatedAt',json_extract(payload,'$.updatedAt'),'createdAt',json_extract(payload,'$.createdAt'),
          'action',json_extract(payload,'$.action'),'name',json_extract(payload,'$.name'),'shipmentId',json_extract(payload,'$.shipmentId'),
          'manifest',json_extract(payload,'$.manifest'),'manifestBefore',json_extract(payload,'$.manifestBefore'))
        ELSE payload END payload FROM cloud_operations
        WHERE kind IN ('production','production-department-move','production-shipment-lock','assembly-only-item','box-position-removal','roll') ORDER BY ordinal,created_at,id`),
      this.db.prepare("SELECT * FROM cloud_transfer_previews WHERE 0"),
      this.db.prepare("SELECT * FROM cloud_sync_events WHERE action='transfer' AND outcome='synced' AND payload IS NOT NULL"),
      this.db.prepare("SELECT substr(id, length('box-position-removal:')+1) id FROM assembly_v2_supply_deliveries WHERE delivered_at IS NULL AND id LIKE 'box-position-removal:%'"),
    ]);
    for (const row of rows(data[0])) row.value = await unpack(row.value);
    for (const row of rows(data[1])) {
      const value = JSON.parse(await unpack(row.payload));
      row.payload = JSON.stringify(['production','production-department-move'].includes(row.kind)
        ? {id:value.id,status:value.status,updatedAt:value.updatedAt,createdAt:value.createdAt,
          action:value.action,name:value.name,shipmentId:value.shipmentId,
          manifest:value.manifest,manifestBefore:value.manifestBefore} : value);
    }
    const scope = new CloudScope(this, null, data);
    scope.boxRemovalsPendingDelivery = new Set(rows(data[4]).map(row => row.id));
    return scope;
  }
  // Each catalog preview has a new random ID and is immutable. It can be
  // inserted while a production writer is working on a different request.
  async withRoutingPreview(callback) {
    const empty = { results: [] };
    const scope = new CloudScope(this, null, [empty, empty, empty, empty]);
    const preview = await callback(scope);
    const row = scope.previews.get("production:" + preview.id);
    if (!row || scope.dirtyPreviews.size !== 1)
      throw new CloudError("preview_missing", "Не удалось сохранить проверенное распределение.");
    await this.db.prepare("INSERT INTO cloud_transfer_previews(id,expires_at,payload) VALUES(?,?,?)")
      .bind(row.id, row.expires_at, row.payload).run();
    return preview;
  }
  async withScope(callback, { waitMs = 0, reportAdmission = false, leaseName = "production", wait = (ms) => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    // Wait only before entering the unit of work. Never retry a callback that
    // may already have sent a production write.
    const deadline = this.now() + (Number.isFinite(waitMs) ? Math.max(0, Math.min(5000, waitMs)) : 0);
    let lease;
    for (;;) {
      try { lease = await this.acquire(leaseName); break; }
      catch (error) {
        const remaining = deadline - this.now();
        if (error.code !== 'cloud_operation_busy') throw error;
        if (remaining <= 0) {
          if (reportAdmission) throw new CloudError("supply_writer_occupied", "Запись ещё не началась. Сервер заканчивает другую операцию.", 409);
          throw error;
        }
        await wait(Math.min(500, remaining));
      }
    }
    try {
      const scope = await this.scope(lease);
      try { return await callback(scope); }
      finally { await scope.checkpoint(); }
    } finally { await this.release(lease); }
  }
  async checkpoint(scope) {
    const lease = scope.lease;
    await this.renew(lease);
    // Read/guard checkpoints still renew the lease, but have no state to write.
    // Do not issue an empty batch plus a second renewal before every Sheets call.
    if(scope.previewsPruned&&!scope.dirtyValues.size&&!scope.dirtyOperations.size&&!scope.dirtyPreviews.size&&!scope.dirtyEvents.size&&!scope.logs.length)return;
    const condition = "EXISTS(SELECT 1 FROM cloud_leases WHERE name=? AND owner=? AND fence=? AND expires_at>?)";
    const guarded = (sql, values) => this.db.prepare(sql.replace(/\{lease\}/g, condition)).bind(...values, lease.name, lease.owner, lease.fence, this.now());
    const statements = [];
    for (const key of scope.dirtyValues) statements.push(guarded("INSERT INTO cloud_state(key,value,updated_at) SELECT ?,?,? WHERE {lease} ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", [key, await serialize(scope.values.get(key)), this.now()]));
    for (const key of scope.dirtyOperations) {
      const { kind, value, ordinal, createdAt } = scope.operations.get(key);
      statements.push(guarded("INSERT INTO cloud_operations(kind,id,payload,created_at,ordinal) SELECT ?,?,?,?,? WHERE {lease} ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,ordinal=excluded.ordinal", [kind, value.id, await serialize(value), createdAt || value.createdAt || value.updatedAt || new Date(this.now()).toISOString(), ordinal]));
      if(['production','roll','production-department-move','production-shipment-lock','box-position-removal'].includes(kind)){
        const job=kind==='production-shipment-lock'
          ? (!value.deferDelivery && ['locked','unlocked'].includes(value.status) ? {id:'lock:'+value.eventId+':'+value.shipmentId,shipmentId:value.shipmentId,createdAt:Date.parse(value.changedAt)} : null)
          : supplyDeliveryJob(kind,value,this.now());
        if(job)statements.push(guarded('INSERT INTO assembly_v2_supply_deliveries(id,shipment_id,created_at) SELECT ?,?,? WHERE {lease} ON CONFLICT(id) DO NOTHING',[job.id,job.shipmentId,job.createdAt]));
      }
    }
    for (const id of scope.dirtyPreviews) {
      const row = scope.previews.get(id);
      statements.push(row
        ? guarded("INSERT INTO cloud_transfer_previews(id,expires_at,payload) SELECT ?,?,? WHERE {lease} ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at,payload=excluded.payload", [id, row.expires_at, row.payload])
        : guarded("DELETE FROM cloud_transfer_previews WHERE id=? AND {lease}", [id]));
    }
    for (const id of scope.dirtyEvents) {
      const row = scope.events.get(id);
      if(row.action==='transfer'&&row.delivered_at&&row.outcome==='synced')statements.push(guarded('INSERT INTO assembly_v2_supply_deliveries(id,shipment_id,created_at) SELECT ?,NULL,? WHERE {lease} ON CONFLICT(id) DO NOTHING',['transfer:'+row.id,this.now()]));
      statements.push(guarded("INSERT INTO cloud_sync_events(id,action,created_at,attempts,next_attempt_at,delivered_at,last_error,payload,outcome,receipt) SELECT ?,?,?,?,?,?,?,?,?,? WHERE {lease} ON CONFLICT(id) DO UPDATE SET attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,delivered_at=excluded.delivered_at,last_error=excluded.last_error,payload=excluded.payload,outcome=excluded.outcome,receipt=excluded.receipt", [row.id, row.action, row.created_at, row.attempts || 0, row.next_attempt_at, row.delivered_at ?? null, row.last_error ?? null, row.payload ?? null, row.outcome ?? null, row.receipt ?? null]));
    }
    for (const row of scope.logs) statements.push(guarded("INSERT INTO cloud_audit(id,at,type,message,incident_id) SELECT ?,?,?,?,? WHERE {lease}", [row.id, row.at, row.type, row.message, row.incidentId]));
    if (lease.name === "production")
      statements.push(guarded("DELETE FROM cloud_transfer_previews WHERE expires_at<=? AND {lease}", [this.now()]));
    if (statements.length) {
      if (statements.length > 90) throw new CloudError("checkpoint_too_large", "Обновление истории нужно разделить на этапы.");
      const result = await this.db.batch(statements);
      if (result.some((item) => item.success === false)) throw new CloudError("checkpoint_failed", "Не удалось подтвердить сохранение истории.");
      await this.renew(lease);
    }
    scope.dirtyValues.clear(); scope.dirtyOperations.clear(); scope.dirtyPreviews.clear(); scope.dirtyEvents.clear(); scope.logs = [];
    scope.previewsPruned=true;
  }
  async snapshot(kind) {
    const result = await this.db.prepare("SELECT s.updated_at,s.chunks,s.digest,c.ordinal,c.payload FROM cloud_snapshots s JOIN cloud_snapshot_chunks c ON c.kind=s.kind AND c.generation=s.generation WHERE s.kind=? ORDER BY c.ordinal").bind(kind).all();
    const data = rows(result);
    if (!data.length) return null;
    const text = data.map((row) => row.payload).join("");
    if (data.length !== data[0].chunks || await digest(text) !== data[0].digest) throw new CloudError("snapshot_corrupt", "Сохранённый снимок не прошёл проверку целостности.");
    return { at: data[0].updated_at, value: JSON.parse(text) };
  }
  async assemblySourceSnapshot() {
    const latest = await this.db.prepare("SELECT kind FROM cloud_snapshots WHERE kind IN ('printing','assembly-printing') ORDER BY updated_at DESC LIMIT 1").first();
    return latest ? this.snapshot(latest.kind) : null;
  }
  async snapshotInfo(kind) {
    return this.db.prepare("SELECT updated_at AS at FROM cloud_snapshots WHERE kind=?").bind(kind).first();
  }
  async latestProductionUpdate() {
    const row = await this.db.prepare("SELECT payload FROM cloud_operations WHERE kind='production' ORDER BY ordinal DESC LIMIT 1").first();
    if (!row) return 0;
    const operation = JSON.parse(await unpack(row.payload));
    return Date.parse(operation.updatedAt || operation.createdAt) || 0;
  }
  async readMeta(key) {
    const row=await this.db.prepare('SELECT value FROM cloud_state WHERE key=?').bind(key).first();
    return row?JSON.parse(await unpack(row.value)):null;
  }
  async readOperationsByKind(kind) {
    const result = await this.db.prepare('SELECT payload FROM cloud_operations WHERE kind=? ORDER BY ordinal,created_at,id').bind(kind).all();
    return Promise.all(rows(result).map(async row => JSON.parse(await unpack(row.payload))));
  }
  async saveSnapshot(kind, value, lease, capturedAt = this.now()) {
    await this.renew(lease);
    const text = JSON.stringify(value);
    if (text.length > 12000000) throw new CloudError("snapshot_too_large", "Снимок превышает разрешённый объём.");
    const generation = crypto.randomUUID(), chunks = [];
    for (let offset = 0; offset < text.length; offset += 200000) chunks.push(text.slice(offset, offset + 200000));
    const statements = chunks.map((payload, ordinal) => this.db.prepare("INSERT INTO cloud_snapshot_chunks(kind,generation,ordinal,payload) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM cloud_leases WHERE name=? AND owner=? AND fence=? AND expires_at>?)").bind(kind, generation, ordinal, payload, lease.name, lease.owner, lease.fence, this.now()));
    if (!Number.isFinite(capturedAt) || capturedAt > this.now() + 60000) throw new CloudError("snapshot_time_invalid", "Некорректное время снимка.");
    statements.push(this.db.prepare("INSERT INTO cloud_snapshots(kind,generation,updated_at,chunks,digest) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cloud_leases WHERE name=? AND owner=? AND fence=? AND expires_at>?) ON CONFLICT(kind) DO UPDATE SET generation=excluded.generation,updated_at=excluded.updated_at,chunks=excluded.chunks,digest=excluded.digest").bind(kind, generation, capturedAt, chunks.length, await digest(text), lease.name, lease.owner, lease.fence, this.now()));
    statements.push(this.db.prepare("DELETE FROM cloud_snapshot_chunks WHERE kind=? AND generation<>? AND EXISTS(SELECT 1 FROM cloud_snapshots WHERE kind=? AND generation=?)").bind(kind, generation, kind, generation));
    const result = await this.db.batch(statements);
    if (result.slice(0, -1).some((row) => row.meta?.changes !== 1)) throw new CloudError("snapshot_lease_lost", "Снимок не сохранён: обновление уже выполняет другой запрос.", 409);
  }
}

export async function digest(value) {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
