import type {
  CatalogEntry,
  CatalogManifest,
  CatalogPhoto,
  CatalogPage,
  CatalogDetail,
} from "../shared/catalog";
import { catalogKey } from "../shared/catalog";
import type { SupplyImport } from "../shared/model";
import type { SqlStore, Statement } from "./database";
const q = (sql: string, ...args: (string | number | null)[]): Statement => ({
  sql,
  args,
});
export function requireCatalog(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
export async function importManifest(
  store: SqlStore,
  id: string,
): Promise<{ manifest: CatalogManifest; state: string }> {
  const row = (
    await store.all<{ manifest: string; state: string }>(
      "select manifest,state from av2_catalog_imports where id=?",
      [id],
    )
  )[0];
  requireCatalog(row, "Импорт справочника не найден.");
  return { manifest: JSON.parse(row.manifest), state: row.state };
}

export function catalogEntryWithStore(entry: CatalogEntry, shop: string): CatalogEntry {
  return {
    ...entry,
    id: JSON.stringify([entry.market, shop, catalogKey(entry.sku)]),
    store: shop,
    issues: entry.issues.filter(issue => issue !== 'Ошибка Excel: store' && issue !== 'Не заполнено поле: store'),
  };
}

export function catalogSourceStoreUpdates(importId: string, previousId: string, entry: CatalogEntry): Statement[] {
  return [
    q('update av2_catalog_entries set entry_id=?,store=?,data=?,review=? where import_id=? and entry_id=?',
      entry.id, entry.store, JSON.stringify(entry), entry.issues.length ? 1 : 0, importId, previousId),
    q('update av2_catalog_aliases set entry_id=?,store=? where import_id=? and entry_id=?',
      entry.id, entry.store, importId, previousId),
    q('update av2_positions set catalog_entry_id=? where catalog_import_id=? and catalog_entry_id=?',
      entry.id, importId, previousId),
  ];
}

export async function catalogActivationPlan(
  store: SqlStore,
  id: string,
): Promise<Statement[]> {
  const { manifest } = await importManifest(store, id);
  const [counts] = await store.all<{
    entries: number;
    photos: number;
    chunks: number;
    files: number;
    rows: number;
    missing: number;
  }>(
    `select
    (select count(*) from av2_catalog_entries where import_id=?) entries,
    (select count(*) from av2_catalog_photos where import_id=?) photos,
    (select count(*) from av2_catalog_chunks where import_id=?) chunks,
    (select count(*) from av2_catalog_files where import_id=?) files,
    (select coalesce(sum(json_array_length(data,'$.rows')),0) from av2_catalog_entries where import_id=?) rows,
    (select count(*) from av2_catalog_entries e where import_id=? and json_extract(e.data,'$.photoId') is not null and not exists(select 1 from av2_catalog_photos p where p.import_id=e.import_id and p.photo_id=json_extract(e.data,'$.photoId'))) missing`,
    [id, id, id, id, id, id],
  );
  requireCatalog(
    counts.entries === manifest.entries &&
      counts.photos === manifest.photos &&
      counts.chunks === manifest.chunks.length &&
      counts.rows === manifest.sourceRows &&
      counts.files === 2 &&
      counts.missing === 0,
    "Импорт ещё не завершён: проверьте пакеты, исходные файлы и ссылки фотографий.",
  );

  // Reapply explicitly saved assignments when a later Excel still omits the store.
  // A real row at the target key or conflicting links require manual review.
  const assignments = await store.all<{ data: string; shop: string }>(`
    with confirmed as (
      select json_extract(r.before,'$.entry.id') source_id, min(p.entry_id) target_id
      from av2_quality_repairs r join av2_catalog_products p on p.entry_id=json_extract(r.after,'$.id')
      where r.kind='catalog.assignStore'
      group by source_id having count(distinct p.entry_id)=1
    )
    select e.data, p.store shop
    from confirmed c join av2_catalog_entries e on e.import_id=? and e.entry_id=c.source_id and e.store=''
    join av2_catalog_products p on p.entry_id=c.target_id
    where not exists(select 1 from av2_imported_catalog_entries t where t.import_id=e.import_id and t.entry_id=p.entry_id)
      and not exists(select 1 from av2_positions pos join av2_supplies s on s.id=pos.supply_id
        where pos.catalog_import_id=e.import_id and pos.catalog_entry_id=e.entry_id and (s.market<>e.market or s.store<>p.store))
      and not exists(select 1 from av2_resolved_catalog_aliases a
        where a.import_id=e.import_id and a.market=p.market and a.store=p.store and a.entry_id<>p.entry_id
          and a.alias in(select value from json_each(e.data,'$.aliases')))`, [id]);
  return [
    ...assignments.flatMap(({ data, shop }) => {
      const entry = JSON.parse(data) as CatalogEntry;
      return catalogSourceStoreUpdates(id, entry.id, catalogEntryWithStore(entry, shop));
    }),
    q("update av2_catalog_imports set state='active' where id=?", id),
    q(
      "insert into av2_meta(id,revision,active_catalog_id) values(1,0,?) on conflict(id) do update set active_catalog_id=excluded.active_catalog_id",
      id,
    ),
  ];
}
// Scope aliases before joining entries. Joining both UNION views can materialize
// the entire catalog repeatedly during each source shipment import in D1.
export async function findCatalogAliases(
  store: SqlStore, market: string, skus: string[], shop: string | null = null,
): Promise<{ sku: string; alias: string; importId: string; data: string; isPrimary: number }[]> {
  const params=[market,shop,shop,JSON.stringify(skus)];
  return store.all(`
    select a.alias sku,a.alias,a.import_id,e.data,a.is_primary
    from av2_catalog_aliases a join av2_catalog_entries e on e.import_id=a.import_id and e.entry_id=a.entry_id
    where a.import_id=(select active_catalog_id from av2_meta where id=1)
      and a.market=? and (? is null or a.store=?) and a.alias in(select value from json_each(?))
      and not exists(select 1 from av2_catalog_products p where p.entry_id=a.entry_id)
    union all
    select j.value sku,j.value alias,r.import_id,r.data,(j.value=r.sku) is_primary
    from av2_catalog_references r join json_each(r.data,'$.aliases') j
    where r.import_id=(select active_catalog_id from av2_meta where id=1)
      and r.market=? and (? is null or r.store=?) and j.value in(select value from json_each(?))
      and not exists(select 1 from av2_catalog_products p where p.entry_id=r.entry_id)
      and not exists(select 1 from av2_catalog_aliases a where a.import_id=r.import_id and a.market=r.market
        and a.alias in(select value from json_each(r.data,'$.aliases')))
    union all
    select j.value sku,j.value alias,m.active_catalog_id import_id,p.data,(j.value=p.sku) is_primary
    from av2_catalog_products p join av2_meta m on m.id=1 join json_each(p.data,'$.aliases') j
    where p.market=? and (? is null or p.store=?) and j.value in(select value from json_each(?))
  `,[...params,...params,...params]);
}
export async function resolveCatalogPositions(
  store: SqlStore,
  data: SupplyImport,
): Promise<Map<string, { importId: string; entry: CatalogEntry }>> {
  const found = await findCatalogAliases(store,data.market,data.positions.map(p=>catalogKey(p.sku)),data.store);
  const grouped = new Map<string, typeof found>();
  for (const r of found) grouped.set(r.sku, [...(grouped.get(r.sku) ?? []), r]);
  const out = new Map<string, { importId: string; entry: CatalogEntry }>();
  for (const [sku, rows] of grouped) {
    const primary = rows.filter((r) => r.isPrimary);
    const candidates = primary.length ? primary : rows;
    const distinct = [
      ...new Map(
        candidates.map((r) => {
          const e = JSON.parse(r.data) as CatalogEntry;
          return [e.id, { importId: r.importId, entry: e }];
        }),
      ).values(),
    ];
    if (distinct.length === 1) out.set(sku, distinct[0]);
  }
  return out;
}
export function effectiveCatalogData(alias="e"):string {
  if(!/^[a-z]+$/.test(alias))throw new Error("Недопустимая таблица справочника.");
  const correction=`(select o.kind from av2_catalog_kind_overrides o where o.market=${alias}.market and o.store=${alias}.store and o.sku=${alias}.sku)`;
  const photo=`coalesce((select o.url from av2_photo_overrides o where o.sku=upper(${alias}.sku)),(select case when count(distinct o.url)=1 then min(o.url) end from av2_photo_overrides o where o.sku in(select upper(value) from json_each(${alias}.data,'$.aliases'))))`;
  const extension = `(select case when count(distinct x.extension)=1 then min(x.extension) end
    from av2_print_extensions x where x.sku in(select value from json_each(${alias}.data,'$.aliases')))`;
  return `json_set(${alias}.data,'$.photoUrl',coalesce(json_extract(${alias}.data,'$.photoUrl'),${photo}),'$.kind',coalesce(nullif(trim(json_extract(${alias}.data,'$.kind')),''),${correction},''),'$.kindCorrection',case when nullif(trim(json_extract(${alias}.data,'$.kind')),'') is null then coalesce((select o.reason from av2_catalog_kind_overrides o where o.market=${alias}.market and o.store=${alias}.store and o.sku=${alias}.sku),'') else '' end,'$.printExtension',coalesce(json_extract(${alias}.data,'$.printExtension'),${extension},''))`;
}
// A LEFT JOIN to the compound resolved view makes SQLite materialize the whole
// imported catalog. Probe the exact position key instead, keeping a nullable row.
export function positionCatalogJoin(position="p", result="pc"):string {
  if(!/^[a-z]+$/.test(position)||!/^[a-z]+$/.test(result))throw new Error("Недопустимая таблица справочника.");
  return `left join json_each((select json_array(json(${effectiveCatalogData()})) from (
    select market,store,sku,data from av2_catalog_products where entry_id=${position}.catalog_entry_id
      and exists(select 1 from av2_catalog_imports where id=${position}.catalog_import_id)
    union all
    select market,store,sku,data from av2_catalog_entries where import_id=${position}.catalog_import_id and entry_id=${position}.catalog_entry_id
      and not exists(select 1 from av2_catalog_products where entry_id=${position}.catalog_entry_id)
    union all
    select r.market,r.store,r.sku,r.data from av2_catalog_references r where r.import_id=${position}.catalog_import_id and r.entry_id=${position}.catalog_entry_id
      and not exists(select 1 from av2_catalog_products where entry_id=${position}.catalog_entry_id)
      and not exists(select 1 from av2_catalog_aliases a where a.import_id=r.import_id and a.market=r.market and a.alias in(select value from json_each(r.data,'$.aliases')))
  ) e limit 1)) ${result}`;
}

// Both inputs are catalog keys: aliases and the SKU embedded in entry_id are
// already trimmed and uppercased at import/save time. Strip only this market's suffix.
function labelArticleSql(key: string, market: string): string {
  return `case when substr(${key},-4)=case ${market} when 'OZON' then '(OZ)' else '(WB)' end
    then rtrim(substr(${key},1,length(${key})-4)) else ${key} end`;
}

const managedLabelIndex = `with managed_label_keys as (
  select market,store,article,count(distinct label_sha) files,max(available) available
  from (
    select p.market,p.store,${labelArticleSql('a.value', 'p.market')} article,
      json_extract(p.data,'$.labelSha') label_sha,f.sha256 is not null available
    from av2_catalog_products p join json_each(p.data,'$.aliases') a
    left join av2_catalog_media f on f.sha256=json_extract(p.data,'$.labelSha')
    where json_extract(p.data,'$.labelSha') is not null
  )
  group by market,store,article
)`;
const catalogLabelKey = labelArticleSql("json_extract(e.entry_id,'$[2]')", "e.market");
const catalogWithLabels = `av2_resolved_catalog_entries e
  left join managed_label_keys k on k.market=e.market and k.store=e.store and k.article=${catalogLabelKey}`;
const missingLabel = `case
  when json_extract(e.data,'$.labelSha') is not null then not exists(
    select 1 from av2_catalog_media f where f.sha256=json_extract(e.data,'$.labelSha')
  )
  when k.files is not null then k.files<>1 or k.available=0
  else not exists (
    select 1 from av2_label_entries l join av2_label_files f on f.sha256=l.sha256
    where l.import_id=(select id from av2_label_imports where state='active')
      and l.market=e.market and l.sku=${catalogLabelKey} and l.status='found'
  )
end`;

export function catalogLabelTargets(store: SqlStore, importId: string, entryIds: string[]) {
  return store.all<{entryId: string; data: string; search: string; review: number; needsLabel: number}>(
    `${managedLabelIndex}
    select e.entry_id,e.data,e.search,e.review,${missingLabel} needs_label
    from ${catalogWithLabels}
    where e.import_id=? and e.entry_id in (select value from json_each(?))`,
    [importId, JSON.stringify(entryIds)],
  );
}

export async function catalogList(
  store: SqlStore,
  url: URL,
): Promise<CatalogPage> {
  const where = [
    "e.import_id=(select active_catalog_id from av2_meta where id=1)",
  ];
  const args: (string | number | null)[] = [];
  for (const key of ["market", "store", "machine"]) {
    const v = url.searchParams.get(key);
    if (v) {
      where.push(`e.${key}=?`);
      args.push(v.slice(0, 300));
    }
  }
  const search = catalogKey(url.searchParams.get("q") ?? "").slice(0, 150);
  if (search) {
    where.push("instr(e.search,?)>0");
    args.push(search);
  }
  if (url.searchParams.get("review") === "1") where.push("e.review=1");
  const missingOnly = url.searchParams.get("missingLabel") === "1";
  const prefix = missingOnly ? managedLabelIndex : "";
  const from = missingOnly ? catalogWithLabels : "av2_resolved_catalog_entries e";
  if (missingOnly) where.push(missingLabel);
  const requested =
    Math.max(0, Math.min(10000, Number(url.searchParams.get("page")) || 0)) | 0;
  const filter = where.join(" and ");
  const rows = await store.readBatch([
    q(
      "select i.id,i.manifest,i.created_at from av2_catalog_imports i join av2_meta m on m.active_catalog_id=i.id where m.id=1",
    ),
    q(
      `${prefix} select count(*) total from ${from} where ${filter}`,
      ...args,
    ),
    q(
      `${prefix} select e.import_id,json_remove(${effectiveCatalogData()},'$.rows','$.aliases') data from ${from} where ${filter} order by e.sku,e.market,e.store limit 30 offset min(?,max(0,((select count(*) from ${from} where ${filter})-1)/30)*30)`,
      ...args,
      requested * 30,
      ...args,
    ),
    q(
      "select distinct machine from av2_resolved_catalog_entries where import_id=(select active_catalog_id from av2_meta where id=1) and machine<>'' order by machine",
    ),
  ]);
  const total = Number(rows[1][0].total);
  const active = rows[0][0];
  return {
    total,
    page: Math.min(requested, Math.max(0, Math.ceil(total / 30) - 1)),
    items: rows[2].map((r) => ({
      ...JSON.parse(r.data as string),
      importId: r.importId,
    })),
    active: active
      ? {
          id: active.id as string,
          createdAt: active.createdAt as string,
          manifest: JSON.parse(active.manifest as string),
        }
      : null,
    machines: rows[3].map((r) => r.machine as string),
  };
}
export async function catalogDetail(
  store: SqlStore,
  importId: string,
  id: string,
): Promise<CatalogDetail | null> {
  const e = (
    await store.all<{ data: string }>(
      `select ${effectiveCatalogData()} data from av2_resolved_catalog_entries e where import_id=? and entry_id=?`,
      [importId, id],
    )
  )[0];
  if (!e) return null;
  const entry = JSON.parse(e.data) as CatalogEntry;
  const p = entry.photoId
    ? (
        await store.all<{ data: string }>(
          "select data from av2_catalog_photos where import_id=? and photo_id=?",
          [importId, entry.photoId],
        )
      )[0]
    : null;
  return {
    ...entry,
    importId,
    photo: p ? (JSON.parse(p.data) as CatalogPhoto) : null,
  };
}
