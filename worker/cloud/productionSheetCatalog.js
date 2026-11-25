import { CloudError } from "./access.js";
import { readAssemblyProductionCatalog } from "./assemblyProductionCatalog.js";
import { assemblyV2Configured } from "./assemblyV2Transport.js";
import { cloudConfig, sourceId } from "./config.js";
import { CloudSheetsReader } from "./googleSheets.js";
import { requireCutover } from "./services.js";
import { DEPARTMENTS, machineDepartment } from "../../agent/productionSupplies.js";
import { productionCatalogFields, productionCatalogSheet, selectSupplyCatalogEntries, sheetCatalogFormula, stockCatalogFields, stockCatalogValueFormula, supplyCatalogShop } from "../../agent/productionCatalogSheet.js";
import { marketplaceForSupply, normalizeCatalogArticle } from "../printing.js";

const title = productionCatalogSheet;
const headers = ["Ключ", ...productionCatalogFields];
const stockHeaders = ["Ключ", ...stockCatalogFields];
const stockTabs = new Set(["Запасы склад", "Срочные 2 этаж"]);
const departments = ["roll", "box"];
const scopeKeys = ["migrationReady", "cloudCutover", "migrationPendingWrites", "externalRepairs"];
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const normalized = value => String(value ?? "").trim().toLowerCase();
const hasArticle = value => typeof value === "string" && /^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,119}$/u.test(normalizeCatalogArticle(value));
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
  const fields = [keyFor(sheet.market, sheet.shop, article), consensus("photoUrl", photoValue),
    consensus("sheetsPerUnit", positiveInteger), consensus("size", physicalSize),
    consensus("printFolder", textValue), consensus(multiple, positiveInteger)];
  if (!sheet.stock) return fields;
  const machine = consensus("machine", textValue);
  const store = consensus("store", textValue);
  const sameDepartment = machineDepartment(machine) === sheet.department;
  return [...fields, sameDepartment ? machine : "", sameDepartment ? consensus("printExtension", textValue) : "",
    /^\d{1,3}$/.test(store) ? store : ""];
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

