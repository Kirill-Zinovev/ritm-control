import { loadSource, todayMoscow, validateApi } from "../../agent/adapters.js";
import { selectAssemblyPeriod } from "../assembly.js";
import { cloudConfig, sourceId } from "./config.js";
import { CloudSheetsReader } from "./googleSheets.js";
import { CloudStore } from "./store.js";
import { CloudError, json, readJson, requireOwner, requireMaintenance } from "./access.js";
import { createServices } from "./services.js";
import { AssemblyTransferService } from "../../agent/assemblyTransfer.js";
import { importMigration } from "./migration.js";
import { verifyBridge } from "./bridge.js";
import { externalLease } from "./externalLease.js";
import { recordCutover } from "./cutover.js";

const signIn = "/signin-with-chatgpt?return_to=%2F%3Fpage%3Dsupplies";
const methods = (request, allowed) => { if (!allowed.includes(request.method)) throw new CloudError("method_not_allowed", "Метод запроса не поддерживается.", 405); };

export async function drainOutbox(bindings, store, fetcher = fetch) {
  return store.withScope(async (scope) => {
    const services = await createServices(bindings, scope, { fetcher });
    await services.guard();
    services.queue.recoverConfirmed();
    await services.queue.flush();
    return services.queue.state();
  });
}

export async function maintenance(bindings, store, { fetcher = fetch, refresh = true } = {}) {
  const result = { ok: true, assemblySync: null, deliverySkipped: !cloudConfig(bindings).writesEnabled };
  if (!result.deliverySkipped) result.assemblySync = await drainOutbox(bindings, store, fetcher);
  if (refresh) {
    result.refreshed = [];
    for (const kind of ["printing", "assembly"]) {
      try { const value = await refreshSnapshot(kind, bindings, store, { fetcher }); result.refreshed.push({ kind, ok: value.refreshFailed !== true, snapshotAt: value.snapshotAt }); }
      catch (error) { result.refreshed.push({ kind, ok: false, error: error.code || "refresh_failed" }); }
    }
    result.ok = result.refreshed.every(row => row.ok);
  }
  return result;
}
export async function refreshSnapshot(kind, bindings, store, { scope = null, fetcher = fetch } = {}) {
  const previous = await store.snapshot(kind);
  const lease = await store.acquire("refresh:" + kind);
  try {
    const current = scope || await store.scope();
    if (!current.meta("migrationReady")) throw new CloudError("migration_not_imported", "Реестр поставок ещё не перенесён и не сверен. Неполная сводка не показана.");
    const reader = new CloudSheetsReader(bindings, { fetcher });
    const transfer = new AssemblyTransferService(current, { backfill: false });
    const source = { adapter: kind, documentId: sourceId(bindings, kind === "printing" ? "seasonalPrintingId" : "fboSourceId") };
    const value = await loadSource(source, (url, init) => reader.authenticatedFetch(url, init), new Date(), {
      googleReader: reader, printingAdditionalSheets: current.meta("rollPrintingAdditionalSheets") || [],
      productionSupplies: current.meta("productionSupplies") || [], assemblyBoxLinks: transfer.links(),
    });
    validateApi(value, kind);
    await store.saveSnapshot(kind, value, lease);
    return { ...value, stale: false, snapshotAt: new Date(store.now()).toISOString(), refreshFailed: false };
  } catch (error) {
    if (!previous) throw error;
    return { ...previous.value, stale: true, snapshotAt: new Date(previous.at).toISOString(), refreshFailed: true, staleReason: "Не удалось обновить источник. Показан предыдущий проверенный снимок." };
  } finally { await store.release(lease); }
}

async function readSnapshot(kind, url, bindings, store, options) {
  const snapshot = await store.snapshot(kind);
  let payload;
  if (!snapshot || url.searchParams.get("refresh") === "1" || store.now() - snapshot.at > cloudConfig(bindings).snapshotMaxAgeMs) {
    try { payload = await refreshSnapshot(kind, bindings, store, options); }
    catch (error) {
      if (!snapshot) throw error;
      payload = { ...snapshot.value, stale: true, snapshotAt: new Date(snapshot.at).toISOString(), refreshFailed: true, staleReason: "Обновление выполняется или источник недоступен. Показан предыдущий снимок." };
    }
  } else payload = { ...snapshot.value, stale: false, snapshotAt: new Date(snapshot.at).toISOString(), refreshFailed: false };
  return kind === "assembly" ? selectAssemblyPeriod(payload, url.searchParams.get("date") || todayMoscow(), url.searchParams.get("period") || "day") : payload;
}

