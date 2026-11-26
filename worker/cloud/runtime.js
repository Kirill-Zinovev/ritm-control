import {readPlanning, savePlanning} from './productionPlanning.js';
import { assemblyV2Feed } from './assemblyV2Feed.js';
import { refreshAssemblyV2Source, verifyAssemblyV2EmptyCommand } from './assemblyV2Refresh.js';
import {receiveAssemblyV2Events,readAssemblyV2Events,overlayPrintingV2} from './assemblyV2Events.js';
import {readAssemblyV2Report} from './assemblyV2Report.js';
import { readAssemblyDispatchReport } from './assemblyDispatchReport.js';
import {drainAssemblyV2,queueSnapshotDelivery,supplyDeliveryStatus} from './assemblyV2Delivery.js';
import {readAssemblyV2Warehouse,mergeAssemblyWarehouses,reconcileArchivedWarehouse,warehouseForSelection,dispatchAssemblyV2} from './assemblyV2Warehouse.js';
import {prepareWarehouseExport,readWarehouseExports} from './warehouseExports.js';
import { forecastStocks, readAssemblyStocks } from './assemblyStock.js';
import {executeProductionMove,cancelProductionMove,lookupProductionMove,productionMoveSummary,finalizeConfirmedProductionMove} from './productionMove.js';
import {advanceMoveBatch,cancelMoveBatch,lookupMoveBatch} from './productionMoveBatch.js';
import {boxRemovalKind, boxRemovalStatus, boxRemovalOverlaps, currentBoxLinks, pendingBoxRemoval, removeBoxPosition} from './boxPositionRemoval.js';
import {createStockGateway} from './stockGateway.js';
import {validateWarehouseBatch} from './warehouseBatch.js';
import {deliverAssemblyOnlyRemoval} from "./assemblyOnlyDelivery.js";
import {createAssemblyOnlyItem, listAssemblyOnlyItems, removeAssemblyOnlyItem} from "./assemblyOnlyItems.js";
import { loadSource, validateApi } from "../../agent/adapters.js";
import { cloudConfig, sourceId } from "./config.js";
import { CloudSheetsReader } from "./googleSheets.js";
import { printingWorkspaceFeed, printingWorkspaceWrite } from "./printing-workspace/feed.mjs";
import { printingReadModel } from "./printing-workspace/read-model.mjs";
import { isPrintingWorkMonth, readD1PrintingWork } from "./printingD1Work.js";
import { readLiveBoxSheetReport } from "./boxSheetReport.js";
import { CloudStore } from "./store.js";
import { CloudError, json, readJson, requireOwner, requireMaintenance } from "./access.js";
import { assertSameOrigin, changeManagerPin, createManagerUser, listManagerUsers, loginWithPin, logoutWithPin, readOwnerPinSettings, removeOwnerPin, resetManagerPin, resolvePrincipal, ritmOwnerAccount, saveOwnerPin, setManagerStatus } from "./auth.js";
import { createServices } from "./services.js";
import { AssemblyTransferService } from "../../agent/assemblyTransfer.js";
import { importMigration } from "./migration.js";
import { verifyAssemblyControlApp, verifyBridge, verifyPrintingWorkspaceBridge } from "./bridge.js";
import { cancelProductionControl, cancelProductionControlBatch, completeAssemblyControl, createProductionControl, createProductionControlBatch, listAssemblyControls, listProductionControls } from "./productionControls.js";
import { externalLease } from "./externalLease.js";
import { recordCutover } from "./cutover.js";
import { exportCloud } from "./export.js";
import { activeWarehouseShipmentIds, activeWarehouseShipmentInfo, readWarehouseSnapshot, readWarehouseForDispatch } from "./warehouse.js";
import { warehouseCartonFingerprint } from '../../src/warehouseFingerprint.js';
import { listWarehouseCartonDispatch, listWarehouseDispatchSnapshots, setWarehouseCartonDispatch } from "./warehouseDispatch.js";
import { activeShipmentIds as activePrintingShipmentIds, listShipmentLocks, normalizeShipmentIds, setShipmentLocks } from "./shipmentLocks.js";
import { assemblyV2Configured } from "./assemblyV2Transport.js";
import { evaluateArkadyWatch } from './arkadyWatch.js';
import { evaluateStockWatch, formatStockCompletion } from './arkadyStockWatch.js';
import { assignmentPresentation, stockCompletionPresentation, supplyWatchPresentation } from './arkadyCards.js';
import { loadStockHistory, loadStockWorkspace, stockHistoryEntries, stockNotificationBatches } from './stockHistory.js';
import { parseReadyStockId, resolveReadyStockEntry, stockTaskReadiness } from './stockCompletion.js';
import { runStockCloseBatch, stockCloseBatchInput, stockCloseRecords } from './stockCloseBatch.js';
import { pendingStockDetails,inspectStockReceipts } from './stockDiagnostics.js';
import { readStockSnapshot } from "../../agent/stockSheets.js";
import { readRollStockHistory } from '../../agent/stockReadiness.js';
import { closeStockTask } from '../../agent/stockCloseOperations.js';
import { verifyArchivedStockClose } from './stockCloseRecovery.js';
import { productionTabVisibility, reconcileProductionTabs } from "./productionTabs.js";
import { syncProductionSheetCatalog } from "./productionSheetCatalog.js";
import { syncMachineLayoutPhotos } from "./machineLayoutPhotos.js";
import { importAssemblyProductionExtensions, readAssemblyItemCatalog, readWorkloadCatalog } from "./assemblyProductionCatalog.js";
import { arkadyCatalog } from "./arkadyCatalog.js";
import { arkadyWbIntake, arkadyWbIntakeMaxBytes } from "./arkadyWbIntake.js";
import { ARKADY_COMPLETION_RECIPIENTS, bitrixConfigured, decryptBitrixConfig, drainBitrixNotifications, encryptBitrixConfig, sendBitrixNotification, sendBitrixTaskReminder, sendBitrixCutReminder, completionPraise, retireObsoleteBitrixNotifications } from './bitrixNotifications.js';
import { cutReminderRecipients, cutReminderRecipientsKey, saveBitrixPreference, saveBitrixConfiguration, validateCutReminderRecipients } from './bitrixSettings.js';
import { runArkadyCutReminders } from './arkadyCutReminders.js';
import { listBitrixRecipients, readBitrixRecipient } from './bitrixRecipients.js';
import { drainProductionTaskReminders, normalizeProductionTaskReminder, TASK_REMINDER_KIND } from './productionTaskReminders.js';
import { productionTaskReminderVerifier } from './productionTaskReminderChecks.js';

const signIn = "/?page=supplies";

async function requireAccessOwner(request, bindings) {
  const caller = await resolvePrincipal(request, bindings);
  const write = request.method !== "GET";
  if (caller?.role === "owner") {
    if (write) assertSameOrigin(request);
    return caller.id;
  }
  if (caller?.role === "manager")
    throw new CloudError("owner_required", "Управлять учётными записями может только владелец RITM.", 403);
  return requireOwner(request, bindings, { write });
}
const methods = (request, allowed) => { if (!allowed.includes(request.method)) throw new CloudError("method_not_allowed", "Метод запроса не поддерживается.", 405); };
const requireNoBoxRemoval = (scope) => {
  if (pendingBoxRemoval(scope)) throw new CloudError("box_remove_pending","Сначала завершите проверку удаления в разделе «Поставки».",409);
};

function managerRouteAllowed(method, path) {
  if (method === "GET") return [
    "/api/production-moves", "/api/production-moves/batch", "/api/box-position-removal",
    "/api/assembly", "/api/assembly-stocks", "/api/printing", "/api/warehouse", "/api/warehouse/exports", "/api/cloud/registry", "/api/production-planning", "/api/assembly-v2/delivery",
    "/api/roll-supplies/status", "/api/roll-supplies/operations",
    "/api/assembly-transfers/sources", "/api/assembly-transfers/links",
    "/api/assembly-transfers/source", "/api/assembly-transfers/operation",
    "/api/production-controls", "/api/printing/revision",
    "/api/production-tabs",
    "/api/assembly-only-items",
    "/api/assembly-only-catalog",
    "/api/shipment-locks",
    "/api/stocks/history",
    "/api/arkady-reminder",
  ].includes(path);
  return method === "POST" && [
    "/api/production-moves", "/api/production-moves/batch", "/api/production-planning", "/api/production-dispatch", "/api/box-position-removal",
    "/api/stocks/history",
    "/api/roll-supplies", "/api/roll-supplies/preview",
    "/api/production-tabs",
    "/api/assembly-transfers", "/api/assembly-transfers/preview",
    "/api/warehouse/dispatch",
    "/api/warehouse/dispatch/batch",
    "/api/warehouse/export",
    "/api/production-controls",
    "/api/assembly-only-items",
    "/api/shipment-locks",
    "/api/arkady-reminder",
    "/api/stocks/preview",
    "/api/arkady/catalog",
    "/api/arkady/catalog/wb-intake",
    "/api/stocks/close",
    "/api/stocks/close/batch",
    "/api/stocks",
  ].includes(path);
}

function appendAudit(scope, principal, path, operation) {
  if (principal?.role !== "manager") return;
  const operationId = operation && typeof operation.id === "string" ? operation.id : "unknown";
  scope.log("manager_supply_write", `${principal.id} ${path} ${operationId}`);
}

export async function recoverPendingShipmentLock(bindings, store) {
  return store.withScope(async (scope) => {
    const pending = [...scope.operations.values()].filter((row) => row.kind === "production-shipment-lock" && ["locking", "unlocking"].includes(row.value?.status));
    if (!pending.length) return { attempted: 0, confirmed: true, remaining: 0 };
    const record = pending[0].value;
    if (!record.eventId || !Array.isArray(record.shipmentIds) || typeof record.targetLocked !== "boolean")
      throw new CloudError("shipment_lock_recovery_invalid", "Не удалось безопасно восстановить состояние замка.", 409);
    const result = await setShipmentLocks(scope, {
      shipmentIds: record.shipmentIds,
      locked: record.targetLocked,
      requestId: record.eventId,
      name: record.name,
      changedBy: record.changedBy,
      sourceOperationId: record.sourceOperationId,
    });
    const remaining = [...scope.operations.values()].filter((row) => row.kind === "production-shipment-lock" && ["locking", "unlocking"].includes(row.value?.status));
    return { attempted: 1, confirmed: result.confirmed === true, remaining: new Set(remaining.map((row) => row.value.eventId)).size, eventId: record.eventId, shipmentIds: record.shipmentIds, targetLocked: record.targetLocked };
  });
}

async function resumeBoxRemoval(bindings,store,input,{fetcher=fetch}={}) {
  return store.withScope(async scope=>{
        const {guard,reader}=await createServices(bindings,scope,{fetcher});
        return await removeBoxPosition(input,{
          scope,bindings,fetcher,guard,now:()=>store.now(),
          readPrinting:()=>readSupplyForWrite(bindings,store,scope,reader,{
            department:"box",sheetId:input.sheetId,name:input.name,
          }),
          readSourceRow:async ({ documentId, sheetId, name, row })=>{
            const grid=await reader.grid(documentId,[`'${name.replaceAll("'","''")}'!E${row}:AD${row}`]);
            const block=grid.sheets?.find(s=>s.properties?.sheetId===sheetId)?.data?.[0];
            if(block?.startRow!==row-1 || block.startColumn!==4) return null;
            return Object.fromEntries([5,6,16,18,30].map(col=>[
              col,block.rowData?.[0]?.values?.[col-5]?.userEnteredValue || null,
            ]));
          },
          hasAssemblyWork:async ({shipmentId,positionId})=>{
            const suffix=positionId.slice(shipmentId.length);
            const work=await store.db.prepare(
              "SELECT 1 found FROM assembly_v2_work_events WHERE kind='work' AND (json_extract(payload,'$.positionId')=? OR substr(json_extract(payload,'$.positionId'),-length(?))=?) LIMIT 1"
            ).bind(positionId,suffix,suffix).first();
            return !!work;
          },
        });
  },{waitMs:5000});
}
const updateAssemblyAfterSupplyWrite = (bindings, store, fetcher) =>
  drainAssemblyV2(bindings, store, { fetcher,
    refresh: () => refreshSnapshot("printing", bindings, store, {fetcher, assemblyOnly:true})
  }).catch(() => {});

async function recoverPendingBoxRemoval(bindings,store,{fetcher=fetch}={}) {
  const scope=await store.operationReadScope(boxRemovalKind);
  const pending=pendingBoxRemoval(scope);
  if(!pending)return null;
  const result=await resumeBoxRemoval(bindings,store,{...pending.identity,operationId:pending.id,explicitWriteApproval:true},{fetcher});
  if (result.status === "verified") await updateAssemblyAfterSupplyWrite(bindings, store, fetcher);
  return result;
}

