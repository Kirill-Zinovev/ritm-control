import { CloudError } from "./access.js";

const clone = (value) => value == null ? value : structuredClone(value);
const rows = (result) => result.results || [];
const serialize = (value) => {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > 900000) throw new CloudError("state_too_large", "История операции требует архивирования перед продолжением.");
  return text;
};

// Synchronous domain methods operate only inside a leased, per-request unit of
// work. All external writes must checkpoint this journal before sending bytes.
// This preserves the existing production algorithms without emulating SQLite.
export class CloudScope {
  constructor(store, lease, data) {
    this.store = store;
    this.lease = lease;
    this.values = new Map(rows(data[0]).map((row) => [row.key, JSON.parse(row.value)]));
    this.operations = new Map(rows(data[1]).map((row) => [row.kind + ":" + row.id, { kind: row.kind, value: JSON.parse(row.payload), ordinal: row.ordinal }]));
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
      for (const operation of value) this.putOperation("production", operation);
      return;
    }
    if (arguments.length === 1) return clone(this.values.get(key));
    this.values.set(key, clone(value));
    this.dirtyValues.add(key);
  }
  putOperation(kind, operation) {
    const key = kind + ":" + operation.id;
    this.operations.delete(key);
    this.operations.set(key, { kind, value: clone(operation), ordinal: ++this.operationOrdinal });
    this.dirtyOperations.add(key);
    return clone(operation);
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
  async acquire(name = "production") {
    const owner = crypto.randomUUID(), at = this.now();
    const row = await this.db.prepare("INSERT INTO cloud_leases(name,owner,expires_at,fence) VALUES(?,?,?,1) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at,fence=cloud_leases.fence+1 WHERE cloud_leases.expires_at<=? RETURNING fence").bind(name, owner, at + this.leaseMs, at).first();
    if (!row) throw new CloudError("cloud_operation_busy", "Другая операция ещё выполняется. Обновите её состояние.", 409);
    return { name, owner, fence: row.fence };
  }
  async release(lease) {
    await this.db.prepare("UPDATE cloud_leases SET expires_at=0 WHERE name=? AND owner=? AND fence=?").bind(lease.name, lease.owner, lease.fence).run();
  }
  async renew(lease) {
    const result = await this.db.prepare("UPDATE cloud_leases SET expires_at=? WHERE name=? AND owner=? AND fence=? AND expires_at>?").bind(this.now() + this.leaseMs, lease.name, lease.owner, lease.fence, this.now()).run();
    if (result.meta?.changes !== 1) throw new CloudError("cloud_lease_lost", "Операция потеряла блокировку. Нужна проверка результата.", 409);
  }
  async scope(lease = null) {
    const data = await this.db.batch([
      this.db.prepare("SELECT key,value FROM cloud_state"),
      this.db.prepare("SELECT kind,id,payload,ordinal FROM cloud_operations ORDER BY ordinal,created_at,id"),
      this.db.prepare("SELECT * FROM cloud_transfer_previews"),
      this.db.prepare("SELECT * FROM cloud_sync_events"),
    ]);
    return new CloudScope(this, lease, data);
  }
  async withScope(callback) {
    const lease = await this.acquire();
    try {
      const scope = await this.scope(lease);
      try { return await callback(scope); }
      finally { await scope.checkpoint(); }
    } finally { await this.release(lease); }
  }
  async checkpoint(scope) {
    const lease = scope.lease;
    await this.renew(lease);
    const condition = "EXISTS(SELECT 1 FROM cloud_leases WHERE name=? AND owner=? AND fence=? AND expires_at>?)";
    const guarded = (sql, values) => this.db.prepare(sql.replace(/\{lease\}/g, condition)).bind(...values, lease.name, lease.owner, lease.fence, this.now());
    const statements = [];
    for (const key of scope.dirtyValues) statements.push(guarded("INSERT INTO cloud_state(key,value,updated_at) SELECT ?,?,? WHERE {lease} ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", [key, serialize(scope.values.get(key)), this.now()]));
    for (const key of scope.dirtyOperations) {
      const { kind, value, ordinal } = scope.operations.get(key);
      statements.push(guarded("INSERT INTO cloud_operations(kind,id,payload,created_at,ordinal) SELECT ?,?,?,?,? WHERE {lease} ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,ordinal=excluded.ordinal", [kind, value.id, serialize(value), value.createdAt || value.updatedAt || new Date(this.now()).toISOString(), ordinal]));
    }
    for (const id of scope.dirtyPreviews) {
      const row = scope.previews.get(id);
      statements.push(row
        ? guarded("INSERT INTO cloud_transfer_previews(id,expires_at,payload) SELECT ?,?,? WHERE {lease} ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at,payload=excluded.payload", [id, row.expires_at, row.payload])
        : guarded("DELETE FROM cloud_transfer_previews WHERE id=? AND {lease}", [id]));
    }
    for (const id of scope.dirtyEvents) {
      const row = scope.events.get(id);
      statements.push(guarded("INSERT INTO cloud_sync_events(id,action,created_at,attempts,next_attempt_at,delivered_at,last_error,payload,outcome,receipt) SELECT ?,?,?,?,?,?,?,?,?,? WHERE {lease} ON CONFLICT(id) DO UPDATE SET attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,delivered_at=excluded.delivered_at,last_error=excluded.last_error,payload=excluded.payload,outcome=excluded.outcome,receipt=excluded.receipt", [row.id, row.action, row.created_at, row.attempts || 0, row.next_attempt_at, row.delivered_at ?? null, row.last_error ?? null, row.payload ?? null, row.outcome ?? null, row.receipt ?? null]));
    }
    for (const row of scope.logs) statements.push(guarded("INSERT INTO cloud_audit(id,at,type,message,incident_id) SELECT ?,?,?,?,? WHERE {lease}", [row.id, row.at, row.type, row.message, row.incidentId]));
    if (statements.length) {
      if (statements.length > 90) throw new CloudError("checkpoint_too_large", "Обновление истории нужно разделить на этапы.");
      const result = await this.db.batch(statements);
      if (result.some((item) => item.success === false)) throw new CloudError("checkpoint_failed", "Не удалось подтвердить сохранение истории.");
      await this.renew(lease);
    }
    scope.dirtyValues.clear(); scope.dirtyOperations.clear(); scope.dirtyPreviews.clear(); scope.dirtyEvents.clear(); scope.logs = [];
  }
  async snapshot(kind) {
    const result = await this.db.prepare("SELECT s.updated_at,s.chunks,s.digest,c.ordinal,c.payload FROM cloud_snapshots s JOIN cloud_snapshot_chunks c ON c.kind=s.kind AND c.generation=s.generation WHERE s.kind=? ORDER BY c.ordinal").bind(kind).all();
    const data = rows(result);
    if (!data.length) return null;
    const text = data.map((row) => row.payload).join("");
    if (data.length !== data[0].chunks || await digest(text) !== data[0].digest) throw new CloudError("snapshot_corrupt", "Сохранённый снимок не прошёл проверку целостности.");
    return { at: data[0].updated_at, value: JSON.parse(text) };
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
