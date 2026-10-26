import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { bridgeSignature, isOperationalRoute } from "../worker/cloud/bridge.js";

const fail = (code, message, status = 503) => { throw Object.assign(new Error(message), { code, status }); };
export class LocalCloudBridge {
  constructor({ baseUrl, id, secret, documentIds = [], fetcher = fetch, now = Date.now } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".chatgpt.site") || url.pathname !== "/" || url.search || url.hash || url.username || url.password || !/^[a-z0-9-]{1,80}$/.test(id || "") || !/^[a-f0-9]{64}$/i.test(secret || "")) throw new Error("Invalid RITM cloud bridge configuration");
    Object.assign(this, { baseUrl: url.origin, id, secret, documentIds, fetcher, now });
    this.repairContext = new AsyncLocalStorage();
  }
  supports(method, pathname) { return isOperationalRoute(method, pathname) && pathname !== "/api/cloud/bridge-lease"; }
  async request(path, { method = "GET", body } = {}) {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl || !isOperationalRoute(method, url.pathname)) fail("cloud_bridge_scope", "Этот запрос не входит в производственные функции облачного RITM.", 403);
    const serialized = body === undefined ? "" : JSON.stringify(body);
    if (Buffer.byteLength(serialized) > 180000) fail("cloud_bridge_body_too_large", "Слишком большой запрос.", 413);
    const timestamp = String(this.now()), nonce = randomUUID();
    let response;
    try {
      response = await this.fetcher(url.href, { method, redirect: "error", headers: {
        "content-type": "application/json", "x-ritm-bridge-id": this.id,
        "x-ritm-bridge-at": timestamp, "x-ritm-bridge-nonce": nonce,
        "x-ritm-bridge-signature": bridgeSignature(this.secret, { method, path: url.pathname + url.search, timestamp, nonce, body: serialized }),
      }, ...(serialized ? { body: serialized } : {}), signal: AbortSignal.timeout(120000) });
    } catch { fail("cloud_bridge_unavailable", "Облачный RITM не подтвердил ответ. Проверьте состояние операции перед повтором."); }
    if (!response.headers.get("content-type")?.includes("application/json")) fail("cloud_bridge_invalid_response", "Облачный RITM вернул неподтверждённый ответ. Повторная запись не выполнялась.");
    const text = await response.text();
    if (text.length > 12000000) fail("cloud_bridge_response_too_large", "Ответ облачного RITM превышает разрешённый размер.");
    let value;
    try { value = JSON.parse(text); } catch { fail("cloud_bridge_invalid_response", "Не удалось подтвердить ответ облачного RITM."); }
    return { status: response.status, value };
  }
  async value(path, options) {
    const response = await this.request(path, options);
    if (response.status >= 400 || response.value.ok === false) fail(response.value.error || "cloud_bridge_failed", response.value.message || "Облачная операция не выполнена.", response.status);
    return response.value;
  }
  async mirrorRegistry(store) {
    const value = await this.value("/api/cloud/registry");
    if (!Array.isArray(value.registeredSheets) || !Array.isArray(value.productionSupplies) || !Array.isArray(value.assemblyBoxLinks) || value.registeredSheets.some((row) => !Number.isSafeInteger(row.gid) || typeof row.name !== "string") || value.productionSupplies.some((supply) => !Array.isArray(supply.parts) || supply.parts.some((part) => !this.documentIds.includes(part.documentId))))
      fail("cloud_registry_invalid", "Реестр облачного RITM не прошёл проверку.");
    store.meta("rollPrintingAdditionalSheets", value.registeredSheets);
    store.meta("productionSupplies", value.productionSupplies);
    store.meta("cloudAssemblyBoxLinks", value.assemblyBoxLinks);
    store.meta("cloudRegistryCheckedAt", new Date(this.now()).toISOString());
  }
  async coordinateRepair({ operationId, table, outcome }, task) {
    return this.repairContext.run({ operationId, table, outcome, lease: null, leaseLost: false, pulse: null }, async () => {
      const context = this.repairContext.getStore();
      try { return await task(); }
      finally {
        if (context.pulse) clearInterval(context.pulse);
        if (context.lease) {
          try { await this.value("/api/cloud/bridge-lease", { method: "POST", body: { action: "release", operationId, table, lease: context.lease, outcome: outcome() } }); }
          catch { /* The persistent cloud marker blocks conflicting work until reconciliation. */ }
        }
      }
    });
  }
  async beforeLocalWrite(documentId) {
    if (!this.documentIds.includes(documentId)) return;
    const context = this.repairContext.getStore();
    if (!context || context.leaseLost) fail("write_rejected", "Связь исправления с облачным RITM не подтверждена. Запись не отправлена.", 409);
    if (!context.lease) {
      try {
        const result = await this.value("/api/cloud/bridge-lease", { method: "POST", body: { action: "acquire", operationId: context.operationId, table: context.table, documentId } });
        context.lease = result.lease;
      } catch { fail("write_rejected", "Облачный RITM занят или не подтвердил блокировку таблицы. Запись не отправлена.", 409); }
      context.documentId = documentId;
      context.pulse = setInterval(() => {
        void this.value("/api/cloud/bridge-lease", { method: "POST", body: { action: "renew", operationId: context.operationId, table: context.table, lease: context.lease } }).catch(() => { context.leaseLost = true; });
      }, 15000);
      context.pulse.unref?.();
    }
    if (context.documentId !== documentId) fail("write_rejected", "Исправление не может менять другую таблицу под прежней блокировкой.", 409);
    // Never rely solely on a past heartbeat before sending an external write.
    try {
      await this.value("/api/cloud/bridge-lease", { method: "POST", body: { action: "renew", operationId: context.operationId, table: context.table, lease: context.lease } });
    } catch {
      context.leaseLost = true;
      fail("write_rejected", "Блокировка таблицы больше не подтверждена. Запись не отправлена.", 409);
    }
  }
  async reconcileRepairs(store) {
    const result = await this.value("/api/cloud/bridge-lease");
    for (const record of result.operations || []) {
      const outcome = localRepairOutcome(store, record.table, record.operationId);
      if (outcome !== "uncertain") await this.value("/api/cloud/bridge-lease", { method: "POST", body: { action: "release", operationId: record.operationId, table: record.table, lease: record.lease, outcome } });
    }
  }
}

export function localRepairOutcome(store, table, id) {
  if (!["test_repair_proposals", "source_recovery_operations"].includes(table)) return "uncertain";
  const row = store.db.prepare(`SELECT status,result FROM ${table} WHERE id=?`).get(id);
  if (!row) return "uncertain";
  let result = {};
  try { result = JSON.parse(row.result || "{}"); } catch {}
  if (["verified", "already_restored"].includes(row.status) || (table === "test_repair_proposals" && row.status === "checking" && result.after && result.api)) return "verified";
  if (["cancelled", "blocked", "needs_review"].includes(row.status) && (result.errorCode === "write_rejected" || result.code === "write_rejected" || result.error?.code === "write_rejected")) return "not_written";
  return "uncertain";
}