async function recoverPendingRollRemovals(bindings, store, fetcher, id = null) {
  const saved = await store.operationReadScope("roll", id);
  const pending = (id ? [saved.rollSupplyOperation(id)].filter(Boolean) : saved.recentRollSupplyOperations(100)).filter(op =>
    op.action === "removeItem" && op.payload?.removal &&
    ["uncertain","written_unverified","writing","checking"].includes(op.status));
  if (!pending.length) return 0;
  return store.withScope(async scope => {
    const services = await createServices(bindings, scope, {fetcher});
    await services.guard();
    let confirmed = 0;
    for (const job of pending.slice(0, 3)) {
      const current = scope.rollSupplyOperation(job.id);
      if (!current) continue;
      try {
        if (await services.legacy.reconcileItemRemoval(current)) confirmed++;
      } catch { /* The original request remains available for a later readback. */ }
    }
    return confirmed;
  });
}

async function taskBitrixConfig(bindings, store) {
  const [enabled, saved] = await Promise.all([
    store.readMeta('bitrixNotificationsEnabled'),
    store.readMeta('bitrixNotificationConfig'),
  ]);
  if (enabled === false) throw new CloudError('bitrix_disabled', 'Уведомления Аркадия в Битрикс24 выключены.', 409);
  try { return { ...bindings, ...await decryptBitrixConfig(bindings, saved) }; }
  catch { throw new CloudError('bitrix_not_configured', 'Сначала настройте связь Аркадия с Битрикс24.', 409); }
}

function refreshProductionCatalog(bindings, store, fetcher) {
  return syncProductionSheetCatalog(bindings, store, { fetcher, dryRun: false, cacheOnly: true })
    .catch(error => ({ ok: false, error: error.code || "production_catalog_sync_failed" }));
}

export async function maintenance(bindings, store, { fetcher = fetch, refresh = true } = {}) {
  const result = { ok: true, assemblySync: null, deliverySkipped: !cloudConfig(bindings).writesEnabled };
  let taskPrinting = refresh ? null : undefined;
  if (!result.deliverySkipped) {
    try { result.boxRemovalRecovery = boxRemovalStatus(await recoverPendingBoxRemoval(bindings,store,{fetcher})); }
    catch (error) { result.boxRemovalRecovery = { error: error.code || "recovery_failed" }; }
  }
  if (!result.deliverySkipped)
    result.rollRemovalsRecovered = await recoverPendingRollRemovals(bindings, store, fetcher).catch(() => 0);
  result.pendingSupplyOperations = await pendingSupplyOperations(store);
  if (!result.deliverySkipped) await drainBitrixNotifications(bindings, store, fetcher).catch(() => {});
  if (!result.deliverySkipped) {
    try { result.lockRecovery = await recoverPendingShipmentLock(bindings, store); }
    catch (error) { result.lockRecovery = { attempted: 0, confirmed: false, error: error.code || "lock_recovery_failed" }; }
    result.ok = result.lockRecovery.confirmed === true;
  }
  if (refresh) {
    result.refreshed = [];
    try {
      const value = await refreshSnapshot("printing", bindings, store, { fetcher });
      taskPrinting = value.refreshFailed === true ? null : value;
      result.refreshed.push({ kind: "printing", ok: value.refreshFailed !== true, snapshotAt: value.snapshotAt, failure: value.refreshFailure });
      if (!result.deliverySkipped && value.refreshFailed !== true) {
        result.productionTabs = await reconcileProductionTabs(bindings, store, value, fetcher).catch(() => ({ pending: true }));
        result.stockCatalog = await syncProductionSheetCatalog(bindings, store, { fetcher, dryRun: false, stockOnly: true })
          .catch(error => ({ ok: false, error: error.code || 'stock_catalog_sync_failed' }));
        try { result.arkadyWatch = await runArkadyWatch(bindings, store, value, {fetcher}); if (result.arkadyWatch.queued) await drainBitrixNotifications(bindings,store,fetcher); }
        catch (error) { result.arkadyWatch={ok:false,reason:error?.code || 'watch_failed',queued:0}; }
      }
    } catch (error) {
      result.refreshed.push({ kind: "printing", ok: false, error: error.code || "refresh_failed" });
    }
    if (!result.deliverySkipped) result.productionCatalog = await refreshProductionCatalog(bindings, store, fetcher);
    result.ok = result.ok && result.refreshed.every(row => row.ok);
  }
  if (!result.deliverySkipped) {
    let taskBindings;
    const bitrix = () => taskBindings ||= taskBitrixConfig(bindings, store);
    try {
      result.taskReminders = await drainProductionTaskReminders(store, {
        verify: productionTaskReminderVerifier(bindings, store, fetcher, taskPrinting),
        readRecipient: async id => readBitrixRecipient(await bitrix(), id, fetcher),
        send: async (schedule, controls) => sendBitrixTaskReminder(await bitrix(), schedule, controls, fetcher),
      });
    } catch (error) { result.taskReminders = { error: error.code || 'task_reminders_failed' }; }
    if (taskPrinting && !taskPrinting.stale) try {
      result.cutReminders = await runArkadyCutReminders(store, taskPrinting, {
        readRecipient: async id => readBitrixRecipient(await bitrix(), id, fetcher),
        send: async (id, issue) => sendBitrixCutReminder(await bitrix(), id, issue, fetcher),
      });
    } catch (error) { result.cutReminders = { error: error.code || 'cut_reminders_failed' }; }
  }
  // A delivery may refresh the same large printing report. Never overlap it
  // with the ordinary refresh or retain another full history scope meanwhile.
  result.assemblyV2Sync=await drainAssemblyV2(bindings,store,{fetcher,refresh:()=>refreshSnapshot('printing',bindings,store,{fetcher,assemblyOnly:true})});
  return result;
}
async function pendingSupplyOperations(store) {
  const scope = await store.scope();
  const operations = scope.operations
    ? [...scope.operations.values()].filter(row => row.kind === 'production').map(row => row.value)
    : scope.meta('productionSupplyOperations') || [];
  return operations.filter(op => !['verified', 'cancelled'].includes(op.status)).map(op => ({
    id: op.id, name: op.name, action: op.action, status: op.status, message: op.message,
    steps: (op.steps || []).map(step => ({department:step.department,status:step.status,message:step.message || null,sheetId:step.plan?.sheetId,action:step.plan?.action})),
  }));
}
export async function runArkadyStockWatch(bindings,store,{fetcher=fetch}={}) {
  const initial=await store.scope();
  if(initial.meta('bitrixNotificationsEnabled')===false||!initial.meta('bitrixNotificationConfig'))return {ok:true,reason:'disabled',queued:0};
  const boxId=sourceId(bindings,'stockBoxPrintingId'),rollId=sourceId(bindings,'stockRollPrintingId');
  if(!boxId||!rollId)return {ok:false,reason:'stock_sources_unconfigured',queued:0};
  const operations=[...initial.operations.values()],now=store.now(),reader=new CloudSheetsReader(bindings,{fetcher});
  const history=await loadStockHistory({operations,reader,boxId,rollId,now,includeOlder:true});
  return store.withScope(async scope=>{
    if(scope.meta('bitrixNotificationsEnabled')===false||!scope.meta('bitrixNotificationConfig'))return {ok:true,reason:'disabled',queued:0};
    await retireObsoleteBitrixNotifications(scope);
    const batches=stockNotificationBatches(scope.operations.values(),now);
    const result=evaluateStockWatch({batches,history,previous:scope.meta('arkadyStockBatchWatchStatesV1')||{},startedAt:scope.meta('arkadyStockBatchWatchStartedAtV1')||null,now});let queued=0;
    for(const event of result.events){
      if(scope.operations.has(`bitrix-notification:${event.id}`))continue;
      const joke=completionPraise(scope,event.id);
      const options={documentIds:{box:boxId,roll:rollId},joke};
      scope.putOperation('bitrix-notification',{id:event.id,status:'pending',department:'roll',message:formatStockCompletion(event,options),presentation:stockCompletionPresentation(event,options),createdAt:new Date(now).toISOString()});queued++;
      if (queued % 40 === 0) await scope.checkpoint();
    }
    scope.meta('arkadyStockBatchWatchStatesV1',result.state);scope.meta('arkadyStockBatchWatchStartedAtV1',result.startedAt);
    return {ok:true,queued};
  });
}
// Called only from the protected maintenance task after a fresh source read.
// Build decisions inside the same lease that records notification IDs.
export async function runArkadyWatch(_bindings, store, printing) {
  if (!printing || printing.stale === true || printing.refreshFailed === true || !['valid','partial'].includes(printing.quality?.status) || (printing.quality?.status === 'partial' && (!Array.isArray(printing.issues) || printing.issues.some(issue => !issue?.source)))) return {ok:false,reason:'source_unconfirmed',queued:0};
  const current=await store.scope();
  if (current.meta('bitrixNotificationsEnabled') === false || !current.meta('bitrixNotificationConfig')) return {ok:true,reason:'disabled',queued:0};
  return store.withScope(scope=>{
    if (scope.meta('bitrixNotificationsEnabled') === false || !scope.meta('bitrixNotificationConfig')) return {ok:true,reason:'disabled',queued:0};
    const evaluated=evaluateArkadyWatch({printing,supplies:scope.meta('productionSupplies') || [],watches:scope.meta('arkadyWatchConfigs') || {},previous:scope.meta('arkadyWatchStates') || {},now:store.now()});
    let queued=0;
    for(const event of evaluated.events){
      if(event.kind!=='completion'||scope.operations.has(`bitrix-notification:${event.id}`))continue;
      const department=event.department==='roll'?'Рулонная печать':'Бокс';
      const name=String(event.name||'').replace(/[\r\n\[\]]/g,' ').trim().slice(0,180);
      const heading='✅ [B]Печать и порезка завершены[/B]';
      const link=/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit#gid=\d+$/.test(event.url) ? `\n[URL=${event.url}]Открыть таблицу участка[/URL]` : '';
      const joke = completionPraise(scope,event.id);
      scope.putOperation('bitrix-notification',{id:event.id,status:'pending',department:'roll',message:`🦎 [B]Аркадий на связи![/B]\n\n${heading}\n📍 Поставка: [B]${name}[/B]\n${event.department==='roll'?'🖨️':'📦'} Участок: [B]${department}[/B]\nКоличество: ${event.quantity} шт.${link}${joke ? `\n\n[I]${joke}[/I]` : ''}`,presentation:supplyWatchPresentation(event,joke),createdAt:new Date(store.now()).toISOString()});queued++;
    }
    scope.meta('arkadyWatchStates',evaluated.states);
    return {ok:true,queued};
  });
}

async function readCurrentPrinting(bindings, current, reader, supplyTarget = null, fetcher = fetch) {
  if (!current.meta("migrationReady")) throw new CloudError("migration_not_imported", "Реестр поставок ещё не перенесён и не сверен. Неполная сводка не показана.");
  const transfer = new AssemblyTransferService(current, { backfill: false });
  const retired = new Set(current.meta("retiredProductionTabs") || []);
  const source = { adapter: "printing", documentId: sourceId(bindings, "seasonalPrintingId") };
  const value = await loadSource(source, (url, init) => reader.authenticatedFetch(url, init), new Date(), {
    googleReader: reader, boxJournalId: sourceId(bindings, "boxJournalId"), stockBoxJournalId: sourceId(bindings, "stockBoxJournalId"), stockBoxPrintingId: sourceId(bindings, "stockBoxPrintingId"), stockRollPrintingId: sourceId(bindings, "stockRollPrintingId"), printingAdditionalSheets: current.meta("rollPrintingAdditionalSheets") || [],
    productionSupplies: current.meta("productionSupplies") || [], assemblyBoxLinks: transfer.links().filter(link => !retired.has(`box:${link.boxSheetId}`)), supplyTarget,
    workloadCatalog: !supplyTarget
      ? (orders, stock) => readWorkloadCatalog(bindings, orders, stock, fetcher)
      : null,
  });
  validateApi(value, "printing");
  if (value.stale === true) throw new CloudError("source_incomplete", "Источник не подтвердил свежую полную сводку.");
  return value;
}

async function readSupplyForWrite(bindings, store, scope, reader, target) {
  const source = await readCurrentPrinting(bindings, scope, reader, target);
  return overlayPrintingV2(source, await readAssemblyV2Events(store));
}

