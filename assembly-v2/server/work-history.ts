import {warehouseWorkQty} from "./warehouse-splits";
import type { SqlStore, Statement } from "./database";
import type { Work } from "../shared/model";
import { effectiveCatalogData, positionCatalogJoin } from "./catalog-store";
export async function readWorkHistory(store: SqlStore, url: URL) {
  const p = url.searchParams,
    page = Math.max(0, Math.min(10000, Number(p.get("page")) || 0)) | 0;
  const filters: string[] = [],
    args: (string | number | null)[] = [];
  if (p.get("includeDemo") !== "1") filters.push("w.is_demo=0");
  for (const [param, column] of [
    ["supply", "w.supply_id"],
    ["employee", "w.employee_id"],
  ] as const) {
    const value = p.get(param);
    if (value) {
      filters.push(`${column}=?`);
      args.push(value.slice(0, 300));
    }
  }
  const search = (p.get("q") || "")
    .trim()
    .slice(0, 150)
    .toLocaleUpperCase("ru");
  if (search) {
    filters.push("instr(upper(w.sku||' '||w.name),?)>0");
    args.push(search);
  }
  const from = `from (
    select w.id,w.position_id,w.employee_id,w.employee_name employee,w.operation,w.qty,w.norm,w.coefficient,w.created_at,p.sku,p.name,s.title supply,w.supply_id,s.is_demo,case when c.id is null then 0 else 1 end canceled,c.reason cancel_reason,'supply' scope
    from av2_work w join av2_positions p on p.id=w.position_id join av2_supplies s on s.id=w.supply_id left join av2_corrections c on c.work_id=w.id
    union all
    select w.id,'' position_id,r.employee_id,r.employee,'packing' operation,${warehouseWorkQty()} qty,w.norm,w.coefficient,w.created_at,r.sku,r.name,'На склад · '||c.market||' · Магазин '||c.store supply,'warehouse' supply_id,0 is_demo,case when w.canceled_at is null then 0 else 1 end canceled,w.cancel_reason,'warehouse' scope
    from av2_warehouse_work w join av2_warehouse_receipts r on r.id=w.receipt_id join av2_warehouse_cartons c on c.id=r.carton_id
    union all
    select w.id,'' position_id,w.employee_id,w.employee,w.operation,w.qty,w.norm,w.coefficient,w.created_at,w.sku,w.name,'В запас · '||w.market||' · Магазин '||w.store supply,'warehouse' supply_id,0 is_demo,case when w.canceled_at is null then 0 else 1 end canceled,w.cancel_reason,'warehouse' scope
    from av2_stock_cut_work w
  ) w ${filters.length ? "where " + filters.join(" and ") : ""}`;
  const q = (sql: string, ...a: (string | number | null)[]): Statement => ({
    sql,
    args: a,
  });
  const r = await store.readBatch([
    q("select count(*) total,coalesce(sum(case when w.canceled=0 then w.qty else 0 end),0) qty,coalesce(sum(case when w.canceled=0 then cast(w.coefficient as real) else 0 end),0) coefficient,coalesce(sum(case when w.canceled=0 and w.coefficient is null then 1 else 0 end),0) missing_coefficient " + from, ...args),
    q(
      `select w.id,w.position_id,w.employee_id,w.employee,w.operation,w.qty,w.norm,w.coefficient,w.created_at,w.sku,w.name,w.supply,w.supply_id,w.canceled,w.cancel_reason,w.scope ${from} order by w.created_at desc,w.id desc limit 20 offset ?`,
      ...args,
      page * 20,
    ),
  ]);
  // Enrich only the 20 visible rows; totals and frozen work facts stay unchanged.
  const ids=JSON.stringify(r[1].map(w=>w.id));
  const photos=await store.all<{id:string;catalogImportId:string|null;photoId:string|null;photoUrl:string|null}>(`
    select w.id,p.catalog_import_id,json_extract(pc.value,'$.photoId') photo_id,
      coalesce(json_extract(pc.value,'$.photoUrl'),sp.url) photo_url
    from av2_work w join av2_positions p on p.id=w.position_id
    ${positionCatalogJoin()}
    left join av2_source_photos sp on sp.position_id=p.external_id and sp.sku=p.sku
    where w.id in(select value from json_each(?))
    union all
    select w.id,r.catalog_import_id,r.photo_id,
      coalesce((select o.url from av2_photo_overrides o where o.sku=upper(r.sku)),sp.url) photo_url
    from av2_warehouse_work w join av2_warehouse_receipts r on r.id=w.receipt_id
    left join av2_positions p on p.id=r.position_id
    left join av2_source_photos sp on sp.position_id=p.external_id and sp.sku=p.sku
    where w.id in(select value from json_each(?))
    union all
    select w.id,w.catalog_import_id,json_extract(e.data,'$.photoId') photo_id,json_extract(${effectiveCatalogData()},'$.photoUrl') photo_url
    from av2_stock_cut_work w join av2_resolved_catalog_entries e on e.import_id=w.catalog_import_id and e.sku=w.sku and e.market=w.market and e.store=w.store
    where w.id in(select value from json_each(?))
    group by w.id having count(*)=1
  `,[ids,ids,ids]);
  const media=new Map(photos.map(row=>[row.id,row]));
  return {
    total: r[0][0].total,
    totals:{qty:r[0][0].qty,coefficient:r[0][0].coefficient,missingCoefficient:r[0][0].missingCoefficient},
    page,
    items: r[1].map((w) => ({
      ...w,
      ...media.get(String(w.id)),
      canceled: !!w.canceled,
    })) as unknown as (Work & { supply: string; supplyId: string })[],
  };
}
