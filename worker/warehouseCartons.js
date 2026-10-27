import { assignCatalogStores, assignWorkloadDetails } from "./printing.js";

const text = (value) => String(value ?? "").trim();
const skuKey = (value) => text(value).toLocaleUpperCase("ru-RU").replace(/\s+/g, "").replace(/\(OZ\)$/i, "");
const marketOf = (value) => {
  const name = text(value).toLocaleUpperCase("ru-RU");
  const ozon = /(^|[^\p{L}\p{N}])(?:OZON|ОЗОН)([^\p{L}\p{N}]|$)/u.test(name);
  const wb = /(^|[^\p{L}\p{N}])(?:WB|ВБ|WILDBERRIES)([^\p{L}\p{N}]|$)/u.test(name);
  return ozon === wb ? "" : wb ? "WB" : "OZON";
};
const whole = (value) => { const n = typeof value === "number" ? value : Number(text(value).replace(",", ".")); return Number.isSafeInteger(n) ? n : null; };
const normalized = (value) => text(value).replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");

function catalogNorms(catalog) {
  const result = new Map();
  for (const market of ["OZON", "WB"]) {
    const rows = catalog?.[market];
    if (!Array.isArray(rows)) continue;
    const headerIndex = rows.slice(0, 10).findIndex((row) => row.some((cell) => normalized(cell) === "артикул"));
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex].map(normalized);
    const columns = {
      articles: headers.flatMap((header, i) => header === "артикул" || header === "артикул (oz)" ? [i] : []),
      type: headers.indexOf("тип короба"), count: headers.indexOf("кол-во вида"), box: headers.indexOf("в коробке"),
    };
    if (market === "OZON" && !columns.articles.includes(1)) columns.articles.push(1);
    for (const row of rows.slice(headerIndex + 1)) {
      const boxText = text(row[columns.box]), match = boxText.match(/^(\d+(?:[.,]\d+)?)(?:\s+(.+))?$/);
      const boxCount = match ? whole(match[1]) : null, typeCount = text(row[columns.count]) ? whole(row[columns.count]) : null;
      const declared = text(row[columns.type]), suffix = text(match?.[2]), boxType = declared || suffix;
      const capacity = boxCount ?? typeCount;
      const valid = !!boxType && Number.isSafeInteger(capacity) && capacity > 0 && !(declared && suffix && normalized(declared) !== normalized(suffix)) && !(boxCount !== null && typeCount !== null && boxCount !== typeCount);
      for (const sku of new Set(columns.articles.map((i) => skuKey(row[i])).filter(Boolean))) {
        const key = `${market}:${sku}`, values = result.get(key) || [];
        values.push(valid ? { boxType, capacity } : null); result.set(key, values);
      }
    }
  }
  return (market, sku) => {
    const entries = result.get(`${market}:${skuKey(sku)}`) || [];
    if (!entries.length || entries.some((entry) => !entry)) return null;
    const signatures = new Set(entries.map((entry) => `${normalized(entry.boxType)}|${entry.capacity}`));
    return signatures.size === 1 ? entries[0] : null;
  };
}