export async function refreshSnapshot(kind, bindings, store, { scope = null, fetcher = fetch, assemblyOnly = false } = {}) {
  if (kind !== "printing") throw new CloudError("snapshot_kind_invalid", "Неизвестный источник рабочего снимка.", 400);
  const previous = await store.snapshot(kind);
  // Source reads are short. A canceled browser request must not block refreshes
  // for the full production-write lease window.
  const lease = await store.acquire("refresh:" + kind, 60000);
  try {
    const current = scope || await (store.snapshotContext ? store.snapshotContext() : store.scope());
    const moveRevision=kind==='printing'?current.meta('printingMoveRevision')||null:null;
    const supplyRevision=kind==='printing'?current.meta('productionSupplyRevision')||null:null;
    const heldMoves = [], heldRemovals = [];
    if(kind==='printing'){
      const moves=[...current.operations.values()].filter(row=>row.kind==='production-department-move'&&!['verified','cancelled'].includes(row.value.status)).map(row=>row.value);
      if (assemblyOnly) {
        for (const {kind, value} of current.operations.values()) {
          if (kind !== boxRemovalKind || value.status !== "checking") continue;
          if (!/^RITM-(SUPPLY-[a-f0-9-]{36}|ROLL-\d+|BOX-\d+)$/i.test(value.shipmentId || "") ||
              !Number.isSafeInteger(value.identity?.sheetId) || value.position?.sheetId !== value.identity.sheetId)
            requireNoBoxRemoval(current);
          heldRemovals.push({ operationId: value.id, id: value.shipmentId, sheetId: value.identity.sheetId, name: value.identity.name });
        }
        for (const move of moves) {
          const proof = move.proof?.plan?.proof;
          const shipment = proof?.shipment || (current.meta("productionSupplies") || []).find(s => s.id === move.input?.shipmentId);
          const parts = shipment?.parts;
          if (!shipment || shipment.id !== move.input?.shipmentId || !/^RITM-(SUPPLY-[a-f0-9-]{36}|ROLL-\d+|BOX-\d+)$/i.test(shipment.id) ||
              !Array.isArray(parts) || parts.length !== 2 || !["roll", "box"].every(dept =>
                parts.some(p => p.department === dept && Number.isSafeInteger(p.sheetId) && p.sheetId > 0 &&
                  p.documentId === sourceId(bindings, dept + "PrintingId"))))
            throw new CloudError("assembly_move_target_unknown", "Не удалось подтвердить листы незавершённого переноса.", 409);
          heldMoves.push({ moveId: move.id, id: shipment.id, name: shipment.name, parts });
        }
      } else {
        requireNoBoxRemoval(current);
        if (moves.length) {
          const blocked=moves.some(move=>move.status==='uncertain');
          const articles=[...new Set(moves.flatMap(move=>(move.input?.items||[move.input]).map(item=>String(item?.article||'').trim()).filter(Boolean)))];
          const label=articles.slice(0,3).join(', ')+(articles.length>3?' и ещё '+(articles.length-3):'');
          throw new CloudError(blocked?'printing_move_needs_review':'printing_move_in_progress',blocked
            ?'Перенос '+(label||'товаров')+' требует проверки. Пока показаны предыдущие данные печати. Откройте перенос в разделе «Поставки».'
            :'Перенос ещё выполняется. Состав участков обновится после его подтверждения.',409);
        }
      }
    }
    const value = await readCurrentPrinting(bindings, current, new CloudSheetsReader(bindings, { fetcher }), null, fetcher);
    if(kind==='printing'){
      if((await store.readMeta?.('printingMoveRevision')||null)!==moveRevision)throw new CloudError('printing_changed_during_refresh','Во время обновления завершился перенос. Повторяем чтение актуального состава.',409);
      value.productionMoveRevision=moveRevision;
      if ((await store.readMeta?.('productionSupplyRevision')||null)!==supplyRevision)
        throw new CloudError('printing_supply_changed','Создана новая поставка. Обновляем её состав.',409);
      value.productionSupplyRevision=supplyRevision;
    }
    const capturedAt=store.now();
    // Only the signed Assembly feed consumes this snapshot. Regular reporting
    // keeps its previous verified data while a move is being reconciled.
    if (heldMoves.length) value.assemblyHeldMoves = heldMoves;
    if (heldRemovals.length) value.assemblyHeldRemovals = heldRemovals;
    const assemblyScoped = heldMoves.length || heldRemovals.length;
    await store.saveSnapshot(assemblyScoped ? "assembly-printing" : kind, value, lease,capturedAt);
    if(kind==='printing' && !assemblyScoped)await queueSnapshotDelivery(store,value,capturedAt);
    return { ...value, stale: false, snapshotAt: new Date(store.now()).toISOString(), refreshFailed: false, refreshInProgress: false };
  } catch (error) {
    if (!previous) throw error;
    const issue = error?.issue;
    const detail = issue?.code === "schema_changed" && issue?.source
      ? ` Лист «${String(issue.source).slice(0, 100)}»: ${String(issue.message || "изменена структура").slice(0, 120)}.`
      : "";
    const failure = { code: issue?.code || error.code || error.name || "refresh_failed", message: (detail.trim() || String(error.message || "Refresh failed")).slice(0, 240) };
    const moveUpdating=['printing_changed_during_refresh','printing_move_in_progress','printing_supply_changed'].includes(error.code);
    return { ...previous.value, stale: true, snapshotAt: new Date(previous.at).toISOString(), refreshFailed: !moveUpdating, refreshInProgress: moveUpdating, refreshRetryAfterMs: moveUpdating?1500:60000, refreshFailure: failure, staleReason: error.code==='printing_move_needs_review'?error.message:moveUpdating?'Обновляем состав участков после переноса. Показан предыдущий снимок.':`Не удалось обновить источник.${detail} Показан предыдущий проверенный снимок.` };
  } finally { await store.release(lease); }
}

export async function readSnapshot(kind, url, bindings, store, options) {
  const [snapshot, moveRevision, supplyRevision] = await Promise.all([
    store.snapshot(kind),
    kind === "printing" ? store.readMeta?.("printingMoveRevision") : null,
    kind === "printing" ? store.readMeta?.("productionSupplyRevision") : null,
  ]);
  const moveChanged=kind==='printing'&&(snapshot?.value.productionMoveRevision||null)!==(moveRevision||null);
  const supplyChanged=kind==='printing'&&(snapshot?.value.productionSupplyRevision||null)!==(supplyRevision||null);
  let payload;
  const expired = snapshot && store.now() - snapshot.at >= cloudConfig(bindings).snapshotMaxAgeMs;
  if (snapshot && kind === "printing" && url.searchParams.get("view") === "last-confirmed" &&
      !url.searchParams.has("refresh") && (expired || moveChanged || supplyChanged)) {
    payload = { ...snapshot.value, stale: true, refreshOnOpen: true, refreshFailed: false,
      snapshotAt: new Date(snapshot.at).toISOString(), refreshInProgress: true,
      staleReason: "Обновляем данные. Пока показан последний подтверждённый состав." };
  } else if (!snapshot || moveChanged || supplyChanged || url.searchParams.get("refresh") === "1" || expired) {
    try {
      payload = await refreshSnapshot(kind, bindings, store, options);
      if (kind === "printing") options.onFreshPrinting?.(payload);
    }
    catch (error) {
      if (!snapshot) throw error;
      const refreshInProgress = error?.code === "cloud_operation_busy";
      const snapshotFresh = store.now() - snapshot.at < cloudConfig(bindings).snapshotMaxAgeMs;
      payload = {
        ...snapshot.value,
        // A competing refresh should not invalidate a still-fresh verified
        // snapshot. Writes still fail closed once that snapshot is older than
        // the normal cache lifetime.
        stale: moveChanged || supplyChanged || !snapshotFresh,
        snapshotAt: new Date(snapshot.at).toISOString(),
        refreshFailed: !refreshInProgress,
        refreshInProgress,
        refreshRetryAfterMs: moveChanged || supplyChanged ? 1500 : refreshInProgress ? 15000 : 60000,
        staleReason: supplyChanged ? 'Новая поставка сохранена. Обновляем общий список автоматически.' : moveChanged ? 'Перенос завершён. Обновляем состав участков; показан предыдущий снимок.' : refreshInProgress && !snapshotFresh
          ? "Обновление уже выполняется. Пока показан предыдущий проверенный снимок."
          : refreshInProgress
            ? null
            : "Обновить источник пока не удалось. Показан предыдущий проверенный снимок.",
      };
    }
  } else payload = { ...snapshot.value, stale: false, snapshotAt: new Date(snapshot.at).toISOString(), refreshFailed: false, refreshInProgress: false };
  return kind === "printing" ? overlayPrintingV2(payload, await readAssemblyV2Events(store)) : payload;
}

