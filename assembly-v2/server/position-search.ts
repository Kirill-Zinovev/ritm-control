import { catalogKey } from "../shared/catalog";
import {
  positionSearchMinLength,
  positionSearchMaxLength,
  type PositionSearchItem,
  type PositionSearchPage,
} from "../shared/position-search";
import type { SqlStore } from "./database";

const pageSize = 24;

export async function searchPositions(store: SqlStore, url: URL): Promise<PositionSearchPage> {
  const sku = catalogKey(url.searchParams.get("q") ?? "").slice(0, positionSearchMaxLength);
  if (sku.length < positionSearchMinLength) return { items: [], nextOffset: null };
  const current = url.searchParams.get("supply")?.slice(0, 150) ?? "";
  const requested = Number(url.searchParams.get("offset"));
  const offset = Number.isSafeInteger(requested) && requested > 0 ? Math.min(10000, requested) : 0;
  const items = await store.all<PositionSearchItem>(`
    select p.id,p.supply_id,p.sku,p.name,p.plan,coalesce(t.packing,0) packing,
      s.title supply_title,s.market,s.store
    from av2_positions p
    join av2_supplies s on s.id=p.supply_id
    left join av2_position_totals t on t.position_id=p.id
    where p.source_active=1 and s.source_active=1 and s.is_demo=0
      and p.sku collate nocase >= ? and p.sku collate nocase < ? and s.id<>?
    order by (p.sku collate nocase = ?) desc,s.created_at desc,s.id,p.id
    limit ? offset ?
  `, [sku, sku + "\u{10ffff}", current, sku, pageSize + 1, offset]);
  return {
    items: items.slice(0, pageSize),
    nextOffset: items.length > pageSize && offset + pageSize <= 10000 ? offset + pageSize : null,
  };
}
