import { CloudError } from "./access.js";
import { cloudConfig } from "./config.js";
import { requireCutover } from "./services.js";

export async function externalLease(request, input, bridgeId, bindings, store) {
  if (!bridgeId) throw new CloudError("bridge_required", "Этот канал предназначен только для локального AI Center.", 403);
  if (request.method === "GET") {
    const scope = await store.scope();
    return { ok: true, operations: (scope.meta("externalRepairs") || []).filter((row) => row.bridgeId === bridgeId && ["writing", "uncertain"].includes(row.status)) };
  }
  const table = input?.table, operationId = input?.operationId;
  if (!["test_repair_proposals", "source_recovery_operations"].includes(table) || !/^[a-f0-9-]{36}$/i.test(operationId || "") || !["acquire", "renew", "release"].includes(input.action))
    throw new CloudError("invalid_repair_lease", "Некорректный запрос блокировки исправления.", 400);
  if (input.action === "acquire") {
    if (!cloudConfig(bindings).writableSources.includes(input.documentId)) throw new CloudError("repair_source_forbidden", "Этот источник не управляется облачным RITM.", 403);
    const lease = await store.acquire();
    try {
      const scope = await store.scope(lease);
      requireCutover(bindings, scope);
      if (scope.supplyWriteConflict(cloudConfig(bindings).writableSources) || (scope.meta("productionSupplyOperations") || []).some((row) => row.status !== "verified"))
        throw new CloudError("supply_operation_pending", "Сначала нужно завершить сверку операции с поставкой.", 409);
      const records = scope.meta("externalRepairs") || [];
      const existing = records.find((row) => row.table === table && row.operationId === operationId);
      if (existing) throw new CloudError("repair_lease_exists", "Эта операция уже зарегистрирована. Нужна сверка результата.", 409);
      records.push({ bridgeId, operationId, table, documentId: input.documentId, status: "writing", lease, startedAt: new Date(store.now()).toISOString() });
      scope.meta("externalRepairs", records); await scope.checkpoint();
      return { ok: true, lease };
    } catch (error) { await store.release(lease); throw error; }
  }
  const scope = await store.scope();
  const record = (scope.meta("externalRepairs") || []).find((row) => row.bridgeId === bridgeId && row.table === table && row.operationId === operationId);
  if (!record || JSON.stringify(record.lease) !== JSON.stringify(input.lease)) throw new CloudError("repair_lease_mismatch", "Блокировка исправления не совпала.", 403);
  if (input.action === "renew") { await store.renew(record.lease); return { ok: true }; }
  if (!["verified", "not_written", "uncertain"].includes(input.outcome)) throw new CloudError("repair_outcome_invalid", "Результат исправления не подтверждён.", 400);
  let lease = record.lease;
  try { await store.renew(lease); }
  catch { lease = await store.acquire(); }
  try {
    const current = await store.scope(lease);
    const records = current.meta("externalRepairs") || [];
    const item = records.find((row) => row.bridgeId === bridgeId && row.table === table && row.operationId === operationId);
    if (!item || JSON.stringify(item.lease) !== JSON.stringify(input.lease)) throw new CloudError("repair_lease_mismatch", "Запись исправления изменилась.", 409);
    item.status = input.outcome; item.finishedAt = new Date(store.now()).toISOString();
    current.meta("externalRepairs", records); await current.checkpoint();
    return { ok: true, status: item.status };
  } finally { await store.release(lease); }
}
