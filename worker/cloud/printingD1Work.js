import { cloudFetch } from "./fetch.js";
import { ritmBridgeEmployee_ } from "../printing.js";
import { sourceId } from "./config.js";

const origin = "https://ritm-print-d1.zinovevkirill234.chatgpt.site";
const freshFor = 8_000;
const pageCount = 3;
const moscowDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
});
const supplyPattern = /^([\w-]{20,100}):(\d{1,16})$/;
export const isPrintingWorkMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "");
const isQuantity = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const hasText = (value, length) => typeof value === "string" && value.trim() && value.length <= length;

function validEvent(row) {
  return row && hasText(row.id, 100) && hasText(row.receiptId, 80) &&
    row.id.startsWith(row.receiptId + ":") && Number.isFinite(Date.parse(row.at)) &&
    typeof row.supplyId === "string" && supplyPattern.test(row.supplyId) &&
    hasText(row.supplyName, 250) && hasText(row.article, 160) &&
    ["box", "roll"].includes(row.department) && ["print", "cut"].includes(row.operation) &&
    (row.correction === true || (
      hasText(row.employee, 140) && isQuantity(row.pieces) &&
      (row.department === "box" || Number.isSafeInteger(row.pieces) && isQuantity(row.area)) &&
      (row.area === null || isQuantity(row.area)) && (row.sheets === null || isQuantity(row.sheets))
    ));
}

function keyOf(value) {
  const match = typeof value === "string" && value.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  const pair = [Number(match[1]), Number(match[2])];
  return pair.every(Number.isSafeInteger) ? pair : null;
}

async function pullWork(fetcher, key, month, previous) {
  const rows = new Map(previous.work.map(row => [row.id, row]));
  let { next, through, complete } = previous;
  for (let page = 0; page < pageCount; page++) {
    const url = new URL("/api/reporting/printing-work", origin);
    url.searchParams.set("month", month);
    url.searchParams.set("after", next);
    if (!complete) url.searchParams.set("through", String(through));
    const response = await cloudFetch(fetcher, url.href, {
      headers: { Authorization: "Bearer " + key },
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Printing journal unavailable");
    const data = await response.json();
    const before = keyOf(next), after = keyOf(data?.next);
    if (data?.schemaVersion !== 1 || !after || !Number.isSafeInteger(data.through) ||
        data.through < through || (!complete && through !== data.through) ||
        after[0] > data.through || after[0] < before[0] ||
        after[0] === before[0] && after[1] < before[1] ||
        typeof data.complete !== "boolean" || (data.complete && after[0] !== data.through) ||
        !Array.isArray(data.work) || data.work.length > 250 || data.work.some(row => !validEvent(row))) {
      throw new Error("Unconfirmed printing journal response");
    }
    if (!data.complete && (data.next === next || data.work.length === 0))
      throw new Error("Printing journal cursor did not advance");
    for (const row of data.work) {
      if (rows.has(row.id) && JSON.stringify(rows.get(row.id)) !== JSON.stringify(row))
        throw new Error("A committed printing record has changed");
      rows.set(row.id, row);
    }
    ({ next, through, complete } = data);
    if (complete) break;
  }
  return { next, through, complete, work: [...rows.values()] };
}

export function projectD1PrintingWork(work, stockRollId = "") {
  const rollPrint = [], rollCut = [], boxPrint = [], boxCut = [];
  let corrections = 0;
  // Only the recorded work has an employee. A progress edit without an original
  // event reference cannot transfer area between employees or earn new area.
  for (const row of new Map(work.map(event => [event.id, event])).values()) {
    if (row.correction === true) {
      corrections++;
      continue;
    }
    const [, spreadsheetId, sheet] = row.supplyId.match(supplyPattern);
    const employee = row.department === "roll"
      ? ritmBridgeEmployee_(row.employee, row.operation === "cut" ? "Резка" : "Печать", "roll-printing") || row.employee.trim()
      : row.employee.trim();
    const common = {
      id: "ritm-print:" + row.id, nativeReceiptId: row.receiptId,
      article: row.article, employee, date: moscowDay.format(new Date(row.at)),
      quantity: row.pieces, area: row.area, sheetId: Number(sheet), spreadsheetId,
    };
    if (row.department === "box") {
      (row.operation === "print" ? boxPrint : boxCut).push({
        ...common, shipment: row.supplyName, sheets: row.sheets,
      });
    } else {
      const stock = spreadsheetId === stockRollId;
      (row.operation === "print" ? rollPrint : rollCut).push({
        ...common, uid: row.rowId || row.id, roll: row.rollName || "",
        sheetName: row.supplyName, site: stock ? "Запасы · рулонная печать" : "Рулонная печать",
        sourceId: "roll-printing", source: "RITM Печать",
      });
    }
  }
  return { rollPrint, rollCut, boxPrint, boxCut, corrections };
}

export async function readD1PrintingWork(bindings, store, month, fetcher) {
  const key = bindings.RITM_PRINTING_D1_WORK_KEY;
  const cacheKey = "printing-d1-staff-work:" + month;
  const stockRollId = sourceId(bindings, "stockRollPrintingId");
  const today = moscowDay.format(new Date(store.now()));
  const freshness = month < today.slice(0, 7) ? 3_600_000 : freshFor;
  const empty = { next: "0:0", through: 0, complete: true, work: [] };
  const report = (state, snapshot) => ({
    state, checkedAt: snapshot ? new Date(snapshot.at).toISOString() : null,
    ...projectD1PrintingWork(snapshot?.value?.work || [], stockRollId),
  });
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) return report("disabled");
  const saved = await store.snapshot(cacheKey).catch(() => null);
  if (saved && store.now() - saved.at < (saved.value.complete ? freshness : freshFor)) return report(saved.value.complete ? "ready" : "syncing", saved);
  let lease;
  try {
    lease = await store.acquire(cacheKey, 20_000);
    const previous = await store.snapshot(cacheKey);
    if (previous && store.now() - previous.at < (previous.value.complete ? freshness : freshFor))
      return report(previous.value.complete ? "ready" : "syncing", previous);
    const value = await pullWork(fetcher, key, month, previous?.value || empty);
    const at = store.now();
    await store.saveSnapshot(cacheKey, value, lease, at);
    return report(value.complete ? "ready" : "syncing", { value, at });
  } catch (error) {
    return report(error?.code === "cloud_operation_busy" ? "syncing" : "stale", saved);
  } finally {
    if (lease) await store.release(lease).catch(() => {});
  }
}
