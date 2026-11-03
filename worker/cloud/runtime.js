import {createAssemblyOnlyItem, listAssemblyOnlyItems} from "./assemblyOnlyItems.js";
import { loadSource, todayMoscow, validateApi } from "../../agent/adapters.js";
import { selectAssemblyPeriod } from "../assembly.js";
import { cloudConfig, sourceId } from "./config.js";
import { CloudSheetsReader } from "./googleSheets.js";
import { CloudStore } from "./store.js";
import { CloudError, json, readJson, requireOwner, requireMaintenance } from "./access.js";
import { assertSameOrigin, changeManagerPin, createManagerUser, listManagerUsers, loginWithPin, logoutManager, resetManagerPin, resolvePrincipal, setManagerStatus } from "./auth.js";
import { createServices } from "./services.js";
import { AssemblyTransferService } from "../../agent/assemblyTransfer.js";
import { importMigration } from "./migration.js";
import { verifyAssemblyControlApp, verifyBridge } from "./bridge.js";
import { cancelProductionControl, cancelProductionControlBatch, completeAssemblyControl, createProductionControl, createProductionControlBatch, listAssemblyControls, listProductionControls } from "./productionControls.js";
import { externalLease } from "./externalLease.js";
import { recordCutover } from "./cutover.js";
import { exportCloud } from "./export.js";
import { activeWarehouseShipmentIds, readWarehouseSnapshot } from "./warehouse.js";
import { listWarehouseCartonDispatch, setWarehouseCartonDispatch } from "./warehouseDispatch.js";
import { activeShipmentIds as activePrintingShipmentIds, deliverShipmentLockEvent, listShipmentLocks, normalizeShipmentIds, setShipmentLocks } from "./shipmentLocks.js";

const signIn = "/?page=supplies";
const methods = (request, allowed) => { if (!allowed.includes(request.method)) throw new CloudError("method_not_allowed", "Метод запроса не поддерживается.", 405); };

function managerRouteAllowed(method, path) {
  if (method === "GET") return [
    "/api/assembly", "/api/printing", "/api/warehouse", "/api/cloud/registry",
    "/api/roll-supplies/status", "/api/roll-supplies/operations",
    "/api/assembly-transfers/sources", "/api/assembly-transfers/links",
    "/api/assembly-transfers/source", "/api/assembly-transfers/operation",
    "/api/production-controls",
    "/api/assembly-only-items",
    "/api/shipment-locks",
  ].includes(path);
  return method === "POST" && [
    "/api/roll-supplies", "/api/roll-supplies/preview",
    "/api/assembly-transfers", "/api/assembly-transfers/preview",
    "/api/warehouse/dispatch",
    "/api/production-controls",
    "/api/assembly-only-items",
    "/api/shipment-locks",
  ].includes(path);
}

function appendAudit(scope, principal, path, operation) {
  if (principal?.role !== "manager") return;
  const operationId = operation && typeof operation.id === "string" ? operation.id : "unknown";
  scope.log("manager_supply_write", `${principal.id} ${path} ${operationId}`);
}

export async function drainOutbox(bindings, store, fetcher = fetch) {
  return store.withScope(async (scope) => {
    const services = await createServices(bindings, scope, { fetcher });
    await services.guard();
    services.queue.recoverConfirmed();
    await services.queue.flush();
    return services.queue.state();
  });
}

export async function recoverPendingShipmentLock(bindings, store, fetcher = fetch) {
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
      deliver: (event) => deliverShipmentLockEvent(bindings, event, fetcher),
    });
    const remaining = [...scope.operations.values()].filter((row) => row.kind === "production-shipment-lock" && ["locking", "unlocking"].includes(row.value?.status));
    return { attempted: 1, confirmed: result.confirmed === true, remaining: new Set(remaining.map((row) => row.value.eventId)).size, eventId: record.eventId, shipmentIds: record.shipmentIds, targetLocked: record.targetLocked };
  });
}

