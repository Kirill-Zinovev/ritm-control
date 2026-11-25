import { CloudError } from "./access.js";
import { readAssemblyProductionCatalog } from "./assemblyProductionCatalog.js";
import { assemblyV2Configured } from "./assemblyV2Transport.js";
import { cloudConfig, sourceId } from "./config.js";
import { CloudSheetsReader } from "./googleSheets.js";
import { requireCutover } from "./services.js";
import { DEPARTMENTS, machineDepartment } from "../../agent/productionSupplies.js";
import { productionCatalogFields, productionCatalogSheet, selectSupplyCatalogEntries, sheetCatalogFormula, supplyCatalogShop } from "../../agent/productionCatalogSheet.js";
import { marketplaceForSupply, normalizeCatalogArticle } from "../printing.js";

const title = productionCatalogSheet;
const headers = ["Ключ", ...productionCatalogFields];
const departments = ["roll", "box"];
const scopeKeys = ["migrationReady", "cloudCutover", "migrationPendingWrites", "externalRepairs"];
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const normalized = value => String(value ?? "").trim().toLowerCase();
const hasArticle = value => typeof value === "string" && /^[\p{L}\p{N}][\p{L}\p{N}._/-]{1,119}$/u.test(normalizeCatalogArticle(value));
const positiveInteger = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : "";
const physicalSize = value => /^\d+(?:[,.]\d+)?\s*[xх×]\s*\d+(?:[,.]\d+)?$/iu.test(textValue(value)) ? textValue(value) : "";

const keyFor = (market, shop, article) => `${market}|${shop}|${normalizeCatalogArticle(article)}`;