async function readBook(reader, id, department, supplyName, stock, initializeStock) {
  const metadata = await reader.metadata(id);
  const tabs = metadata.sheets.map(sheet => sheet.properties);
  const cache = tabs.find(tab => tab.title === title);
  if (stock && !cache && !initializeStock) return null;
  if (cache && (!cache.hidden || cache.gridProperties?.columnCount !== (stock ? stockHeaders : headers).length))
    throw new CloudError("print_catalog_cache_mismatch", "Служебный лист справочника имеет неожиданную структуру.", 409);
  const candidates = tabs.flatMap(tab => {
    const market = stock ? (stockTabs.has(tab.title) ? "OZON" : null) : marketplaceForSupply(tab.title);
    const rows = tab.gridProperties?.rowCount;
    if (!market || tab.hidden || (supplyName && tab.title !== supplyName) || (!stock && tab.sheetId === DEPARTMENTS[department].template.gid) ||
      rows < 5 || (stock && rows > 4096) || tab.gridProperties?.columnCount < (stock ? 30 : 16)) return [];
    return [{ id: tab.sheetId, title: tab.title, market, shop: supplyCatalogShop(tab.title), department, rows, stock }];
  });
  if (stock) {
    if (candidates.length !== stockTabs.size)
      throw new CloudError("stock_catalog_book_mismatch", "Не удалось подтвердить оба рабочих листа запасов.", 409);
    return readBookValues(reader, { id, department, cache, tabs, sheets: candidates, stock, initializeStock });
  }
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
  if (book.stock) return readStockBookValues(reader, book);
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

const cellValue = cell => cell?.formulaValue ?? cell?.stringValue ?? cell?.numberValue ?? cell?.boolValue ?? "";

async function readStockBookValues(reader, book) {
  // The first sync repairs the prepared rows. Later runs only need the current
  // stock records and the gaps between them.
  const articleColumns = book.cache && !book.initializeStock ? await sheetValues(reader, book.id,
    book.sheets.map(tab => `${quote(tab.title)}!E4:E${tab.rows}`)) : null;
  const stockRanges = book.sheets.map((tab, index) => {
    const lastRow = articleColumns ? Math.max(5, 3 + articleColumns[index].length) : tab.rows;
    return `${quote(tab.title)}!B4:AD${lastRow}`;
  });
  const cacheRange = book.cache && `${quote(title)}!A1:I${book.cache.gridProperties.rowCount}`;
  const response = await reader.grid(book.id, cacheRange ? [...stockRanges, cacheRange] : stockRanges);
  const sheetData = (id, name, row, column) => {
    const target = response.sheets.find(sheet => sheet.properties.sheetId === id && sheet.properties.title === name);
    const grid = target?.data?.[0];
    if (!grid || (grid.startRow || 0) !== row || (grid.startColumn || 0) !== column || !Array.isArray(grid.rowData))
      throw new CloudError("stock_catalog_book_mismatch", "Не удалось подтвердить диапазон запасов.", 409);
    return grid.rowData;
  };
  const sheets = book.sheets.map(sheet => {
    const rows = sheetData(sheet.id, sheet.title, 3, 1);
    const values = rows.map(row => (row.values || []).map(cell => cellValue(cell.userEnteredValue)));
    const effective = rows.map(row => (row.values || []).map(cell => cellValue(cell.effectiveValue)));
    const entries = values.slice(1).flatMap((cells, index) => hasArticle(cells[3]) ? [{ row: index + 5, article: cells[3] }] : []);
    if (normalized(values[0]?.[3]) !== "артикул" || normalized(values[0]?.[14]) !== "кол-во" ||
        stockCatalogFields.some(field => !values[0].some(cell => normalized(cell) === normalized(field))))
      throw new CloudError("stock_catalog_headers_changed", "Изменились заголовки запасов.", 409);
    return { ...sheet, values, effective, entries };
  });
  const stored = book.cache ? sheetData(book.cache.sheetId, title, 0, 0)
    .map(row => (row.values || []).map(cell => cellValue(cell.userEnteredValue))) : [stockHeaders];
  if (stockHeaders.some((header, index) => stored[0]?.[index] !== header) ||
      new Set(stored.slice(1).map(row => row[0])).size !== stored.length - 1 ||
      stored.slice(1).some(row => !/^OZON\|\|[^|]+$/.test(row[0]) || row.some(cell => typeof cell === "string" && cell.startsWith("="))))
    throw new CloudError("stock_catalog_cache_mismatch", "Не удалось подтвердить ключи справочника запасов.", 409);
  return { ...book, sheets, stored };
}

const entered = value => typeof value === "number" ? { numberValue: value } : { stringValue: value || "" };

function planStockCatalogSheet(sheet, catalog, next, patches, matched) {
  const columns = sheet.values[0].map(normalized);
  const fields = stockCatalogFields.map(name => columns.indexOf(normalized(name)));
  const planned = new Map(sheet.entries.map(({ row, article }) => [row, normalizeCatalogArticle(article)]));
  let blankRows = 0;
  for (const [index, values] of sheet.values.entries()) {
    if (!index) continue;
    const row = index + 4, article = planned.get(row);
    const current = sheet.effective[index] || [];
    const blank = !String(values[3] ?? "").trim();
    const reusable = blank && (values[14] ?? "") === "" && (values[28] ?? "") === "";
    if (!blank && (!article || !catalog)) continue;
    const firstPatch = patches.length;
    const entry = article ? sheetCatalogRow(sheet, article, catalog.get(article) || []) : [];
    if (article) {
      if (entry.slice(1).some(Boolean) || next.has(entry[0])) next.set(entry[0], entry);
      if (entry.slice(1).some(Boolean)) matched.add(entry[0]);
    }
    const put = (column, value, formula = false) => {
      if (value !== (values[column] ?? ""))
        patches.push({ sheetId: sheet.id, row, column: column + 1, ...(formula ? { formula: value } : { value }) });
    };
    for (const [i, column] of fields.entries()) {
      const field = i + 1, before = values[column] ?? "";
      if (field === 7) {
        // The extension is an input cleared by the existing stock-close gateway.
        // It must remain an input so the same worksheet row can be used again.
        if (reusable) put(column, "");
        else if (entry[field] && (!textValue(current[column]) || legacyLookup(before))) put(column, entry[field]);
        continue;
      }
      const formula = sheetCatalogFormula(sheet, row, field);
      if (blank) {
        if (before !== "") put(column, formula, true);
        continue;
      }
      if (before === formula) continue;
      const effective = current[column];
      const known = field === 2 || field === 5 ? positiveInteger(effective) :
        field === 3 ? physicalSize(effective) : field === 6 ?
          (machineDepartment(textValue(effective)) === sheet.department ? textValue(effective) : "") : textValue(effective);
      // Machine, sheets per item and multiplicity are already used by live jobs.
      // Keep confirmed assignments while connecting missing data to the catalog.
      const keep = [2, 5, 6, 8].includes(field) || ([3, 4].includes(field) && !entry[field]);
      put(column, known && keep ? stockCatalogValueFormula(sheet, row, article, field, known) : formula, true);
    }
    if (reusable) put(columns.indexOf("наличие макета"), "");
    for (const column of [7, 8, 9, 10]) { // I:L, calculated dimensions and area
      const before = values[column];
      if (typeof before === "string" && before.startsWith("=")) {
        const guard = `=IF(TRIM(TO_TEXT($E${row}))="";"";`;
        if (!before.startsWith(guard)) put(column, guard + before.slice(1) + ")", true);
      } else if (reusable && before !== undefined) put(column, "");
    }
    if (blank && patches.length !== firstPatch) blankRows++;
  }
  return blankRows;
}

export function planCatalogBook(book, catalogs) {
  const next = new Map(book.stored.slice(1).map(row => [row[0], row]));
  const patches = [];
  let positions = 0;
  let blankRows = 0;
  const matched = new Set();
  for (const sheet of book.sheets) {
    const catalog = catalogs.get(sheet.market);
    if (book.stock) {
      blankRows += planStockCatalogSheet(sheet, catalog, next, patches, matched);
      if (catalog) positions += sheet.entries.length;
      continue;
    }
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
  return { patches, cacheRows, changedRows, positions, matched: matched.size, blankRows };
}

function batchRequests(book, plan) {
  const requests = [];
  const labels = book.stock ? stockHeaders : headers;
  const used = new Set(book.tabs.map(tab => tab.sheetId));
  let cacheId = book.cache?.sheetId ?? 849681173;
  while (!book.cache && used.has(cacheId)) cacheId++;
  const required = plan.cacheRows.length + 1;
  if (!book.cache) {
    requests.push({ addSheet: { properties: { sheetId: cacheId, title, hidden: true,
      gridProperties: { rowCount: Math.max(100, required), columnCount: labels.length, frozenRowCount: 1 } } } });
  } else if (required > book.cache.gridProperties.rowCount) {
    requests.push({ appendDimension: { sheetId: cacheId, dimension: "ROWS", length: required - book.cache.gridProperties.rowCount } });
  }
  const cacheWrite = (row, values) => ({ updateCells: { start: { sheetId: cacheId, rowIndex: row, columnIndex: 0 },
    rows: [{ values: values.map(value => ({ userEnteredValue: entered(value) })) }], fields: "userEnteredValue" } });
  if (!book.cache) requests.push(cacheWrite(0, labels));
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
      const value = patch.formula ? { formulaValue: patch.formula } : entered(patch.value);
      if (!block || patch.row - 1 !== block.start.rowIndex + block.rows.length || (book.stock && block.rows.length === 350)) {
        block = { start: { sheetId: patch.sheetId, rowIndex: patch.row - 1, columnIndex: patch.column }, rows: [], fields: "userEnteredValue" };
        requests.push({ updateCells: block });
      }
      block.rows.push({ values: [{ userEnteredValue: value }] });
    }
  }
  return requests;
}

