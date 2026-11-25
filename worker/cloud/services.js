import { RollSupplyManagementService } from "../../agent/rollSupply.js";
import { ProductionSupplyService, ProductionSupplyWriter, DEPARTMENTS } from "../../agent/productionSupplies.js";
import { AssemblySyncQueue } from "../../agent/assemblySync.js";
import { AssemblyTransferService } from "../../agent/assemblyTransfer.js";
import { CloudSheetsReader } from "./googleSheets.js";
import { cloudConfig, sourceId } from "./config.js";
import { readMachineLayoutArticles } from "./machineLayouts.js";
import { CloudError } from "./access.js";
import { cloudFetch } from "./fetch.js";
import { setShipmentLocks } from "./shipmentLocks.js";
import { assemblyV2Configured } from "./assemblyV2Transport.js";
import { readAssemblyProductionCatalog } from "./assemblyProductionCatalog.js";
import { StockOperations } from '../../agent/stockOperations.js';
import { StockSheetsAdapter } from '../../agent/stockSheets.js';
import { boxStockReadiness, rollStockReadiness, readRollStockHistory } from '../../agent/stockReadiness.js';
import { createStockGateway,stockGatewaySupportsDryRun } from './stockGateway.js';
import { queueBitrixNotifications } from './bitrixNotifications.js';

export function requireCutover(bindings, scope) {
  const config = cloudConfig(bindings), cutover = scope.meta("cloudCutover");
  if (!config.writesEnabled || !cutover || cutover.id !== bindings.RITM_CLOUD_CUTOVER_ID || cutover.localWriterDisabled !== true || !scope.meta("migrationReady"))
    throw new CloudError("cloud_write_disabled", "Облачная запись ещё не включена: перенос и сверка должны быть завершены.", 403);
  if (scope.meta("migrationPendingWrites")?.some((row) => !row.documentId || config.writableSources.includes(row.documentId)))
    throw new CloudError("migration_operations_pending", "Сначала нужно сверить незавершённые операции прежнего RITM.", 409);
  if (scope.meta("externalRepairs")?.some((row) => ["writing", "uncertain"].includes(row.status) && config.writableSources.includes(row.documentId)))
    throw new CloudError("local_repair_pending", "Эту таблицу изменяет локальный AI Center или результат его исправления требует сверки.", 409);
}