export async function cloudApi(request, bindings, ctx, { fetcher = fetch } = {}) {
  const url = new URL(request.url), path = url.pathname;
  try {
    if (path === "/api/runtime") {
      methods(request, ["GET"]);
      const id = request.headers.get("oai-authenticated-user-id");
      return json({ ok: true, mode: "cloud", authenticated: !!id, authorized: !!id && cloudConfig(bindings).owners.includes(id), signInPath: signIn });
    }
    // This reports only the caller's site-specific ID; it does not grant access.
    if (path === "/api/cloud/identity") {
      methods(request, ["GET"]);
      const id = request.headers.get("oai-authenticated-user-id");
      if (!id) throw new CloudError("authentication_required", "Войдите через ChatGPT.", 401);
      return json({ ok: true, userId: id, authorized: cloudConfig(bindings).owners.includes(id) });
    }
    let bridgeId = null;
    if (request.headers.has("x-ritm-bridge-id")) bridgeId = await verifyBridge(request, bindings);
    else if (["/api/cloud/import", "/api/cloud/cutover", "/api/cloud/state"].includes(path) && request.headers.has("authorization")) {
      if (bindings.RITM_CLOUD_IMPORT_ENABLED !== "true") throw new CloudError("migration_service_disabled", "Служебный канал переноса закрыт.", 403);
      requireMaintenance(request, bindings, "RITM_MIGRATION_TOKEN");
    }
    else if (path === "/api/cloud/maintenance" && request.headers.has("authorization")) requireMaintenance(request, bindings);
    else requireOwner(request, bindings, { write: request.method !== "GET" });
    const config = cloudConfig(bindings);
    if (!config.configured) throw new CloudError("cloud_not_configured", "Облачное подключение источников и хранилища ещё не настроено.");
    const store = new CloudStore(bindings.DB);
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
      const transfer = new AssemblyTransferService(scope, { backfill: false });
      return json({ ok: true, registeredSheets: scope.meta("rollPrintingAdditionalSheets") || [], productionSupplies: scope.meta("productionSupplies") || [], assemblyBoxLinks: transfer.links() });
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
    const getPaths = ["/api/roll-supplies/status", "/api/roll-supplies/operations", "/api/assembly-transfers/sources", "/api/assembly-transfers/links", "/api/assembly-transfers/source", "/api/assembly-transfers/operation"];
    if (getPaths.includes(path)) {
      methods(request, ["GET"]);
      const scope = await store.scope();
      const services = await createServices(bindings, scope, { fetcher });
      if (path.startsWith("/api/roll-supplies")) return json(services.state());
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
            const routed = ["create", "append", "resume", "deletePart"].includes(input?.action);
            if (!routed && services.production.operations().some((op) => op.status !== "verified")) throw new CloudError("production_operation_pending", "Сначала завершите сверку общей поставки.", 409);
            if (input?.action === "delete" && (scope.meta("productionSupplies") || []).some((supply) => supply.parts.some((part) => part.department === "roll" && part.sheetId === input.sheetId)))
              throw new CloudError("linked_supply_delete_forbidden", "Это часть общей поставки. Удалите производственный участок через его действие.", 409);
            value = routed ? await services.production.execute(input) : await services.legacy.execute(input);
            services.queue.enqueue(value);
          }
          await scope.checkpoint();
          return { ok: true, operation: value };
        } finally { services.savePreviews(); }
      });
      if (result.operation && ctx?.waitUntil) ctx.waitUntil(drainOutbox(bindings, store, fetcher).catch(() => {}));
      return json(result, result.operation?.status === "pending" ? 202 : 200);
    }
    throw new CloudError("cloud_route_pending", "Этот раздел ещё не прошёл перенос в облачную версию.", 503);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
    return json({ ok: false, error: error.code || "cloud_request_failed", message: error instanceof CloudError || error.code ? error.message : "Не удалось выполнить облачный запрос. Сохранённые данные не подменены нулями." }, status);
  }
}
