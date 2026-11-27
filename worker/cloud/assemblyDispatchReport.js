import { CloudError, readBytes } from "./access.js";
import { callAssemblyV2 } from "./assemblyV2Transport.js";

const shipmentIdPattern = /^RITM-(?:(?:ROLL|BOX)-\d{1,16}|SUPPLY-[a-f0-9-]{36})$/i;
const maxSupplies = 100;
const maxReportRows = 20_000;
const maxReportBytes = 4_000_000;
const maxSnapshotAge = 120_000;

const invalidReport = () => new CloudError(
  "production_dispatch_unavailable",
  "Не удалось подтвердить данные об отгрузке в «РИТМ Сборке». Повторите обновление.",
  503,
);

const largeReport = () => new CloudError(
  "production_dispatch_too_large",
  "В отчёте слишком много позиций. Выберите меньше поставок.",
  413,
);

const boundedString = (value, max) => typeof value === "string" && value.length <= max;
const requiredString = (value, max) => boundedString(value, max) && value.trim().length > 0;
const validQuantity = (value) => Number.isSafeInteger(value) && value >= 0;

function validCarton(carton) {
  return requiredString(carton?.id, 240) && requiredString(carton.label, 240) &&
    validQuantity(carton.qty) && carton.qty > 0 &&
    (carton.state === "open" || carton.state === "closed") && typeof carton.prepared === "boolean";
}

function verifiedRows(rows, requested) {
  if (!Array.isArray(rows)) throw invalidReport();
  if (rows.length > maxReportRows) throw largeReport();
  const positions = new Set();
  return rows.map((row) => {
    if (!requested.has(row?.supplyId) || (row.supplyTitle !== undefined && !boundedString(row.supplyTitle, 300)) ||
      !requiredString(row.positionId, 500) ||
      !requiredString(row.sku, 160) || !boundedString(row.department, 80) ||
      (row.market !== "WB" && row.market !== "OZON") || !boundedString(row.store, 40) ||
      !boundedString(row.destination, 240) || !validQuantity(row.plan) || !validQuantity(row.packed) ||
      (row.sent !== null && !validQuantity(row.sent)) || !Array.isArray(row.cartons) ||
      !row.cartons.every(validCarton) || new Set(row.cartons.map((carton) => carton.id)).size !== row.cartons.length)
      throw invalidReport();
    const key = JSON.stringify([row.supplyId, row.market, row.store, row.positionId]);
    if (positions.has(key)) throw invalidReport();
    positions.add(key);
    const { supplyId, supplyTitle, positionId, sku, department, market, store, destination, plan, packed, sent } = row;
    const cartons = row.cartons.map(({ id, label, qty, state, prepared }) => ({ id, label, qty, state, prepared }));
    const sentCartons = row.sentCartons ?? [];
    if (!Array.isArray(sentCartons) || !sentCartons.every(box => requiredString(box?.id, 240) &&
        requiredString(box.label, 240) && validQuantity(box.qty) && box.qty > 0) ||
        new Set(sentCartons.map(box => box.id)).size !== sentCartons.length ||
        (sent !== null && sentCartons.reduce((sum, box) => sum + box.qty, 0) > sent)) throw invalidReport();
    return { supplyId, ...(supplyTitle === undefined ? {} : { supplyTitle }), positionId, sku, department, market, store, destination, plan, packed, sent, cartons,
      ...(row.sentCartons !== undefined && {sentCartons: sentCartons.map(({ id, label, qty }) => ({ id, label, qty }))}) };
  });
}

export async function readAssemblyDispatchReport(input, bindings, { fetcher = fetch, now = Date.now } = {}) {
  const supplyIds = input?.supplyIds;
  if (!Array.isArray(supplyIds) || !supplyIds.length || supplyIds.length > maxSupplies ||
    supplyIds.some((id) => typeof id !== "string" || !shipmentIdPattern.test(id)) ||
    new Set(supplyIds).size !== supplyIds.length)
    throw new CloudError("production_dispatch_invalid_input", "Выберите от 1 до 100 разных поставок.", 400);

  let data;
  try {
    const response = await callAssemblyV2(bindings, "/api/ritm/dispatch-report", {
      method: "POST", body: JSON.stringify({ supplyIds }), fetcher, now: now(), timeout: 10_000,
    });
    if (response.status === 413) {
      await response.body?.cancel();
      throw largeReport();
    }
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw invalidReport();
    }
    const bytes = await readBytes(response, maxReportBytes);
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error?.code === "production_dispatch_too_large" || error?.code === "body_too_large") throw largeReport();
    throw invalidReport();
  }

  const timestamp = typeof data?.checkedAt === "string" ? Date.parse(data.checkedAt) : NaN;
  if (data?.schemaVersion !== 1 || !validQuantity(data.revision) || !Number.isFinite(timestamp))
    throw invalidReport();
  if (Math.abs(now() - timestamp) > maxSnapshotAge)
    throw new CloudError("production_dispatch_stale", "Данные об отправке устарели. Обновите отчёт.", 503);

  return {
    ok: true,
    source: "РИТМ Сборка",
    checkedAt: data.checkedAt,
    stale: false,
    schemaVersion: data.schemaVersion,
    revision: data.revision,
    rows: verifiedRows(data.rows, new Set(supplyIds)),
  };
}
