import { readWorkloadCatalog } from "./assemblyProductionCatalog.js";
import { buildWarehouseSnapshot } from "../warehouseCartons.js";
import { CloudError } from "./access.js";
import { cloudConfig, sourceId } from "./config.js";
import { CloudSheetsReader } from "./googleSheets.js";

const definitions = [
  { name: "Cartons", endColumn: "P", minColumns: 16, required: ["cartonId", "directionId", "Направление", "Номер", "Занято, шт", "Статус", "createdAt", "closedAt", "shipmentId"] },
  { name: "CartonContents", endColumn: "O", minColumns: 13, required: ["allocationId", "cartonId", "shipmentId", "directionId", "positionId", "Артикул", "Количество, шт", "createdAt", "action", "sourceAllocationId"] },
];
const maxRows = 20000;
const ritmShipmentId = /^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i;
const text = (value) => String(value ?? "").trim();

export function activeWarehouseShipmentIds(printing) {
  if (printing?.ok !== true || !Array.isArray(printing.sheets)) return null;
  const ids = new Set();
  for (const sheet of printing.sheets) {
    const source = text(sheet?.sourceId);
    if (source !== "roll-printing" && source !== "box-printing") continue;
    const sheetId = Number(sheet?.sheetId);
    if (!Number.isSafeInteger(sheetId) || sheetId <= 0) return null;
    const shipmentId = text(sheet?.assemblyShipmentId) ||
      (source === "roll-printing" ? `RITM-ROLL-${sheetId}` : `RITM-BOX-${sheetId}`);
    if (!ritmShipmentId.test(shipmentId)) return null;
    ids.add(shipmentId);
  }
  return ids;
}

export function activeWarehouseShipmentInfo(printing) {
  if (printing?.ok !== true || !Array.isArray(printing.sheets)) return null;
  const result = Object.create(null);
  for (const sheet of printing.sheets) {
    const source = text(sheet?.sourceId);
    if (source !== "roll-printing" && source !== "box-printing") continue;
    const sheetId = Number(sheet?.sheetId);
    if (!Number.isSafeInteger(sheetId) || sheetId <= 0) return null;
    const id = text(sheet?.assemblyShipmentId) || (source === "roll-printing" ? `RITM-ROLL-${sheetId}` : `RITM-BOX-${sheetId}`);
    const name = text(sheet?.name);
    if (!ritmShipmentId.test(id) || !name) return null;
    if (result[id] && result[id].name !== name) return null;
    result[id] = { name, directionId: "ROLL" };
  }
  return result;
}

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
    return { ...definition, endColumn: definition.name === "CartonContents" && columns < 15 ? "M" : definition.endColumn, sheetId: properties.sheetId, rows, columns };
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

export async function loadWarehouse(reader, bindings, { signal, now = Date.now, activeShipmentIds = null, shipmentInfo = null, fetcher = fetch } = {}) {
  const documentId = sourceId(bindings, "assemblyDatabaseId");
  if (!documentId) throw new CloudError("warehouse_source_unconfigured", "Источник коробов Assembly не настроен.");
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
  const cartons = new Map(second[0].map(row => [text(row.cartonId), row]));
  const positions = second[1].map(row => {
    const shipmentId = text(row.shipmentId);
    const carton = cartons.get(text(row.cartonId));
    const manualMarket = shipmentId.match(/^RITM-WAREHOUSE-MANUAL-(OZON|WB)-\d+$/)?.[1];
    const name = manualMarket || (shipmentId === "RITM-STOCK-WAREHOUSE" ? "OZON" :
      shipmentInfo?.[shipmentId]?.name || carton?.["Направление"]);
    return { article: row["Артикул"], sheetName: name };
  });
  const catalog = await readWorkloadCatalog(bindings, positions, [], fetcher);
  return buildWarehouseSnapshot(second[0], second[1], { catalog, checkedAt: new Date(now()).toISOString(), activeShipmentIds, shipmentInfo, includeArchived: true });
}

