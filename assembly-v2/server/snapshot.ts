import { cartonScopeSql } from "./carton-scope-sql";
import type {
  CartonItem,
  Dispatch,
  Employee,
  ExportSnapshot,
  Position,
  Snapshot,
  Supply,
  TeamRow,
  Work,
} from "../shared/model";
import type { SqlStore, Statement } from "./database";
import { effectiveWorkNorms, type ShiftNorm } from "../shared/work-norm";
import { catalogCartonCapacity, catalogForPositionScope, positionCatalogJoin, positionWorkCatalogSql } from "./catalog-store";
import { groupDirections } from "../shared/directions";
import type { RitmSchedule } from "../shared/ritm";
import type { ManagedProduct } from "../shared/catalog-editor";
import { positionNeedsStoreReviewSql } from "./position-search";

type CartonRow = Omit<Snapshot["cartons"][number], "items" | "fill" | "qty">;
type DispatchRow = Omit<Dispatch, "cartonIds"> & { cartonIds: string };
type RosterRow = Omit<Supply, "schedule"> & { schedule?: string | null };
type PositionRow = Omit<Position, "team" | "catalog" | "ready" | "sourceActive" | "storeNeedsReview"> & {
  ready: number;
  sourceActive: number;
  storeNeedsReview: number;
  positionStore: Supply["store"];
  positionMarket: Supply["market"];
  workCatalog: string | null;
};

function positionProgress(positions: readonly Pick<Position, "plan" | "packing">[]) {
  const progress = { plan: 0, packed: 0 };
  for (const position of positions) {
    progress.plan += position.plan;
    progress.packed += position.packing;
  }
  return progress;
}

// Catalog, connection settings and journal need names and filters, not every
// carton composition and production position. Keep this read in one transaction.
export async function readDirectorySnapshot(store: SqlStore): Promise<Snapshot> {
  const [meta, employees, supplies] = await store.readBatch([
    {sql:"select revision from av2_meta where id=1",args:[]},
    {sql:"select id,name,active from av2_employees order by name,id",args:[]},
    {sql:`select s.id,s.external_id,s.origin_shipment_id,s.source_active,s.title,s.market,s.store,s.destination,s.source_version
      from av2_supplies s where s.is_demo=0 and exists(select 1 from av2_positions p where p.supply_id=s.id)
      order by s.source_active desc,s.created_at desc,s.id desc limit 300`,args:[]},
  ]);
  return {revision:Number(meta[0]?.revision??0),cartonScope:"directory",selectedSupplyId:null,
    employees:employees.map(e=>({...e,active:!!e.active})) as Employee[],
    supplies:supplies.map(s=>({...s,sourceActive:!!s.sourceActive})) as Supply[],
    progress:{plan:0,packed:0},positions:[],works:[],cartons:[],dispatches:[],exports:[]};
}
const usable =
  "s.is_demo=0 and exists(select 1 from av2_positions p where p.supply_id=s.id)";
const rosterSql = `select s.id,s.external_id,s.origin_shipment_id,s.source_active,s.title,s.market,s.store,s.destination,s.source_version,
  coalesce(json_extract(l.payload,'$.locked'),0) source_locked,
  json_extract(l.payload,'$.schedule') schedule,
  case when json_extract(l.payload,'$.schedule.packingAt') is not null and s.source_active=1
    and exists(select 1 from av2_positions p where p.supply_id=s.id and p.source_active=1) then not exists(
    select 1 from av2_positions p left join av2_position_totals t on t.position_id=p.id
    where p.supply_id=s.id and p.source_active=1 and coalesce(t.packing,0)<p.plan
  ) else 0 end packing_complete
  from av2_supplies s left join av2_ritm_links l on l.shipment_id=s.origin_shipment_id
  where ${usable} order by s.source_active desc,s.created_at desc,s.id desc limit 300`;