function textValue(value) {
  const text = String(value ?? "").trim();
  return /^[=#]/.test(text) || text.length > 500 ? "" : text;
}

function photoValue(value) {
  return typeof value === "string" && value.length <= 2000 && value.startsWith("https://") ? value : "";
}

export function sheetCatalogRow(sheet, article, entries) {
  const matches = selectSupplyCatalogEntries(entries, sheet.shop);
  const consensus = (field, normalize) => {
    const values = matches.map(entry => normalize(entry[field]));
    return values[0] && values.every(value => value === values[0]) ? values[0] : "";
  };
  const multiple = sheet.department === "roll" ? "rollMultiplicity" : "xeroxMultiplicity";
  return [keyFor(sheet.market, sheet.shop, article), consensus("photoUrl", photoValue),
    consensus("sheetsPerUnit", positiveInteger), consensus("size", physicalSize),
    consensus("printFolder", textValue), consensus(multiple, positiveInteger)];
}

const legacyLookup = value => typeof value === "string" && value.startsWith("=") &&
  /(?:\bIMPORTRANGE\s*\(|(?:'?(?:Cache(?: FBO)?|_RITM_WB_SOURCE|_RITM_МАКЕТЫ|БДО)'?)!)/i.test(value);

async function sheetValues(reader, id, ranges, render = "FORMULA") {
  if (!ranges.length) return [];
  const results = [];
  for (let offset = 0; offset < ranges.length; offset += 24) {
    const batch = ranges.slice(offset, offset + 24);
    const params = new URLSearchParams({ valueRenderOption: render });
    for (const range of batch) params.append("ranges", range);
    const response = await reader.request(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${params}`);
    const value = await response.json();
    if (value.spreadsheetId !== id || value.valueRanges?.length !== batch.length)
      throw new CloudError("print_catalog_book_mismatch", "Не удалось подтвердить диапазоны рабочего справочника.", 503);
    results.push(...value.valueRanges.map(range => range.values || []));
  }
  return results;
}

async function readBook(reader, id, department, supplyName) {
  const metadata = await reader.metadata(id);
  const tabs = metadata.sheets.map(sheet => sheet.properties);
  const cache = tabs.find(tab => tab.title === title);
  if (cache && (!cache.hidden || cache.gridProperties?.columnCount !== headers.length))
    throw new CloudError("print_catalog_cache_mismatch", "Служебный лист справочника имеет неожиданную структуру.", 409);
  const candidates = tabs.flatMap(tab => {
    const market = marketplaceForSupply(tab.title);
    const rows = tab.gridProperties?.rowCount;
    if (!market || tab.hidden || (supplyName && tab.title !== supplyName) || tab.sheetId === DEPARTMENTS[department].template.gid ||
      rows < 5 || tab.gridProperties?.columnCount < 16) return [];
    return [{ id: tab.sheetId, title: tab.title, market, shop: supplyCatalogShop(tab.title), department, rows }];
  });
  const columns = await sheetValues(reader, id, candidates.map(tab => `${quote(tab.title)}!E4:E${tab.rows}`));
  const sheets = candidates.flatMap((tab, index) => {
    const [heading, ...rows] = columns[index];
    if (normalized(heading?.[0]) !== "артикул") return [];
    const entries = rows.flatMap(([article], index) => hasArticle(article) ? [{ row: index + 5, article }] : []);
    return entries.length ? [{ ...tab, entries, lastRow: entries.at(-1).row }] : [];
  });
  return readBookValues(reader, { id, department, cache, tabs, sheets });
}

async function readBookValues(reader, book) {
  const ranges = book.sheets.map(tab => `${quote(tab.title)}!B4:P${tab.lastRow}`);
  if (book.cache) ranges.push(`${quote(title)}!A1:F${book.cache.gridProperties.rowCount}`);
  const values = await sheetValues(reader, book.id, ranges);
  const stored = book.cache ? values.pop() : [headers];
  if (book.cache && (headers.some((name, index) => stored[0]?.[index] !== name) ||
    new Set(stored.slice(1).map(row => row[0])).size !== stored.length - 1 ||
    stored.slice(1).some(row => !/^(?:OZON|WB)\|[12]?\|[^|]+$/.test(row[0]) || row.some(cell => typeof cell === "string" && cell.startsWith("=")))))
    throw new CloudError("print_catalog_cache_mismatch", "Не удалось подтвердить ключи служебного справочника.", 409);
  const sheets = book.sheets.map((sheet, index) => ({ ...sheet, values: values[index] }));
  const machineLookups = sheets.filter(sheet => sheet.entries.some(({ row }) => legacyLookup(sheet.values[row - 4]?.[2])));
  const machines = await sheetValues(reader, book.id,
    machineLookups.map(sheet => `${quote(sheet.title)}!D5:E${sheet.lastRow}`), "UNFORMATTED_VALUE");
  for (const [index, sheet] of machineLookups.entries()) sheet.machines = machines[index];
  return { ...book, sheets, stored };
}

const entered = value => typeof value === "number" ? { numberValue: value } : { stringValue: value || "" };

export function planCatalogBook(book, catalogs) {
  const next = new Map(book.stored.slice(1).map(row => [row[0], row]));
  const patches = [];
  let positions = 0;
  const matched = new Set();
  for (const sheet of book.sheets) {
    const catalog = catalogs.get(sheet.market);
    if (!catalog) continue;
    const columns = (sheet.values[0] || []).map(normalized);
    if (columns[3] !== "артикул") continue;
    const fields = headers.slice(1).map(name => columns.indexOf(normalized(name)));
    const quantity = columns.indexOf("кол-во");
    if (quantity < 0 || fields.some(field => field < 0)) continue;
    if (columns[2] !== "станок") continue;
    for (const { row, article } of sheet.entries) {
      const values = sheet.values[row - 4] || [];
      if (values[3] !== article || !positiveInteger(values[quantity])) continue;
      positions++;
      const key = normalizeCatalogArticle(article);
      const entries = catalog.get(key) || [];
      const entry = sheetCatalogRow(sheet, article, entries);
      if (entry.slice(1).some(Boolean) || next.has(entry[0])) next.set(entry[0], entry);
      if (entry.slice(1).some(Boolean)) matched.add(entry[0]);
      fields.forEach((column, index) => {
        const field = index + 1;
        const before = values[column] || "";
        const formula = sheetCatalogFormula(sheet, row, field);
        if (before !== formula)
          patches.push({ sheetId: sheet.id, row, column: column + 1, formula });
      });
      // This column records the actual assignment of a physical job. Capture
      // an existing valid assignment before removing its old catalog lookup.
      const before = values[2];
      const oldAssignment = legacyLookup(before);
      if (oldAssignment || before === '=""' || !before) {
        const assignment = sheet.machines?.[row - 5];
        if (oldAssignment && assignment?.[1] !== article) continue;
        const existing = oldAssignment ? textValue(assignment[0]) : "";
        const candidates = new Set(selectSupplyCatalogEntries(entries, sheet.shop).map(entry => textValue(entry.machine)));
        const machine = machineDepartment(existing) === sheet.department ? existing :
          candidates.size === 1 && machineDepartment([...candidates][0]) === sheet.department ? [...candidates][0] : "";
        if (machine || oldAssignment)
          patches.push({ sheetId: sheet.id, row, column: 3, formula: `="${machine.replace(/"/g, '""')}"` });
      }
    }
  }
  const cacheRows = [...next.values()];
  const changedRows = cacheRows.flatMap((row, i) => row.every((cell, j) => cell === (book.stored[i + 1]?.[j] ?? "")) ? [] : [{ row: i + 1, data: row }]);
  return { patches, cacheRows, changedRows, positions, matched: matched.size };
}