function stockWriteBatches(requests) {
  const encoder = new TextEncoder();
  const batches = [[]];
  let size = 0;
  for (const request of requests) {
    const bytes = encoder.encode(JSON.stringify(request)).length + 1;
    if (size && size + bytes > 1_400_000) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1).push(request);
    size += bytes;
  }
  return batches;
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

async function syncBooks(bindings, store, { fetcher, dryRun, supplyName, stockOnly, initializeStock }) {
  const config = cloudConfig(bindings);
  if (!assemblyV2Configured(bindings) || !config.configured) return { ok: false, error: "print_catalog_not_configured" };
  if (!dryRun && (!config.writesEnabled || !bindings.RITM_GOOGLE_WRITER_JSON))
    return { ok: false, error: "print_catalog_write_disabled" };
  const reader = new CloudSheetsReader(bindings, { fetcher });
  const revisions = async () => Promise.all(["productionSupplyRevision", "printingMoveRevision"].map(key => store.readMeta(key)));
  const before = dryRun ? null : await revisions();
  const books = (await Promise.all(departments.map(department => {
    const key = stockOnly ? (department === "box" ? "stockBoxPrintingId" : "stockRollPrintingId") : department + "PrintingId";
    return readBook(reader, sourceId(bindings, key), department, supplyName, stockOnly, initializeStock);
  }))).filter(Boolean);
  const catalogs = await readCatalogs(bindings, books, fetcher);
  const marketsUnavailable = [...catalogs].flatMap(([market, catalog]) => catalog ? [] : [market]);
  const results = [];
  for (const book of books) {
    const plan = planCatalogBook(book, catalogs);
    const stats = { department: book.department, sheets: book.sheets.length, positions: plan.positions,
      matched: plan.matched, formulas: plan.patches.length, updatedRows: plan.changedRows.length,
      ...(book.stock ? { blankRows: plan.blankRows } : {}) };
    results.push(stats);
    if (dryRun || (!book.stock && !plan.positions) || (!plan.changedRows.length && !plan.patches.length && book.cache)) continue;
    const lease = await store.acquire("production", 30000);
    try {
      const values = await Promise.all(scopeKeys.map(key => store.readMeta(key)));
      requireCutover(bindings, { meta: key => values[scopeKeys.indexOf(key)] });
      if (!config.writableSources.includes(book.id) || (await revisions()).some((value, index) => value !== before[index]))
        throw new CloudError("print_catalog_book_changed", "Рабочая таблица изменилась. Справочник обновится после повторной сверки.", 409);
      const currentBook = await readBookValues(reader, book);
      if (book.stock && currentBook.sheets.some((sheet, index) =>
        JSON.stringify(sheet.entries) !== JSON.stringify(book.sheets[index].entries)))
        throw new CloudError("print_catalog_book_changed", "Состав запасов изменился. Справочник обновится после повторной сверки.", 409);
      const currentPlan = planCatalogBook(currentBook, catalogs);
      const requests = batchRequests(currentBook, currentPlan);
      if (!requests.length) continue;
      const writer = new CloudSheetsReader(bindings, { writer: true, fetcher, beforeWrite: () => store.renew(lease) });
      for (const batch of book.stock ? stockWriteBatches(requests) : [requests]) {
        const response = await writer.request(`https://sheets.googleapis.com/v4/spreadsheets/${book.id}:batchUpdate`, {
          method: "POST", body: { requests: batch }, write: true,
        });
        const receipt = await response.json();
        if (receipt.spreadsheetId !== book.id || !Array.isArray(receipt.replies) || (book.stock && receipt.replies.length !== batch.length))
          throw new CloudError("print_catalog_unverified", "Google Sheets пока не подтвердил обновление справочника.", 503);
      }
      Object.assign(stats, { formulas: currentPlan.patches.length, updatedRows: currentPlan.changedRows.length, written: true,
        ...(book.stock ? { blankRows: currentPlan.blankRows } : {}) });
    } finally { await store.release(lease); }
  }
  return { ok: !marketsUnavailable.length, dryRun, marketsUnavailable, books: results };
}

export async function syncProductionSheetCatalog(bindings, store, {
  fetcher = fetch, dryRun = true, supplyName = "", stockOnly = false, initializeStock = false,
} = {}) {
  const options = { fetcher, dryRun, supplyName, stockOnly, initializeStock };
  if (dryRun) return syncBooks(bindings, store, options);
  const lease = await store.acquire(stockOnly ? "production-stock-catalog" : "production-print-catalog", 120000);
  try { return await syncBooks(bindings, store, options); }
  finally { await store.release(lease); }
}
