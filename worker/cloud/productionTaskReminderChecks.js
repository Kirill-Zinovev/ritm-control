import { marketplaceForSupply } from "../printing.js";
import { supplyCatalogShop } from "../../agent/productionCatalogSheet.js";
import { readAssemblyProductionCatalog } from "./assemblyProductionCatalog.js";
import { overlayPrintingV2, readAssemblyV2Events } from "./assemblyV2Events.js";

const departments = { "roll-printing": "ROLL", "box-printing": "BOX" };
const exactArticle = value => String(value ?? "").trim().normalize("NFC").toLocaleUpperCase("ru-RU");
const articleKey = value => exactArticle(value).replace(/Ё/gu, "Е");
const missing = "unconfirmed";
const minute = 60_000;
const exact = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const storeNumber = value => {
  const match = /^(?:магазин\s+)?([1-9]\d*)$/iu.exec(String(value ?? "").trim());
  return match ? match[1] : "";
};

function indexPrintingSheets(printing) {
  const orderGroups = new Map();
  const sheetKey = row => row.sourceId + ':' + row.sheetId;
  for (const row of printing.supplies) {
    if (row.archived === true) continue;
    const key = sheetKey(row);
    if (!orderGroups.has(key)) orderGroups.set(key, []);
    orderGroups.get(key).push(row);
  }
  return printing.sheets.filter(sheet =>
    Object.hasOwn(departments, sheet.sourceId) && Number.isSafeInteger(sheet.sheetId)
  ).map(sheet => {
    const rows = orderGroups.get(sheetKey(sheet)) || [];
    const canonicalIds = new Set([sheet.assemblyShipmentId, ...rows.map(row => row.assemblyShipmentId)].filter(Boolean));
    const ids = new Set(canonicalIds);
    // The controls dialog includes the stable physical ID on sheets published
    // before we recorded their canonical shipment ID in the sheet metadata.
    if (!sheet.assemblyShipmentId) ids.add("RITM-" + departments[sheet.sourceId] + "-" + sheet.sheetId);
    return { sheet, rows, canonicalIds, ids };
  });
}

function scopedOrders(printing, sheets, control) {
  const ids = new Set(control.shipmentIds || [control.shipmentId]);
  const tagged = sheets.filter(group => [...group.ids].some(id => ids.has(id)));
  if (!tagged.length || tagged.some(group => group.canonicalIds.size > 1) ||
    [...ids].some(id => !tagged.some(group => group.ids.has(id)))) return null;
  for (const group of tagged)
    for (const id of group.ids) ids.add(id);
  if (printing.quality?.status === "partial") {
    if (!printing.issues?.length || printing.issues.some(issue => !issue?.source) ||
      tagged.some(({sheet}) => printing.issues.some(issue => issue.source === sheet.name))) return null;
  }
  if (tagged.some(group => !group.rows.length)) return null;
  const rows = tagged.flatMap(group => group.rows).filter(row =>
    control.scope === "shipment" || articleKey(row.article) === control.article);
  if (!rows.length || rows.some(row => !Number.isSafeInteger(row.quantity) || row.quantity <= 0 ||
    !row.uid || !row.article) ||
    new Set(rows.map(row => JSON.stringify([row.sourceId, row.sheetId, row.uid]))).size !== rows.length) return null;
  return { ids, rows };
}

function compareRows(rows, fields) {
  let unknown = false;
  for (const row of rows) {
    for (const field of fields) {
      const value = row[field];
      if (!exact(value)) unknown = true;
      else if (value < row.quantity) return "open";
    }
  }
  return unknown ? missing : "closed";
}

