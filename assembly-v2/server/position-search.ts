import { catalogKey } from "../shared/catalog";
import {
  isArticleSuffixQuery,
  positionSearchMinLength,
  positionSearchMaxLength,
  type PositionSearchItem,
  type PositionSearchPage,
} from "../shared/position-search";
import type { SqlStore } from "./database";

const pageSize = 24;
const skuRange = "p.sku collate nocase >= ? and p.sku collate nocase < ?";
const skuSuffix = `substr(case when substr(upper(trim(p.sku)), -4)='(OZ)'
  then rtrim(substr(trim(p.sku), 1, length(trim(p.sku)) - 4))
  else trim(p.sku) end, -4)=?`;

// A row can still belong to the current RITM order while packing is blocked
// pending store confirmation. Removed source rows retain their history only.
export const positionNeedsStoreReviewSql = `p.source_active=0 and p.ready=0
  and s.source_active=1 and s.origin_shipment_id is not null
  and not exists(select 1 from av2_quality_repairs r
    where r.kind='ritm.manualRetired' and r.entity_id=p.external_id)
  and exists(select 1 from av2_ritm_links l join json_each(l.payload,'$.positions') original
    where l.shipment_id=s.origin_shipment_id and coalesce(json_extract(l.payload,'$.confirmedDeleted'),0)=0
      and json_extract(original.value,'$.positionId')=p.external_id)`;

export async function searchPositions(store: SqlStore, url: URL): Promise<PositionSearchPage> {
  const sku = catalogKey(url.searchParams.get("q") ?? "").slice(0, positionSearchMaxLength);
  if (sku.length < positionSearchMinLength) return { items: [], nextOffset: null };
  const current = url.searchParams.get("supply")?.slice(0, 150) ?? "";
  const requested = Number(url.searchParams.get("offset"));
  const offset = Number.isSafeInteger(requested) && requested > 0 ? Math.min(10000, requested) : 0;
  const bySuffix = isArticleSuffixQuery(sku);
  const skuMatch = bySuffix ? skuSuffix : skuRange;
  const skuArgs = bySuffix ? [sku] : [sku, sku + "\u{10ffff}"];
  const items = await store.all<Omit<PositionSearchItem, "storeNeedsReview"> & { storeNeedsReview: number }>(`
    with matches as (
      select p.id,0 store_needs_review from av2_positions p
      where p.source_active=1 and ${skuMatch}
      union all
      select p.id,1 store_needs_review from av2_positions p
      join av2_supplies s on s.id=p.supply_id
      where ${skuMatch} and ${positionNeedsStoreReviewSql}
    )
    select p.id,p.supply_id,p.sku,p.name,p.plan,coalesce(t.packing,0) packing,
      s.title supply_title,s.market,s.store,m.store_needs_review
    from matches m
    join av2_positions p on p.id=m.id
    join av2_supplies s on s.id=p.supply_id
    left join av2_position_totals t on t.position_id=p.id
    where s.source_active=1 and s.is_demo=0 and s.id<>?
    order by (p.sku collate nocase = ?) desc,m.store_needs_review,s.created_at desc,s.id,p.id
    limit ? offset ?
  `, [...skuArgs, ...skuArgs, current, sku, pageSize + 1, offset]);
  return {
    items: items.slice(0, pageSize).map(item => ({ ...item, storeNeedsReview: Boolean(item.storeNeedsReview) })),
    nextOffset: items.length > pageSize && offset + pageSize <= 10000 ? offset + pageSize : null,
  };
}
