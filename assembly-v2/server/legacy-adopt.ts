import type { SqlStore, Statement } from "./database";
import { requireCatalog as check } from "./catalog-store";
import { digest } from "../shared/catalog";
import { legacyRestorePlan } from "./legacy-restore";

const q = (sql: string, ...args: (string | number | null)[]): Statement => ({ sql, args });
const text = (value: unknown) => typeof value === "string" ? value : "";
type Placement = { id: string; positionId: string; qty: number; legacy: number };

// Adopt an existing v2 number only after the owner has identified the old
// physical carton as authoritative. No work or historical allocation is deleted.
export async function legacyAdoptCartonPlan(
  store: SqlStore,
  payload: Record<string, unknown>,
  actor: string,
  now: string,
) {
  const box = payload.box as Record<string, unknown> | undefined;
  const raw = box?.raw as Record<string, unknown> | undefined;
  const expected = payload.expected as Array<Record<string, unknown>> | undefined;
  const placements = payload.placements as Array<Record<string, unknown>> | undefined;
  check(box && raw && Array.isArray(expected) && Array.isArray(placements), "Не подтверждены состав и источник короба.");
  check(payload.confirmed === true && text(payload.reason).trim().length >= 8, "Не подтверждено решение владельца.");
  const id = text(box.id), sourceId = text(box.sourceId), label = text(box.label);
  check(id && !id.startsWith("legacy:") && sourceId.startsWith("carton-") && label, "Не подтверждён номер короба.");
  check(raw.cartonId === sourceId && raw["Номер"] === label && raw["Статус"] === "Открыт" && box.state === "open", "Исходный короб изменился.");
  check(Number.isSafeInteger(Number(raw["Занято, шт"])) && Number(raw["Занято, шт"]) > 0 && placements.length > 0 && placements.length <= 100, "Не подтверждено количество старого короба.");

  const current = (await store.all<{ id: string; label: string; market: string; store: string; destination: string; state: string; dispatchId: string | null; createdAt: string }>(
    "select id,label,market,store,destination,state,dispatch_id,created_at from av2_cartons where id=?", [id],
  ))[0];
  check(current && current.label === label && current.state === "open" && !current.dispatchId && current.market === box.market && current.store === box.store, "Короб изменился или выбран на отгрузку.");
  check(!(await store.all("select source_id from av2_legacy_records where (kind='cartonAlias' and source_id=?) or (kind='cartons' and source_id=?)", [id, sourceId])).length, "Короб уже связан с историей.");
  const supply = await store.all("select id from av2_supplies where origin_shipment_id=? and market=? and store=? and destination=?", [text(raw.shipmentId), text(box.market), text(box.store), text(box.destination)]);
  check(supply.length === 1, "Исходное направление короба не подтверждено.");

  const active = await store.all<Placement>("select id,position_id,qty,legacy from av2_all_allocations where carton_id=? and removed_at is null order by id", [id]);
  const normalize = (items: Array<Record<string, unknown>>) => items.map((item) => ({ id: text(item.id), positionId: text(item.positionId), qty: Number(item.qty) })).sort((a, b) => a.id.localeCompare(b.id));
  check(active.every((item) => item.legacy === 0) && JSON.stringify(normalize(active as unknown as Array<Record<string, unknown>>)) === JSON.stringify(normalize(expected)), "Состав нового короба изменился. Повторите сверку.");
  check(new Set(placements.map((item) => text(item.sourceId))).size === placements.length, "Повторяются вложения старого короба.");
  for (const item of placements) {
    const itemRaw = item.raw as Record<string, unknown> | undefined;
    check(itemRaw && itemRaw.cartonId === sourceId && itemRaw.allocationId === item.sourceId && item.id === "legacy:" + item.sourceId && item.cartonId === id && Number.isSafeInteger(item.qty) && Number(item.qty) > 0, "Не подтверждено вложение старого короба.");
  }
  check(placements.reduce((sum, item) => sum + Number(item.qty), 0) === Number(raw["Занято, шт"]), "Количество вложений не совпадает со старым коробом.");

  const positions = new Set([...active.map((item) => item.positionId), ...placements.map((item) => text(item.positionId))]);
  for (const positionId of positions) {
    const totals = (await store.all<{ packing: number; boxed: number }>("select packing,boxed from av2_position_totals where position_id=?", [positionId]))[0];
    const removed = active.filter((item) => item.positionId === positionId).reduce((sum, item) => sum + item.qty, 0);
    const added = placements.filter((item) => item.positionId === positionId).reduce((sum, item) => sum + Number(item.qty), 0);
    check(totals && totals.boxed >= removed && totals.boxed - removed + added <= totals.packing, "Упаковка и состав короба расходятся.");
  }

  const statements: Statement[] = [];
  for (const item of active) {
    statements.push(q("update av2_allocations set removed_at=?,removal_reason=? where id=? and removed_at is null", now, text(payload.reason), item.id));
    statements.push(q("update av2_position_totals set boxed=boxed-? where position_id=?", item.qty, item.positionId));
  }
  statements.push(q("update av2_cartons set destination=?,created_at=? where id=?", text(box.destination), text(box.createdAt), id));
  const common = { sourceWorkbookId: payload.sourceWorkbookId, sourceHash: payload.sourceHash };
  const cartonPlan = await legacyRestorePlan(store, { ...common, kind: "cartons", rows: [box] }, actor, now);
  const allocationPlan = await legacyRestorePlan(store, { ...common, kind: "allocations", rows: placements }, actor, now);
  statements.push(...cartonPlan.statements, ...allocationPlan.statements);
  const alias = { legacySourceId: sourceId };
  statements.push(q("insert into av2_legacy_records(kind,source_id,hash,data,captured_at) values('cartonAlias',?,?,?,?)", id, await digest(JSON.stringify(alias)), JSON.stringify(alias), now));
  statements.push(q('insert into av2_quality_repairs(id,kind,entity_id,"before","after",evidence,actor,created_at) values(?,?,?,?,?,?,?,?)', crypto.randomUUID(), "legacy.carton.adoption", id, JSON.stringify({ carton: current, allocations: active }), JSON.stringify({ legacySourceId: sourceId, label, count: placements.length }), JSON.stringify({ sourceHash: payload.sourceHash, reason: payload.reason }), actor, now));
  return { statements, result: { cartonId: id, legacySourceId: sourceId, label, removedQty: active.reduce((sum, item) => sum + item.qty, 0), importedQty: placements.reduce((sum, item) => sum + Number(item.qty), 0) } };
}
