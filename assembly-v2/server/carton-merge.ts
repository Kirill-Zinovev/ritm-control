import type { CartonItem } from "../shared/model";
import type { SqlStore, Statement } from "./database";

export type MergeAllocation = CartonItem & { legacy: number };

export async function planCartonTransfers(
  store: SqlStore, moves: { item: MergeAllocation; qty: number }[],
  sourceId: string, targetId: string, actor: string, now: string,
) {
  const statements: Statement[] = [];
  const add = (sql: string, ...args: Statement["args"]) => statements.push({ sql, args });
  const partial = moves.filter(({ item, qty }) => qty < item.qty);
  const ancestors = partial.length ? await store.all<{ id: string; legacy: number; rootId: string }>(
    "select id,legacy,root_id from av2_carton_merge_splits where id in (select value from json_each(?))",
    [JSON.stringify(partial.map(({ item }) => item.id))],
  ) : [];
  const roots = new Map(ancestors.map(row => [`${row.legacy}:${row.id}`, row.rootId]));
  const splits = partial.map(({ item, qty }) => ({
    id: crypto.randomUUID(),
    repairId: crypto.randomUUID(),
    legacy: item.legacy,
    parentId: item.id,
    qty,
    before: { id: item.id, positionId: item.positionId, sku: item.sku, qty: item.qty, unitsPerBox: item.unitsPerBox },
    after: { qty, rootId: roots.get(`${item.legacy}:${item.id}`) ?? item.id },
  }));
  if (splits.length) {
    add(`insert into av2_quality_repairs(id,kind,entity_id,"before","after",evidence,actor,created_at)
      select json_extract(value,'$.repairId'),'carton.merge.split',json_extract(value,'$.id'),
        json_extract(value,'$.before'),json_extract(value,'$.after'),
        json_object('from',?,'to',?,'legacy',json_extract(value,'$.legacy')),?,?
      from json_each(?)`, sourceId, targetId, actor, now, JSON.stringify(splits));
  }

  for (const [legacy, table] of [[0, "av2_allocations"], [1, "av2_legacy_allocations"]] as const) {
    const ids = moves.filter(({ item, qty }) => item.legacy === legacy && qty === item.qty).map(({ item }) => item.id);
    if (ids.length) {
      add(`update ${table} set carton_id=? where carton_id=? and removed_at is null
        and id in (select value from json_each(?))`, targetId, sourceId, JSON.stringify(ids));
    }
    const parts = splits.filter(split => split.legacy === legacy);
    if (!parts.length) continue;
    const values = JSON.stringify(parts);
    add(`insert into ${table}(id,carton_id,position_id,qty,units_per_box,created_at,actor)
      select json_extract(part.value,'$.id'),?,a.position_id,json_extract(part.value,'$.qty'),
        a.units_per_box,a.created_at,a.actor
      from json_each(?) part join ${table} a on a.id=json_extract(part.value,'$.parentId')
      where a.carton_id=? and a.removed_at is null`, targetId, values, sourceId);
    // Native inserts use the split trigger to debit their parent during the insert.
    if (legacy) {
      add(`with parts(id,qty) as (select json_extract(value,'$.parentId'),json_extract(value,'$.qty') from json_each(?))
        update av2_legacy_allocations
        set qty=qty-(select qty from parts where id=av2_legacy_allocations.id)
        where carton_id=? and removed_at is null and id in (select id from parts)`, values, sourceId);
    }
  }
  const splitIds = new Map(splits.map(split => [`${split.legacy}:${split.parentId}`, split.id]));
  const items = moves.map(({ item, qty }) => {
    const splitId = splitIds.get(`${item.legacy}:${item.id}`);
    return {
      id: splitId ?? item.id,
      positionId: item.positionId,
      sku: item.sku,
      qty,
      ...(splitId && { splitFromId: item.id }),
    };
  });
  return { statements, items };
}
