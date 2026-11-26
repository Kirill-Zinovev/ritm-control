import { CloudError } from "./access.js";
import { readAssemblyProductionCatalog } from "./assemblyProductionCatalog.js";
import { cloudConfig, sourceId } from "./config.js";
import { CloudSheetsReader } from "./googleSheets.js";
import { machineLayoutPhotoSheet, machineLayoutProperties, machineLayoutSheet } from "./machineLayouts.js";
import { normalizeCatalogArticle } from "../printing.js";

const cache = machineLayoutPhotoSheet;
const legacySourceId = sourceId({}, "assemblyPhotosId");
const normalized = value => String(value ?? "").normalize("NFC").toUpperCase().replace(/\s+/g, "");
const cellKey = ({ stringValue, numberValue } = {}) => normalized(stringValue ?? numberValue);
const text = cell => cell?.effectiveValue?.stringValue ?? "";
const sheetRange = (title, range) => "'" + title + "'!" + range;
const sourceRange = range => sheetRange(machineLayoutSheet.title, range);
const cacheRange = range => sheetRange(cache.title, range);

// A formula per row keeps sorting, filtering and manual images working.
export const machineLayoutPhotoFormula = String.raw`=LET(item;UPPER(REGEXREPLACE(SUBSTITUTE(TO_TEXT(INDEX($B:$B;ROW()));CHAR(160);" ");"\s+";""));shop;UPPER(REGEXREPLACE(SUBSTITUTE(TO_TEXT(INDEX($F:$F;ROW()));CHAR(160);" ");"\s+";""));keys;'_RITM_ФОТО'!$A$2:$A;photos;'_RITM_ФОТО'!$B$2:$B;IF(item="";"";LET(source;IFNA(XLOOKUP(item&"|"&shop;keys;photos);XLOOKUP(item&"|";keys;photos;""));IF(LEFT(source;8)="https://";IFERROR(IMAGE(source);"");""))))`;

function publicPhoto(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.href : "";
  } catch { return ""; }
}

function bestPhoto(candidates) {
  if (!candidates.length) return undefined;
  const primary = candidates.filter(candidate => candidate.primary);
  const pictures = new Set((primary.length ? primary : candidates).map(candidate => candidate.url));
  return pictures.size === 1 ? pictures.values().next().value : "";
}

export function layoutPhotoIndex(articles, results) {
  const byArticle = new Map(articles.map(article => [article, { WB: [], OZON: [] }]));
  for (const [market, entries] of results) {
    for (const entry of entries) {
      const bucket = byArticle.get(normalizeCatalogArticle(entry.article));
      const url = publicPhoto(entry.photoUrl);
      if (bucket && url) bucket[market].push({ shop: normalized(entry.store), primary: entry.primary, url });
    }
  }
  const index = new Map();
  for (const [article, { WB, OZON }] of byArticle) {
    const stores = new Set(["", ...WB.map(entry => entry.shop), ...OZON.map(entry => entry.shop)]);
    for (const store of stores) {
      const forStore = entries => store ? entries.filter(entry => entry.shop === store) : entries;
      const wb = bestPhoto(forStore(WB));
      const oz = bestPhoto(forStore(OZON));
      // Bare SKUs use the WB card first. An explicit OZ suffix uses OZON only.
      if (wb !== undefined || oz !== undefined) index.set(article + "|" + store, wb ?? oz);
      if (oz !== undefined) index.set(article + "(OZ)|" + store, oz);
    }
  }
  return index;
}

async function readPhotoIndex(bindings, articles, fetcher) {
  const base = [...new Set(articles.map(normalizeCatalogArticle).filter(article => article && article.length <= 116))].sort();
  const results = await Promise.all(["WB", "OZON"].map(async market => {
    const keys = market === "WB" ? base : base.flatMap(article => [article, article + "(OZ)"]);
    const batches = [];
    for (let i = 0; i < keys.length; i += 500)
      batches.push(readAssemblyProductionCatalog(bindings, market, keys.slice(i, i + 500), fetcher, { includePhotos: true }));
    return [market, (await Promise.all(batches)).flat()];
  }));
  const index = layoutPhotoIndex(base, results);
  if (base.length && ![...index.values()].some(Boolean))
    throw new CloudError("layout_catalog_photos_empty", "Справочник RITM не вернул фото для макетов. Предыдущее содержимое сохранено.", 503);
  return index;
}

