import type { SqlStore, Statement } from "./database";
import type { Carton, Dispatch } from "../shared/model";
import {
  cartonFingerprint,
  legacyCartonComparison,
  type RitmCarton,
  type RitmCartonItem,
} from "../shared/ritm-warehouse";
import { requireCatalog as check } from "./catalog-store";
const q = (sql: string, ...args: (string | number | null)[]): Statement => ({
  sql,
  args,
});
const text = (v: unknown) => (typeof v === "string" ? v : "");
type BoxRow = {
  id: string;
  label: string;
  market: string;
  store: string;
  destination?: string;
  state: "open" | "closed";
  createdAt: string;
  closedAt: string | null;
  dispatchId: string | null;
  dispatchState: string | null;
  sentAt: string | null;
  sentPayload: string | null;
  dispatchActor: string | null;
  legacyData: string | null;
  nativeChanges: number;
};
type ItemRow = {
  id: string;
  cartonId: string;
  positionId: string;
  sku: string;
  name: string;
  qty: number;
  unitsPerBox: number | null;
  supply: string;
  externalSupplyId: string;
  externalPositionId: string;
  barcode: string;
  photoUrl: string | null;
  catalogImportId: string | null;
  photoId: string | null;
  boxType: string | null;
  createdAt: string;
  removedAt: string | null;
  removalReason: string | null;
  employee: string | null;
  legacyData: string | null;
};
export async function readRitmWarehousePage(store: SqlStore, url: URL) {
  const stock = url.searchParams.get("kind") === "warehouse",
    cursor = url.searchParams.get("cursor") || "",
    id = url.searchParams.get("id") || "";
  check(cursor.length <= 200 && id.length <= 200, "Неверная страница коробов.");
  const table = stock ? "av2_warehouse_cartons" : "av2_production_cartons";
  const selection = `select id from ${table} where id>? and (?='' or id=?) order by id limit 100`;
  const args = [cursor, id, id];
  const boxSql = stock
    ? `select c.*,null dispatch_id,null dispatch_state,null sent_at,null sent_payload,null dispatch_actor,l.data legacy_data,(exists(select 1 from av2_warehouse_receipts r where r.carton_id=c.id and r.id not like 'legacy:%') or exists(select 1 from av2_commands cmd where cmd.action='warehouse.move' and (json_extract(cmd.payload,'$.fromCartonId')=c.id or json_extract(cmd.payload,'$.toCartonId')=c.id))) native_changes from av2_warehouse_cartons c left join av2_legacy_records l on l.kind='warehouseCartons' and c.id like 'legacy:%' and l.source_id=substr(c.id,8) where c.id in (${selection}) order by c.id`
    : `select c.*,d.state dispatch_state,d.sent_at,d.sent_payload,d.actor dispatch_actor,l.data legacy_data,
      (exists(select 1 from av2_allocations a where a.carton_id=c.id)
        or exists(select 1 from av2_legacy_allocations a where a.carton_id=c.id and a.removed_at is not null)
        or exists(select 1 from av2_quality_repairs q join av2_all_allocations a on a.id=q.entity_id where a.carton_id=c.id and q.kind like 'work.cancel.%')
        or exists(select 1 from av2_quality_repairs q where q.kind='carton.merge' and q.entity_id=c.id)
        or exists(select 1 from av2_commands cmd where cmd.action in('carton.close','carton.reopen','ritm.carton.dispatch') and cmd.carton_id=c.id)) native_changes
      from av2_cartons c left join av2_dispatches d on d.id=c.dispatch_id
      left join av2_legacy_records alias on alias.kind='cartonAlias' and alias.source_id=c.id
      left join av2_legacy_records l on l.kind='cartons' and l.source_id=coalesce(json_extract(alias.data,'$.legacySourceId'),case when c.id like 'legacy:%' then substr(c.id,8) end)
      where c.id in (${selection}) order by c.id`;
  const photoJoin = `left join av2_resolved_catalog_entries e on e.import_id=p.catalog_import_id and e.entry_id=p.catalog_entry_id left join av2_catalog_photos cp on cp.import_id=p.catalog_import_id and cp.photo_id=json_extract(e.data,'$.photoId')`;
  const itemSql = stock
    ? `select r.id,r.carton_id,r.position_id,r.sku,r.name,r.qty,null units_per_box,r.supply,coalesce(s.origin_shipment_id,'') external_supply_id,coalesce(p.external_id,'') external_position_id,coalesce(p.barcode,'') barcode,r.catalog_import_id,r.photo_id,json_extract(cp.data,'$.primary') photo_url,null box_type,r.created_at,r.voided_at removed_at,coalesce(r.void_reason,r.comment) removal_reason,r.employee,l.data legacy_data from av2_warehouse_receipts r left join av2_positions p on p.id=r.position_id left join av2_supplies s on s.id=p.supply_id left join av2_catalog_photos cp on cp.import_id=r.catalog_import_id and cp.photo_id=r.photo_id left join av2_legacy_records l on l.kind='warehouseReceipts' and r.id like 'legacy:%' and l.source_id=substr(r.id,8) where r.carton_id in (${selection}) order by r.created_at,r.id`
    : `select a.*,p.sku,p.name,p.barcode,p.supply_id,s.title supply,coalesce(s.origin_shipment_id,s.external_id) external_supply_id,p.external_id external_position_id,p.catalog_import_id,json_extract(e.data,'$.photoId') photo_id,json_extract(cp.data,'$.primary') photo_url,json_extract(e.data,'$.boxType') box_type,null employee,l.data legacy_data from av2_all_allocations a join av2_positions p on p.id=a.position_id join av2_supplies s on s.id=p.supply_id ${photoJoin} left join av2_legacy_records l on l.kind='allocations' and a.id like 'legacy:%' and l.source_id=substr(a.id,8) where a.carton_id in (${selection}) order by a.created_at,a.id`;
  const result = await store.readBatch([
    q(
      `select revision,(select count(*) from ${table}) total from av2_meta where id=1`,
    ),
    q(boxSql, ...args),
    q(itemSql, ...args),
  ]);
  const meta = result[0][0] as { revision: number; total: number };
  check(meta, "База коробов ещё не готова.");
  if (url.searchParams.has("revision"))
    check(
      Number(url.searchParams.get("revision")) === meta.revision,
      "Короба изменились во время чтения. Повторите обновление.",
    );
  const boxes = result[1] as unknown as BoxRow[],
    items = result[2] as unknown as ItemRow[];
  const cartons = boxes.map((box) => {
    const own = items.filter((i) => i.cartonId === box.id),
      active = own.filter((i) => !i.removedAt),
      base = box.legacyData ? JSON.parse(box.legacyData) : null;
    const legacyId = base?.sourceId || null,
      baseItems = own
        .filter((i) => i.legacyData)
        .map((i) => JSON.parse(i.legacyData!));
    const comparisonItems = new Map<string, RitmCartonItem>();
    for (const b of baseItems) {
      const raw = b.raw || {},
        key = JSON.stringify([raw.shipmentId, raw.positionId, raw["Артикул"]]);
      const old = comparisonItems.get(key);
      comparisonItems.set(key, {
        shipmentId: text(raw.shipmentId),
        positionId: text(raw.positionId),
        article: text(raw["Артикул"]),
        quantity: Number(b.qty) + (old?.quantity || 0),
      } as RitmCartonItem);
    }
    const legacyBaseline = base
      ? legacyCartonComparison({
          number: base.label,
          status: base.state,
          quantity: baseItems.reduce((n, b) => n + Number(b.qty), 0),
          contents: [...comparisonItems.values()],
        })
      : null;
    let frozen: Carton | null = null;
    if (box.dispatchState === "sent" && box.sentPayload) {
      const saved = JSON.parse(box.sentPayload) as { cartons: Carton[] };
      frozen = saved.cartons.find((c) => c.id === box.id) || null;
    }
    const selected: ItemRow[] = frozen
      ? frozen.items.map((i) => ({
          ...i,
          cartonId: box.id,
          legacyData: null,
          catalogImportId: i.catalogImportId || null,
          photoId: i.photoId || null,
          externalSupplyId: i.externalSupplyId || "",
          externalPositionId: i.externalPositionId || "",
          createdAt: box.createdAt,
          removedAt: null,
          removalReason: null,
          employee: null,
          photoUrl: active.find((a) => a.id === i.id)?.photoUrl || null,
          boxType: active.find((a) => a.id === i.id)?.boxType || null,
        }))
      : active;
    const contentMap = new Map<string, RitmCartonItem>();
    for (const i of selected) {
      const key = JSON.stringify([
        i.externalSupplyId,
        i.externalPositionId,
        i.sku,
        i.barcode,
      ]);
      const old = contentMap.get(key);
      contentMap.set(key, {
        article: i.sku,
        shipmentId: i.externalSupplyId,
        shipment: i.supply,
        market: box.market,
        positionId: i.externalPositionId,
        quantity: i.qty + (old?.quantity || 0),
        store: box.store,
        storeStatus: "assembly_v2",
        productName: i.name,
        photoUrl: i.photoUrl || "",
        barcode: i.barcode || "",
      });
    }
    const contents = [...contentMap.values()],
      quantity = contents.reduce((n, i) => n + i.quantity, 0),
      status = frozen?.state || box.state;
    const root = text(base?.raw?.shipmentId) || text(own[0]?.externalSupplyId),
      issues: string[] = [];
    if (!quantity) issues.push("Короб пуст.");
    if (!/^[1-9]\d*$/.test(box.store)) issues.push("Магазин не подтверждён.");
    if (
      !stock &&
      !/^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i.test(root)
    )
      issues.push("Не подтверждена исходная поставка.");
    if (box.dispatchState === "draft")
      issues.push("Короб уже включён в подготовленную отгрузку RITM Сборка.");
    const historicalSnapshotMissing = box.dispatchState === "sent" && !frozen;
    if (historicalSnapshotMissing)
      issues.push("Не сохранён состав на момент старой отправки.");
    const history: RitmCarton["history"] = own.flatMap((i) => {
      const added = {
        action: "add" as const,
        article: i.sku,
        quantity: i.qty,
        shipmentId: i.externalSupplyId,
        shipment: i.supply,
        createdAt: i.createdAt,
        reason: "",
        employee: i.employee || null,
      };
      return i.removedAt
        ? [
            added,
            {
              ...added,
              action: "remove" as const,
              quantity: -i.qty,
              createdAt: i.removedAt,
              reason: i.removalReason || "",
            },
          ]
        : [added];
    });
    if (box.closedAt)
      history.push({
        action: "close",
        article: "",
        quantity: null,
        shipmentId: root,
        shipment: box.destination || "",
        createdAt: box.closedAt,
        reason: "",
        employee: null,
      });
    const dto: RitmCarton = {
      id: legacyId || "av2:" + box.id,
      assemblyV2Id: box.id,
      sourceSystem: "assembly-v2",
      sourceKind: stock ? "warehouse" : "direction",
      legacyId,
      legacyBaseline,
      modifiedInV2:
        !base ||
        !!box.nativeChanges ||
        box.state !== base.state ||
        !!(box.dispatchId && !box.dispatchId.startsWith("legacy:")),
      number: box.label,
      shipmentId: root,
      shipment:
        box.destination || `${box.market} · Склад · Магазин ${box.store}`,
      directionId: stock
        ? "WAREHOUSE"
        : text(base?.raw?.directionId) || "ASSEMBLY_V2",
      market: box.market,
      store: box.store,
      boxType:
        text(base?.raw?.["Тип короба"]) ||
        [...new Set(selected.map((i) => i.boxType).filter(Boolean))].join(
          " / ",
        ) ||
        "",
      status,
      createdAt: box.createdAt,
      closedAt: box.closedAt || "",
      quantity,
      fillPercent:
        stock || selected.some((i) => !i.unitsPerBox)
          ? null
          : selected.reduce((n, i) => n + i.qty / i.unitsPerBox!, 0) * 100,
      ready: status === "closed" && !issues.length,
      issues,
      contents,
      history,
      dispatchStatus: box.dispatchState === "sent" ? "sent" : "pending",
      sentAt: box.sentAt,
      dispatchChangedBy: box.dispatchActor,
      reserved: box.dispatchState === "draft",
      historicalSnapshotMissing,
    };
    return dto;
  });
  return {
    ok: true,
    format: "assembly-v2-warehouse",
    version: 1,
    kind: stock ? "warehouse" : "direction",
    revision: meta.revision,
    total: meta.total,
    checkedAt: new Date().toISOString(),
    cartons,
    nextCursor: boxes.length === 100 ? boxes.at(-1)!.id : null,
  };
}
export async function ritmCartonDispatchPlan(
  store: SqlStore,
  p: Record<string, unknown>,
  actor: string,
  now: string,
  loadCartons: (ids: string[]) => Promise<Carton[]>,
) {
  check(
    typeof p.cartonId === "string" &&
      p.cartonId.length <= 200 &&
      ["sent", "pending"].includes(String(p.status)) &&
      typeof p.fingerprint === "string" &&
      p.fingerprint.length <= 200000,
    "Не подтверждён короб для отправки.",
  );
  const page = await readRitmWarehousePage(
    store,
    new URL(
      "https://assembly.invalid/api/ritm/warehouse?id=" +
        encodeURIComponent(p.cartonId),
    ),
  );
  const box = page.cartons[0];
  check(
    box && cartonFingerprint(box) === p.fingerprint,
    "Состав короба изменился. Обновите склад перед отправкой.",
  );
  const sql: Statement[] = [];
  if (p.status === box.dispatchStatus)
    return {
      statements: sql,
      result: {
        cartonId: box.id,
        status: box.dispatchStatus,
        sentAt: box.sentAt,
      },
    };
  if (p.status === "sent") {
    check(
      box.status === "closed" && box.quantity > 0 && !box.reserved,
      "Отправить можно закрытый короб, свободный от другой отгрузки.",
    );
    check(
      /^[1-9]\d*$/.test(box.store) && box.shipmentId.startsWith("RITM-"),
      "Не подтверждены магазин и поставка короба.",
    );
    const carton = (await loadCartons([p.cartonId]))[0],
      dispatchId = crypto.randomUUID();
    const dispatch: Dispatch = {
      id: dispatchId,
      label: "РИТМ · " + box.number,
      market: carton.market,
      store: carton.store,
      destination: carton.destination,
      state: "sent",
      createdAt: now,
      sentAt: now,
      cartonIds: [carton.id],
      qty: carton.qty,
    };
    sql.push(
      q(
        "insert into av2_dispatches(id,label,market,store,destination,state,actor,created_at,sent_at,sent_payload,carton_ids,qty) values(?,?,?,?,?,'sent',?,?,?,?,?,?)",
        dispatchId,
        dispatch.label,
        dispatch.market,
        dispatch.store,
        dispatch.destination,
        text(p.changedBy) || actor,
        now,
        now,
        JSON.stringify({ dispatch, cartons: [carton] }),
        JSON.stringify(dispatch.cartonIds),
        dispatch.qty,
      ),
      q(
        "update av2_cartons set dispatch_id=? where id=? and dispatch_id is null",
        dispatchId,
        carton.id,
      ),
    );
  } else {
    check(box.dispatchStatus === "sent", "Короб ещё не отправлен.");
    // Detaching returns one physical carton. The original departure and its
    // frozen contents remain in the immutable export history.
    sql.push(
      q("update av2_cartons set dispatch_id=null where id=?", p.cartonId),
    );
  }
  return {
    statements: sql,
    result: {
      cartonId: box.id,
      status: p.status,
      sentAt: p.status === "sent" ? now : null,
    },
  };
}