export async function maintenance(bindings, store, { fetcher = fetch, refresh = true } = {}) {
  const result = { ok: true, assemblySync: null, deliverySkipped: !cloudConfig(bindings).writesEnabled };
  const diagnosticScope = await store.scope();
  result.pendingSupplyOperations = (diagnosticScope.meta("productionSupplyOperations") || []).filter((op) => !["verified", "cancelled"].includes(op.status)).map((op) => ({
    id: op.id, name: op.name, action: op.action, status: op.status, message: op.message,
    steps: (op.steps || []).map((step) => ({ department: step.department, status: step.status, message: step.message || null, sheetId: step.plan?.sheetId, action: step.plan?.action })),
  }));
  if (!result.deliverySkipped) result.assemblySync = await drainOutbox(bindings, store, fetcher);
  if (!result.deliverySkipped) {
    try { result.lockRecovery = await recoverPendingShipmentLock(bindings, store, fetcher); }
    catch (error) { result.lockRecovery = { attempted: 0, confirmed: false, error: error.code || "lock_recovery_failed" }; }
    result.ok = result.lockRecovery.confirmed === true;
  }
  if (refresh) {
    result.refreshed = [];
    for (const kind of ["printing", "assembly"]) {
      try { const value = await refreshSnapshot(kind, bindings, store, { fetcher }); result.refreshed.push({ kind, ok: value.refreshFailed !== true, snapshotAt: value.snapshotAt, failure: value.refreshFailure }); }
      catch (error) { result.refreshed.push({ kind, ok: false, error: error.code || "refresh_failed" }); }
    }
    result.ok = result.ok && result.refreshed.every(row => row.ok);
  }
  return result;
}
export async function refreshSnapshot(kind, bindings, store, { scope = null, fetcher = fetch } = {}) {
  const previous = await store.snapshot(kind);
  // Source reads are short. A canceled browser request must not block refreshes
  // for the full production-write lease window.
  const lease = await store.acquire("refresh:" + kind, 60000);
  try {
    const current = scope || await store.scope();
    if (!current.meta("migrationReady")) throw new CloudError("migration_not_imported", "Реестр поставок ещё не перенесён и не сверен. Неполная сводка не показана.");
    const reader = new CloudSheetsReader(bindings, { fetcher });
    const transfer = new AssemblyTransferService(current, { backfill: false });
    const source = { adapter: kind, documentId: sourceId(bindings, kind === "printing" ? "seasonalPrintingId" : "fboSourceId") };
    const value = await loadSource(source, (url, init) => reader.authenticatedFetch(url, init), new Date(), {
      googleReader: reader, boxJournalId: sourceId(bindings, "boxJournalId"), photoSourceId: sourceId(bindings, "photosId"), printingAdditionalSheets: current.meta("rollPrintingAdditionalSheets") || [],
      productionSupplies: current.meta("productionSupplies") || [], assemblyBoxLinks: transfer.links(),
    });
    validateApi(value, kind);
    if (value.stale === true) throw new CloudError("source_incomplete", "Источник не подтвердил свежую полную сводку.");
    await store.saveSnapshot(kind, value, lease);
    return { ...value, stale: false, snapshotAt: new Date(store.now()).toISOString(), refreshFailed: false, refreshInProgress: false };
  } catch (error) {
    if (!previous) throw error;
    const issue = error?.issue;
    const detail = issue?.code === "schema_changed" && issue?.source
      ? ` Лист «${String(issue.source).slice(0, 100)}»: ${String(issue.message || "изменена структура").slice(0, 120)}.`
      : "";
    const failure = { code: issue?.code || error.code || error.name || "refresh_failed", message: (detail.trim() || String(error.message || "Refresh failed")).slice(0, 240) };
    return { ...previous.value, stale: true, snapshotAt: new Date(previous.at).toISOString(), refreshFailed: true, refreshInProgress: false, refreshRetryAfterMs: 60000, refreshFailure: failure, staleReason: `Не удалось обновить источник.${detail} Показан предыдущий проверенный снимок.` };
  } finally { await store.release(lease); }
}