function gridRows(book, sheetId, startColumn) {
  const range = book.sheets.find(sheet => sheet.properties.sheetId === sheetId)?.data?.find(
    block => (block.startRow ?? 0) === 0 && (block.startColumn ?? 0) === startColumn);
  if (!range) throw new Error("range");
  return range.rowData || [];
}

function photoRuns(positions, current) {
  const runs = [];
  for (let index = 1; index < Math.max(positions.length, current.length); index++) {
    const value = current[index]?.values?.[0]?.userEnteredValue;
    const legacy = value?.formulaValue?.includes(legacySourceId) && /IMPORTRANGE/i.test(value.formulaValue);
    if (!legacy && (value || !positions[index]?.article)) continue;
    const previous = runs.at(-1);
    if (previous?.[1] === index) previous[1]++;
    else runs.push([index, index + 1]);
  }
  return runs;
}

export async function syncMachineLayoutPhotos(bindings, store, { dryRun = true, fetcher = fetch } = {}) {
  if (!dryRun && !cloudConfig(bindings).writesEnabled)
    throw new CloudError("layout_photos_write_disabled", "Обновление фотографий в таблице макетов отключено.", 403);
  const id = sourceId(bindings, "machineLayoutsId");
  const lease = dryRun ? null : await store.acquire("machine-layout-photos", 90000);
  try {
    const reader = new CloudSheetsReader(bindings, { fetcher });
    const metadata = await reader.metadata(id);
    const rowCount = machineLayoutProperties(metadata).gridProperties.rowCount;
    const existing = metadata.sheets.map(sheet => sheet.properties).find(sheet => sheet.sheetId === cache.id || sheet.title === cache.title);
    if (existing && (existing.sheetId !== cache.id || existing.title !== cache.title || !existing.hidden ||
        existing.gridProperties.columnCount !== 2 || existing.gridProperties.rowCount < 2))
      throw new CloudError("layout_photos_sheet_conflict", "Лист служебных фото в таблице макетов уже занят.", 409);
    const book = await reader.grid(id, [sourceRange("B1:C" + rowCount), sourceRange("F1:F" + rowCount),
      ...(existing ? [cacheRange("A1:B" + existing.gridProperties.rowCount)] : [])]);
    const articles = gridRows(book, machineLayoutSheet.id, 1);
    const stores = gridRows(book, machineLayoutSheet.id, 5);
    if (text(articles[0]?.values?.[0]) !== "Артикул" || text(articles[0]?.values?.[1]) !== "Фото" || text(stores[0]?.values?.[0]) !== "Магазин")
      throw new CloudError("layout_photos_headers_changed", "На листе «Все макеты» изменились столбцы «Артикул», «Фото» или «Магазин».", 409);
    const positions = articles.map((row, index) => ({
      article: cellKey(row?.values?.[0]?.effectiveValue),
      store: cellKey(stores[index]?.values?.[0]?.effectiveValue),
    }));
    const entered = positions.slice(1).filter(row => row.article);
    const index = await readPhotoIndex(bindings, entered.map(row => row.article), fetcher);
    const matched = entered.filter(row => index.get(row.article + "|" + row.store) ?? index.get(row.article + "|")).length;
    const photoRows = [cache.header, ...[...index].sort(([left], [right]) => left.localeCompare(right))];
    const previous = existing ? gridRows(book, cache.id, 0).map(row => [text(row.values?.[0]), text(row.values?.[1])]) : [];
    if (existing && cache.header.some((cell, idx) => previous[0]?.[idx] !== cell))
      throw new CloudError("layout_photos_sheet_conflict", "Содержимое служебного листа фото изменилось.", 409);
    const photoRowsChanged = JSON.stringify(photoRows) !== JSON.stringify(previous);
    const stats = { ok: true, dryRun, rows: entered.length, matched, missing: entered.length - matched, photoRowsChanged, formulas: 0 };
    if (dryRun) return stats;
    // Read C again after the network lookup to preserve any manual photo added
    // while the catalog was being read.
    const current = await reader.grid(id, [sourceRange("C1:C" + rowCount)]);
    const formulaRuns = photoRuns(positions, gridRows(current, machineLayoutSheet.id, 2));
    stats.formulas = formulaRuns.reduce((count, [first, last]) => count + last - first, 0);
    const writer = new CloudSheetsReader(bindings, { fetcher, writer: true, beforeWrite: () => store.renew(lease) });
    stats.written = await writer.updateMachineLayoutPhotos({
      metadata, photoRows: photoRowsChanged ? photoRows : null, formula: machineLayoutPhotoFormula, formulaRuns,
    });
    return stats;
  } finally { if (lease) await store.release(lease); }
}
