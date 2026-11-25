import {warehouseWorkQty} from "./warehouse-splits";
import type { SqlStore, Statement } from "./database";
import type { Work } from "../shared/model";
import { missingWorkNormReason, type ShiftNorm } from "../shared/work-norm";
import { effectiveCatalogData, positionCatalogJoin, positionWorkCatalogSql } from "./catalog-store";
const workRows = `
  select w.id,w.position_id,w.employee_id,w.employee_name employee,w.operation,w.qty,w.norm,w.coefficient,w.created_at,p.sku,p.name,s.title supply,w.supply_id,s.is_demo,case when c.id is null then 0 else 1 end canceled,c.reason cancel_reason,'supply' scope,
    coalesce(
      (select json_extract(e.data,'$.kind') from av2_resolved_catalog_entries e where e.import_id=p.catalog_import_id and e.entry_id=p.catalog_entry_id limit 1),
      (select json_extract(o.payload,'$.productType') from av2_ritm_work_outbox o where o.id='av2:'||w.id)
    ) product_type,
    p.external_id source_position_id,coalesce(s.origin_shipment_id,s.external_id) source_supply_id
  from av2_work w join av2_positions p on p.id=w.position_id join av2_supplies s on s.id=w.supply_id left join av2_corrections c on c.work_id=w.id
  union all
  select w.id,'' position_id,r.employee_id,r.employee,'packing' operation,${warehouseWorkQty()} qty,w.norm,w.coefficient,w.created_at,r.sku,r.name,'На склад · '||c.market||' · Магазин '||c.store supply,'warehouse' supply_id,0 is_demo,case when w.canceled_at is null then 0 else 1 end canceled,w.cancel_reason,'warehouse' scope,w.product_type,'','warehouse'
  from av2_warehouse_work w join av2_warehouse_receipts r on r.id=w.receipt_id join av2_warehouse_cartons c on c.id=r.carton_id
  union all
  select w.id,'' position_id,w.employee_id,w.employee,w.operation,w.qty,w.norm,w.coefficient,w.created_at,w.sku,w.name,'В запас · '||w.market||' · Магазин '||w.store supply,'warehouse' supply_id,0 is_demo,case when w.canceled_at is null then 0 else 1 end canceled,w.cancel_reason,'warehouse' scope,w.product_type,'','warehouse'
  from av2_stock_cut_work w
`;

const endOfDayMs = 24 * 60 * 60 * 1000;
const reportPageSize = 1500;
function moscowMidnight(day: string | null) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const noon = new Date(day + "T12:00:00Z");
  if (!Number.isFinite(noon.getTime()) || noon.toISOString().slice(0, 10) !== day) return null;
  return Date.parse(day + "T00:00:00+03:00");
}

export async function readRitmWorkReport(store: SqlStore, url: URL) {
  const from = moscowMidnight(url.searchParams.get("from"));
  const through = moscowMidnight(url.searchParams.get("to"));
  const after = url.searchParams.get("after");
  const afterId = url.searchParams.get("id");
  const hasCursor = after !== null || afterId !== null;
  if (from === null || through === null || from > through ||
      (hasCursor && (!after || !/^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d\.\d{3}Z$/.test(after)
        || !Number.isFinite(Date.parse(after)) || !afterId || afterId.length > 300)))
    return null;
  const first = new Date(from).toISOString(), end = new Date(through + endOfDayMs).toISOString();
  const [proof, rows] = await store.readBatch([
    { sql: "select coalesce((select revision from av2_meta where id=1),0) revision", args: [] },
    {
      sql: `with work as (
        select id,source_position_id position_id,employee_id,employee,operation,qty,norm,coefficient,sku,supply,source_supply_id supply_id,scope,product_type,
          strftime('%Y-%m-%dT%H:%M:%fZ',created_at) created_at
        from (${workRows}) where is_demo=0 and canceled=0
      )
      select * from work where created_at>=? and created_at<?${hasCursor ? " and (created_at>? or (created_at=? and id>?))" : ""}
      order by created_at,id limit ?`,
      args: [first, end, ...(hasCursor ? [after, after, afterId] : []), reportPageSize + 1],
    },
  ]);
  const events = rows.slice(0, reportPageSize);
  const missing = events.filter(row => row.scope === "supply" && row.coefficient === null);
  if (missing.length) {
    const [details, norms] = await store.readBatch([
      {
        sql: `select w.id,s.market,s.store,${positionWorkCatalogSql(true)} catalog
          from av2_work w join av2_positions p on p.id=w.position_id
          join av2_supplies s on s.id=w.supply_id ${positionCatalogJoin()}
          where w.id in (select value from json_each(?))`,
        args: [JSON.stringify(missing.map(row => row.id))],
      },
      { sql: "select data from av2_shift_norms", args: [] },
    ]);
    const shifts = norms.map(row => JSON.parse(String(row.data)) as ShiftNorm);
    const byId = new Map(details.map(row => [row.id, row]));
    for (const event of missing) {
      const source = byId.get(event.id);
      if (!source) continue;
      const candidate = source.catalog ? JSON.parse(String(source.catalog)) as Record<string, unknown> : null;
      const catalog = candidate?.retiredIdentity ? null : candidate;
      const reason = missingWorkNormReason(catalog, shifts, event.operation as Work["operation"]);
      event.normIssue = {
        reason: event.norm !== null && catalog ? "ready" : reason,
        market: source.market,
        store: catalog?.store || source.store,
        hasCard: !!catalog,
      };
    }
  }
  const last = events.at(-1);
  return {
    ok: true, schemaVersion: 1, revision: proof[0].revision, events,
    next: rows.length > reportPageSize && last ? { at: last.createdAt, id: last.id } : null,
  };
}
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
  const from = `from (${workRows}) w ${filters.length ? "where " + filters.join(" and ") : ""}`;
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