// Dispatch changes a physical carton's status, not a production plan. Reuse the
// known source identities but verify the actual Assembly carton/journal twice;
// a failing refresh of unrelated printing sheets must not block the warehouse.
export async function readWarehouseForDispatch(bindings, store, { fetcher = fetch, reader } = {}) {
  const printing = (await store.snapshot('printing'))?.value;
  if (!activeWarehouseShipmentIds(printing)) throw new CloudError('warehouse_supply_roster_unavailable', 'Сначала загрузите склад: связи поставок ещё не получены. Статусы не изменены.', 503);
  const sourceReader=reader || new CloudSheetsReader(bindings, { fetcher });
  // Reconfirm just the production tab identities, not every production metric.
  // Deleted/hidden/renamed supplies cannot acquire a new dispatch status.
  const documents=new Map();
  for(const sheet of printing.sheets){
    const source=sheet.sourceId==='roll-printing'?'rollPrintingId':sheet.sourceId==='box-printing'?'boxPrintingId':null;
    if(source)documents.set(sheet.sourceId,sourceId(bindings,source));
  }
  const properties=new Map(await Promise.all([...documents].map(async([source,id])=>{
    if(!id)throw new CloudError('warehouse_supply_roster_unavailable','Не настроена таблица производственных заданий.',503);
    const metadata=await sourceReader.metadata(id);
    if(metadata.spreadsheetId!==id||!Array.isArray(metadata.sheets))throw new CloudError('warehouse_source_mismatch','Не удалось подтвердить таблицу заданий.',503);
    return [source,new Map(metadata.sheets.map(sheet=>[sheet.properties?.sheetId,sheet.properties]))];
  })));
  const confirmed={ok:true,sheets:printing.sheets.filter(sheet=>{
    const property=properties.get(sheet.sourceId)?.get(Number(sheet.sheetId));
    return property&&!property.hidden&&property.title===sheet.name;
  })};
  return loadWarehouse(sourceReader, bindings, {
    now: () => store.now(), activeShipmentIds:activeWarehouseShipmentIds(confirmed), shipmentInfo:activeWarehouseShipmentInfo(confirmed), fetcher,
  });
}

export async function readWarehouseSnapshot(url, bindings, store, { fetcher = fetch, activeShipmentIds = null, shipmentInfo = null, rosterStale = false } = {}) {
  const snapshot = await store.snapshot("warehouse");
  const publicSnapshot = (value, options = {}) => {
    const { activeShipmentIds: _ids, activeShipmentFingerprint: _fingerprint, ...visible } = value;
    return { ...visible, ...options };
  };
  if (!activeShipmentIds) {
    if (snapshot) return publicSnapshot(snapshot.value, { stale: true, snapshotAt: new Date(snapshot.at).toISOString(), staleReason: "Не удалось подтвердить список действующих поставок. Показан последний проверенный снимок склада." });
    throw new CloudError("warehouse_supply_roster_unavailable", "Не удалось подтвердить список действующих поставок. Обновите данные позже.", 503);
  }
  const activeIds = [...activeShipmentIds].sort();
  const activeShipmentFingerprint = activeIds.map(id => `${id}:${shipmentInfo?.[id]?.name || ""}`).join("\n");
  const current = snapshot?.value?.warehouseStockVersion === 1 && snapshot?.value?.warehouseArchiveVersion === 1 && snapshot?.value?.activeShipmentFingerprint === activeShipmentFingerprint;
  if (snapshot && current && url.searchParams.get("refresh") !== "1" && store.now() - snapshot.at < cloudConfig(bindings).snapshotMaxAgeMs)
    return publicSnapshot(snapshot.value, rosterStale
      ? { stale: true, snapshotAt: new Date(snapshot.at).toISOString(), staleReason: "Не удалось подтвердить свежесть списка поставок. Показан последний проверенный снимок." }
      : { stale: false, snapshotAt: new Date(snapshot.at).toISOString() });
  let lease;
  try {
    lease = await store.acquire("refresh:warehouse", 60000);
    const value = await loadWarehouse(new CloudSheetsReader(bindings, { fetcher }), bindings, { now: () => store.now(), activeShipmentIds, shipmentInfo, fetcher });
    value.activeShipmentFingerprint = activeShipmentFingerprint;
    value.activeShipmentIds = activeIds;
    await store.saveSnapshot("warehouse", value, lease);
    return publicSnapshot(value, rosterStale
      ? { stale: true, snapshotAt: value.checkedAt, staleReason: "Список поставок не удалось обновить. Показаны последние подтверждённые данные." }
      : { snapshotAt: value.checkedAt });
  } catch (error) {
    if (!snapshot) throw error;
    return publicSnapshot(snapshot.value, { stale: true, snapshotAt: new Date(snapshot.at).toISOString(), staleReason: "Не удалось подтвердить свежие данные коробов. Показан предыдущий снимок; готовность к отправке требует проверки." });
  } finally { if (lease) await store.release(lease); }
}