function batchRequests(book, plan) {
  const requests = [];
  const used = new Set(book.tabs.map(tab => tab.sheetId));
  let cacheId = book.cache?.sheetId ?? 849681173;
  while (!book.cache && used.has(cacheId)) cacheId++;
  const required = plan.cacheRows.length + 1;
  if (!book.cache) {
    requests.push({ addSheet: { properties: { sheetId: cacheId, title, hidden: true,
      gridProperties: { rowCount: Math.max(100, required), columnCount: headers.length, frozenRowCount: 1 } } } });
  } else if (required > book.cache.gridProperties.rowCount) {
    requests.push({ appendDimension: { sheetId: cacheId, dimension: "ROWS", length: required - book.cache.gridProperties.rowCount } });
  }
  const cacheWrite = (row, values) => ({ updateCells: { start: { sheetId: cacheId, rowIndex: row, columnIndex: 0 },
    rows: [{ values: values.map(value => ({ userEnteredValue: entered(value) })) }], fields: "userEnteredValue" } });
  if (!book.cache) requests.push(cacheWrite(0, headers));
  for (const { row, data } of plan.changedRows) requests.push(cacheWrite(row, data));
  const columns = new Map();
  for (const patch of plan.patches) {
    const key = `${patch.sheetId}:${patch.column}`;
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key).push(patch);
  }
  for (const patches of columns.values()) {
    let block;
    for (const patch of patches) {
      if (!block || patch.row - 1 !== block.start.rowIndex + block.rows.length) {
        block = { start: { sheetId: patch.sheetId, rowIndex: patch.row - 1, columnIndex: patch.column }, rows: [], fields: "userEnteredValue" };
        requests.push({ updateCells: block });
      }
      block.rows.push({ values: [{ userEnteredValue: { formulaValue: patch.formula } }] });
    }
  }
  return requests;
}

