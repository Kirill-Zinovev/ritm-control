import { RollSupplyManagementService } from "../../agent/rollSupply.js";
import { ProductionSupplyService, ProductionSupplyWriter, DEPARTMENTS } from "../../agent/productionSupplies.js";
import { AssemblySyncQueue } from "../../agent/assemblySync.js";
import { AssemblyTransferService } from "../../agent/assemblyTransfer.js";
import { CloudSheetsReader } from "./googleSheets.js";
import { cloudConfig } from "./config.js";
import { CloudError } from "./access.js";
import { cloudFetch } from "./fetch.js";
import { deliverShipmentLockEvent, setShipmentLocks } from "./shipmentLocks.js";

export function requireCutover(bindings, scope) {
  const config = cloudConfig(bindings), cutover = scope.meta("cloudCutover");
  if (!config.writesEnabled || !cutover || cutover.id !== bindings.RITM_CLOUD_CUTOVER_ID || cutover.localWriterDisabled !== true || !scope.meta("migrationReady"))
    throw new CloudError("cloud_write_disabled", "Облачная запись ещё не включена: перенос и сверка должны быть завершены.", 403);
  if (scope.meta("migrationPendingWrites")?.some((row) => !row.documentId || config.writableSources.includes(row.documentId)))
    throw new CloudError("migration_operations_pending", "Сначала нужно сверить незавершённые операции прежнего RITM.", 409);
  if (scope.meta("externalRepairs")?.some((row) => ["writing", "uncertain"].includes(row.status) && config.writableSources.includes(row.documentId)))
    throw new CloudError("local_repair_pending", "Эту таблицу изменяет локальный AI Center или результат его исправления требует сверки.", 409);
}

export async function createServices(bindings, scope, { fetcher = fetch, refresh = null, printing = null } = {}) {
  const config = cloudConfig(bindings);
  const reader = new CloudSheetsReader(bindings, { fetcher });
  const writerCredentials = bindings.RITM_GOOGLE_WRITER_JSON ? new CloudSheetsReader(bindings, { writer: true, fetcher }) : reader;
  const guard = async (documentId = null) => {
    requireCutover(bindings, scope);
    if (!scope.lease) throw new CloudError("lease_required", "Операция должна получить блокировку.", 409);
    if (documentId && !config.writableSources.includes(documentId)) throw new CloudError("write_source_forbidden", "Изменение этой таблицы не разрешено.", 403);
    if (documentId && !bindings.RITM_GOOGLE_WRITER_JSON) throw new CloudError("writer_not_configured", "Облачный доступ для создания поставок ещё не настроен.", 503);
    await scope.checkpoint();
  };
  const guardedFetch = async (input, init = {}) => {
    const url = new URL(input), match = url.pathname.match(/^\/v4\/spreadsheets\/([A-Za-z0-9_-]+)(?:[/:]|$)/);
    if (url.protocol !== "https:" || url.hostname !== "sheets.googleapis.com" || url.username || url.password || !match || !config.sources.includes(match[1]))
      throw new CloudError("google_request_forbidden", "Запрос к этому источнику не разрешён.", 403);
    if ((init.method || "GET") !== "GET") await guard(match[1]);
    return cloudFetch(fetcher,url.href,init);
  };
  const writers = reader.configured ? Object.fromEntries(Object.entries(DEPARTMENTS).map(([department, target]) => [department, new ProductionSupplyWriter({ department, credentialWriter: writerCredentials, fetcher: guardedFetch, documentId: target.documentId, template: target.template })])) : null;
  const queue = new AssemblySyncQueue(scope, { secret: bindings.RITM_ASSEMBLY_SYNC_SECRET || "", fetchImpl: (...args) => cloudFetch(fetcher,...args), beforeDeliver: () => guard() });
  // No process-owned timers in Sites. Requests and the protected maintenance
  // endpoint drain the same durable outbox; the scheduler survives closed tabs.
  queue.schedule = () => {};
  let latestPrinting = printing;
  const refreshPrinting = refresh ? async () => {
    await scope.checkpoint();
    latestPrinting = await refresh(scope);
    return { ok: latestPrinting.ok === true, partial: latestPrinting.partial === true };
  } : null;
  const legacy = new RollSupplyManagementService(scope, { writer: writers?.roll || null, recoverInterrupted: !!scope.lease, refresh: refreshPrinting, getPrintingSnapshot: () => latestPrinting });
  const production = new ProductionSupplyService(scope, {
    writers, legacy, recoverInterrupted: !!scope.lease, refresh: refreshPrinting,
    beforeCreateWrite: async (operation) => {
      const shipmentIds = (operation.steps || []).map((step) => {
        const sheetId = Number(step?.plan?.sheetId);
        const department = step?.department;
        if (!['roll', 'box'].includes(department) || !Number.isSafeInteger(sheetId) || sheetId <= 0)
          throw new CloudError("shipment_lock_identity_unavailable", "Не удалось подтвердить листы новой поставки для замка. Запись остановлена.", 503);
        return `RITM-${department.toUpperCase()}-${sheetId}`;
      });
      if (!shipmentIds.length || shipmentIds.length > 20)
        throw new CloudError("shipment_lock_identity_unavailable", "Не удалось определить направления новой поставки для замка. Запись остановлена.", 503);
      const result = await setShipmentLocks(scope, {
        shipmentIds,
        locked: true,
        name: operation.name,
        changedBy: "RITM",
        sourceOperationId: operation.id,
        deliver: (event) => deliverShipmentLockEvent(bindings, event, fetcher),
      });
      if (!result.confirmed)
        throw new CloudError("shipment_lock_unconfirmed", "Замок поставки ожидает подтверждения Assembly. Состав не продолжен; проверьте состояние операции и повторите.", 503);
    },
  });
  // Old releases stored all active production previews as one cloud_state
  // value. Replace that oversized legacy cache once and keep each preview in
  // cloud_transfer_previews with its own expiry instead.
  const legacyPreviews = scope.meta("productionPreviewCache");
  if (Array.isArray(legacyPreviews) && legacyPreviews.length) scope.meta("productionPreviewCache", []);
  production.previews = new Map();
  const transfer = new AssemblyTransferService(scope, { reader, queue, backfill: !!scope.lease });
  return { reader, writers, legacy, production, transfer, queue, guard,
    savePreviews() {},
    state() {
      const state = legacy.state();
      const writable = config.writesEnabled && !!bindings.RITM_GOOGLE_WRITER_JSON && scope.meta("migrationReady") === true && scope.meta("cloudCutover")?.id === bindings.RITM_CLOUD_CUTOVER_ID;
      return { ...state, mode: "cloud", available: writable && state.available, reason: writable ? state.reason : "Облачная версия готовится к переключению. Запись пока отключена.", production: { ...production.state(), available: writable && production.state().available }, assemblySync: queue.state() };
    },
  };
}