export function buildWarehouseSnapshot(boxRows, contentRows, { catalog = null, photos = null, checkedAt = new Date().toISOString(), activeShipmentIds = null } = {}) {
  const activeIds = activeShipmentIds instanceof Set ? activeShipmentIds : null;
  const currentBoxRows = activeIds ? boxRows.filter((row) => {
    const shipmentId = text(row.shipmentId);
    return !shipmentId || activeIds.has(shipmentId);
  }) : boxRows;
  const currentCartonIds = new Set(currentBoxRows.map((row) => text(row.cartonId)).filter(Boolean));
  const currentContentRows = activeIds ? contentRows.filter((row) => {
    const cartonId = text(row.cartonId), shipmentId = text(row.shipmentId);
    if (cartonId && currentCartonIds.has(cartonId)) return true;
    return !shipmentId || activeIds.has(shipmentId);
  }) : contentRows;
  const boxes = new Map(), issues = [], activeNumbers = new Map();
  for (const row of currentBoxRows) {
    const id = text(row.cartonId), rawStatus = normalized(row["Статус"]);
    if (!id || boxes.has(id)) { issues.push("Повторный или пустой идентификатор короба"); if (id && boxes.has(id)) boxes.get(id).issues.push("Идентификатор короба повторяется"); continue; }
    const cancelled = ["отменён", "отменен", "cancelled"].includes(rawStatus);
    const open = ["открыт", "open", "active"].includes(rawStatus);
    const closed = ["закрыт", "closed"].includes(rawStatus);
    const record = { id, number: text(row["Номер"]), shipmentId: text(row.shipmentId), directionId: text(row.directionId), shipment: text(row["Направление"]), market: marketOf(row["Направление"]), boxType: text(row["Тип короба"]), status: cancelled ? "cancelled" : open ? "open" : closed ? "closed" : "unknown", createdAt: text(row.createdAt), closedAt: text(row.closedAt), recordedOccupied: text(row["Занято, шт"]) === "" ? null : whole(row["Занято, шт"]), issues: [], allocations: [], history: [] };
    if (!record.number || !record.shipmentId || !record.directionId || !record.shipment) record.issues.push("Не подтверждена связь с поставкой или номер короба");
    if (record.status === "unknown") record.issues.push("Статус короба не подтверждён");
    if (closed && (!record.closedAt || !Number.isFinite(Date.parse(record.closedAt)))) record.issues.push("Закрытие ещё не подтверждено временем");
    if (open && record.closedAt) record.issues.push("Статус и время закрытия противоречат друг другу");
    boxes.set(id, record);
    if (!cancelled && record.number) { const key = normalized(record.number); activeNumbers.set(key, [...(activeNumbers.get(key) || []), id]); }
  }
  for (const ids of activeNumbers.values()) if (ids.length > 1) for (const id of ids) boxes.get(id).issues.push("Номер короба повторяется");
  const allocations = new Map(), removals = [], seenAllocations = new Set();
  for (const row of currentContentRows) {
    const id = text(row.allocationId), cartonId = text(row.cartonId), box = boxes.get(cartonId), action = text(row.action).toUpperCase();
    if (!box) { issues.push("Запись состава без короба"); continue; }
    const quantity = whole(row["Количество, шт"]), sku = text(row["Артикул"]), createdAt = text(row.createdAt);
    if (!id || seenAllocations.has(id)) { box.issues.push("Повторная или неполная запись состава"); continue; }
    seenAllocations.add(id);
    if (!Number.isSafeInteger(quantity) || !sku || !text(row.positionId) || !text(row.shipmentId) || !text(row.directionId)) { box.issues.push("Некорректная запись состава"); continue; }
    if (text(row.shipmentId) !== box.shipmentId || text(row.directionId) !== box.directionId) box.issues.push("Состав относится к другой поставке или направлению");
    const entry = { id, cartonId, sku, quantity, positionId: text(row.positionId), createdAt, action, sourceAllocationId: text(row.sourceAllocationId), reason: text(row.reason) };
    if (action === "REMOVE") { if (quantity >= 0 || !entry.sourceAllocationId) { box.issues.push("Некорректная корректировка состава"); continue; } removals.push(entry); }
    else if ((action === "" || action === "ADD") && quantity > 0) { allocations.set(id, { ...entry, removed: 0 }); }
    else { box.issues.push("Неизвестное действие в журнале короба"); continue; }
    box.history.push({ action: action === "REMOVE" ? "remove" : "add", article: sku, quantity, createdAt, reason: entry.reason, employee: null });
  }
  for (const removal of removals) {
    const source = allocations.get(removal.sourceAllocationId), box = boxes.get(removal.cartonId);
    if (!source || source.cartonId !== removal.cartonId || source.positionId !== removal.positionId || skuKey(source.sku) !== skuKey(removal.sku)) { box.issues.push("Не найдена исходная запись корректировки"); continue; }
    source.removed += Math.abs(removal.quantity);
    if (source.removed > source.quantity) box.issues.push("Корректировка превышает исходное количество");
  }
  for (const allocation of allocations.values()) {
    const quantity = Math.max(0, allocation.quantity - allocation.removed);
    if (quantity) boxes.get(allocation.cartonId).allocations.push({ ...allocation, quantity });
  }
  const resolveNorm = catalogNorms(catalog);
  const lookup = [];
  for (const box of boxes.values()) {
    const grouped = new Map();
    for (const item of box.allocations) {
      const key = `${item.positionId}\u0000${skuKey(item.sku)}`;
      const entry = grouped.get(key) || { article: item.sku, positionId: item.positionId, quantity: 0 };
      entry.quantity += item.quantity; grouped.set(key, entry);
    }
    box.contents = [...grouped.values()];
    for (const item of box.contents) { const row = { article: item.article, sheetName: box.shipment }; lookup.push({ box, item, row }); }
  }
  const lookups = lookup.map((entry) => entry.row);
  assignCatalogStores(lookups, catalog);
  assignWorkloadDetails(lookups, catalog, photos);
  for (const { item, row } of lookup) Object.assign(item, { store: row.shopCatalogStatus === "matched" ? text(row.shop) : "", storeStatus: row.shopCatalogStatus || "unavailable", productName: text(row.productName), photoUrl: text(row.photoUrl) });
  const result = [];
  for (const box of boxes.values()) {
    if (box.status === "cancelled") continue;
    const quantity = box.contents.reduce((sum, item) => sum + item.quantity, 0);
    if (!quantity) box.issues.push("Состав короба пуст или не подтверждён");
    if (box.recordedOccupied === null || box.recordedOccupied !== quantity) box.issues.push("Количество в коробе требует сверки");
    if (!box.boxType) box.issues.push("Тип короба не подтверждён");
    const stores = [...new Set(box.contents.map((item) => item.store).filter(Boolean))];
    if (stores.length > 1) box.issues.push("В коробе обнаружены разные магазины");
    if (box.contents.some((item) => !item.store)) box.issues.push("Магазин не подтверждён для всех товаров");
    const numberStore = text(box.number).match(/^(\d+)[a-zа-яё]/i)?.[1] || "";
    if (!numberStore) box.issues.push("Магазин в номере короба не подтверждён");
    if (stores.length === 1 && numberStore && Number(stores[0]) !== Number(numberStore)) box.issues.push("Магазин в номере короба не совпадает с базой");
    const norms = box.contents.map((item) => resolveNorm(box.market, item.article));
    const fill = box.contents.length && norms.every(Boolean) ? box.contents.reduce((sum, item, index) => sum + item.quantity / norms[index].capacity, 0) * 100 : null;
    const uniqueIssues = [...new Set(box.issues)];
    if (box.closedAt && Number.isFinite(Date.parse(box.closedAt))) box.history.push({ action: "close", article: "", quantity: null, createdAt: box.closedAt, reason: "", employee: null });
    result.push({ id: box.id, number: box.number, shipmentId: box.shipmentId, shipment: box.shipment, directionId: box.directionId, market: box.market, store: stores.length === 1 && box.contents.every((item) => item.store) ? stores[0] : "", boxType: box.boxType, status: box.status, createdAt: box.createdAt, closedAt: box.closedAt, quantity, fillPercent: fill, ready: box.status === "closed" && uniqueIssues.length === 0 && issues.length === 0, issues: uniqueIssues, contents: box.contents, history: box.history.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) });
  }
  return { ok: true, schemaVersion: 1, checkedAt, stale: false, cartons: result, cancelledCount: [...boxes.values()].filter((box) => box.status === "cancelled").length, issues: [...new Set(issues)], catalogAvailable: !!catalog };
}
