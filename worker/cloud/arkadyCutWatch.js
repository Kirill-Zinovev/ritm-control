import { isRitmAssemblyShipmentId } from "../assemblyWorkLog.js";

const departments = { "roll-printing": "roll", "box-printing": "box" };
const minute = 60_000;
const knownQuantity = value => Number.isFinite(value) && value >= 0;
const stageDone = (row, field) => knownQuantity(row[field]) && row[field] >= row.quantity;
const packingStarted = row => Number.isSafeInteger(row.packed) && row.packed > 0 &&
  Number.isSafeInteger(row.packingRecords) && row.packingRecords > 0;
const exactRows = rows => rows.length > 0 && rows.every(row =>
  Number.isSafeInteger(row.quantity) && row.quantity > 0 && typeof row.uid === "string" && row.uid &&
  typeof row.article === "string" && row.article.trim()) &&
  new Set(rows.map(row => row.uid)).size === rows.length;
const sheetKey = row => `${row.sourceId}:${row.sheetId}`;

function recent(value, now) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && timestamp <= now + minute && now - timestamp <= 15 * minute;
}

// Compare only marks from the printing sheet with packing joined to that
// source position by the WorkLog reader. An unknown mark is never a zero.
export function evaluateArkadyCutWatch({ printing, supplies = [], excludedShipmentIds = new Set(), now = Date.now() }) {
  const events = [], resolvedKeys = [];
  if (printing?.ok !== true || printing.stale || printing.refreshFailed || printing.refreshInProgress ||
    printing.assemblyHeldMoves?.length || printing.assemblyHeldRemovals?.length ||
    !recent(printing.snapshotAt, now) || !recent(printing.packing?.checkedAt, now) ||
    !["available", "partial"].includes(printing.packing?.status) || printing.assemblyV2?.pendingRefresh ||
    !["valid", "partial"].includes(printing.quality?.status) ||
    !Array.isArray(printing.sheets) || !Array.isArray(printing.supplies)) return { events, resolvedKeys };
  if (printing.quality.status === "partial" &&
    (!Array.isArray(printing.issues) || !printing.issues.length || printing.issues.some(issue => !issue?.source)))
    return { events, resolvedKeys };
  const affectedSheets = new Set(printing.quality.status === "partial" ? printing.issues.map(issue => issue.source) : []);
  const byShipment = new Map(supplies.map(supply => [supply.id, supply]));
  const bySheet = new Map();
  for (const row of printing.supplies) {
    if (!Object.hasOwn(departments, row.sourceId)) continue;
    const key = sheetKey(row);
    if (!bySheet.has(key)) bySheet.set(key, []);
    bySheet.get(key).push(row);
  }
  const duplicates = new Set();
  const seen = new Set();
  for (const sheet of printing.sheets) {
    const key = sheetKey(sheet);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  for (const sheet of printing.sheets) {
    if (!Object.hasOwn(departments, sheet.sourceId) || !Number.isSafeInteger(sheet.sheetId) ||
      sheet.sheetId < 0 || !sheet.name || duplicates.has(sheetKey(sheet))) continue;
    const department = departments[sheet.sourceId];
    const allRows = bySheet.get(sheetKey(sheet)) || [];
    const rows = allRows.filter(row => row.archived !== true);
    const ids = new Set([sheet.assemblyShipmentId, ...allRows.map(row => row.assemblyShipmentId)].filter(Boolean));
    if (ids.size > 1) continue;
    const supplyId = [...ids][0] || `RITM-${department.toUpperCase()}-${sheet.sheetId}`;
    if (supplyId === "RITM-STOCK-WAREHOUSE" || !isRitmAssemblyShipmentId(supplyId)) continue;
    const key = `${supplyId}:${department}:${sheet.sheetId}`;
    const supply = byShipment.get(supplyId);
    if (excludedShipmentIds.has(supplyId) || sheet.archived === true || supply?.archived === true ||
      (allRows.length > 0 && rows.length === 0)) {
      resolvedKeys.push(key);
      continue;
    }
    if (affectedSheets.has(sheet.name) || !exactRows(rows) ||
      rows.some(row => row.spreadsheetId && sheet.spreadsheetId && row.spreadsheetId !== sheet.spreadsheetId)) continue;
    const packedRows = rows.filter(packingStarted);
    if (rows.every(row => stageDone(row, "cutProgress")) ||
      (rows.every(row => row.packed === 0 || packingStarted(row)) &&
        packedRows.every(row => stageDone(row, "cutProgress")))) {
      resolvedKeys.push(key);
      continue;
    }
    if (!rows.every(row => stageDone(row, "printProgress"))) continue;
    const pending = packedRows.filter(row => knownQuantity(row.cutProgress)
      ? row.cutProgress < row.quantity : row.cutProgress === null && row.cutMarkMissing === true);
    if (!pending.length) continue;
    events.push({
      key, supplyId, name: supply?.name || sheet.name, department, sheetId: sheet.sheetId,
      articles: [...new Set(pending.map(row => row.article))].sort(),
      positions: pending.length, url: sheet.spreadsheetUrl || "",
    });
  }
  return { events, resolvedKeys };
}
