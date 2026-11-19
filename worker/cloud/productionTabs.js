import { CloudError } from "./access.js";
import { cloudConfig, sourceId } from "./config.js";
import { requireCutover } from "./services.js";
import { CloudSheetsReader } from "./googleSheets.js";
import { physicalShipmentId, productionOperationPending, productionOperationTarget, sourceTargetMatches } from "./productionOperationTarget.js";
import { DEPARTMENTS } from "../../agent/productionSupplies.js";

const stateKey = "productionTabVisibilityV1";
const visibilityLease = "production-tab-visibility";
const departments = ["roll", "box"];
const sourceFor = (bindings, department) => sourceId(bindings, department + "PrintingId");
const tabKey = ({ department, sheetId }) => `${department}:${sheetId}`;
const missing = () => new CloudError("production_tab_missing", "Не удалось подтвердить лист поставки по ID и названию.", 409);

function reportTabs(bindings, report) {
  return (report?.sheets || []).flatMap(sheet => {
    const department = departments.find(value => sheet.sourceId === value + "-printing");
    if (!department || !sourceFor(bindings, department) || sourceFor(bindings, department) !== sheet.spreadsheetId ||
        !Number.isSafeInteger(sheet.sheetId) || sheet.sheetId < 0 || !sheet.name ||
        sheet.sheetId === DEPARTMENTS[department].template.gid ||
        /^(?:запасы(?:\s|$)|срочные(?:\s|$)|шаблон(?:\s|$)|журнал(?:\s|$)|пример(?:\s|$))/iu.test(sheet.name)) return [];
    return [{ ...sheet, department }];
  });
}

function overlaps(scope, tab) {
  const target = { id: tab.assemblyShipmentId || physicalShipmentId(tab), parts: [tab] };
  for (const { kind, value } of scope.operations.values()) {
    if (!productionOperationPending(value)) continue;
    if (kind === "production") {
      const affected = productionOperationTarget(value);
      if (!affected || sourceTargetMatches(target, affected)) return true;
    } else if (kind === "production-department-move") {
      const proof = value.proof?.plan?.proof;
      if (!proof?.[tab.department] || proof[tab.department].sheetId === tab.sheetId ||
          value.input?.shipmentId === target.id) return true;
    } else if (kind === "box-position-removal" && value.status === "checking") {
      if (tab.department === "box" && value.identity?.sheetId === tab.sheetId ||
          value.shipmentId === target.id) return true;
    } else if (kind === "roll" && tab.department === "roll" &&
        ["writing", "checking", "uncertain", "written_unverified"].includes(value.status)) {
      const sheetId = value.payload?.sheetId ?? value.payload?.plan?.sheetId;
      if (!Number.isSafeInteger(sheetId) || sheetId === tab.sheetId) return true;
    }
  }
  return false;
}

function deliveryMatch(snapshot, tab, orders) {
  const valid = snapshot?.ok === true && !snapshot.stale && !snapshot.refreshFailed && !snapshot.refreshInProgress &&
    ["valid", "partial"].includes(snapshot.quality?.status) &&
    !(snapshot.issues || []).some(issue => !issue?.source || issue.source === tab.name);
  if (!valid) return null;
  return orders.length > 0 && orders.every(order =>
    Number.isSafeInteger(order.quantity) && order.quantity > 0 &&
    order.productionTabComplete === true &&
    (!Number.isFinite(order.planningPrinted) || order.planningPrinted >= order.quantity) &&
    (!Number.isFinite(order.planningCut) || order.planningCut >= order.quantity) &&
    Number.isFinite(order.printProgress) && order.printProgress >= order.quantity &&
    Number.isFinite(order.cutProgress) && order.cutProgress >= order.quantity);
}

function matchingSheet(metadata, tab) {
  return metadata.sheets.find(({ properties }) => properties.sheetId === tab.sheetId && properties.title === tab.name)?.properties;
}

function writerFor(bindings, store, scope, fetcher, report = null) {
  return new CloudSheetsReader(bindings, { writer: true, fetcher, beforeWrite: async id => {
    requireCutover(bindings, scope);
    if (!departments.some(department => sourceFor(bindings, department) === id))
      throw new CloudError("production_tab_source", "Это не рабочая таблица печати.", 403);
    if (await store.leaseIsActive("production"))
      throw new CloudError("production_tab_pending", "Сначала завершите запись по поставке.", 409);
    if (report) {
      const [supply, move] = await Promise.all([store.readMeta("productionSupplyRevision"), store.readMeta("printingMoveRevision")]);
      if ((supply || null) !== (report.productionSupplyRevision || null) ||
          (move || null) !== (report.productionMoveRevision || null))
        throw new CloudError("production_tab_stale", "Состав изменился. Видимость обновится после сверки.", 409);
    }
    await scope.checkpoint();
  }});
}
async function applyVisibility(writer, id, metadata, changes) {
  const requested = new Map(changes.map(change => [change.sheetId, change.hidden]));
  if (!metadata.sheets.some(({ properties: p }) => !(requested.get(p.sheetId) ?? (p.hidden === true))))
    throw new CloudError("production_tab_last_visible", "В книге должен остаться хотя бы один видимый лист.", 409);
  const requests = changes.map(change => ({
    updateSheetProperties: { properties: { sheetId: change.sheetId, hidden: change.hidden }, fields: "hidden" },
  }));
  const response = await writer.request(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
    method: "POST", body: { requests }, write: true,
  });
  await response.body?.cancel();
  const actual = await writer.metadata(id);
  if (changes.some(change => {
    const updated = matchingSheet(actual, change);
    return !updated || (updated.hidden === true) !== change.hidden;
  })) throw new CloudError("production_tab_unverified", "Google Sheets пока не подтвердил видимость вкладки.", 503);
}