export async function currentShipmentLockSnapshot(bindings, store, { fetcher = fetch, refresh = refreshSnapshot, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let snapshot = await store.snapshot("printing");
  if (snapshot && store.now() - snapshot.at <= cloudConfig(bindings).snapshotMaxAgeMs) return snapshot;
  let updated;
  try { updated = await refresh("printing", bindings, store, { fetcher }); }
  catch (error) {
    if (error?.code === "cloud_operation_busy") {
      for (let i = 0; i < 12; i++) {
        await wait(1000);
        snapshot = await store.snapshot("printing");
        if (snapshot && store.now() - snapshot.at <= cloudConfig(bindings).snapshotMaxAgeMs) return snapshot;
      }
      throw new CloudError("shipment_lock_snapshot_busy", "Данные поставок ещё обновляются. Подождите и повторите изменение замка.", 503);
    }
    throw new CloudError("shipment_lock_snapshot_stale", "Не удалось обновить данные поставок. Замок не изменён; повторите после восстановления связи.", 503);
  }
  if (!updated || updated.stale === true || updated.refreshFailed === true)
    throw new CloudError("shipment_lock_snapshot_stale", "Не удалось обновить данные поставок. Замок не изменён; повторите после восстановления связи.", 503);
  snapshot = await store.snapshot("printing");
  if (!snapshot || store.now() - snapshot.at > cloudConfig(bindings).snapshotMaxAgeMs)
    throw new CloudError("shipment_lock_snapshot_stale", "Не удалось подтвердить обновление данных поставок. Замок не изменён.", 503);
  return snapshot;
}

async function requirePrintingWorkspaceAccess(request,bindings,key) {
  if (!request.headers.has('x-ritm-bridge-id')) return requireMaintenance(request,bindings,key);
  if (typeof bindings[key] !== 'string' || bindings[key].length < 32) {
    throw new CloudError('printing_access_disabled','Служебный доступ к печати не настроен.',403);
  }
  await verifyPrintingWorkspaceBridge(request,bindings);
}

export async function cloudApi(request, bindings, ctx, { fetcher = fetch } = {}) {
  const url = new URL(request.url), path = url.pathname;
  try {
    if (path === '/api/printing-workspace-feed') {
      methods(request,['GET']);
      await requirePrintingWorkspaceAccess(request,bindings,'RITM_PRINTING_WORKSPACE_TOKEN');
      const sourceUrl = new URL('/api/printing',url);
      const store = new CloudStore(bindings.DB);
      const firstScreen = url.searchParams.get('boot') === '1' && !url.searchParams.has('supply');
      const supplyPreview = url.searchParams.get('preview') === '1' && url.searchParams.has('supply');
      const fresh = url.searchParams.get('fresh') === '1' && !url.searchParams.has('supply');
      if (fresh) sourceUrl.searchParams.set('refresh','1');
      const load = () => readSnapshot('printing',sourceUrl,bindings,store,{fetcher});
      return await printingWorkspaceFeed(url,bindings,fetcher,async () => {
        if (supplyPreview || (firstScreen && ctx?.waitUntil)) {
          const latest = await store.snapshot('printing');
          if (latest) {
            const stale = !!latest.value.stale || store.now()-latest.at >= cloudConfig(bindings).snapshotMaxAgeMs;
            if (supplyPreview || fresh || stale) {
              if (fresh && ctx?.waitUntil) ctx.waitUntil(load().catch(() => {}));
              return {...latest.value,stale:fresh || stale,snapshotAt:new Date(latest.at).toISOString()};
            }
          }
        }
        return load();
      },printingReadModel(store));
    }
    if (path === '/api/printing-workspace-write') {
      methods(request,['POST']);
      await requirePrintingWorkspaceAccess(request,bindings,'RITM_PRINTING_WORKSPACE_WRITE_TOKEN');
      const sourceUrl = new URL('/api/printing',url);
      const store = new CloudStore(bindings.DB);
      return await printingWorkspaceWrite(request,bindings,fetcher,
        () => readSnapshot('printing',sourceUrl,bindings,store,{fetcher}),
        () => {
          if (!ctx?.waitUntil) return;
          const refreshUrl = new URL(sourceUrl);
          refreshUrl.searchParams.set('refresh','1');
          ctx.waitUntil(readSnapshot('printing',refreshUrl,bindings,store,{fetcher}).catch(() => {}));
        },printingReadModel(store),
      );
    }
    if (path === '/api/assembly-v2/feed') return await assemblyV2Feed(request, bindings, new CloudStore(bindings.DB));
    if (path === '/api/assembly-v2/refresh') {
      const store = new CloudStore(bindings.DB);
      return await refreshAssemblyV2Source(request, bindings, store, async () => {
        const report = await refreshSnapshot('printing', bindings, store, {fetcher, assemblyOnly:true});
        if (ctx?.waitUntil) ctx.waitUntil(reconcileProductionTabs(bindings, store, report, fetcher).catch(() => {}));
        return report;
      });
    }
    if (path === '/api/assembly-v2/events') return await receiveAssemblyV2Events(request,bindings,new CloudStore(bindings.DB));
    if (path === '/api/assembly-v2/stock-catalog-sync') {
      const store = new CloudStore(bindings.DB);
      await verifyAssemblyV2EmptyCommand(request, bindings, store, 'stock-catalog-sync');
      const stock = syncProductionSheetCatalog(bindings, store, { fetcher, dryRun: false, stockOnly: true });
      // The signed command already fires after a save in RITM СБОРКА.
      // Reuse it for supplies while keeping the existing stock response.
      const production = stock.then(
        () => refreshProductionCatalog(bindings, store, fetcher),
        () => refreshProductionCatalog(bindings, store, fetcher),
      );
      if (ctx?.waitUntil) ctx.waitUntil(production);
      else await production;
      if (ctx?.waitUntil) ctx.waitUntil(syncMachineLayoutPhotos(bindings, store, { fetcher, dryRun: false })
        .catch(error => console.warn("machine_layout_photos", error.code || "layout_photos_sync_failed")));
      const result = await stock;
      return json({ ok: result.ok }, result.ok ? 200 : 503);
    }
    if (path === "/api/machine-layout-photos/sync") {
      methods(request, ["POST"]);
      await requireAccessOwner(request, bindings);
      return json(await syncMachineLayoutPhotos(bindings, new CloudStore(bindings.DB), { fetcher, dryRun: false }));
    }
    if (path === "/api/auth/login") {
      methods(request, ["POST"]);
      return await loginWithPin(request, bindings);
    }
    if (path === "/api/auth/logout") {
      methods(request, ["POST"]);
      return await logoutWithPin(request, bindings);
    }
    if (path === "/api/auth/change-pin") {
      methods(request, ["POST"]);
      const principal = await resolvePrincipal(request, bindings);
      return json(await changeManagerPin(request, bindings.DB, principal));
    }
    if (path === "/api/auth/owner-pin") {
      methods(request, ["GET", "POST", "DELETE"]);
      const ownerId = await requireAccessOwner(request, bindings);
      const canEdit = ritmOwnerAccount(request, bindings) === ownerId;
      if (request.method === "GET") return json({ ok: true, canEdit, ...await readOwnerPinSettings(bindings, ownerId) });
      if (!canEdit) throw new CloudError("owner_chatgpt_required", "Войдите через ChatGPT, чтобы изменить вход владельца по PIN.", 403);
      const settings = request.method === "DELETE"
        ? await removeOwnerPin(bindings, ownerId)
        : await saveOwnerPin(bindings, ownerId, await readJson(request, 2048));
      return json({ ok: true, canEdit, ...settings });
    }
    if (path === "/api/auth/users") {
      const ownerId = await requireAccessOwner(request, bindings);
      if (request.method === "GET") return json({ ok: true, users: await listManagerUsers(bindings.DB) });
      methods(request, ["POST"]);
      return json({ ok: true, user: await createManagerUser(bindings.DB, await readJson(request, 2048), ownerId) }, 201);
    }
    const managerAction = path.match(/^\/api\/auth\/users\/([0-9a-f-]{36})\/(reset-pin|status)$/i);
    if (managerAction) {
      const ownerId = await requireAccessOwner(request, bindings);
      methods(request, ["POST"]);
      const [, id, action] = managerAction;
      if (action === "reset-pin") return json({ ok: true, ...await resetManagerPin(bindings.DB, id, ownerId) });
      const input = await readJson(request, 1024);
      if (input.status !== "active" && input.status !== "disabled") throw new CloudError("status_invalid", "Некорректный статус учётной записи.", 400);
      await setManagerStatus(bindings.DB, id, input.status, ownerId);
      return json({ ok: true, status: input.status });
    }
    if (path === "/api/runtime") {
      methods(request, ["GET"]);
      const principal = await resolvePrincipal(request, bindings);
      const authorized = principal?.role === "owner" || principal?.role === "manager";
      if (authorized && ctx?.waitUntil && cloudConfig(bindings).configured)
        ctx.waitUntil(drainBitrixNotifications(bindings, new CloudStore(bindings.DB), fetcher).catch(() => {}));
      return json({ ok: true, mode: "cloud", authenticated: !!principal, authorized, role: authorized ? principal.role : null, displayName: authorized ? principal.displayName : null, username: authorized ? principal.username : null, mustChangePin: authorized && principal.role === "manager" ? principal.mustChangePin : false, signInPath: signIn });
    }
    // This reports only the caller's site-specific ID; it does not grant access.
    if (path === "/api/cloud/identity") {
      methods(request, ["GET"]);
      const id = request.headers.get("oai-authenticated-user-id");
      if (!id) throw new CloudError("authentication_required", "Войдите через ChatGPT.", 401);
      return json({ ok: true, userId: id, authorized: cloudConfig(bindings).owners.includes(id) });
    }
    let bridgeId = null, assemblyControlApp = false, principal = null;
    if (request.headers.has("x-ritm-assembly-at")) { await verifyAssemblyControlApp(request, bindings); assemblyControlApp = true; }
    else if (request.headers.has("x-ritm-bridge-id")) bridgeId = await verifyBridge(request, bindings);
    else if (["/api/cloud/import", "/api/cloud/cutover", "/api/cloud/state"].includes(path) && request.headers.has("authorization")) {
      if (bindings.RITM_CLOUD_IMPORT_ENABLED !== "true") throw new CloudError("migration_service_disabled", "Служебный канал переноса закрыт.", 403);
      requireMaintenance(request, bindings, "RITM_MIGRATION_TOKEN");
    }
    else if (path === "/api/cloud/maintenance" && request.headers.has("authorization")) requireMaintenance(request, bindings);
    else {
      principal = await resolvePrincipal(request, bindings);
      if (principal?.role === "owner") {
        if (request.method !== "GET") assertSameOrigin(request);
      } else if (principal?.role === "manager") {
        if (!managerRouteAllowed(request.method, path)) throw new CloudError("manager_route_forbidden", "Этот раздел или служебная операция недоступны для учётной записи менеджера.", 403);
        if (principal.mustChangePin) throw new CloudError("pin_change_required", "Перед продолжением задайте личный PIN.", 403);
        if (request.method !== "GET") assertSameOrigin(request);
      } else requireOwner(request, bindings, { write: request.method !== "GET" });
    }
    if (path === "/api/assembly") {
      methods(request, ["GET"]);
      return json(await readAssemblyV2Report(url, bindings, { fetcher }));
    }
    if (path === "/api/production-dispatch") {
      methods(request, ["POST"]);
      if (!principal || !["owner", "manager"].includes(principal.role))
        throw new CloudError("production_dispatch_forbidden", "Войдите в РИТМ, чтобы увидеть отгрузки.", 403);
      return json(await readAssemblyDispatchReport(await readJson(request, 8192), bindings, { fetcher }));
    }
    const config = cloudConfig(bindings);
    if (!config.configured) throw new CloudError("cloud_not_configured", "Облачное подключение источников и хранилища ещё не настроено.");
    const store = new CloudStore(bindings.DB);
    if(path==='/api/printing/revision') {
      methods(request,['GET']);
      const [source, savedRevision] = await Promise.all([store.snapshotInfo('printing'), store.readMeta('productionSupplyRevision')]);
      const revision = savedRevision || 0;
      const refreshNeeded=!source || source.at<revision;
      // A lightweight poll may retry durable deliveries, but never starts a
      // competing report scan while a supply write is running.
      if(ctx?.waitUntil && config.writesEnabled)
        ctx.waitUntil((async()=>{
          // Coalesce background maintenance across all open RITM tabs.
          const now = store.now();
          const slot = await store.db.prepare("insert into cloud_state(key,value,updated_at) values('printingRecoveryPoll','true',?) on conflict(key) do update set updated_at=excluded.updated_at where cloud_state.updated_at<=?")
            .bind(now,now-15000).run();
          if (slot.meta?.changes !== 1 || await store.leaseIsActive("production")) return;
          await recoverPendingBoxRemoval(bindings,store,{fetcher}).catch(()=>{});
          await recoverPendingRollRemovals(bindings,store,fetcher).catch(()=>0);
          await updateAssemblyAfterSupplyWrite(bindings,store,fetcher);
        })().catch(()=>{}));
      return json({ok:true,revision:`${revision}:${source?.at||0}`,refreshNeeded});
    }
    if(path==='/api/assembly-v2/delivery'){
      methods(request,['GET','POST']);
      return json({ok:true,assemblyV2:request.method==='POST'?await drainAssemblyV2(bindings,store,{fetcher,refresh:()=>refreshSnapshot('printing',bindings,store,{fetcher,assemblyOnly:true})}):await supplyDeliveryStatus(store)});
    }
    if (path === '/api/production-planning') {
      methods(request,['GET','POST']);
      if (!principal || !['owner','manager'].includes(principal.role)) throw new CloudError('planning_forbidden','Войдите в RITM.',403);
      if (request.method === 'GET') {
        const before=await store.db.prepare("SELECT fence,expires_at FROM cloud_leases WHERE name='production'").first();
        const [planning,supplies,items]=await Promise.all([store.readMeta('productionPlanning'),store.readMeta('productionSupplies'),store.readOperationsByKind('assembly-only-item')]);
        const after=await store.db.prepare("SELECT fence,expires_at FROM cloud_leases WHERE name='production'").first();
        const extraItems=items.filter(item=>item.status!=='removed').map(({shipmentId,positionId,article,quantity,status,createdAt})=>({shipmentId,positionId,article,quantity,status:status||'active',createdAt}));
        const confirmed=Number(before?.expires_at||0)<=store.now() && Number(after?.expires_at||0)<=store.now() && (before?.fence||0)===(after?.fence||0);
        return json({ok:true,planning:readPlanning({meta:key=>key==='productionPlanning'?planning:supplies}),extraItems,extraItemsConfirmed:confirmed});
      }
      const input=await readJson(request), snapshot=await store.snapshot('printing');
      if (['packing-stock','cut-confirmation'].includes(input.action) && (!snapshot || !Number.isFinite(snapshot.at) || snapshot.at > store.now() + 60000 || store.now() - snapshot.at > 15 * 60000))
        throw new CloudError('planning_stock_source_stale','Рабочие данные устарели. Обновите прогноз и повторите подтверждение источника.',409);
      let printingForPlanning=snapshot?.value;
      if (input.action === 'packing-stock') {
        // Validate the same legacy + Assembly v2 facts the forecast displays,
        // including cancellations, before attaching a source to event IDs.
        printingForPlanning=overlayPrintingV2(printingForPlanning,await readAssemblyV2Events(store));
        if (printingForPlanning.assemblyV2?.pendingRefresh)
          throw new CloudError('planning_stock_source_stale','Рабочие данные устарели. Обновите прогноз и повторите подтверждение источника.',409);
      }
      const planning=await store.withScope(scope=>savePlanning(scope,input,{principal,printing:printingForPlanning,now:store.now()}));
      return json({ok:true,planning});
    }
    if (path === '/api/bitrix-settings') {
      if (principal?.role !== 'owner') throw new CloudError('owner_required','Настройки бота доступны владельцу RITM.',403);
      methods(request, ['GET','POST']);
      if (request.method === 'POST') {
        const input = await readJson(request, 1024);
        if (Object.keys(input).join() === 'enabled' && typeof input.enabled === 'boolean') {
          await saveBitrixPreference(store, 'enabled', input.enabled);
        } else if (Object.keys(input).join() === 'humorLevel' && ['off', 'sometimes', 'always'].includes(input.humorLevel)) {
          await saveBitrixPreference(store, 'humorLevel', input.humorLevel);
        } else if (Object.keys(input).join() === 'reminderHumorLevel' && ['off', 'sometimes', 'always'].includes(input.reminderHumorLevel)) {
          await saveBitrixPreference(store, 'reminderHumorLevel', input.reminderHumorLevel);
        } else if (Object.keys(input).join() === 'cutReminderRecipients') {
          const recipients = validateCutReminderRecipients(input.cutReminderRecipients);
          const ids = [...new Set(Object.values(recipients).filter(Boolean))];
          if (ids.length) {
            const config = await taskBitrixConfig(bindings, store);
            const employees = await Promise.all(ids.map(id => readBitrixRecipient(config, id, fetcher)));
            if (employees.some((employee, index) => employee?.id !== ids[index]))
              throw new CloudError('bitrix_recipient_unavailable', 'Выбранный сотрудник недоступен в Битрикс24. Проверьте получателей.', 409);
          }
          await saveBitrixPreference(store, 'cutReminderRecipients', recipients);
        } else if (Object.keys(input).join() === 'chatId' && /^chat\d+$/.test(input.chatId)) {
          const saved = await store.readMeta('bitrixNotificationConfig');
          if (!saved) throw new CloudError('bitrix_not_configured','Сначала настройте подключение бота.',409);
          const cfg = await decryptBitrixConfig(bindings,saved);
          let response, body;
          try {
            response = await fetcher(`${cfg.RITM_BITRIX_WEBHOOK_URL}imbot.chat.user.list`, {method:'POST',redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'content-type':'application/json'},body:JSON.stringify({BOT_ID:Number(cfg.RITM_BITRIX_BOT_ID),CLIENT_ID:cfg.RITM_BITRIX_BOT_TOKEN,CHAT_ID:Number(input.chatId.slice(4))})});
            body = await response.json();
          } catch {
            throw new CloudError('bitrix_chat_check_failed','Не удалось проверить чат в Битрикс24. Подключение не изменено; повторите сохранение.',502);
          }
          const members = Array.isArray(body?.result) ? body.result : Object.values(body?.result || {});
          const containsBot = members.some(member => Number(typeof member === 'object' ? member?.id ?? member?.ID ?? member?.userId : member) === Number(cfg.RITM_BITRIX_BOT_ID));
          if (!response.ok || !containsBot) throw new CloudError('bitrix_chat_unavailable','Битрикс24 не подтвердил участие Аркадия в этом чате. Добавьте бота в чат и проверьте ID.',409);
          cfg.RITM_BITRIX_ROLL_CHAT = input.chatId;
          await saveBitrixConfiguration(store, await encryptBitrixConfig(bindings,cfg), saved);
        } else throw new CloudError('bitrix_setting_invalid','Проверьте настройку уведомлений.',400);
      }
      const scope = await store.scope();

      const saved = scope.meta('bitrixNotificationConfig');
      let configured = false, chatId = '';
      if (saved) try { const cfg = await decryptBitrixConfig(bindings,saved); configured = bitrixConfigured(cfg); chatId = cfg.RITM_BITRIX_ROLL_CHAT; } catch { /* invalid saved configuration */ }
      const events = [...scope.operations.values()].filter(row => row.kind === 'bitrix-notification').map(row => row.value);
      const last = events.filter(event => event.status === 'sent').sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))[0];
      return json({ok:true,configured,enabled:scope.meta('bitrixNotificationsEnabled') !== false,humorLevel:scope.meta('bitrixHumorLevel') || 'always',reminderHumorLevel:scope.meta('bitrixReminderHumorLevel') || 'off',cutReminderRecipients:cutReminderRecipients(scope.meta(cutReminderRecipientsKey)),chatId,pending:events.filter(event=>event.status==='pending').length,uncertain:events.filter(event=>['uncertain','sending'].includes(event.status)).length,lastSentAt:last?.updatedAt||null});
    }
    if (path === '/api/bitrix-setup') {
      methods(request, ['POST']);
      if (principal?.role !== 'owner') throw new CloudError('owner_required','Настройка доступна владельцу RITM.',403);
      const input = await readJson(request, 4096);
      const previous = await store.readMeta('bitrixNotificationConfig');
      const value = { RITM_BITRIX_WEBHOOK_URL: String(input.webhook || '').trim(), RITM_BITRIX_BOT_TOKEN: String(input.clientId || '').trim(), RITM_BITRIX_BOT_ID:'5768', RITM_BITRIX_BOX_CHAT:'chat37626', RITM_BITRIX_ROLL_CHAT:'chat37628' };
      if (!bitrixConfigured(value)) throw new CloudError('bitrix_config_invalid','Проверьте адрес подключения и код бота.',400);
      try {
        for (const chat of [37626, 37628]) {
          const response = await fetcher(`${value.RITM_BITRIX_WEBHOOK_URL}imbot.chat.user.list`, {method:'POST',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify({BOT_ID:5768,CLIENT_ID:value.RITM_BITRIX_BOT_TOKEN,CHAT_ID:chat})});
          const body = await response.json();
          if (!response.ok || !body?.result) throw new Error('rejected');
        }
      } catch { throw new CloudError('bitrix_connection_failed','Битрикс24 не подтвердил доступ бота к обоим чатам. Проверьте данные подключения.',409); }
      const encrypted = await encryptBitrixConfig(bindings,value);
      await saveBitrixConfiguration(store, encrypted, previous);
      return json({ok:true});
    }
    if (path === '/api/bitrix-setup/avatar') {
      methods(request, ['POST']);
      if (principal?.role !== 'owner') throw new CloudError('owner_required','Настройка доступна владельцу RITM.',403);
      const saved = (await store.scope()).meta('bitrixNotificationConfig');
      if (!saved) throw new CloudError('bitrix_not_configured','Сначала сохраните подключение.',409);
      const cfg = await decryptBitrixConfig(bindings,saved);
      const avatar = await bindings.ASSETS.fetch(new Request(new URL('/ritm-chameleon.png',request.url)));
      if (!avatar.ok) throw new CloudError('bitrix_avatar_missing','Изображение недоступно.',503);
      const bytes = new Uint8Array(await avatar.arrayBuffer());
      if (bytes.length > 4000000) throw new CloudError('bitrix_avatar_large','Изображение слишком большое.',400);
      let binary=''; for(let i=0;i<bytes.length;i+=16384) binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
      let result;
      try {
        const response = await fetcher(`${cfg.RITM_BITRIX_WEBHOOK_URL}imbot.v2.Bot.update`, {method:'POST',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify({botId:5768,botToken:cfg.RITM_BITRIX_BOT_TOKEN,fields:{properties:{avatar:btoa(binary)}}})});
        result = await response.json();
        if (!response.ok || !result?.result?.bot) throw new Error('rejected');
      } catch { throw new CloudError('bitrix_avatar_failed','Битрикс24 не подтвердил обновление аватара. Проверьте подключение.',502); }
      return json({ok:true,confirmed:!!result.result.users?.some(user=>Number(user.id)===5768 && !!user.avatar)});
    }
    if (path === '/api/bitrix-setup/greeting') {
      methods(request, ['POST']);
      if (principal?.role !== 'owner') throw new CloudError('owner_required','Отправка доступна владельцу RITM.',403);
      const previous = (await store.scope()).operations.get('bitrix-greeting:greeting-chat26688-20261106')?.value;
      return json({ok:true,status:previous?.status || 'superseded'});
    }
    if (path === '/api/bitrix-setup/test') {
      methods(request, ['POST']);
      if (principal?.role !== 'owner') throw new CloudError('owner_required','Проверка доступна владельцу RITM.',403);
      const saved = (await store.scope()).meta('bitrixNotificationConfig');
      if (!saved) throw new CloudError('bitrix_not_configured','Сначала сохраните подключение.',409);
      const cfg = await decryptBitrixConfig(bindings,saved);
      const result = await sendBitrixNotification({...bindings,...cfg},{department:'roll',presentation:assignmentPresentation({kind:'production',title:'Тестовое сообщение · OZON МОСКВА 10_10',manager:principal?.displayName||'RITM',sections:[{department:'roll',articles:147,quantity:5020},{department:'box',articles:127,quantity:5325}],joke:'Тест оформления. Новая поставка не создавалась.'})},fetcher,ARKADY_COMPLETION_RECIPIENTS[0]);
      return json({ok:true,results:{private:result.status}});
    }
    if (path === '/api/arkady-reminder') {
      methods(request,['GET','POST']);
      if(assemblyControlApp||bridgeId)throw new CloudError('stock_manager_scope_required','Настройка доступна только в RITM.',403);
      const input=request.method==='POST'?await readJson(request):{shipmentId:url.searchParams.get('shipmentId')};
      const id=String(input.shipmentId||'');
      if(!/^RITM-(?:SUPPLY|ROLL|BOX)-[A-Za-z0-9-]+$/.test(id))throw new CloudError('reminder_invalid','Не подтверждена поставка.',400);
      const read=scope=>{const supply=(scope.meta('productionSupplies')||[]).find(x=>x.id===id);if(!supply||!/🔥\s*$/u.test(supply.name||''))throw new CloudError('reminder_unavailable','Напоминание доступно для срочных поставок RITM.',404);return {supply,config:(scope.meta('arkadyWatchConfigs')||{})[id]||null};};
      if(request.method==='GET'){const info=read(await store.scope());return json({ok:true,minutes:info.config?.reminderMinutes ?? 0,configured:!!info.config});}
      if(![0,30,60,120,240].includes(input.minutes))throw new CloudError('reminder_invalid','Выберите время напоминания.',400);
      const config=await store.withScope(scope=>{const info=read(scope),all=scope.meta('arkadyWatchConfigs')||{};all[id]={...(info.config||{}),priority:'urgent',createdAt:info.config?.createdAt||new Date(store.now()).toISOString(),reminderMinutes:input.minutes};scope.meta('arkadyWatchConfigs',all);return all[id];});
      return json({ok:true,minutes:config.reminderMinutes,configured:true});
    }
    if(path==='/api/stocks/pending-status'){
      methods(request,['GET']);
      if(assemblyControlApp)throw new CloudError('stock_diagnostic_forbidden','Сверка доступна только владельцу RITM и защищённому локальному каналу.',403);
      const scope=await store.scope();
      const operations=pendingStockDetails(scope.operations.values(),url.searchParams.get('article'));
      return json({ok:true,operations:url.searchParams.get('inspect')==='1'?await inspectStockReceipts(operations,bindings,{fetcher}):operations});
    }
    if (path === '/api/stocks/history') {
      methods(request,['GET','POST']);
      if(assemblyControlApp||bridgeId)throw new CloudError('stock_manager_scope_required','Раздел доступен только из RITM.',403);
      if (request.method === 'POST' || url.searchParams.get('checkCatalog') === '1') {
        const dryRun = request.method === 'GET';
        if (!dryRun) {
          const input = await readJson(request, 1024);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
            throw new CloudError('stock_catalog_invalid','Проверка справочника не принимает данные для записи.',400);
        }
        const result = await syncProductionSheetCatalog(bindings, store, { fetcher, dryRun, stockOnly: true, initializeStock: true });
        return json(result, result.ok ? 200 : 503);
      }
      const scopes=await Promise.all(['stock','stock-close'].map(kind=>store.operationReadScope(kind)));
      const workspace=await loadStockWorkspace({
        operations:scopes.flatMap(scope=>[...scope.operations.values()]),
        reader:new CloudSheetsReader(bindings,{fetcher}),
        boxId:sourceId(bindings,'stockBoxPrintingId'),rollId:sourceId(bindings,'stockRollPrintingId'),
      });
      return json({ok:true,...workspace});
    }
    if (path === '/api/stocks/close') {
      methods(request,['POST']);
      if(assemblyControlApp||bridgeId)throw new CloudError('stock_manager_scope_required','Действие доступно только из RITM.',403);
      const input=await readJson(request,2048);
      if(typeof input?.entryId!=='string' || !/^[a-f0-9-]{36}$/i.test(String(input.operationId||'')))
        throw new CloudError('stock_close_invalid','Не подтверждён запрос завершения.',400);
      const readySource=parseReadyStockId(input.entryId);
      const manager=principal?.displayName||principal?.username||'RITM';
      const operation=await store.withScope(async scope=>{
        const prior=scope.operations.get('stock-close:'+input.operationId)?.value;
        if(prior && prior.entryId!==input.entryId) throw new CloudError('stock_close_conflict','Номер операции уже используется.',409);
        let entry=prior ? {...prior,id:prior.entryId} : null;
        if(!entry && !readySource) entry=stockHistoryEntries(scope.operations.values()).find(item=>item.id===input.entryId && !item.closedAt);
        const source=entry||readySource;
        if(!source)throw new CloudError('stock_close_missing','Задание не найдено. Обновите историю.',409);
        const services=await createServices(bindings,scope,{fetcher,manager});
        await services.guard();
        const id=sourceId(bindings,source.department==='box'?'stockBoxPrintingId':'stockRollPrintingId');
        const records=stockCloseRecords(scope);
        const readSnapshot=()=>readStockSnapshot(services.reader,id,source.destination);
        try {
          const snapshot=prior ? null : await readSnapshot();
          if(!entry) entry=resolveReadyStockEntry(input.entryId,source,snapshot);
          const writer=prior ? null : services.stock().adapters[entry.department].writer;
          const result=await closeStockTask({
            operationId:input.operationId,entry,store:records,manager,
            checkpoint:()=>services.guard(),readSnapshot:()=>snapshot,
            readiness:async (item,fresh)=>{
              const current=fresh.rows.find(row=>row.row===item.row);
              if(!current)throw new Error('Задание не найдено.');
              const history=item.department==='roll' ? await readRollStockHistory(services.reader,id) : null;
              return stockTaskReadiness(item,current,fresh,history);
            },
            archive:plan=>writer.closeStockTask(plan),
            verifyArchive:op=>verifyArchivedStockClose(services.reader,id,op),
          });
          if(result.status==='verified' && prior?.status!=='verified') appendAudit(scope,principal,path,result);
          return result;
        } catch(error) {
          const message=error.message||'Не удалось проверить задание.';
          if(readySource && !records.get(input.operationId)) return {id:input.operationId,status:'not_saved',message};
          throw new CloudError('stock_close_unavailable',message,409);
        }
      },{waitMs:3000});
      return json({ok:true,operation});
    }
    if(path==='/api/stocks/close/batch') {
      methods(request,['POST']);
      if(assemblyControlApp||bridgeId)throw new CloudError('stock_manager_scope_required','Действие доступно только из RITM.',403);
      const items=stockCloseBatchInput(await readJson(request,8192));
      const manager=principal?.displayName||principal?.username||'RITM';
      const results=await store.withScope(async scope=>{
        const services=await createServices(bindings,scope,{fetcher,manager});
        await services.guard();
        const alreadyClosed=new Set(items.filter(item=>scope.operations.get('stock-close:'+item.operationId)?.value?.status==='verified').map(item=>item.operationId));
        const receipts=await runStockCloseBatch(items,{scope,services,bindings,manager});
        for(const receipt of receipts)if(receipt.status==='verified'&&!alreadyClosed.has(receipt.id))appendAudit(scope,principal,path,receipt);
        return receipts.map(({id,status,message})=>({id,status,message}));
      },{waitMs:3000});
      return json({ok:true,results});
    }
    if (path === '/api/stocks/preview') {
      methods(request,['POST']);
      const input=await readJson(request),boxId=sourceId(bindings,'stockBoxPrintingId'),rollId=sourceId(bindings,'stockRollPrintingId');
      if(!boxId||!rollId)throw new CloudError('stock_sources_unconfigured','Таблицы запасов ещё не подключены.',503);
      const scope=await store.scope(),services=await createServices(bindings,scope,{fetcher});
      if(!services.reader.configured||!services.writers?.roll)throw new CloudError('stock_reader_unavailable','Не удалось подключиться к базе и таблицам запасов.',503);
      try {
        const preview=await services.stock().preview(input);
        return json({ok:true,preview});
      } catch(error) { if(error?.code)throw error;throw new CloudError('stock_preview_invalid',error instanceof Error?error.message:'Не удалось проверить список запасов.',409); }
    }
    if(path==='/api/stocks'){
      methods(request,['POST']);
      if(assemblyControlApp||bridgeId)throw new CloudError('stock_manager_scope_required','Действие доступно только из RITM.',403);
      const input=await readJson(request);
      const result=await store.withScope(async scope=>{
        const services=await createServices(bindings,scope,{fetcher,manager:principal?.displayName||principal?.username||'RITM'});
        try{
          await services.guard();
          for (const record of [...scope.operations.values()].filter(r=>r.kind==='stock-close' && ['writing','uncertain'].includes(r.value?.status))) {
            const close = record.value;
            const doc = sourceId(bindings,close.department === 'box' ? 'stockBoxPrintingId' : close.department === 'roll' ? 'stockRollPrintingId' : '');
            let proof = null;
            try { if (doc) proof = await verifyArchivedStockClose(services.reader,doc,close); } catch { /* leave uncertain */ }
            if (proof) {
              scope.putOperation('stock-close',{...close,status:'verified',closedAt:proof.closedAt,message:undefined});
              await services.guard();
            }
          }
          if([...scope.operations.values()].some(r=>r.kind==='stock-close'&&!['verified','not_saved'].includes(r.value?.status)))throw new CloudError('stock_close_pending','Сначала необходимо сверить результат закрытия задания.',409);
          const operation=await services.stock().execute(input);
          appendAudit(scope,principal,path,operation);
          return {operation};
        }catch(error){
          if(!scope.operations.has('stock:'+String(input?.operationId||'')))return {notSaved:true,message:error?.code?error.message:'Не удалось проверить данные. Изменения не отправлены.'};
          throw error;
        }
      });
      if(result.operation?.status==='verified' && ctx?.waitUntil)ctx.waitUntil(drainBitrixNotifications(bindings,store,fetcher).catch(()=>{}));
      return json({ok:true,...result});
    }
    if (path === "/api/cloud/export") { methods(request,["GET"]);return json(await exportCloud(bindings,store)); }
    if (path === "/api/cloud/state") {
      methods(request, ["GET"]); const scope=await store.scope();
      return json({ok:true,migrationReady:scope.meta("migrationReady")===true,cutover:scope.meta("cloudCutover")||null,productionOperations:scope.meta("productionSupplyOperations")?.length||0,rollOperations:[...scope.operations.values()].filter(row=>row.kind==="roll").length,syncEvents:scope.events.size,pendingSync:scope.syncEvents().filter(row=>!row.delivered_at).length});
    }
    if (path === "/api/cloud/cutover") { methods(request,["POST"]);return json(await recordCutover(await readJson(request),bindings,store)); }
    if (path === "/api/cloud/maintenance") { methods(request,["POST"]); const input=await readJson(request);return json(await maintenance(bindings,store,{fetcher,refresh:input.refresh===true})); }
    if (path === "/api/cloud/bridge-lease") {
      methods(request, ["GET", "POST"]);
      return json(await externalLease(request, request.method === "POST" ? await readJson(request) : null, bridgeId, bindings, store));
    }
    if (path === "/api/cloud/registry") {
      methods(request, ["GET"]);
      const scope = await store.scope();
      if (scope.meta("migrationReady") !== true) throw new CloudError("migration_not_imported", "Реестр ещё не перенесён. Локальное состояние сохранено.", 503);
      const transfer = new AssemblyTransferService(scope, { backfill: false });
      return json({ ok: true, registeredSheets: scope.meta("rollPrintingAdditionalSheets") || [], productionSupplies: scope.meta("productionSupplies") || [], assemblyBoxLinks: transfer.links() });
    }
    if (path === "/api/production-controls") {
      methods(request, ["GET", "POST"]);
      if (assemblyControlApp || bridgeId) throw new CloudError("control_manager_scope_required", "Это действие доступно только из RITM.", 403);
      if (request.method === "GET") {
        if (url.searchParams.get('view') === 'bitrix-recipients')
          return json({ ok: true, recipients: await listBitrixRecipients(await taskBitrixConfig(bindings, store), fetcher) });
        const scope = await store.scope();
        const shipmentIds = url.searchParams.getAll("shipmentId").concat((url.searchParams.get("shipmentIds") || "").split(",").filter(Boolean));
        return json({ ok: true, controls: listProductionControls(scope, shipmentIds) });
      }
      const input = await readJson(request);
      let reminderRecipient;
      if (['create', 'create-batch'].includes(input?.action) && input.bitrixReminder !== undefined) {
        const reminder = normalizeProductionTaskReminder(input.bitrixReminder, input.action === 'create-batch' ? 'article' : input.scope);
        const id = String(input.requestId || '').trim();
        if (!/^[a-f0-9-]{36}$/i.test(id)) throw new CloudError('control_request_invalid', 'Обновите форму и повторите сохранение задачи.', 400);
        const history = await store.operationReadScope(TASK_REMINDER_KIND, id);
        if (!history.operations.has(TASK_REMINDER_KIND + ':' + id))
          reminderRecipient = await readBitrixRecipient(await taskBitrixConfig(bindings, store), reminder.recipientId, fetcher);
      }
      const result = await store.withScope(async (scope) => {
        if (scope.meta("migrationReady") !== true) throw new CloudError("migration_not_imported", "Реестр поставок ещё не готов. Задача не сохранена.", 503);
        let value;
        if (input?.action === "cancel") value = cancelProductionControl(scope, input);
        else if (input?.action === "cancel-batch") value = cancelProductionControlBatch(scope, input);
        else if (input?.action === "create") value = createProductionControl(scope, input, { owner: principal?.displayName || principal?.id || "RITM", reminderRecipient });
        else if (input?.action === "create-batch") value = createProductionControlBatch(scope, input, { owner: principal?.displayName || principal?.id || "RITM", reminderRecipient });
        else throw new CloudError("control_action_invalid", "Неизвестное действие с задачей.", 400);
        if (Array.isArray(value.controls)) value.controls.forEach((control) => appendAudit(scope, principal, path, control));
        else appendAudit(scope, principal, path, value.control);
        return value;
      });
      return json({ ok: true, ...result });
    }
    if (path === "/api/shipment-locks") {
      methods(request, ["GET", "POST"]);
      if (assemblyControlApp || bridgeId) throw new CloudError("shipment_lock_manager_scope_required", "Управлять замком поставки можно только в RITM.", 403);
      if (request.method === "GET") {
        const shipmentIds = url.searchParams.getAll("shipmentId").concat((url.searchParams.get("shipmentIds") || "").split(",").filter(Boolean));
        return json({ ok: true, locks: listShipmentLocks(await store.scope(), shipmentIds) });
      }
      const input = await readJson(request, 4096);
      if (!["lock", "unlock"].includes(input?.action)) throw new CloudError("shipment_lock_action_invalid", "Выберите, закрыть или открыть поставку.", 400);
      if (!assemblyV2Configured(bindings) || !bindings.RITM_ASSEMBLY_V2_TARGET_TOKEN)
        throw new CloudError("assembly_v2_unconfigured", "Связь с «RITM Сборка» не настроена. Замок не изменён.", 503);
      const shipmentIds = normalizeShipmentIds(input.shipmentIds);
      const currentSnapshot = await currentShipmentLockSnapshot(bindings, store, { fetcher });
      const active = activePrintingShipmentIds(currentSnapshot.value);
      if (!active || shipmentIds.some((id) => !active.has(id)))
        throw new CloudError("shipment_lock_shipment_unavailable", "Поставка изменилась или больше не активна. Обновите RITM.", 409);
      const result = await store.withScope(async (scope) => {
        if (scope.meta("migrationReady") !== true) throw new CloudError("migration_not_imported", "Реестр поставок ещё не готов. Замок не изменён.", 503);
        const value = await setShipmentLocks(scope, {
          shipmentIds,
          locked: input.action === "lock",
          requestId: input.requestId,
          name: input.shipmentName,
          changedBy: principal?.displayName || principal?.username || "RITM",
          now: () => Math.max(store.now(), currentSnapshot.at + 1),
        });
        if (value.confirmed) appendAudit(scope, principal, path, { id: value.locks[0]?.eventId || "unchanged" });
        return value;
      });
      if (ctx?.waitUntil) ctx.waitUntil(updateAssemblyAfterSupplyWrite(bindings, store, fetcher));
      return json({ ok: true, ...result }, result.confirmed ? 200 : 202);
    }
    if (path === "/api/assembly-stocks") {
      methods(request,["GET"]);
      const reader = new CloudSheetsReader(bindings,{fetcher});
      const load = () => readAssemblyStocks({reader,boxId:sourceId(bindings,'stockBoxPrintingId'),rollId:sourceId(bindings,'stockRollPrintingId')});
      return json(url.searchParams.get("view") === "forecast"
        ? await forecastStocks(store,load,ctx?.waitUntil ? task=>ctx.waitUntil(task) : null,url.searchParams.get("refresh")==="1")
        : await load());
    }
    if (path === "/api/arkady/catalog") {
      methods(request, ["POST"]);
      return json(await arkadyCatalog(await readJson(request, 4096), {
        bindings, principal, writesEnabled: config.writesEnabled, fetcher,
      }));
    }
    if (path === "/api/arkady/catalog/wb-intake") {
      methods(request, ["POST"]);
      if (!principal || !["owner", "manager"].includes(principal.role))
        throw new CloudError("arkady_wb_intake_forbidden", "Проверка карточки WB доступна в РИТМ.", 403);
      return json(await arkadyWbIntake(await readJson(request, arkadyWbIntakeMaxBytes), {
        bindings, principal, writesEnabled: config.writesEnabled, fetcher,
      }));
    }
    if (path === "/api/assembly-only-catalog") {
      methods(request,["GET"]);
      if (assemblyControlApp || bridgeId) throw new CloudError("catalog_access_forbidden", "Поиск доступен только в RITM.",403);
      const shipmentId=url.searchParams.get("shipmentId")||"";
      const snapshot=await currentShipmentLockSnapshot(bindings,store,{fetcher});
      const source=(snapshot.value.sheets||[]).find(sheet=>(sheet.assemblyShipmentId || `RITM-${sheet.sourceId === 'box-printing' ? 'BOX' : 'ROLL'}-${sheet.sheetId}`)===shipmentId);
      if(!source)throw new CloudError("catalog_supply_missing","Поставка недоступна.",409);
      const market=/^OZON/i.test(String(source.name||''))?'OZON':/^WB/i.test(String(source.name||''))?'WB':'';
      const articles=url.searchParams.getAll('article');
      return json({ok:true,items:await readAssemblyItemCatalog(bindings,market,articles,fetcher)});
    }
    if (path === "/api/assembly-only-items") {
      methods(request, ["GET", "POST"]);
      if (bridgeId || (assemblyControlApp && request.method !== "GET")) throw new CloudError("assembly_item_forbidden", "Недостаточно прав для изменения товаров.", 403);
      if (request.method === "GET") return json({ok:true, items:listAssemblyOnlyItems(await store.scope(), url.searchParams.get("shipmentId") || "")});
      const input=await readJson(request,4096);
      if(input?.action === 'remove') {
        const result=await store.withScope(scope=>removeAssemblyOnlyItem(scope,input,{owner:principal?.displayName||principal?.username||'RITM',deliver:event=>deliverAssemblyOnlyRemoval(bindings,event,fetcher)}));
        return json({ok:true,...result},result.confirmed?200:202);
      }
      const snapshot=await currentShipmentLockSnapshot(bindings,store,{fetcher});
      const active=activePrintingShipmentIds(snapshot.value), shipmentId=String(input?.shipmentId||'');
      if (!active || !active.has(shipmentId)) throw new CloudError("assembly_item_shipment_unavailable", "Поставка изменилась или недоступна. Обновите данные.", 409);
      const sheetIdentity = sheet => sheet.assemblyShipmentId || `RITM-${sheet.sourceId === 'box-printing' ? 'BOX' : 'ROLL'}-${sheet.sheetId}`;
      const targetNames = new Set((snapshot.value.sheets || []).filter(sheet => sheetIdentity(sheet) === shipmentId).map(sheet => sheet.name).filter(Boolean));
      const orders=(snapshot.value.supplies||[]).filter(o => sheetIdentity(o)===shipmentId || targetNames.has(o.sheetName));
      const result=await store.withScope(async scope=>{
        if(scope.meta("migrationReady")!==true) throw new CloudError("migration_not_imported","Реестр поставок ещё не готов.",503);
        const value=createAssemblyOnlyItem(scope,input,{owner:principal?.displayName||principal?.username||'RITM',orders});
        appendAudit(scope,principal,path,value.item);return value;
      });
      return json({ok:true,...result});
    }
    if (path === "/api/assembly-controls") {
      methods(request, ["GET"]);
      if (!assemblyControlApp) throw new CloudError("assembly_control_auth_required", "Запрос должен прийти из RITM Assembly.", 403);
      const shipmentId = url.searchParams.get("shipmentId") || "";
      const scope = await store.scope();
      return json({ ok: true, controls: listAssemblyControls(scope, shipmentId), shipmentLock: listShipmentLocks(scope, shipmentId ? [shipmentId] : [])[0] || null });
    }
    if (path === "/api/assembly-controls/complete") {
      methods(request, ["POST"]);
      if (!assemblyControlApp) throw new CloudError("assembly_control_auth_required", "Запрос должен прийти из RITM Assembly.", 403);
      const input = await readJson(request);
      const result = await store.withScope(async (scope) => completeAssemblyControl(scope, input));
      return json({ ok: true, ...result });
    }
    if (path.startsWith("/api/intelligence/")) {
      throw new CloudError("intelligence_local_only", "AI Center пока работает в локальном RITM на рабочем компьютере.", 503);
    }
    if (path === "/api/cloud/import") {
      methods(request, ["POST"]);
      const input = await readJson(request, 12000000);
      if (input.explicitImportApproval !== true) throw new CloudError("import_confirmation_required", "Подтвердите импорт проверенного снимка.", 400);
      return json(await importMigration(input.envelope, bindings, store));
    }
    if (path === "/api/printing") {
      methods(request, ["GET"]);
      if (url.searchParams.get("view") === "box-sheets") {
        if (!["owner", "manager"].includes(principal?.role))
          throw new CloudError("manager_required", "Число листов доступно владельцу и менеджеру RITM.", 403);
        return json(await readLiveBoxSheetReport(
          new CloudSheetsReader(bindings, { fetcher }),
          sourceId(bindings, "boxPrintingId"),
          store,
        ));
      }
      if (url.searchParams.get("view") === "work") {
        if (!["owner", "manager"].includes(principal?.role))
          throw new CloudError("manager_required", "Журнал печати доступен в RITM владельцу и менеджеру.", 403);
        const month = url.searchParams.get("month");
        if (!isPrintingWorkMonth(month)) throw new CloudError("printing_work_month_invalid", "Укажите месяц журнала.", 400);
        return json(await readD1PrintingWork(bindings, store, month, fetcher));
      }
      return json(await readSnapshot("printing", url, bindings, store, {
        fetcher, onFreshPrinting: ctx?.waitUntil && (principal?.role === "owner" || principal?.role === "manager")
          ? report => ctx.waitUntil((async () => {
            await reconcileProductionTabs(bindings, store, report, fetcher).catch(() => {});
            if (url.searchParams.get("refresh") === "1" && !report.stale)
              await syncProductionSheetCatalog(bindings, store, { fetcher, dryRun: false }).catch(() => {});
            if (!report.stale)
              await syncProductionSheetCatalog(bindings, store, { fetcher, dryRun: false, stockOnly: true }).catch(() => {});
          })()) : null,
      }));
    }
    if (path === "/api/production-tabs") {
      methods(request, ["GET", "POST"]);
      if (principal?.role !== "owner" && principal?.role !== "manager")
        throw new CloudError("production_tab_manager", "Управление вкладками доступно руководителю.", 403);
      const change = request.method === "POST";
      const input = change ? await readJson(request, 2048) : {
        department: url.searchParams.get("department"), sheetId: Number(url.searchParams.get("sheetId")), name: url.searchParams.get("name"),
      };
      return json(await productionTabVisibility(input, { bindings, store, fetcher, change }));
    }
    if (path === "/api/cloud/production-extensions") {
      methods(request, ["POST"]);
      if (!bridgeId && principal?.role !== "owner")
        throw new CloudError("owner_required", "Импорт доступен только владельцу.", 403);
      const input = await readJson(request, 90000);
      if (input.explicitWriteApproval !== true || !Array.isArray(input.rows) || input.rows.length > 500)
        throw new CloudError("production_extensions_invalid", "Подтвердите пакет импорта расширений.", 400);
      return json(await importAssemblyProductionExtensions(bindings, input.rows, fetcher));
    }
    if(path==='/api/warehouse/export'||path==='/api/warehouse/exports'){
      if(principal?.role!=='owner'&&principal?.role!=='manager')throw new CloudError('manager_required','Выгрузки доступны владельцу и менеджеру.',401);
      if(path.endsWith('/exports')){methods(request,['GET']);return json({ok:true,...(url.searchParams.get('id')?{snapshot:await readWarehouseExports(bindings.DB,url.searchParams.get('id'))}:{exports:await readWarehouseExports(bindings.DB)})});}
      methods(request,['POST']);
      return json({ok:true,snapshot:await prepareWarehouseExport(await readJson(request,2_000_000),bindings,store,{actor:principal.id||principal.username||'owner',fetcher})});
    }
    if (path === "/api/warehouse") {
      methods(request, ["GET"]);
      const modernPromise=readAssemblyV2Warehouse(bindings,store,{fetcher,force:url.searchParams.get('refresh')==='1'});
      let snapshot;
      try {
        const printing = await readSnapshot("printing", url, bindings, store, { fetcher });
        snapshot = await readWarehouseSnapshot(url, bindings, store, {
          fetcher, activeShipmentIds: activeWarehouseShipmentIds(printing),
          shipmentInfo: activeWarehouseShipmentInfo(printing),
          rosterStale: printing.stale === true || printing.refreshFailed === true,
        });
      }catch(error){
        const cached=await store.snapshot('warehouse');
        snapshot={...(cached?.value||{ok:true,schemaVersion:1,checkedAt:new Date(store.now()).toISOString(),cartons:[],stockCartons:[],cancelledCount:0,issues:[],catalogAvailable:true}),stale:true,staleReason:'Архив сборки временно недоступен. Состав архивных коробов нужно проверить.'};
        delete snapshot.activeShipmentIds;delete snapshot.activeShipmentFingerprint;
      }
      const [dispatch, savedCartons] = await Promise.all([listWarehouseCartonDispatch(bindings.DB), listWarehouseDispatchSnapshots(bindings.DB)]);
      const cartons = snapshot.cartons.map((carton) => {
        const state = dispatch.get(carton.id);
        return {
          ...(state?.status === "sent" && state.shipmentId === carton.shipmentId ? savedCartons.get(carton.id) || carton : carton),
          dispatchStatus: state?.shipmentId === carton.shipmentId ? state.status : "pending",
          sentAt: state?.shipmentId === carton.shipmentId ? state.sentAt : null,
          dispatchChangedAt: state?.shipmentId === carton.shipmentId ? state.changedAt : null,
          dispatchChangedBy: state?.shipmentId === carton.shipmentId ? state.changedBy : null,
        };
      });
      const known = new Set(cartons.map(box => box.id));
      for (const [id, saved] of savedCartons) {
        const state = dispatch.get(id);
        if (!known.has(id) && state?.status === "sent" && state.shipmentId === saved.shipmentId)
          cartons.push({ ...saved, dispatchStatus: "sent", sentAt: state.sentAt, dispatchChangedAt: state.changedAt, dispatchChangedBy: state.changedBy, archivedSourceUnavailable: true });
      }
      const modern = await modernPromise;
      const legacy = { ...snapshot, cartons };
      const merged = mergeAssemblyWarehouses(legacy, modern);
      const visible = new Set(merged.cartons.map(box => box.id));
      const archivedCartons = reconcileArchivedWarehouse(legacy, modern, dispatch).filter(box => !visible.has(box.id));
      return json({ ...merged, archivedCartons });
    }
    if (path === "/api/warehouse/dispatch") {
      methods(request, ["POST"]);
      if (principal?.role !== "owner" && principal?.role !== "manager")
        throw new CloudError("manager_required", "Войдите в RITM как владелец или менеджер, чтобы изменить статус короба.", 401);
      const input = await readJson(request, 204800);
      const cartonId = typeof input?.cartonId === "string" ? input.cartonId.trim() : "";
      const shipmentId = typeof input?.shipmentId === "string" ? input.shipmentId.trim() : "";
      const status = input?.status;
      if (!cartonId || !shipmentId || !["sent", "pending"].includes(status))
        throw new CloudError("warehouse_dispatch_invalid", "Укажите короб, поставку и нужный статус.", 400);

      const snapshot = await warehouseForSelection([cartonId],bindings,store,{fetcher});
      const carton = snapshot.cartons.find((row) => row.id === cartonId && row.shipmentId === shipmentId);
      if (!carton) throw new CloudError("warehouse_carton_not_found", "Короб или поставка уже изменились. Обновите склад.", 404);
      if (input.fingerprint !== undefined && (typeof input.fingerprint !== 'string' || input.fingerprint.length > 200000 || warehouseCartonFingerprint(carton) !== input.fingerprint))
        throw new CloudError('warehouse_carton_changed', 'Состав короба изменился. Обновите его перед отправкой.', 409);
      if (status === "sent" && carton.status !== "closed")
        throw new CloudError("warehouse_carton_not_closed", "Отправить можно только закрытый короб.", 409);
      if(carton.sourceSystem==='assembly-v2')return json({ok:true,dispatch:await dispatchAssemblyV2(carton,{key:input.commandKey,status,changedBy:principal.displayName||principal.username||principal.id||'Менеджер'},bindings,{fetcher})});
      const updated = await setWarehouseCartonDispatch(bindings.DB, {
        cartonId,
        shipmentId,
        status,
        changedBy: principal.displayName || principal.username || principal.id || "Менеджер",
        cartonSnapshot: status === "sent" ? carton : null,
      });
      return json({ ok: true, dispatch: updated });
    }
    if (path === "/api/warehouse/dispatch/batch") {
      methods(request, ["POST"]);
      if (principal?.role !== "owner" && principal?.role !== "manager")
        throw new CloudError("manager_required", "Войдите как владелец или менеджер.", 401);
      const input = await readJson(request, 2000000);
      const requested = Array.isArray(input?.cartons) ? input.cartons : [];
      if (!requested.length || requested.length > 500 || requested.some(row => typeof row?.cartonId !== "string" || !row.cartonId.trim() || row.cartonId.length > 160 || typeof row?.shipmentId !== "string" || !row.shipmentId.trim() || row.shipmentId.length > 200 || typeof row?.fingerprint !== "string" || row.fingerprint.length > 200000))
        throw new CloudError("warehouse_dispatch_invalid", "Укажите от 1 до 500 подтверждённых коробов.", 400);
      if (new Set(requested.map(row => row.cartonId)).size !== requested.length)
        throw new CloudError("warehouse_dispatch_duplicate", "Один короб указан несколько раз. Проверьте список.", 400);
      const snapshot = await warehouseForSelection(requested.map(row=>row.cartonId),bindings,store,{fetcher});
      const current = validateWarehouseBatch(requested, snapshot.cartons);
      const saved = await listWarehouseCartonDispatch(bindings.DB);
      const results = [];
      for (const item of requested) {
        const previous = saved.get(item.cartonId);
        const box=current.get(item.cartonId);
        if (box.dispatchStatus==='sent'||(box.sourceSystem!=='assembly-v2'&&previous?.status === "sent" && previous.shipmentId === item.shipmentId)) { results.push({ cartonId: item.cartonId, status: "already_sent" }); continue; }
        try {
          if(box.sourceSystem==='assembly-v2')await dispatchAssemblyV2(box,{key:item.commandKey,status:'sent',changedBy:principal.displayName||principal.username||principal.id||'Менеджер'},bindings,{fetcher});
          else await setWarehouseCartonDispatch(bindings.DB, { cartonId:item.cartonId, shipmentId:item.shipmentId, status:"sent", changedBy:principal.displayName || principal.username || principal.id || "Менеджер", cartonSnapshot:box });
          results.push({ cartonId:item.cartonId, status:"sent" });
        } catch (error) {
          results.push({ cartonId:item.cartonId, status:"unconfirmed", message:"Не удалось подтвердить сохранение. Обновите склад перед повтором." });
        }
      }
      return json({ ok:true, results });
    }
    const getPaths = ["/api/roll-supplies/status", "/api/roll-supplies/operations", "/api/assembly-transfers/sources", "/api/assembly-transfers/links", "/api/assembly-transfers/source", "/api/assembly-transfers/operation"];
    if (getPaths.includes(path)) {
      methods(request, ["GET"]);
      if(path==='/api/roll-supplies/operations'&&url.searchParams.get('departmentMoves')==='1'){
        const scope = await store.operationReadScope('production-department-move');
        const moves=[...scope.operations.values()].filter(row=>row.kind==='production-department-move'&&!['verified','cancelled'].includes(row.value.status)).map(row=>productionMoveSummary(row.value));
        return json({ok:true,moves});
      }
      if (path === "/api/roll-supplies/operations" && url.searchParams.has("removalId")) {
        const id = url.searchParams.get("removalId");
        if (!/^[a-f0-9-]{36}$/i.test(id)) throw new CloudError("roll_remove_invalid", "Неверный номер запроса.", 400);
        const scope = await store.operationReadScope("roll", id);
        const op = scope.rollSupplyOperation(id);
        if (op?.action !== "removeItem") return json({ok:true,operation:null});
        if (!["verified", "failed"].includes(op.status) && ctx?.waitUntil && !await store.leaseIsActive("production")) {
          ctx.waitUntil((async () => {
            if (await recoverPendingRollRemovals(bindings, store, fetcher, id))
              await updateAssemblyAfterSupplyWrite(bindings, store, fetcher);
          })().catch(() => {}));
        }
        return json({ok:true,operation:{id,status:op.status,message:op.result?.message || null}});
      }
      const scope = await store.scope();
      if(path==='/api/roll-supplies/status'&&url.searchParams.get('stockRollPanelHealth')==='1'){
        if(!bridgeId&&principal?.role!=='owner')throw new CloudError('owner_required','Диагностика доступна только владельцу.',403);
        // Existing authenticated health action reads the stock panel, never
        // creates rolls or modifies work. Credentials remain inside the worker.
        const health=await createStockGateway({url:bindings.RITM_STOCK_ROLL_GATEWAY_URL,token:bindings.RITM_STOCK_ROLL_GATEWAY_TOKEN,fetcher,beforeWrite:async()=>{}}).health();
        return json({ok:true,status:health.status,panelCheck:Array.isArray(health.panelCheck)?health.panelCheck.map(row=>({sheetId:row.sheetId,status:row.status,article:row.article,quantity:row.quantity,rolls:row.rolls,printed:row.printed,cut:row.cut})):null});
      }
      // Bounded operational diagnostics through the existing authenticated
      // supply-status route; never expose sheet-cell backups or credentials.
      const services = await createServices(bindings, scope, { fetcher });
      if (path.startsWith("/api/roll-supplies")) {
        const state = services.state();
        const leaseBusy = await store.leaseIsActive("production");
        return json({
          ...state,
          assemblyV2Sync:await supplyDeliveryStatus(store),
          busy: state.busy || leaseBusy,
          production: state.production
            ? { ...state.production, busy: state.production.busy || leaseBusy }
            : state.production,
        });
      }
      if (path.endsWith("/links")) return json({ ok: true, links: currentBoxLinks(services.transfer.links(), scope) });
      if (path.endsWith("/sources")) return json({ ok: true, sources: await services.transfer.sources() });
      if (path.endsWith("/source")) return json({ ok: true, source: await services.transfer.source(url.searchParams.get("department"), Number(url.searchParams.get("sheetId"))) });
      return json({ ok: true, operation: services.transfer.operation(url.searchParams.get("id")) });
    }
    if(path === '/api/production-moves/batch'){
      if(request.method==='GET')return json({ok:true,batch:lookupMoveBatch(await store.operationReadScope('production-department-move-batch',url.searchParams.get('id')),url.searchParams)});
      methods(request,['POST']);
      const input=await readJson(request);
      const result=await store.withScope(async scope=>{
        const services=await createServices(bindings,scope,{fetcher,manager:principal?.displayName||'RITM'});
        await services.guard();
        if(services.production.operations().some(o=>!['verified','cancelled'].includes(o.status)))throw new CloudError('production_operation_pending','Сначала завершите текущую операцию поставки.',409);
        if(input.action==='cancel'&&Object.keys(input).sort().join()!=='action,operationId')throw new CloudError('move_batch_invalid','Неверная отмена списка.',400);
        const batch=input.action==='cancel'?await cancelMoveBatch(input.operationId,{bindings,scope,services,fetcher}):await advanceMoveBatch(input,{bindings,scope,services,fetcher,groupSize:bindings.RITM_MOVE_GROUPS_ENABLED==='true'?10:1});
        appendAudit(scope,principal,path,batch);await scope.checkpoint();
        return {ok:true,batch};
      },{waitMs:5000});
      if(result.batch?.status === "complete" && result.batch.results.some(row => row.status === "verified") && ctx?.waitUntil)
        ctx.waitUntil(updateAssemblyAfterSupplyWrite(bindings,store,fetcher));
      return json(result);
    }
    if(path === '/api/box-position-removal'){
      if(request.method==="GET"){
        if(ctx?.waitUntil) ctx.waitUntil(recoverPendingBoxRemoval(bindings,store,{fetcher}).catch(()=>{}));
        const id=url.searchParams.get("id");
        if(id && !/^[a-f0-9-]{36}$/i.test(id)) throw new CloudError("box_remove_invalid","Неверный номер запроса.",400);
        const scope=await store.operationReadScope(boxRemovalKind,id);
        return json({ok:true,operation:boxRemovalStatus(id ? scope.operations.get(boxRemovalKind+":"+id)?.value : pendingBoxRemoval(scope))});
      }
      methods(request,["POST"]);
      const input=await readJson(request);
      const operation=await resumeBoxRemoval(bindings,store,input,{fetcher});
      if(operation.status==="verified" && ctx?.waitUntil)
        ctx.waitUntil(updateAssemblyAfterSupplyWrite(bindings,store,fetcher));
      return json({ok:true,operation:boxRemovalStatus(operation)},operation.status==="checking"?202:200);
    }
    if(path === '/api/production-moves'){
      if(request.method==='GET') {const scope=await store.operationReadScope('production-department-move',url.searchParams.get('id'));const op=lookupProductionMove(scope,url.searchParams);return json({ok:true,operation:op?{id:op.id,status:op.status,input:op.input,message:op.message||null,steps:op.steps,destinationRow:op.proof?.plan?.destination?.startRow,destinationUid:op.proof?.plan?.destination?.uids?.[0]?.uid,preserveExistingRows:op.proof?.plan?.destination?.preserveExistingRows===true}:null});}
      methods(request,['POST']);
      const input=await readJson(request);
      if(input.action==='cancel'){if(Object.keys(input).sort().join()!=='action,operationId')throw new CloudError('move_input_invalid','Неверная отмена.',400);const result=await store.withScope(async scope=>{const services=await createServices(bindings,scope,{fetcher});await services.guard();return cancelProductionMove(input.operationId,{scope,services,bindings,fetcher});},{waitMs:5000});return json({ok:true,operation:{id:result.id,status:result.status,message:result.message}});}
      const allowed=['operationId','shipmentId','uid','article','quantity','machine','extension','sourceDepartment'];
      const resume=input.action==='resume' && Object.keys(input).sort().join()==='action,operationId' && /^[a-f0-9-]{36}$/i.test(input.operationId);
      if(!resume && (Object.keys(input).some(k=>!allowed.includes(k))||allowed.filter(k=>k!=='sourceDepartment').some(k=>input[k]===undefined)))throw new CloudError('move_input_invalid','Не подтверждены параметры переноса.',400);
      const result=await store.withScope(async scope=>{
        const services=await createServices(bindings,scope,{fetcher,manager:principal?.displayName||'RITM'});
        await services.guard();
        if(services.production.operations().some(o=>!['verified','cancelled'].includes(o.status)))throw new CloudError('production_operation_pending','Сначала завершите текущую операцию поставки.',409);
        const savedInput=resume ? scope.operations.get('production-department-move:'+input.operationId)?.value?.input : input;
        if(!savedInput)throw new CloudError('move_missing','Перенос не найден.',404);
        const operation=await executeProductionMove(savedInput,{bindings,scope,services,fetcher});
        appendAudit(scope,principal,path,operation);await scope.checkpoint();return {ok:true,operation:{id:operation.id,status:operation.status,input:operation.input,message:operation.message||null,steps:operation.steps}};
      },{waitMs:5000});
      if(result.operation.status === "verified" && ctx?.waitUntil)
        ctx.waitUntil(updateAssemblyAfterSupplyWrite(bindings,store,fetcher));
      return json(result);
    }
    if (["/api/assembly-transfers", "/api/assembly-transfers/preview"].includes(path))
      throw new CloudError("legacy_supply_delivery_disabled", "«RITM Сборка» получает поставки автоматически.", 410);
    const writePaths = ["/api/roll-supplies", "/api/roll-supplies/preview"];
    if (writePaths.includes(path)) {
      methods(request, ["POST"]);
      const input = await readJson(request);
      if (path === "/api/roll-supplies/preview") {
        const preview = await store.withRoutingPreview(async scope => {
          const services = await createServices(bindings, scope, { fetcher });
          return services.production.preview(input);
        });
        return json({ ok: true, preview });
      }
      const reconcileMove=path==='/api/roll-supplies'&&input?.action==='finalizeDepartmentMove';
      if(reconcileMove&&(!bridgeId&&principal?.role!=='owner'))throw new CloudError('owner_required','Служебная сверка доступна владельцу RITM.',403);
      if(reconcileMove&&(Object.keys(input).sort().join()!=='action,operationId'||!/^[-a-f0-9]{36}$/i.test(input.operationId||'')))throw new CloudError('move_input_invalid','Не подтверждён ID существующего переноса.',400);
      const routedSupply = path === "/api/roll-supplies" && ["create", "append", "resume", "deletePart", "deleteSupply", "cancelAbsentCreate"].includes(input?.action);
      const result = await store.withScope(async (scope) => {
        // Routed supply writes have fresh catalog/template/readback checks.
        // Keeping the entire reporting snapshot alive alongside their plans
        // and historical journal can exceed the Worker's memory limit.
        const itemWrite = path === "/api/roll-supplies" && ["updateItem", "removeItem"].includes(input.action);
        const cached = routedSupply || itemWrite ? null : await store.snapshot("printing");
        const refresh = current => refreshSnapshot("printing", bindings, store, { scope: current, fetcher });
        const services = await createServices(bindings, scope, { fetcher, manager: principal?.displayName || principal?.username || 'RITM', printing: cached?.value || null, refresh,
          readItemSnapshot: itemWrite ?
            (reader,payload) => readSupplyForWrite(bindings,store,scope,reader,{department:"roll",sheetId:payload.sheetId,name:payload.name}) : null,
        });
        let value;
        try {
          await services.guard();
          if(reconcileMove){
            const op=await finalizeConfirmedProductionMove(input.operationId,{bindings,scope,services,fetcher});
            appendAudit(scope,principal,path,op);await scope.checkpoint();
            return {ok:true,operation:productionMoveSummary(op)};
          }
          // Creation only allocates new sheets after checking their titles and IDs.
          // A retry must belong to the same saved creation; moves on that
          // shipment still conflict. Existing-sheet actions retain their guard.
          const previous = routedSupply && scope.operations.get("production:" + input.operationId)?.value;
          const newSheets = routedSupply && (previous
            ? ["create", "resume"].includes(input.action) && previous.action === "create"
            : input.action === "create");
          if (!newSheets && (path !== '/api/roll-supplies' ||
              !['updateItem','removeItem'].includes(input.action) ||
              boxRemovalOverlaps(scope,input.sheetId,'roll'))) requireNoBoxRemoval(scope);
          for (const { kind, value: move } of scope.operations.values()) {
            if (kind !== "production-department-move" || ["verified", "cancelled"].includes(move.status)) continue;
            const moveSupply = move.input?.shipmentId;
            const proof = move.proof?.plan?.proof;
            const overlaps = previous?.manifest?.parts?.some(part =>
              part.sheetId === proof?.[part.department]?.sheetId ||
              moveSupply === `RITM-${part.department.toUpperCase()}-${part.sheetId}`);
            if (!newSheets || !moveSupply || overlaps || moveSupply === (previous?.shipmentId || "RITM-SUPPLY-" + input.operationId))
              throw new CloudError("move_pending", "Сначала завершите сверку переноса артикула.", 409);
          }
          if (!routedSupply && services.production.operations().some((op) => !["verified", "cancelled"].includes(op.status))) throw new CloudError("production_operation_pending", "Сначала завершите сверку общей поставки.", 409);
          if (input?.action === "delete" && (scope.meta("productionSupplies") || []).some((supply) => supply.parts.some((part) => part.department === "roll" && part.sheetId === input.sheetId)))
            throw new CloudError("linked_supply_delete_forbidden", "Это часть общей поставки. Удалите производственный участок через его действие.", 409);
          value = routedSupply ? await services.production.execute(input) : await services.legacy.execute(input);
          appendAudit(scope, principal, path, value);
          await scope.checkpoint();
          return { ok: true, operation: value };
        } finally { services.savePreviews(); }
      }, { waitMs: routedSupply ? 5000 : 0, reportAdmission: routedSupply });
      if (result.operation && ctx?.waitUntil) ctx.waitUntil((async () => {
        await updateAssemblyAfterSupplyWrite(bindings,store,fetcher);
        if (!reconcileMove) {
          await drainBitrixNotifications(bindings, store, fetcher).catch(() => {});
        }
        const { action, status, name } = result.operation;
        if (status === "verified" && ["create", "append"].includes(action) && name) {
          await syncProductionSheetCatalog(bindings, store, { fetcher, dryRun: false, supplyName: name }).catch(() => {});
        }
      })().catch(() => {}));
      return json(result, result.operation?.status === "pending" ? 202 : 200);
    }
    throw new CloudError("cloud_route_pending", "Этот раздел ещё не прошёл перенос в облачную версию.", 503);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
    return json({ ok: false, error: error.code || "cloud_request_failed", message: error instanceof CloudError || error.code ? error.message : "Не удалось выполнить облачный запрос. Сохранённые данные не подменены нулями." }, status);
  }
}
