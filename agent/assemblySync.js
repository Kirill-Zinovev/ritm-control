import { createHmac } from "node:crypto";
import { privateGoogleUrl } from "../worker/privateGoogleConfig.js";
import { supplyPersistence } from "./supplyPersistence.js";

export const ASSEMBLY_SYNC_URL = privateGoogleUrl("assemblyWebAppUrl");
const actions = new Set(["create", "append", "updateItem", "removeItem", "delete", "deletePart", "reconcile"]);
const confirmed = new Set(["verified", "verified_with_calculation_errors"]);

export class AssemblySyncQueue {
  constructor(store, { secret = "", fetchImpl = fetch, now = Date.now, beforeDeliver = null } = {}) {
    if (secret && !/^[a-f0-9]{64}$/i.test(secret)) throw new Error("Invalid Assembly sync key");
    Object.assign(this, { store, secret, fetchImpl, now, beforeDeliver });
    this.persistence = supplyPersistence(store);
    this.persistence.ensureSyncSchema();
    this.timer = null;
    this.current = null;
    this.stopped = false;
    this.controller = new AbortController();
  }
  enqueueTransfer(id, payload) {
    const serialized = JSON.stringify(payload), existing = this.persistence.syncEvent(id);
    if (existing && existing.payload !== serialized) throw new Error("Номер передачи уже использован для другого состава.");
    if (!existing) this.persistence.saveSyncEvent({ id, action: "transfer", created_at: this.now(), next_attempt_at: this.now(), attempts: 0, payload: serialized });
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.schedule(250);
  }
  enqueue(operation) {
    if (!operation || !confirmed.has(operation.status) || !actions.has(operation.action) || !/^[a-f0-9-]{36}$/i.test(operation.id || "")) return false;
    if (this.persistence.syncEvent(operation.id)) return false;
    this.persistence.saveSyncEvent({ id: operation.id, action: operation.action, created_at: this.now(), next_attempt_at: this.now(), attempts: 0 });
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.schedule(250);
    return true;
  }
  recoverConfirmed() {
    for (const operation of this.store.meta("productionSupplyOperations") || []) this.enqueue(operation);
    for (const operation of this.persistence.recoverableRollOperations()) this.enqueue(operation);
  }
  state() {
    const events = this.persistence.syncEvents();
    const delivered = events.filter((row) => row.delivered_at).sort((a, b) => b.delivered_at - a.delivered_at || b.created_at - a.created_at || b.id.localeCompare(a.id));
    return { configured: !!this.secret, pending: events.filter((row) => !row.delivered_at).length,
      lastDeliveredAt: delivered[0]?.delivered_at || null, lastDeliveredEventId: delivered[0]?.id || null };
  }
  start() { this.recoverConfirmed(); this.schedule(0); }
  schedule(delay) {
    if (this.stopped || !this.secret || this.timer || this.current) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => {
      this.store.log("assembly_sync_retry", "Передача в Assembly ожидает повторной проверки", null);
    }); }, delay);
    this.timer.unref?.();
  }
  async flush() {
    if (this.stopped || !this.secret || this.current) return this.current;
    this.current = this.deliver();
    try { await this.current; }
    finally {
      this.current = null;
      const next = this.persistence.syncEvents().filter((row) => !row.delivered_at).map((row) => row.next_attempt_at).sort((a, b) => a - b)[0];
      if (next !== undefined) this.schedule(Math.max(250, next - this.now()));
    }
  }
  async deliver() {
    let batch = this.persistence.syncEvents().filter((row) => !row.delivered_at && row.next_attempt_at <= this.now()).slice(0, 100);
    if (!batch.length) return;
    const transfer = batch[0].action === "transfer";
    batch = transfer ? batch.slice(0, 1) : batch.filter((row) => row.action !== "transfer");
    const event = { v: 1, eventId: batch.at(-1).id, action: transfer ? "transfer" : "reconcile", issuedAt: this.now(),
      ...(transfer ? { transfer: JSON.parse(batch[0].payload).transfer } : {}) };
    // Cloud scopes durably checkpoint the outbox and check cutover ownership
    // before invoking the unchanged, signed Assembly receiver.
    if (this.beforeDeliver) await this.beforeDeliver();
    const signature = createHmac("sha256", this.secret).update(JSON.stringify(event)).digest("hex");
    let accepted = false, conflict = false, receipt = null;
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(120000), this.controller.signal]);
      let response = await this.fetchImpl(ASSEMBLY_SYNC_URL, { method: "POST", redirect: "manual", signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ event, signature }) });
      if ([302, 303].includes(response.status)) {
        const location = new URL(response.headers.get("location") || "", ASSEMBLY_SYNC_URL);
        if (location.protocol !== "https:" || location.hostname !== "script.googleusercontent.com" || location.username || location.password) throw new Error("redirect_rejected");
        response = await this.fetchImpl(location.href, { method: "GET", redirect: "error", signal });
      }
      if (!response.ok) throw new Error("delivery_unavailable");
      const raw = await response.text();
      if (raw.length > 8192) throw new Error("invalid_receipt");
      receipt = JSON.parse(raw);
      accepted = receipt.ok === true && receipt.eventId === event.eventId && receipt.status === "synced";
      conflict = transfer && receipt.ok === false && receipt.eventId === event.eventId && receipt.status === "conflict";
    } catch { /* Retry an unknown delivery with the same event identity. */ }
    if (transfer && (accepted || conflict)) {
      this.persistence.saveSyncEvent({ ...batch[0], delivered_at: this.now(), attempts: batch[0].attempts + 1, last_error: null, outcome: conflict ? "conflict" : "synced",
        receipt: JSON.stringify({ name: typeof receipt.name === "string" ? receipt.name.slice(0, 100) : "", added: Number.isSafeInteger(receipt.added) ? receipt.added : null,
          existing: Number.isSafeInteger(receipt.existing) ? receipt.existing : null, message: conflict ? (typeof receipt.message === "string" && receipt.message.length <= 240 ? receipt.message : "Источник изменился или не прошёл проверку. Обновите состав и подготовьте новую передачу.") : "Состав подтверждён в Assembly." }) });
      return;
    }
    this.persistence.saveSyncEvents(batch.map((row) => ({ ...row, attempts: row.attempts + 1,
      ...(accepted ? { delivered_at: this.now(), last_error: null } : { next_attempt_at: this.now() + Math.min(300000, 5000 * 2 ** Math.min(row.attempts, 6)), last_error: "delivery_unconfirmed" }) })));
  }
  async stop() {
    this.stopped = true; clearTimeout(this.timer); this.controller.abort();
    if (this.current) await this.current;
  }
}
