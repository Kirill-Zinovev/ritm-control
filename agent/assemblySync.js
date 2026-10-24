import { createHmac } from "node:crypto";
import { privateGoogleUrl } from "../worker/privateGoogleConfig.js";

export const ASSEMBLY_SYNC_URL = privateGoogleUrl("assemblyWebAppUrl");
const actions = new Set(["create", "append", "updateItem", "removeItem", "delete", "deletePart", "reconcile"]);
const confirmed = new Set(["verified", "verified_with_calculation_errors"]);

// An outbox, not a replay of production writes. Notifications only ask Assembly
// to reconcile its existing, marked mirror against authoritative source sheets.
export class AssemblySyncQueue {
  constructor(store, { secret = "", fetchImpl = fetch, now = Date.now } = {}) {
    if (secret && !/^[a-f0-9]{64}$/i.test(secret)) throw new Error("Invalid Assembly sync key");
    Object.assign(this, { store, secret, fetchImpl, now });
    this.timer = null;
    this.current = null;
    this.stopped = false;
    this.controller = new AbortController();
    store.db.exec(`CREATE TABLE IF NOT EXISTS assembly_sync_events (
      id TEXT PRIMARY KEY, action TEXT NOT NULL, created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
      delivered_at INTEGER, last_error TEXT
    )`);
    store.db.exec("CREATE INDEX IF NOT EXISTS assembly_sync_due ON assembly_sync_events(delivered_at,next_attempt_at)");
    const columns = new Set(store.db.prepare("PRAGMA table_info(assembly_sync_events)").all().map(row => row.name));
    for (const column of ["payload", "outcome", "receipt"]) if (!columns.has(column)) store.db.exec(`ALTER TABLE assembly_sync_events ADD COLUMN ${column} TEXT`);
  }
  enqueueTransfer(id, payload) {
    const serialized = JSON.stringify(payload), existing = this.store.db.prepare("SELECT payload FROM assembly_sync_events WHERE id=?").get(id);
    if (existing && existing.payload !== serialized) throw new Error("Номер передачи уже использован для другого состава.");
    this.store.db.prepare(`INSERT OR IGNORE INTO assembly_sync_events (id,action,created_at,next_attempt_at,payload) VALUES(?,'transfer',?,?,?)`)
      .run(id, this.now(), this.now(), serialized);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.schedule(250);
  }
  enqueue(operation) {
    if (!operation || !confirmed.has(operation.status) || !actions.has(operation.action) ||
        !/^[a-f0-9-]{36}$/i.test(operation.id || "")) return false;
    const changed = this.store.db.prepare(`INSERT OR IGNORE INTO assembly_sync_events
      (id,action,created_at,next_attempt_at) VALUES(?,?,?,?)`)
      .run(operation.id, operation.action, this.now(), this.now()).changes > 0;
    if (changed && this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (changed) this.schedule(250);
    return changed;
  }
  recoverConfirmed() {
    for (const operation of this.store.meta("productionSupplyOperations") || []) this.enqueue(operation);
    for (const operation of this.store.db.prepare(`SELECT id,action,status FROM roll_supply_operations
      WHERE status IN ('verified','verified_with_calculation_errors')
      AND id NOT IN (SELECT id FROM assembly_sync_events)`).all()) this.enqueue(operation);
  }
  state() {
    return { configured: !!this.secret,
      pending: this.store.db.prepare("SELECT count(*) AS n FROM assembly_sync_events WHERE delivered_at IS NULL").get().n,
      lastDeliveredAt: this.store.db.prepare("SELECT max(delivered_at) AS at FROM assembly_sync_events").get().at || null,
      lastDeliveredEventId: this.store.db.prepare("SELECT id FROM assembly_sync_events WHERE delivered_at IS NOT NULL ORDER BY delivered_at DESC,created_at DESC,id DESC LIMIT 1").get()?.id || null };
  }
  start() {
    this.recoverConfirmed();
    this.schedule(0);
  }
  schedule(delay) {
    if (!this.secret || this.stopped || this.timer || this.current) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => {
      this.store.log("assembly_sync_retry", "Передача в Assembly ожидает повторной проверки", null);
    }); }, delay);
    this.timer.unref?.();
  }
  async flush() {
    if (this.stopped || !this.secret) return;
    if (this.current) return this.current;
    this.current = this.deliver();
    try { await this.current; }
    finally {
      this.current = null;
      const next = this.store.db.prepare("SELECT min(next_attempt_at) AS at FROM assembly_sync_events WHERE delivered_at IS NULL").get().at;
      if (next !== null) this.schedule(Math.max(250, next - this.now()));
    }
  }
  async deliver() {
    let batch = this.store.db.prepare(`SELECT * FROM assembly_sync_events
      WHERE delivered_at IS NULL AND next_attempt_at<=? ORDER BY created_at,id LIMIT 100`).all(this.now());
    if (!batch.length) return;
    const transfer = batch[0].action === "transfer";
    batch = transfer ? batch.slice(0, 1) : batch.filter(row => row.action !== "transfer");
    const event = { v: 1, eventId: batch.at(-1).id, action: transfer ? "transfer" : "reconcile", issuedAt: this.now(),
      ...(transfer ? { transfer: JSON.parse(batch[0].payload).transfer } : {}) };
    const signature = createHmac("sha256", this.secret).update(JSON.stringify(event)).digest("hex");
    let accepted = false, conflict = false, receipt = null;
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(120_000), this.controller.signal]);
      let response = await this.fetchImpl(ASSEMBLY_SYNC_URL, { method: "POST", redirect: "manual", signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ event, signature }) });
      // ContentService redirects its result to Google's content host. Never
      // forward the signed POST body to a redirect target or an arbitrary host.
      if ([302, 303].includes(response.status)) {
        const location = new URL(response.headers.get("location") || "", ASSEMBLY_SYNC_URL);
        if (location.protocol !== "https:" || location.hostname !== "script.googleusercontent.com" || location.username || location.password)
          throw new Error("redirect_rejected");
        response = await this.fetchImpl(location.href, { method: "GET", redirect: "error", signal });
      }
      if (!response.ok) throw new Error("delivery_unavailable");
      const raw = await response.text();
      if (raw.length > 8192) throw new Error("invalid_receipt");
      receipt = JSON.parse(raw);
      accepted = receipt.ok === true && receipt.eventId === event.eventId && receipt.status === "synced";
      conflict = transfer && receipt.ok === false && receipt.eventId === event.eventId && receipt.status === "conflict";
    } catch { /* Unknown delivery is retried with the same event identity. */ }
    if (transfer && (accepted || conflict)) {
      this.store.db.prepare("UPDATE assembly_sync_events SET delivered_at=?,attempts=attempts+1,last_error=NULL,outcome=?,receipt=? WHERE id=? AND delivered_at IS NULL")
        .run(this.now(), conflict ? "conflict" : "synced", JSON.stringify({ name: typeof receipt.name === "string" ? receipt.name.slice(0, 100) : "", added: Number.isSafeInteger(receipt.added) ? receipt.added : null,
          existing: Number.isSafeInteger(receipt.existing) ? receipt.existing : null, message: conflict ? (typeof receipt.message === "string" && receipt.message.length <= 240 ? receipt.message : "Источник изменился или не прошёл проверку. Обновите состав и подготовьте новую передачу.") : "Состав подтверждён в Assembly." }), batch[0].id);
      return;
    }
    const update = accepted
      ? this.store.db.prepare("UPDATE assembly_sync_events SET delivered_at=?,attempts=attempts+1,last_error=NULL WHERE id=? AND delivered_at IS NULL")
      : this.store.db.prepare("UPDATE assembly_sync_events SET next_attempt_at=?,attempts=attempts+1,last_error='delivery_unconfirmed' WHERE id=? AND delivered_at IS NULL");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of batch) update.run(accepted ? this.now() : this.now() + Math.min(300_000, 5000 * 2 ** Math.min(item.attempts, 6)), item.id);
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller.abort();
    if (this.current) await this.current;
  }
}