async function readCatalogs(bindings, books, fetcher) {
  const keys = new Map();
  for (const book of books) for (const sheet of book.sheets) {
    if (!keys.has(sheet.market)) keys.set(sheet.market, new Set());
    for (const { article } of sheet.entries) keys.get(sheet.market).add(normalizeCatalogArticle(article));
  }
  const results = await Promise.all([...keys].map(async ([market, keys]) => {
    const articles = [...keys];
    const entries = new Map();
    try {
      for (let offset = 0; offset < articles.length; offset += 500) {
        const rows = await readAssemblyProductionCatalog(bindings, market, articles.slice(offset, offset + 500), fetcher,
          { includePhotos: true, includeProductDetails: true });
        for (const entry of rows) {
          const key = normalizeCatalogArticle(entry.article);
          if (!keys.has(key)) continue;
          if (!entries.has(key)) entries.set(key, []);
          entries.get(key).push(entry);
        }
      }
      return [market, entries];
    } catch { return [market, null]; }
  }));
  return new Map(results);
}

async function syncBooks(bindings, store, { fetcher, dryRun, supplyName }) {
  const config = cloudConfig(bindings);
  if (!assemblyV2Configured(bindings) || !config.configured) return { ok: false, error: "print_catalog_not_configured" };
  if (!dryRun && (!config.writesEnabled || !bindings.RITM_GOOGLE_WRITER_JSON))
    return { ok: false, error: "print_catalog_write_disabled" };
  const reader = new CloudSheetsReader(bindings, { fetcher });
  const revisions = async () => Promise.all(["productionSupplyRevision", "printingMoveRevision"].map(key => store.readMeta(key)));
  const before = dryRun ? null : await revisions();
  const books = await Promise.all(departments.map(department => readBook(reader, sourceId(bindings, department + "PrintingId"), department, supplyName)));
  const catalogs = await readCatalogs(bindings, books, fetcher);
  const marketsUnavailable = [...catalogs].flatMap(([market, catalog]) => catalog ? [] : [market]);
  const results = [];
  for (const book of books) {
    const plan = planCatalogBook(book, catalogs);
    const stats = { department: book.department, sheets: book.sheets.length, positions: plan.positions,
      matched: plan.matched, formulas: plan.patches.length, updatedRows: plan.changedRows.length };
    results.push(stats);
    if (dryRun || !plan.positions || (!plan.changedRows.length && !plan.patches.length && book.cache)) continue;
    const lease = await store.acquire("production", 30000);
    try {
      const values = await Promise.all(scopeKeys.map(key => store.readMeta(key)));
      requireCutover(bindings, { meta: key => values[scopeKeys.indexOf(key)] });
      if (!config.writableSources.includes(book.id) || (await revisions()).some((value, index) => value !== before[index]))
        throw new CloudError("print_catalog_book_changed", "Рабочая таблица изменилась. Справочник обновится после повторной сверки.", 409);
      const currentBook = await readBookValues(reader, book);
      const currentPlan = planCatalogBook(currentBook, catalogs);
      const requests = batchRequests(currentBook, currentPlan);
      if (!requests.length) continue;
      const writer = new CloudSheetsReader(bindings, { writer: true, fetcher, beforeWrite: () => store.renew(lease) });
      const response = await writer.request(`https://sheets.googleapis.com/v4/spreadsheets/${book.id}:batchUpdate`, {
        method: "POST", body: { requests }, write: true,
      });
      const receipt = await response.json();
      if (receipt.spreadsheetId !== book.id || !Array.isArray(receipt.replies))
        throw new CloudError("print_catalog_unverified", "Google Sheets пока не подтвердил обновление справочника.", 503);
      Object.assign(stats, { formulas: currentPlan.patches.length, updatedRows: currentPlan.changedRows.length, written: true });
    } finally { await store.release(lease); }
  }
  return { ok: !marketsUnavailable.length, dryRun, marketsUnavailable, books: results };
}

export async function syncProductionSheetCatalog(bindings, store, { fetcher = fetch, dryRun = true, supplyName = "" } = {}) {
  if (dryRun) return syncBooks(bindings, store, { fetcher, dryRun, supplyName });
  const lease = await store.acquire("production-print-catalog", 120000);
  try { return await syncBooks(bindings, store, { fetcher, dryRun, supplyName }); }
  finally { await store.release(lease); }
}