export async function readSnapshot(kind, url, bindings, store, options) {
  const snapshot = await store.snapshot(kind);
  let payload;
  if (!snapshot || url.searchParams.get("refresh") === "1" || store.now() - snapshot.at >= cloudConfig(bindings).snapshotMaxAgeMs) {
    try { payload = await refreshSnapshot(kind, bindings, store, options); }
    catch (error) {
      if (!snapshot) throw error;
      const refreshInProgress = error?.code === "cloud_operation_busy";
      const snapshotFresh = store.now() - snapshot.at < cloudConfig(bindings).snapshotMaxAgeMs;
      payload = {
        ...snapshot.value,
        // A competing refresh should not invalidate a still-fresh verified
        // snapshot. Writes still fail closed once that snapshot is older than
        // the normal cache lifetime.
        stale: !snapshotFresh,
        snapshotAt: new Date(snapshot.at).toISOString(),
        refreshFailed: !refreshInProgress,
        refreshInProgress,
        refreshRetryAfterMs: refreshInProgress ? 15000 : 60000,
        staleReason: refreshInProgress && !snapshotFresh
          ? "Обновление уже выполняется. Пока показан предыдущий проверенный снимок."
          : refreshInProgress
            ? null
            : "Обновить источник пока не удалось. Показан предыдущий проверенный снимок.",
      };
    }
  } else payload = { ...snapshot.value, stale: false, snapshotAt: new Date(snapshot.at).toISOString(), refreshFailed: false, refreshInProgress: false };
  if (kind !== "assembly") return payload;
  const selected = selectAssemblyPeriod(
    payload,
    url.searchParams.get("date") || todayMoscow(),
    url.searchParams.get("period") || "day",
  );
  return selected.stale === true ? { ...selected, staleSnapshot: true } : selected;
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

export async function cloudApi(request, bindings, ctx, { fetcher = fetch } = {}) {
  const url = new URL(request.url), path = url.pathname;
  try {
    if (path === "/api/auth/login") {
      methods(request, ["POST"]);
      return await loginWithPin(request, bindings.DB);
    }
    if (path === "/api/auth/logout") {
      methods(request, ["POST"]);
      return await logoutManager(request, bindings.DB);
    }
    if (path === "/api/auth/change-pin") {
      methods(request, ["POST"]);
      const principal = await resolvePrincipal(request, bindings);
      return json(await changeManagerPin(request, bindings.DB, principal));
    }
    if (path === "/api/auth/users") {
      const caller = await resolvePrincipal(request, bindings);
      if (caller?.role === "manager") throw new CloudError("owner_required", "Управлять учётными записями может только владелец RITM.", 403);
      requireOwner(request, bindings, { write: request.method !== "GET" });
      if (request.method === "GET") return json({ ok: true, users: await listManagerUsers(bindings.DB) });
      methods(request, ["POST"]);
      return json({ ok: true, user: await createManagerUser(bindings.DB, await readJson(request, 2048), request.headers.get("oai-authenticated-user-id")) }, 201);
    }
    const managerAction = path.match(/^\/api\/auth\/users\/([0-9a-f-]{36})\/(reset-pin|status)$/i);
    if (managerAction) {
      const caller = await resolvePrincipal(request, bindings);
      if (caller?.role === "manager") throw new CloudError("owner_required", "Управлять учётными записями может только владелец RITM.", 403);
      requireOwner(request, bindings, { write: true });
      methods(request, ["POST"]);
      const [, id, action] = managerAction;
      const ownerId = request.headers.get("oai-authenticated-user-id");
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
      if (principal?.role === "owner") requireOwner(request, bindings, { write: request.method !== "GET" });
      else if (principal?.role === "manager") {
        if (!managerRouteAllowed(request.method, path)) throw new CloudError("manager_route_forbidden", "Этот раздел или служебная операция недоступны для учётной записи менеджера.", 403);
        if (principal.mustChangePin) throw new CloudError("pin_change_required", "Перед продолжением задайте личный PIN.", 403);
        if (request.method !== "GET") assertSameOrigin(request);
      } else requireOwner(request, bindings, { write: request.method !== "GET" });
    }
    const config = cloudConfig(bindings);
    if (!config.configured) throw new CloudError("cloud_not_configured", "Облачное подключение источников и хранилища ещё не настроено.");
    const store = new CloudStore(bindings.DB);
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
        const scope = await store.scope();
        const shipmentIds = url.searchParams.getAll("shipmentId").concat((url.searchParams.get("shipmentIds") || "").split(",").filter(Boolean));
        return json({ ok: true, controls: listProductionControls(scope, shipmentIds) });
      }
      const input = await readJson(request);
      const result = await store.withScope(async (scope) => {
        if (scope.meta("migrationReady") !== true) throw new CloudError("migration_not_imported", "Реестр поставок ещё не готов. Задача не сохранена.", 503);
        let value;
        if (input?.action === "cancel") value = cancelProductionControl(scope, input);
        else if (input?.action === "cancel-batch") value = cancelProductionControlBatch(scope, input);
        else if (input?.action === "create") value = createProductionControl(scope, input, { owner: principal?.displayName || principal?.id || "RITM" });
        else if (input?.action === "create-batch") value = createProductionControlBatch(scope, input, { owner: principal?.displayName || principal?.id || "RITM" });
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
          deliver: (event) => deliverShipmentLockEvent(bindings, event, fetcher),
        });
        if (value.confirmed) appendAudit(scope, principal, path, { id: value.locks[0]?.eventId || "unchanged" });
        return value;
      });
      return json({ ok: true, ...result }, result.confirmed ? 200 : 202);
    }
    if (path === "/api/assembly-only-items") {
      methods(request, ["GET", "POST"]);
      if (bridgeId || (assemblyControlApp && request.method !== "GET")) throw new CloudError("assembly_item_forbidden", "Недостаточно прав для изменения товаров.", 403);
      if (request.method === "GET") return json({ok:true, items:listAssemblyOnlyItems(await store.scope(), url.searchParams.get("shipmentId") || "")});
      const input=await readJson(request,4096);
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
    if (path === "/api/printing" || path === "/api/assembly") {
      methods(request, ["GET"]);
      return json(await readSnapshot(path.endsWith("printing") ? "printing" : "assembly", url, bindings, store, { fetcher }));
    }
    if (path === "/api/warehouse") {
      methods(request, ["GET"]);
      const printing = await readSnapshot("printing", url, bindings, store, { fetcher });
      const snapshot = await readWarehouseSnapshot(url, bindings, store, {
        fetcher,
        activeShipmentIds: activeWarehouseShipmentIds(printing),
        rosterStale: printing.stale === true || printing.refreshFailed === true,
      });
      const dispatch = await listWarehouseCartonDispatch(bindings.DB);
      return json({ ...snapshot, cartons: snapshot.cartons.map((carton) => {
        const state = dispatch.get(carton.id);
        return {
          ...carton,
          dispatchStatus: state?.shipmentId === carton.shipmentId ? state.status : "pending",
          sentAt: state?.shipmentId === carton.shipmentId ? state.sentAt : null,
          dispatchChangedAt: state?.shipmentId === carton.shipmentId ? state.changedAt : null,
          dispatchChangedBy: state?.shipmentId === carton.shipmentId ? state.changedBy : null,
        };
      }) });
    }
    if (path === "/api/warehouse/dispatch") {
      methods(request, ["POST"]);
      if (principal?.role !== "owner" && principal?.role !== "manager")
        throw new CloudError("manager_required", "Войдите в RITM как владелец или менеджер, чтобы изменить статус короба.", 401);
      const input = await readJson(request, 2048);
      const cartonId = typeof input?.cartonId === "string" ? input.cartonId.trim() : "";
      const shipmentId = typeof input?.shipmentId === "string" ? input.shipmentId.trim() : "";
      const status = input?.status;
      if (!cartonId || !shipmentId || !["sent", "pending"].includes(status))
        throw new CloudError("warehouse_dispatch_invalid", "Укажите короб, поставку и нужный статус.", 400);

      const freshUrl = new URL(url);
      freshUrl.searchParams.set("refresh", "1");
      const printing = await readSnapshot("printing", freshUrl, bindings, store, { fetcher });
      const activeShipmentIds = activeWarehouseShipmentIds(printing);
      if (!activeShipmentIds || printing.stale === true || printing.refreshFailed === true)
        throw new CloudError("warehouse_supply_roster_unavailable", "Не удалось подтвердить актуальный список поставок. Статус короба не изменён.", 503);
      const snapshot = await readWarehouseSnapshot(freshUrl, bindings, store, { fetcher, activeShipmentIds });
      if (snapshot.stale)
        throw new CloudError("warehouse_snapshot_unavailable", "Не удалось подтвердить актуальный состав короба. Статус не изменён.", 503);
      const carton = snapshot.cartons.find((row) => row.id === cartonId && row.shipmentId === shipmentId);
      if (!carton) throw new CloudError("warehouse_carton_not_found", "Короб или поставка уже изменились. Обновите склад.", 404);
      if (status === "sent" && carton.status !== "closed")
        throw new CloudError("warehouse_carton_not_closed", "Отправить можно только закрытый короб.", 409);
      const updated = await setWarehouseCartonDispatch(bindings.DB, {
        cartonId,
        shipmentId,
        status,
        changedBy: principal.displayName || principal.username || principal.id || "Менеджер",
      });
      return json({ ok: true, dispatch: updated });
    }
    const getPaths = ["/api/roll-supplies/status", "/api/roll-supplies/operations", "/api/assembly-transfers/sources", "/api/assembly-transfers/links", "/api/assembly-transfers/source", "/api/assembly-transfers/operation"];
    if (getPaths.includes(path)) {
      methods(request, ["GET"]);
      const scope = await store.scope();
      const services = await createServices(bindings, scope, { fetcher });
      if (path.startsWith("/api/roll-supplies")) {
        const state = services.state();
        const leaseBusy = await store.leaseIsActive("production");
        return json({
          ...state,
          busy: state.busy || leaseBusy,
          production: state.production
            ? { ...state.production, busy: state.production.busy || leaseBusy }
            : state.production,
        });
      }
      if (path.endsWith("/links")) return json({ ok: true, links: services.transfer.links() });
      if (path.endsWith("/sources")) return json({ ok: true, sources: await services.transfer.sources() });
      if (path.endsWith("/source")) return json({ ok: true, source: await services.transfer.source(url.searchParams.get("department"), Number(url.searchParams.get("sheetId"))) });
      return json({ ok: true, operation: services.transfer.operation(url.searchParams.get("id")) });
    }
    const writePaths = ["/api/roll-supplies", "/api/roll-supplies/preview", "/api/assembly-transfers", "/api/assembly-transfers/preview"];
    if (writePaths.includes(path)) {
      methods(request, ["POST"]);
      const input = await readJson(request);
      const result = await store.withScope(async (scope) => {
        const cached = await store.snapshot("printing");
        const services = await createServices(bindings, scope, { fetcher, printing: cached?.value || null, refresh: (current) => refreshSnapshot("printing", bindings, store, { scope: current, fetcher }) });
        let value;
        try {
          if (path === "/api/roll-supplies/preview") return { ok: true, preview: await services.production.preview(input) };
          if (path === "/api/assembly-transfers/preview") return { ok: true, preview: await services.transfer.preview(input) };
          await services.guard();
          if (path === "/api/assembly-transfers") value = await services.transfer.execute(input);
          else {
            const routed = ["create", "append", "resume", "deletePart", "cancelAbsentCreate"].includes(input?.action);
            if (!routed && services.production.operations().some((op) => !["verified", "cancelled"].includes(op.status))) throw new CloudError("production_operation_pending", "Сначала завершите сверку общей поставки.", 409);
            if (input?.action === "delete" && (scope.meta("productionSupplies") || []).some((supply) => supply.parts.some((part) => part.department === "roll" && part.sheetId === input.sheetId)))
              throw new CloudError("linked_supply_delete_forbidden", "Это часть общей поставки. Удалите производственный участок через его действие.", 409);
            value = routed ? await services.production.execute(input) : await services.legacy.execute(input);
            if (value.status !== "cancelled") services.queue.enqueue(value);
          }
          appendAudit(scope, principal, path, value);
          await scope.checkpoint();
          return { ok: true, operation: value };
        } finally { services.savePreviews(); }
      });
      if (result.operation && ctx?.waitUntil) ctx.waitUntil(drainOutbox(bindings, store, fetcher).catch(() => {}));
      if (result.operation?.status === "verified" && ["create", "append"].includes(result.operation.action) && ctx?.waitUntil)
        ctx.waitUntil(refreshSnapshot("printing", bindings, store, { fetcher }).catch(() => {}));
      return json(result, result.operation?.status === "pending" ? 202 : 200);
    }
    throw new CloudError("cloud_route_pending", "Этот раздел ещё не прошёл перенос в облачную версию.", 503);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
    return json({ ok: false, error: error.code || "cloud_request_failed", message: error instanceof CloudError || error.code ? error.message : "Не удалось выполнить облачный запрос. Сохранённые данные не подменены нулями." }, status);
  }
}