export async function productionTabVisibility(input, { bindings, store, fetcher, change = false }) {
  if (!input || !departments.includes(input.department) || !Number.isSafeInteger(input.sheetId) ||
      typeof input.name !== "string" || !input.name.trim() || input.name.length > 100 ||
      change && typeof input.hidden !== "boolean")
    throw new CloudError("production_tab_invalid", "Укажите конкретную вкладку поставки.", 400);
  const snapshot = await store.snapshot("printing");
  const tab = reportTabs(bindings, snapshot?.value).find(item => item.department === input.department &&
    item.sheetId === input.sheetId && item.name === input.name);
  if (!tab) throw missing();
  const available = cloudConfig(bindings).writesEnabled && !!bindings.RITM_GOOGLE_WRITER_JSON;
  const result = hidden => ({ ok: true, available, hidden, department: tab.department, sheetId: tab.sheetId });
  if (!change) {
    const reader = new CloudSheetsReader(bindings, { fetcher });
    const sheet = matchingSheet(await reader.metadata(tab.spreadsheetId), tab);
    if (!sheet) throw missing();
    return result(sheet.hidden === true);
  }
  return store.withScope(async scope => {
    if (!available) throw new CloudError("production_tab_unavailable", "Управление вкладками пока недоступно.", 503);
    if (overlaps(scope, tab)) throw new CloudError("production_tab_pending", "Сначала завершите запись по этой поставке.", 409);
    const writer = writerFor(bindings, store, scope, fetcher);
    const metadata = await writer.metadata(tab.spreadsheetId);
    const sheet = matchingSheet(metadata, tab);
    if (!sheet) throw missing();
    if ((sheet.hidden === true) !== input.hidden)
      await applyVisibility(writer, tab.spreadsheetId, metadata, [{ ...tab, hidden: input.hidden }]);
    const state = scope.meta(stateKey) || {};
    state[tabKey(tab)] = input.hidden ? "manual" : "shown";
    scope.meta(stateKey, state);
    return result(input.hidden);
  }, { waitMs: 3000, leaseName: visibilityLease });
}

export function automaticVisibility(ready, hidden, mode) {
  if (ready === null) return { mode, hidden };
  if (mode === "manual") return { mode: hidden ? "manual" : "shown", hidden };
  if (mode === "shown") return { mode: ready ? "shown" : null, hidden };
  if (mode === "auto" && !hidden) return { mode: ready ? "shown" : null, hidden };
  if (mode === "auto" && !ready) return { mode: null, hidden: false };
  if (!mode && !hidden && ready) return { mode: "auto", hidden: true };
  return { mode, hidden };
}

export async function reconcileProductionTabs(bindings, store, report, fetcher) {
  if (!cloudConfig(bindings).writesEnabled || !bindings.RITM_GOOGLE_WRITER_JSON || !report?.ok ||
      report.stale || report.refreshFailed || report.assemblyHeldMoves || report.assemblyHeldRemovals ||
      !Array.isArray(report.supplies) || !Number.isFinite(Date.parse(report.snapshotAt)) ||
      store.now() - Date.parse(report.snapshotAt) > 90000) return { hidden: 0, shown: 0 };
  const tabs = reportTabs(bindings, report);
  if (!tabs.length || await store.leaseIsActive("production")) return { hidden: 0, shown: 0 };
  const contents = new Map();
  for (const order of report.supplies) {
    const key = `${order.sourceId}:${order.sheetId}`;
    if (!contents.has(key)) contents.set(key, []);
    contents.get(key).push(order);
  }
  return store.withScope(async scope => {
    if ((scope.meta("productionSupplyRevision") || null) !== (report.productionSupplyRevision || null) ||
        (scope.meta("printingMoveRevision") || null) !== (report.productionMoveRevision || null))
      return { hidden: 0, shown: 0 };
    const state = scope.meta(stateKey) || {};
    const nextState = { ...state };
    const writer = writerFor(bindings, store, scope, fetcher, report);
    const result = { hidden: 0, shown: 0 };
    for (const department of departments) {
      const candidates = tabs.filter(tab => tab.department === department && !overlaps(scope, tab))
        .map(tab => ({ tab, key: tabKey(tab), ready: deliveryMatch(report, tab, contents.get(`${tab.sourceId}:${tab.sheetId}`) || []) }))
        .filter(({ key, ready }) => ready === true || (ready === false && state[key]));
      if (!candidates.length) continue;
      const id = sourceFor(bindings, department), metadata = await writer.metadata(id);
      const changes = [];
      for (const { tab, key, ready } of candidates) {
        const live = matchingSheet(metadata, tab);
        if (!live) continue;
        const hidden = live.hidden === true;
        const next = automaticVisibility(ready, hidden, state[key]);
        if (next.hidden !== hidden) changes.push({ ...tab, hidden: next.hidden });
        if (next.mode) nextState[key] = next.mode;
        else delete nextState[key];
      }
      if (changes.length) {
        await applyVisibility(writer, id, metadata, changes);
        result.hidden += changes.filter(change => change.hidden).length;
        result.shown += changes.filter(change => !change.hidden).length;
        scope.meta(stateKey, nextState);
        await scope.checkpoint();
      }
    }
    if (JSON.stringify(state) !== JSON.stringify(nextState)) scope.meta(stateKey, nextState);
    return result;
  }, { leaseName: visibilityLease });
}