export async function createServices(bindings, scope, { fetcher = fetch, refresh = null, printing = null, readItemSnapshot = null, manager = 'RITM' } = {}) {
  const config = cloudConfig(bindings);
  let nextJoke = null;
  try { nextJoke = JSON.parse(bindings.RITM_BITRIX_NEXT_ASSIGNMENT_JOKE || 'null'); } catch { /* no one-time owner request */ }
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
    if ((init.method || "GET") !== "GET") {
      try { await guard(match[1]); }
      catch (error) { error.beforeExternalWrite = true; error.uncertain = false; throw error; }
    }
    return cloudFetch(fetcher,url.href,init);
  };
  // guardedFetch performs the durable guard immediately before every Sheets write.
  // A second beforeWrite hook would checkpoint the same lease twice per request.
  const writers = reader.configured ? Object.fromEntries(Object.entries(DEPARTMENTS).map(([department, target]) => [department, new ProductionSupplyWriter({ department, credentialWriter: writerCredentials, fetcher: guardedFetch, documentId: target.documentId, template: target.template, assemblyCatalogOnly: true, ...(department === 'roll' ? { layoutLookup: () => readMachineLayoutArticles(reader, sourceId(bindings, 'machineLayoutsId')) } : {}) })])) : null;
  // Historical transfer receipts are still readable in cloud mode.
  const queue = new AssemblySyncQueue(scope);
  let latestPrinting = printing;
  const refreshPrinting = refresh ? async () => {
    await scope.checkpoint();
    latestPrinting = await refresh(scope);
    return { ok: latestPrinting.ok === true, partial: latestPrinting.partial === true };
  } : null;
  const legacy = new RollSupplyManagementService(scope, { writer: writers?.roll || null, recoverInterrupted: !!scope.lease, refresh: refreshPrinting, getPrintingSnapshot: () => latestPrinting, readItemSnapshot: readItemSnapshot && (payload => readItemSnapshot(reader, payload)), refreshAfterWrite: !readItemSnapshot });
  const production = new ProductionSupplyService(scope, {
    writers, legacy, recoverInterrupted: !!scope.lease, refresh: refreshPrinting,
    createCatalog: (market, articles) => readAssemblyProductionCatalog(bindings, market, articles, fetcher),
    // The two department writes are already read back and committed before
    // the response. A full source scan must not hold the production write
    // lease or keep the manager's create button disabled.
    refreshAfterWrite: false,
    onVerified: op => {
      if (op.action === 'create') {
        const watches = scope.meta('arkadyWatchConfigs') || {};
        if (!watches[op.shipmentId]) {
          watches[op.shipmentId] = {priority: op.priority || 'normal', reminderMinutes: op.priority === 'urgent' ? (op.reminderMinutes ?? 0) : 0, createdAt: op.createdAt || op.updatedAt};
          scope.meta('arkadyWatchConfigs', watches);
          // A newly created task starts before any work, unlike older supplies
          // that are baselined on the first confirmed observation.
          const states = scope.meta('arkadyWatchStates') || {};
          for (const step of op.steps || []) if (['roll','box'].includes(step.department)) states[`${op.shipmentId}:${step.department}`] ||= {print:false,cut:false};
          scope.meta('arkadyWatchStates', states);
        }
      }
      queueBitrixNotifications(scope, op, { kind: 'production', manager, nextJoke, documentIds:{roll:DEPARTMENTS.roll.documentId,box:DEPARTMENTS.box.documentId}, enabled: !!scope.meta('bitrixNotificationConfig') && scope.meta('bitrixNotificationsEnabled') !== false });
    },
    beforeCreateWrite: async (operation) => {
      if (!assemblyV2Configured(bindings) || !bindings.RITM_ASSEMBLY_V2_TARGET_TOKEN)
        throw new CloudError("assembly_v2_unconfigured", "Связь с «RITM Сборка» не настроена. Поставка не записана.", 503);
      // The production job delivers the roster together with this canonical lock.
      await setShipmentLocks(scope, {
        shipmentIds: [operation.shipmentId],
        locked: true,
        name: operation.name,
        changedBy: "RITM",
        sourceOperationId: operation.id,
      });
    },
  });
  // Old releases stored all active production previews as one cloud_state
  // value. Replace that oversized legacy cache once and keep each preview in
  // cloud_transfer_previews with its own expiry instead.
  const legacyPreviews = scope.meta("productionPreviewCache");
  if (Array.isArray(legacyPreviews) && legacyPreviews.length) scope.meta("productionPreviewCache", []);
  production.previews = new Map();
  const transfer = new AssemblyTransferService(scope, { reader, queue, backfill: !!scope.lease });
  const stock = () => {
    const boxId=sourceId(bindings,'stockBoxPrintingId'),rollId=sourceId(bindings,'stockRollPrintingId');
    if(!boxId||!rollId)throw new CloudError('stock_sources_unconfigured','Таблицы запасов ещё не подключены.',503);
    const layouts=()=>readMachineLayoutArticles(reader,sourceId(bindings,'machineLayoutsId'));
    const rollHistories=new WeakMap();
    const rollReadiness=async args=>{
      if(!rollHistories.has(args.snapshot))rollHistories.set(args.snapshot,readRollStockHistory(reader,rollId));
      return rollStockReadiness({...args,...await rollHistories.get(args.snapshot),sheetName:args.destination==='warehouse'?'Запасы склад':'Срочные 2 этаж'});
    };
    // Receipt inspection uses an existing dry-run contract. These are the two
    // live deployments whose versioned source was checked for that contract.
    // Unknown endpoints remain fully guarded instead of probing a possible writer.
    const gateway=(department,id)=>{
      const url=bindings[`RITM_STOCK_${department.toUpperCase()}_GATEWAY_URL`];
      return createStockGateway({url,token:bindings[`RITM_STOCK_${department.toUpperCase()}_GATEWAY_TOKEN`],fetcher,beforeWrite:()=>guard(id),dryRunSupported:stockGatewaySupportsDryRun(department,url)});
    };
    const adapters={
      box:new StockSheetsAdapter({reader,writer:gateway('box',boxId),spreadsheetId:boxId,department:'box',layouts,readiness:boxStockReadiness}),
      roll:new StockSheetsAdapter({reader,writer:gateway('roll',rollId),spreadsheetId:rollId,department:'roll',layouts,readiness:rollReadiness}),
    };
    const operations={get:id=>structuredClone(scope.operations.get('stock:'+id)?.value||null),put:op=>{scope.putOperation('stock',op);queueBitrixNotifications(scope,op,{kind:'stock',manager,nextJoke,documentIds:{roll:rollId,box:boxId},enabled:!!scope.meta('bitrixNotificationConfig') && scope.meta('bitrixNotificationsEnabled') !== false});},pending:()=>[...scope.operations.values()].filter(row=>row.kind==='stock'&&!['verified','not_saved'].includes(row.value?.status)).map(row=>row.value)};
    return new StockOperations({store:operations,adapters,catalog:lines=>{
      if(!Array.isArray(lines)||!lines.length||lines.length>500||lines.some(line=>typeof line?.article!=="string"||!line.article.trim()||line.article.trim().length>120))
        throw new CloudError("stock_preview_invalid","Добавьте от 1 до 500 корректных артикулов.",400);
      return readAssemblyProductionCatalog(bindings,"OZON",lines.map(line=>line.article),fetcher,{includePhotos:true});
    },checkpoint:()=>guard(),manager});
  };
  return { reader, writers, legacy, production, transfer, queue, guard, stock,
    savePreviews() {},
    state() {
      const state = legacy.state();
      const writable = config.writesEnabled && !!bindings.RITM_GOOGLE_WRITER_JSON && scope.meta("migrationReady") === true && scope.meta("cloudCutover")?.id === bindings.RITM_CLOUD_CUTOVER_ID;
      return { ...state, mode: "cloud", available: writable && state.available, reason: writable ? state.reason : "Облачная версия готовится к переключению. Запись пока отключена.", production: { ...production.state(), available: writable && production.state().available }, assemblySync: queue.state() };
    },
  };
}