/** A manager's task is compared with existing confirmed production data only. */
export async function evaluateProductionTaskReminder(check, controls, {
  printing, extraItems = null, now = Date.now(), readCatalog,
} = {}) {
  if (check === "manual") return "open";
  if (!["production", "packing", "catalog-exists"].includes(check) ||
    printing?.ok !== true || printing.stale || printing.refreshFailed ||
    printing.assemblyHeldMoves?.length || printing.assemblyHeldRemovals?.length ||
    !["valid", "partial"].includes(printing.quality?.status) ||
    !Array.isArray(printing.sheets) || !Array.isArray(printing.supplies)) return missing;
  const results = new Map();
  const catalogTargets = new Map();
  const sheets = indexPrintingSheets(printing);
  for (const control of controls) {
    const selected = scopedOrders(printing, sheets, control);
    if (!selected) {
      results.set(control.id, missing);
      continue;
    }
    if (check === "production") {
      results.set(control.id, compareRows(selected.rows, ["printProgress", "cutProgress"]));
      continue;
    }
    if (check === "packing") {
      const packedAt = Date.parse(printing.packing?.checkedAt || "");
      if (printing.packing?.status !== "available" || printing.packing.invalidRecords !== 0 ||
        !Number.isFinite(packedAt) || packedAt > now + minute || now - packedAt > 15 * minute ||
        printing.assemblyV2?.pendingRefresh) {
        results.set(control.id, missing);
        continue;
      }
      const observed = compareRows(selected.rows, ["packed"]);
      const unknownExtras = !Array.isArray(extraItems) || extraItems.some(item =>
        item.status !== "removed" && selected.ids.has(item.shipmentId) &&
        (control.scope === "shipment" || articleKey(item.article) === control.article));
      results.set(control.id, observed === "closed" && unknownExtras ? missing : observed);
      continue;
    }
    if (control.scope !== "article" || !control.article) {
      results.set(control.id, missing);
      continue;
    }
    const unique = new Map(selected.rows.map(row => {
      const titleStore = supplyCatalogShop(row.sheetName);
      const matchedStore = row.shopCatalogStatus === "matched" ? storeNumber(row.shop) : "";
      const target = {
        article: exactArticle(row.article), market: marketplaceForSupply(row.sheetName),
        store: titleStore && matchedStore && titleStore !== matchedStore ? "" : titleStore || matchedStore,
      };
      return [JSON.stringify(target), target];
    }));
    const [target] = unique.values();
    if (unique.size !== 1 || !target.market || !target.store) {
      results.set(control.id, missing);
      continue;
    }
    if (!catalogTargets.has(target.market)) catalogTargets.set(target.market, []);
    catalogTargets.get(target.market).push({ ...target, id: control.id });
  }
  for (const [market, targets] of catalogTargets) {
    let entries;
    try { entries = await readCatalog(market, [...new Set(targets.map(target => target.article))]); }
    catch { entries = null; }
    for (const target of targets) {
      if (!Array.isArray(entries) || entries.some(entry =>
        !entry || !articleKey(entry.article) || !storeNumber(entry.store))) {
        results.set(target.id, missing);
        continue;
      }
      const matches = entries.filter(row =>
        exactArticle(row.article) === target.article && storeNumber(row.store) === target.store);
      results.set(target.id, matches.length === 1 ? "closed" : matches.length === 0 ? "open" : missing);
    }
  }
  const states = [...results.values()];
  if (states.some(state => state === "open")) return "open";
  return states.length > 0 && states.every(state => state === "closed") ? "closed" : missing;
}

export function productionTaskReminderVerifier(bindings, store, fetcher, currentPrinting) {
  let printing;
  let packing;
  return async (schedule, controls) => {
    if (schedule.check === "manual") return "open";
    printing ||= readTaskPrinting(store, currentPrinting);
    const source = await printing;
    if (schedule.check === "packing" && source) packing ||= readTaskPacking(store, source);
    const data = schedule.check === "packing" && packing
      ? await packing
      : {printing: source};
    return evaluateProductionTaskReminder(schedule.check, controls, {
      ...data,
      now: store.now(),
      readCatalog: (market, articles) => readAssemblyProductionCatalog(bindings, market, articles, fetcher),
    });
  };
}

const leaseInfo = store => store.db.prepare("SELECT fence,expires_at FROM cloud_leases WHERE name='production'").first();
const continuousRead = (before, after, started, now) =>
  Number(before?.expires_at || 0) <= started && Number(after?.expires_at || 0) <= now &&
  Number(before?.fence || 0) === Number(after?.fence || 0);

async function readTaskPacking(store, printing) {
  const now = store.now();
  const before = await leaseInfo(store);
  const [events, extraItems] = await Promise.all([
    readAssemblyV2Events(store), store.readOperationsByKind("assembly-only-item"),
  ]);
  const after = await leaseInfo(store);
  if (!continuousRead(before, after, now, store.now())) return {printing: null};
  return { printing: overlayPrintingV2(printing, events), extraItems };
}

async function readTaskPrinting(store, freshPrinting) {
  const now = store.now();
  if (freshPrinting === null) return null;
  const held = await leaseInfo(store);
  const cached = freshPrinting ? {
    value: freshPrinting, at: Date.parse(freshPrinting.snapshotAt || ""),
  } : await store.snapshot("printing");
  const [revision, moveRevision] = await Promise.all([
    store.readMeta("productionSupplyRevision"), store.readMeta("printingMoveRevision"),
  ]);
  const released = await leaseInfo(store);
  if (!cached || !Number.isFinite(cached.at) || cached.at > now + minute || now - cached.at > 15 * minute ||
    (cached.value.productionSupplyRevision || null) !== (revision || null) ||
    (cached.value.productionMoveRevision || null) !== (moveRevision || null) ||
    !continuousRead(held, released, now, store.now())) return null;
  return cached.value;
}