function readRoster(rows: RosterRow[]): Supply[] {
  return rows.map(({schedule, ...row}) => ({
    ...row,
    sourceActive: !!row.sourceActive,
    sourceLocked: !!row.sourceLocked,
    packingComplete: !!row.packingComplete,
    ...(schedule ? { schedule: JSON.parse(schedule) as RitmSchedule } : {}),
  }));
}
const selected = `coalesce((select s.id from av2_supplies s where ${usable} and s.id=?),
 (select s.id from av2_supplies s join av2_work w on w.supply_id=s.id where ${usable} and s.origin_shipment_id is not null order by w.created_at desc,w.id desc limit 1),
 (select s.id from av2_supplies s where ${usable} order by s.created_at desc,s.id desc limit 1))`;

export async function readWorkspaceSnapshot(
  store: SqlStore,
  supplyId: string | null,
  scopeOnly = false,
  directions = false,
  retry = 0,
): Promise<Snapshot> {
  const seed = directions
    ? await store.readBatch([
        {
          sql: `select ${selected} selected_supply_id,coalesce((select revision from av2_meta where id=1),0) revision`,
          args: [supplyId],
        },
        { sql: rosterSql, args: [] },
      ])
    : null;
  const originalSupplies = seed
    ? readRoster(seed[1] as RosterRow[])
    : [];
  const chosenSource = originalSupplies.find(
    (s) => s.id === seed?.[0][0].selectedSupplyId,
  );
  const groups = groupDirections(
    originalSupplies,
    chosenSource?.sourceActive === false
      ? null
      : String(seed?.[0][0].selectedSupplyId || ""),
  );
  const group = groups.find((s) =>
    s.sources?.some((source) => source.id === seed?.[0][0].selectedSupplyId),
  );
  const navigationGroups: Supply[] = groups
    .filter((s) => s.sourceActive !== false)
    .map((s) => ({
      ...s,
      sources: s.sources.filter((source) => source.sourceActive !== false),
    }));
  // Direct journal links can still read an archived source without adding it
  // back to the collector's working navigation.
  if (chosenSource?.sourceActive === false)
    navigationGroups.push({ ...chosenSource, sources: [chosenSource] });
  // Archived history links retain exact source ownership; active summaries
  // never include archived plans or historical output.
  const memberIds =
    group?.sources
      ?.filter((s) =>
        chosenSource?.sourceActive === false
          ? s.id === chosenSource.id
          : s.sourceActive !== false,
      )
      .map((s) => s.id) || [];
  const positionSelection = directions
    ? "in(select value from json_each(?))"
    : `=${selected}`;
  const positionArg = directions ? JSON.stringify(memberIds) : supplyId;
  const scope = scopeOnly
    ? ` and exists(select 1 from av2_supply_city_scopes ss join av2_carton_city_scopes cc on cc.id=c.id
        where ss.id ${positionSelection} and ${cartonScopeSql('cc','ss')})` : "";
  const scopeArgs = scopeOnly ? [positionArg] : [];
  const currentCartons = `select c.id from av2_production_cartons c left join av2_dispatches d on d.id=c.dispatch_id where (d.state is null or d.state<>'sent') ${scope} order by c.created_at desc,c.id desc limit 500`;
  const query = (
    sql: string,
    ...args: (string | number | null)[]
  ): Statement => ({ sql, args });
  // D1 batch is one database transaction. No revision retry loop, and no mixed
  // position/carton snapshots while another collector is saving work.
  const result = await store.readBatch([
    query(
      `with chosen as (select ${selected} id)
      select coalesce((select revision from av2_meta where id=1),0) revision,chosen.id selected_supply_id,
      coalesce((select sum(p.plan) from av2_positions p where p.supply_id=chosen.id),0) plan,
      coalesce((select sum(t.packing) from av2_positions p join av2_position_totals t on t.position_id=p.id where p.supply_id=chosen.id),0) packed from chosen`,
      supplyId,
    ),
    query(directions ? "select 1 where 0" : rosterSql),
    query(
      `select p.*,coalesce(t.cut,0) cut,coalesce(t.assembly,0) assembly,coalesce(t.packing,0) packing,coalesce(t.boxed,0) boxed,(select coalesce(sum(r.qty),0) from av2_warehouse_receipts r where r.position_id=p.id) warehouse_qty
      ,coalesce(json_extract(pc.value,'$.photoUrl'),(select o.url from av2_photo_overrides o where o.sku=upper(p.sku)),(select sp.url from av2_source_photos sp where sp.position_id=p.external_id and sp.sku=p.sku)) photo_url
      ,case when ${positionNeedsStoreReviewSql} then 1 else 0 end store_needs_review,
      s.store position_store,s.market position_market,
      ${positionWorkCatalogSql(false, true)} work_catalog
      from av2_positions p join av2_supplies s on s.id=p.supply_id left join av2_position_totals t on t.position_id=p.id ${positionCatalogJoin("p", "pc", true)} where p.supply_id ${positionSelection} order by p.sku,p.id ${directions ? "" : "limit 500"}`,
      positionArg,
    ),
    query(
      `select t.position_id,t.employee_id,t.name,t.cut,t.assembly,t.packing from av2_team_totals t join av2_positions p on p.id=t.position_id
      where p.supply_id ${positionSelection} and t.cut+t.assembly+t.packing>0 order by t.name`,
      positionArg,
    ),
    query(
      `select w.id,w.position_id,w.employee_id,w.employee_name employee,w.operation,w.qty,w.created_at,p.sku,
      case when c.id is null then 0 else 1 end canceled,c.reason cancel_reason
      from (select * from av2_work where supply_id ${positionSelection} order by created_at desc,id desc limit 100) w
      join av2_positions p on p.id=w.position_id left join av2_corrections c on c.work_id=w.id order by w.created_at desc,w.id desc`,
      positionArg,
    ),
    query("select id,name,active from av2_employees order by name limit 500"),
    query(
      `select c.*,d.state dispatch_state from av2_production_cartons c left join av2_dispatches d on d.id=c.dispatch_id
      where (d.state is null or d.state<>'sent') ${scope} order by c.created_at desc,c.id desc limit 500`,
      ...scopeArgs,
    ),
    query(`select d.id,d.label,d.market,d.store,d.destination,d.state,d.created_at,d.sent_at,
      coalesce(d.carton_ids,(select json_group_array(c.id) from av2_cartons c where c.dispatch_id=d.id)) carton_ids,
      coalesce(d.qty,(select coalesce(sum(a.qty),0) from av2_cartons c join av2_all_allocations a on a.carton_id=c.id and a.removed_at is null where c.dispatch_id=d.id)) qty
      from av2_dispatches d order by d.created_at desc,d.id desc limit 100`),
    query(
      "select id,dispatch_id,kind,created_at from av2_exports where kind in ('account','template') order by created_at desc,id desc limit 100",
    ),
    query(
      `select a.id,a.carton_id,a.position_id,p.supply_id,s.title supply,coalesce(s.origin_shipment_id,s.external_id) external_supply_id,p.external_id external_position_id,
      p.sku,p.name,p.barcode,p.catalog_import_id,json_extract(pc.value,'$.photoId') photo_id,coalesce(json_extract(pc.value,'$.photoUrl'),(select o.url from av2_photo_overrides o where o.sku=upper(p.sku)),(select sp.url from av2_source_photos sp where sp.position_id=p.external_id and sp.sku=p.sku)) photo_url,a.qty,a.units_per_box from av2_all_allocations a join av2_positions p on p.id=a.position_id join av2_supplies s on s.id=p.supply_id ${positionCatalogJoin()}
      where a.removed_at is null and a.carton_id in (${currentCartons}) order by a.created_at,a.id`,
      ...scopeArgs,
    ),
    query("select data from av2_shift_norms"),
  ]);
  const rows = <T>(index: number) => result[index] as T[];
  const meta = rows<{
    revision: number;
    selectedSupplyId: string | null;
    plan: number;
    packed: number;
  }>(0)[0];
  const contributions = rows<TeamRow & { positionId: string }>(3);
  const boxItems = rows<CartonItem & { cartonId: string }>(9);
  const shiftNorms = rows<{ data: string }>(10).map(
    (n) => JSON.parse(n.data) as ShiftNorm,
  );
  if (seed && meta.revision !== seed[0][0].revision) {
    if (retry < 2)
      return readWorkspaceSnapshot(
        store,
        supplyId,
        scopeOnly,
        directions,
        retry + 1,
      );
    throw Error("Состав направления обновляется. Повторите загрузку.");
  }

  // Keep the live plan and store reviews in the working direction. The journal
  // and carton contents still carry the recorded facts for retired positions.
  const includeArchivedPositions = !directions || chosenSource?.sourceActive === false;
  const positionRows = rows<PositionRow>(2);
  const positions = includeArchivedPositions
    ? positionRows
    : positionRows.filter((p) => p.sourceActive || p.storeNeedsReview);
  const selectedProgress = directions
    ? positionProgress(positions.filter((p) => p.supplyId === meta.selectedSupplyId))
    : { plan: meta.plan, packed: meta.packed };
  return {
    ...(directions ? { sourceSupplies: originalSupplies } : {}),
    cartonScope: scopeOnly ? "supply" : "all",
    revision: meta.revision,
    progress: directions ? positionProgress(positions) : selectedProgress,
    selectedSupplyId: meta.selectedSupplyId,
    // Selected metrics also remain present for an already-open v1 browser.
    supplies: (directions ? navigationGroups : readRoster(rows<RosterRow>(1)))
      .map((s) =>
        s.id === meta.selectedSupplyId
          ? { ...s, ...selectedProgress }
          : s,
      ),
    positions: positions.map(({ workCatalog, positionStore, positionMarket, ...p }) => {
      const card: (ManagedProduct & Record<string, unknown> & { lookupImportId?: string }) | null =
        workCatalog ? JSON.parse(workCatalog) : null;
      const confirmedCard = catalogForPositionScope(card, { store: positionStore, market: positionMarket }, p.barcode);
      return {
        ...p,
        name: (p.sourceActive || p.storeNeedsReview) && card?.name ? card.name : p.name,
        barcode: p.barcode || confirmedCard?.barcode || "",
        unitsPerBox: p.unitsPerBox ?? catalogCartonCapacity(confirmedCard),
        photoUrl: card?.photoUrl || p.photoUrl,
        photoCatalogImportId: card?.lookupImportId !== p.catalogImportId ? card?.lookupImportId : undefined,
        workNorms: effectiveWorkNorms(card, shiftNorms),
        catalog: card ? {
          kind: card.kind,
          boxType: card.boxType,
          machine: card.machine,
          packaging: card.packaging,
          size: card.size,
          photoId: card.photoId,
          capacitySource: card.capacitySource,
          labelSha: card.labelSha,
          store: card.store,
          unitsPerBox: card.unitsPerBox,
        } : null,
        ready: !!p.ready,
        sourceActive: !!p.sourceActive,
        storeNeedsReview: Boolean(p.storeNeedsReview),
        team: contributions.filter((t) => t.positionId === p.id),
      };
    }),
    works: rows<Work>(4).map((w) => ({ ...w, canceled: !!w.canceled })),
    employees: rows<Employee>(5).map((e) => ({ ...e, active: !!e.active })),
    cartons: rows<CartonRow>(6).map((b) => {
      const items = boxItems.filter((i) => i.cartonId === b.id);
      return {
        ...b,
        items,
        qty: items.reduce((n, i) => n + i.qty, 0),
        fill: items.reduce(
          (n, i) => n + (i.unitsPerBox ? i.qty / i.unitsPerBox : 0),
          0,
        ),
        capacityUnknown: items.some((i) => !i.unitsPerBox),
      };
    }),
    dispatches: rows<DispatchRow>(7).map((d) => ({
      ...d,
      cartonIds: JSON.parse(d.cartonIds),
    })),
    exports: rows<Omit<ExportSnapshot, "payload">>(8),
  };
}
