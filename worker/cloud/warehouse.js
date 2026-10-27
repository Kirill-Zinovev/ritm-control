import { readProductionShopCatalog, readWorkloadPhotos } from "../../agent/adapters.js";
import { buildWarehouseSnapshot } from "../warehouseCartons.js";
import { CloudError } from "./access.js";
import { cloudConfig, sourceId } from "./config.js";
import { CloudSheetsReader } from "./googleSheets.js";

const definitions = [
  { name: "Cartons", endColumn: "P", minColumns: 16, required: ["cartonId", "directionId", "Направление", "Номер", "Занято, шт", "Статус", "createdAt", "closedAt", "shipmentId"] },
  { name: "CartonContents", endColumn: "M", minColumns: 13, required: ["allocationId", "cartonId", "shipmentId", "directionId", "positionId", "Артикул", "Количество, шт", "createdAt", "action", "sourceAllocationId"] },
];
const maxRows = 20000;
function cellValue(cell) {
  if (cell?.effectiveValue?.errorValue) throw new CloudError("warehouse_cell_error", "В таблице коробов обнаружена ошибка ячейки. Проверьте источник.");
  const value = cell?.effectiveValue || cell?.userEnteredValue || {};
  return value.stringValue ?? value.numberValue ?? value.boolValue ?? "";
}
function describe(metadata, documentId) {
  if (metadata?.spreadsheetId !== documentId || !Array.isArray(metadata.sheets)) throw new CloudError("warehouse_source_mismatch", "Не удалось подтвердить таблицу Assembly.");
  return definitions.map((definition) => {
    const found = metadata.sheets.filter((sheet) => sheet.properties?.title === definition.name);
    const properties = found[0]?.properties;
    const rows = properties?.gridProperties?.rowCount, columns = properties?.gridProperties?.columnCount;
    if (found.length !== 1 || !Number.isSafeInteger(properties?.sheetId) || !Number.isSafeInteger(rows) || rows < 1 || rows > maxRows || !Number.isSafeInteger(columns) || columns < definition.minColumns)
      throw new CloudError("warehouse_schema_unavailable", "Не удалось подтвердить структуру листов коробов Assembly.");
    return { ...definition, sheetId: properties.sheetId, rows, columns };
  });
}
function extract(grid, documentId, sheets) {
  if (grid?.spreadsheetId !== documentId || !Array.isArray(grid.sheets)) throw new CloudError("warehouse_source_mismatch", "Не удалось подтвердить таблицу Assembly.");
  return sheets.map((definition) => {
    const matches = grid.sheets.filter((sheet) => sheet.properties?.sheetId === definition.sheetId && sheet.properties?.title === definition.name);
    const block = matches[0]?.data?.[0];
    if (matches.length !== 1 || matches[0]?.data?.length !== 1 || (block?.startRow ?? 0) !== 0 || (block?.startColumn ?? 0) !== 0 || !Array.isArray(block?.rowData) || !block.rowData.length)
      throw new CloudError("warehouse_grid_unavailable", "Не удалось прочитать таблицу коробов полностью.");
    const rows = block.rowData.map((row) => (row.values || []).map(cellValue));
    const headers = rows[0].map((value) => String(value).replace(/^\uFEFF/, "").trim());
    if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length || definition.required.some((header) => !headers.includes(header)))
      throw new CloudError("warehouse_schema_changed", "В таблице коробов изменились заголовки. Проверьте источник.");
    return rows.slice(1).filter((row) => row.some((value) => value !== "" && value !== null)).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]).filter(([header]) => header)));
  });
}

export async function loadWarehouse(reader, bindings, { signal, now = Date.now } = {}) {
  const documentId = sourceId(bindings, "assemblyDatabaseId");
  if (!documentId) throw new CloudError("warehouse_source_unconfigured", "Источник коробов Assembly не настроен.");
  const catalogPromise = readProductionShopCatalog(reader, signal).catch(() => null);
  const photoId = sourceId(bindings, "photosId");
  const photoPromise = photoId ? readWorkloadPhotos(reader, photoId, signal).catch(() => null) : Promise.resolve(null);
  const metadata = await reader.metadata(documentId, signal), sheets = describe(metadata, documentId);
  const ranges = sheets.map((sheet) => `'${sheet.name}'!A1:${sheet.endColumn}${sheet.rows}`);
  let first, second;
  for (let attempt = 0; attempt < 2; attempt++) {
    first = extract(await reader.grid(documentId, ranges, signal), documentId, sheets);
    second = extract(await reader.grid(documentId, ranges, signal), documentId, sheets);
    if (JSON.stringify(first) === JSON.stringify(second)) break;
    first = null;
  }
  if (!first) throw new CloudError("warehouse_changing", "Короба сейчас обновляются. Повторите чтение через несколько секунд.", 409);
  const finalSheets = describe(await reader.metadata(documentId, signal), documentId);
  if (sheets.some((sheet, index) => sheet.sheetId !== finalSheets[index].sheetId || sheet.rows !== finalSheets[index].rows || sheet.columns !== finalSheets[index].columns))
    throw new CloudError("warehouse_changing", "Структура коробов изменилась во время чтения. Повторите обновление.", 409);
  const [catalog, photos] = await Promise.all([catalogPromise, photoPromise]);
  return buildWarehouseSnapshot(second[0], second[1], { catalog, photos, checkedAt: new Date(now()).toISOString() });
}

export async function readWarehouseSnapshot(url, bindings, store, { fetcher = fetch } = {}) {
  const snapshot = await store.snapshot("warehouse");
  if (snapshot && url.searchParams.get("refresh") !== "1" && store.now() - snapshot.at < cloudConfig(bindings).snapshotMaxAgeMs)
    return { ...snapshot.value, stale: false, snapshotAt: new Date(snapshot.at).toISOString() };
  let lease;
  try {
    lease = await store.acquire("refresh:warehouse", 60000);
    const value = await loadWarehouse(new CloudSheetsReader(bindings, { fetcher }), bindings, { now: () => store.now() });
    await store.saveSnapshot("warehouse", value, lease);
    return { ...value, snapshotAt: value.checkedAt };
  } catch (error) {
    if (!snapshot) throw error;
    return { ...snapshot.value, stale: true, snapshotAt: new Date(snapshot.at).toISOString(), staleReason: "Не удалось подтвердить свежие данные коробов. Показан предыдущий снимок; готовность к отправке требует проверки." };
  } finally { if (lease) await store.release(lease); }
}
