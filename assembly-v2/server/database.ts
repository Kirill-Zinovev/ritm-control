import { positionCatalogJoin } from "./catalog-store";
import { sameCartonScope } from "../shared/carton-scope";
import { catalogAttachLabelsPlan, catalogSavePlan } from "./catalog-editor";
import { searchPositions } from "./position-search";
import type {
  Carton,
  CartonItem,
  Dispatch,
  Employee,
  ExportSnapshot,
  Position,
  Supply,
  SupplyImport,
  Work,
} from "../shared/model";
import { sameScope } from "../shared/model";
import type { Database } from "./api";
import { readWorkspaceSnapshot, readDirectorySnapshot } from "./snapshot";
import {
  catalogActivationPlan,
  resolveCatalogPositions,
  effectiveCatalogData,
} from "./catalog-store";
import { catalogKey, digest, photoAllowed } from "../shared/catalog";
import { prepareRitmImport } from "./ritm-import";
import { ritmShipmentId, type RitmSupply } from "../shared/ritm";
import { nextCartonLabel } from "../shared/carton-number";
import { cancelWarehouseWorkPlan, readWarehouse, warehousePlan } from "./warehouse";
import { ozonShipments } from "./ozon-shipments";
import { readDispatchHistoryDetail, readDispatchHistoryPage } from "./dispatch-history";
import { planDeparture, readPreparedDispatches } from "./dispatch-departure";
import { readWorkHistory } from "./work-history";
import { legacyRestorePlan } from "./legacy-restore";
import { legacyAdoptCartonPlan } from "./legacy-adopt";
import { enqueueWork, enqueueCancellation } from "./ritm-outbox";
import { ritmCartonDispatchPlan } from "./ritm-warehouse";
import { qualityPlan } from "./quality";
import { cancelPacking } from "./cancel-packing";
import { placementAmounts } from "../shared/assembly";
import {
  effectiveWorkNorms,
  savedCoefficient,
  type ShiftNorm,
  workTypeKey,
} from "../shared/work-norm";
export interface Statement {
  sql: string;
  args: (string | number | null)[];
}
export interface SqlStore {
  all<T>(sql: string, args?: (string | number | null)[]): Promise<T[]>;
  batch(statements: Statement[]): Promise<void>;
  readBatch(statements: Statement[]): Promise<Record<string, unknown>[][]>;
}
type SupplyRow = Supply & { sourcePayload: string; createdAt: string };
type PositionRow = Omit<Position, "team">;
type CartonRow = Omit<Carton, "items" | "fill" | "qty">;
const id = () => crypto.randomUUID();
const statement = (
  sql: string,
  ...args: (string | number | null)[]
): Statement => ({ sql, args });
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function integer(value: unknown, label: string, minimum = 1): number {
  assert(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= 2147483647,
    `${label}: введите целое число ${minimum ? "больше нуля" : "не меньше нуля"}.`,
  );
  return value;
}
function text(value: unknown, label: string, maximum = 300): string {
  assert(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= maximum,
    `Проверьте поле «${label}».`,
  );
  return value;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function createDatabase(store: SqlStore): Database {
  const all = <T>(sql: string, args: (string | number | null)[] = []) =>
    store.all<T>(sql, args);
  async function one<T>(
    sql: string,
    args: (string | number | null)[],
    message: string,
  ): Promise<T> {
    const row = (await all<T>(sql, args))[0];
    assert(row, message);
    return row;
  }
  async function revision() {
    return (
      (
        await all<{ revision: number }>(
          "select revision from av2_meta where id=1",
        )
      )[0]?.revision ?? 0
    );
  }
  async function loadCartons(ids: string[], ozonCatalog = false): Promise<Carton[]> {
    if (!ids.length) return [];
    const parameter = JSON.stringify(ids);
    const sameOzonStore = "json_extract(pc.value,'$.market')='OZON' and json_extract(pc.value,'$.store')=s.store";
    const productFields = ozonCatalog
      ? `coalesce(case when ${sameOzonStore} then nullif(trim(json_extract(pc.value,'$.sku')),'') end,p.sku) sku,
        p.name,coalesce(case when ${sameOzonStore} then nullif(trim(json_extract(pc.value,'$.barcode')),'') end,p.barcode) barcode`
      : "p.sku,p.name,p.barcode";
    const [boxes, items] = await Promise.all([
      all<CartonRow>(
        "select c.*,d.state dispatch_state from av2_production_cartons c left join av2_dispatches d on d.id=c.dispatch_id where c.id in (select value from json_each(?)) order by c.label",
        [parameter],
      ),
      all<CartonItem & { cartonId: string }>(
        `select a.id,a.carton_id,a.position_id,p.supply_id,s.title supply,coalesce(s.origin_shipment_id,s.external_id) external_supply_id,p.external_id external_position_id,${productFields},p.catalog_import_id,json_extract(pc.value,'$.photoId') photo_id,a.qty,a.units_per_box from av2_all_allocations a join av2_positions p on p.id=a.position_id join av2_supplies s on s.id=p.supply_id ${positionCatalogJoin()} where a.carton_id in (select value from json_each(?)) and a.removed_at is null order by a.created_at,a.id`,
        [parameter],
      ),
    ]);
    const contents = new Map<string, CartonItem[]>();
    for (const item of items) {
      const content = contents.get(item.cartonId) ?? [];
      content.push(item);
      contents.set(item.cartonId, content);
    }
    return boxes.map((b) => {
      const content = contents.get(b.id) ?? [];
      return {
        ...b,
        items: content,
        qty: content.reduce((n, i) => n + i.qty, 0),
        fill: content.reduce(
          (n, i) => n + (i.unitsPerBox ? i.qty / i.unitsPerBox : 0),
          0,
        ),
        capacityUnknown: content.some((i) => !i.unitsPerBox),
      };
    });
  }
  async function carton(cartonId: string): Promise<Carton> {
    const box = (await loadCartons([cartonId]))[0];
    assert(box, "Короб не найден.");
    return box;
  }
  async function dispatch(dispatchId: string): Promise<Dispatch> {
    const row = await one<Dispatch>(
      "select * from av2_dispatches where id=?",
      [dispatchId],
      "Отгрузка не найдена.",
    );
    const boxes = await all<{ id: string; qty: number }>(
      "select c.id,coalesce(sum(a.qty),0) qty from av2_cartons c left join av2_all_allocations a on a.carton_id=c.id and a.removed_at is null where c.dispatch_id=? group by c.id order by c.label",
      [dispatchId],
    );
    const stored = row as unknown as {
      cartonIds: string | null;
      qty: number | null;
    };
    return {
      ...row,
      cartonIds: stored.cartonIds
        ? JSON.parse(stored.cartonIds)
        : boxes.map((c) => c.id),
      qty: stored.qty ?? boxes.reduce((n, c) => n + c.qty, 0),
    };
  }
  const snapshot = (supplyId: string | null, scopeOnly = false, directions = false, directory = false) =>
    directory ? readDirectorySnapshot(store) : readWorkspaceSnapshot(store, supplyId, scopeOnly, directions);
  const ozon = ozonShipments(store, (ids) => loadCartons(ids, true));
  async function plan(
    action: string,
    payload: Record<string, unknown>,
    actor: string,
    rev: number,
  ): Promise<{ statements: Statement[]; result: Record<string, unknown> }> {
    const sql: Statement[] = [];
    const now = new Date().toISOString();
    if (action === "ozon.prepare" || action === "ozon.assign")
      return ozon.plan(action, payload, actor, rev, now);
    if (action === "dispatch.send")
      return planDeparture(store, payload, actor, rev, now, loadCartons, ozon.splitDeparture);
    let result: Record<string, unknown> = {};
    const add = (query: string, ...args: (string | number | null)[]) =>
      sql.push(statement(query, ...args));
    const increment = (
      positionId: string,
      operation: string,
      qty: number,
      employee?: { id: string; name: string },
    ) => {
      assert(
        ["cut", "assembly", "packing", "boxed"].includes(operation),
        "Неизвестный показатель.",
      );
      add(
        `insert into av2_position_totals(position_id,${operation}) values(?,?) on conflict(position_id) do update set ${operation}=${operation}+excluded.${operation}`,
        positionId,
        qty,
      );
      if (employee)
        add(
          `insert into av2_team_totals(id,position_id,employee_id,name,${operation}) values(?,?,?,?,?) on conflict(position_id,employee_id) do update set ${operation}=${operation}+excluded.${operation}`,
          id(),
          positionId,
          employee.id,
          employee.name,
          qty,
        );
    };
    const createCarton = async (supply: SupplyRow): Promise<Carton> => {
      const numbers = await all<{ label: string }>(
        "select label from av2_cartons union select label from av2_carton_number_reservations",
      );
      const box: Carton = {
        id: id(),
        label: nextCartonLabel(
          supply,
          numbers.map((n) => n.label),
        ),
        market: supply.market,
        store: supply.store,
        destination: supply.destination,
        state: "open",
        dispatchId: null,
        dispatchState: null,
        createdAt: now,
        closedAt: null,
        items: [],
        qty: 0,
        fill: 0,
      };
      add(
        "insert into av2_cartons(id,label,market,store,destination,state,created_at) values(?,?,?,?,?,?,?)",
        box.id,
        box.label,
        box.market,
        box.store,
        box.destination,
        box.state,
        now,
      );
      return box;
    };
    if (action === "catalog.save") return catalogSavePlan(store,payload,actor,now);
    if (action === "catalog.attachLabels") return catalogAttachLabelsPlan(store,payload,actor,now);
    if (action.startsWith("quality."))
      return qualityPlan(store, action, payload, actor, now);
    if (action === "legacy.restore")
      return legacyRestorePlan(store, payload, actor, now);
    if (action === "legacy.adoptCarton")
      return legacyAdoptCartonPlan(store, payload, actor, now);
    if (action === "ritm.carton.dispatch")
      return ritmCartonDispatchPlan(store,payload,actor,now,loadCartons);
    if (action === "ritm.removeManualItem") {
      const { shipmentId, itemId, positionId } = payload;
      assert(actor === "ritm-service" && typeof shipmentId === "string" && ritmShipmentId(shipmentId) &&
        typeof itemId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(itemId) &&
        typeof positionId === "string" && positionId.startsWith(shipmentId+"|manual:"+itemId+"|") &&
        positionId.length > shipmentId.length + itemId.length + 9 && positionId.length <= 1500, "Некорректная дополнительная позиция.");
      const positions = "select p.id from av2_positions p join av2_supplies s on s.id=p.supply_id where s.origin_shipment_id=? and p.external_id=?";
      const history = await all(`with target(id) as (${positions}) select 1 from av2_work where position_id in target
        union all select 1 from av2_all_allocations where position_id in target
        union all select 1 from av2_warehouse_receipts where position_id in target limit 1`, [shipmentId,positionId]);
      if (history.length) return {statements:[],result:{status:"rejected",reason:"item_has_work"}};
      add('insert or ignore into av2_quality_repairs(id,kind,entity_id,"before","after",evidence,actor,created_at) values(?,?,?,?,?,?,?,?)',
        "ritm-manual:"+itemId,"ritm.manualRetired",positionId,"{}",'{"sourceActive":false}',JSON.stringify({shipmentId,itemId}),actor,now);
      add(`update av2_positions set source_active=0,ready=0 where id in (${positions})`,shipmentId,positionId);
      return {statements:sql,result:{status:"synced"}};
    }
    if (action === "photo.assign") {
      const sku = catalogKey(text(payload.sku, "Артикул"));
      const url = text(payload.url, "Фото", 2048);
      assert(photoAllowed(url), "Нужна ссылка на изображение товара с разрешённого источника.");
      await one("select id from av2_positions where upper(sku)=? limit 1", [sku], "Артикул не найден в поставках.");
      add("insert into av2_photo_overrides(sku,url,actor,updated_at) values(?,?,?,?) on conflict(sku) do update set url=excluded.url,actor=excluded.actor,updated_at=excluded.updated_at", sku, url, actor, now);
      return {statements: sql, result: {sku, photoUrl: url}};
    }
    if(action==="catalog.correctKind") {
      const entry=await one<{market:string;store:string;sku:string}>("select market,store,sku from av2_resolved_catalog_entries where import_id=(select active_catalog_id from av2_meta where id=1) and entry_id=?",[text(payload.entryId,"Карточка")],"Карточка не найдена в действующем справочнике.");
      const kind=text(payload.kind,"Вид товара"),reason=text(payload.reason,"Основание",500);
      await one("select type_key from av2_shift_norms where type_key=?",[workTypeKey(kind)],"Для этого вида не подтверждены нормы.");
      add("insert into av2_catalog_kind_overrides(id,market,store,sku,kind,reason,actor,created_at) values(?,?,?,?,?,?,?,?) on conflict(market,store,sku) do update set kind=excluded.kind,reason=excluded.reason,actor=excluded.actor,created_at=excluded.created_at",JSON.stringify([entry.market,entry.store,entry.sku]),entry.market,entry.store,entry.sku,kind,reason,actor,now);
      return {statements:sql,result:{...entry,kind}};
    }
    if (action === "allocation.place") {
      const row = await one<{
        plan: number;
        packing: number;
        boxed: number;
        assigned: number;
      }>(
        `select p.plan,coalesce(t.packing,0) packing,coalesce(t.boxed,0) boxed,(select coalesce(sum(a.qty),0) from av2_all_allocations a where a.position_id=p.id and a.removed_at is null) assigned from av2_positions p left join av2_position_totals t on t.position_id=p.id where p.id=?`,
        [text(payload.positionId, "Позиция")],
        "Позиция не найдена.",
      );
      const qty = integer(payload.qty, "Количество");
      assert(
        qty <= row.packing - row.boxed,
        "Недостаточно упакованного товара без короба. Обновите данные.",
      );
      const destination = payload.excessDestination ?? "box";
      assert(destination === "box" || destination === "stock", "Выберите, куда направить излишек.");
      const { shipmentQty: shipment, warehouseQty: excess } = placementAmounts(qty, row.plan - row.assigned, destination);
      const shipmentPlan = shipment
        ? await plan(
            "allocation.add",
            { ...payload, qty: shipment },
            actor,
            rev,
          )
        : null;
      const stockPlan = excess
        ? await warehousePlan(
            store,
            "warehouse.transfer",
            { ...payload, qty: excess },
            actor,
            now,
          )
        : null;
      return {
        statements: [
          ...(shipmentPlan?.statements || []),
          ...(stockPlan?.statements || []),
        ],
        result: {
          ...shipmentPlan?.result,
          ...stockPlan?.result,
          shipmentQty: shipment,
          warehouseQty: excess,
        },
      };
    } else if (
      [
        "warehouse.receive",
        "warehouse.transfer",
        "warehouse.create",
        "warehouse.close",
        "warehouse.remove",
        "warehouse.reopen",
  "warehouse.move",
      ].includes(action)
    ) {
      return warehousePlan(store, action, payload, actor, now);
    } else if (action === "employee.create") {
      const name = text(payload.name, "Имя", 120).trim();
      assert(
        !(
          await all("select id from av2_employees where name=? and active=1", [
            name,
          ])
        ).length,
        "Сотрудник с таким именем уже добавлен.",
      );
      add(
        "insert into av2_employees(id,name,active) values(?,?,1)",
        id(),
        name,
      );
    } else if (action === "legacy.references.import") {
      assert(
        payload.sourceWorkbookId ===
          "1dn7a7s-Ev9vLuNE2W8lECVwXCdpq8DXvC5Gt_O1sBbI",
        "Не подтверждён источник справочника RITM Сборка.",
      );
      const staff = payload.employees as { id: string; name: string }[];
      const labels = payload.cartonNumbers as string[];
      assert(
        Array.isArray(staff) &&
          staff.length > 0 &&
          staff.length <= 100 &&
          staff.every(
            (e) =>
              /^emp-\d+$/.test(e.id) &&
              typeof e.name === "string" &&
              e.name.trim() &&
              e.name.length <= 120,
          ) &&
          new Set(staff.map((e) => e.id)).size === staff.length &&
          new Set(staff.map((e) => e.name)).size === staff.length,
        "Проверьте список сборщиков из действующего Assembly.",
      );
      assert(
        Array.isArray(labels) &&
          labels.length <= 10000 &&
          labels.every(
            (s) => typeof s === "string" && s.trim() && s.length <= 100,
          ),
        "Проверьте существующие номера коробов.",
      );
      const existing = await all<Employee>(
        "select id,name,active from av2_employees",
      );
      for (const e of staff) {
        const prior =
          existing.find((p) => p.id === `legacy:${e.id}`) ||
          existing.find((p) => p.name === e.name);
        add(
          "insert into av2_employees(id,name,active) values(?,?,1) on conflict(id) do update set name=excluded.name,active=1",
          prior?.id || `legacy:${e.id}`,
          e.name,
        );
      }
      // Keep previous work attribution; only retire visibly synthetic menu choices.
      for (const e of existing.filter((e) => /^Тест:/u.test(e.name)))
        add("update av2_employees set active=0 where id=?", e.id);
      add(
        "insert into av2_carton_number_reservations(label,source) select value,? from json_each(?) where 1 on conflict(label) do nothing",
        String(payload.sourceWorkbookId),
        JSON.stringify([...new Set(labels)]),
      );
      result = {
        employees: staff.length,
        reservedNumbers: new Set(labels).size,
      };
    } else if (action === "supply.import") {
      const data = payload as unknown as SupplyImport;
      text(data.externalId, "ID поставки", 1000);
      text(data.title, "Название");
      text(data.store, "Магазин");
      text(data.destination, "Назначение");
      integer(data.sourceVersion, "Версия");
      assert(
        data.originShipmentId === undefined ||
          ritmShipmentId(data.originShipmentId),
        "Не подтверждён исходный ID РИТМ.",
      );
      assert(
        data.sourceActive === undefined ||
          typeof data.sourceActive === "boolean",
        "Не подтверждён статус источника.",
      );
      assert(
        data.market === "WB" || data.market === "OZON",
        "Выберите WB или OZON.",
      );
      assert(
        Array.isArray(data.positions) &&
          data.positions.length > 0 &&
          data.positions.length <= 500,
        "В поставке должно быть от 1 до 500 позиций.",
      );
      assert(
        new Set(data.positions.map((p) => p.externalId)).size ===
          data.positions.length,
        "Повторяются исходные ID позиций.",
      );
      const existing = (
        await all<SupplyRow>("select * from av2_supplies where external_id=?", [
          data.externalId,
        ])
      )[0];
      const supplyId = existing?.id ?? id();
      const canonical = stable(data);
      if (existing) {
        const confirmUnknownStore = actor === 'ritm-source' && existing.originShipmentId && existing.store === 'Не подтверждён' && /^[1-9]\d*$/.test(data.store) && sameScope({...existing,store:data.store},data);
        if (confirmUnknownStore) {
          const activity = (await all<{n:number}>(`select (select count(*) from av2_work where supply_id=?)+(select count(*) from av2_all_allocations where position_id in(select id from av2_positions where supply_id=?))+(select count(*) from av2_warehouse_receipts where position_id in(select id from av2_positions where supply_id=?)) n`,[existing.id,existing.id,existing.id]))[0];
          assert(activity.n===0,'У позиции уже есть работа или вложения; требуется сверка истории.');
          add('insert into av2_quality_repairs(id,kind,entity_id,"before","after",evidence,actor,created_at) values(?,?,?,?,?,?,?,?)',id(),'store.confirmed',existing.id,JSON.stringify({store:existing.store}),JSON.stringify({store:data.store}),JSON.stringify({origin:existing.originShipmentId,source:'confirmed-ritm-feed'}),actor,now);
        }
        assert(
          data.sourceVersion >= existing.sourceVersion,
          "Получена устаревшая версия поставки.",
        );
        assert(
          sameScope(existing, data) || confirmUnknownStore,
          "Назначение существующей поставки менять нельзя. Создайте отдельную поставку.",
        );
        assert(
          (existing.originShipmentId || null) ===
            (data.originShipmentId || null),
          "Исходную поставку РИТМ менять нельзя.",
        );
        if (data.sourceVersion === existing.sourceVersion) {
          assert(
            canonical === existing.sourcePayload,
            "Содержимое версии изменилось. Увеличьте sourceVersion.",
          );
          return { statements: [], result: { supplyId } };
        }
        add(
          "update av2_supplies set store=?,title=?,source_version=?,source_payload=?,source_active=? where id=?",
          data.store,
          data.title,
          data.sourceVersion,
          canonical,
          data.sourceActive === false ? 0 : 1,
          supplyId,
        );
      } else
        add(
          "insert into av2_supplies(id,external_id,title,market,store,destination,source_version,source_payload,created_at,origin_shipment_id,source_active) values(?,?,?,?,?,?,?,?,?,?,?)",
          supplyId,
          data.externalId,
          data.title,
          data.market,
          data.store,
          data.destination,
          data.sourceVersion,
          canonical,
          now,
          data.originShipmentId || null,
          data.sourceActive === false ? 0 : 1,
        );
      const previous = await all<PositionRow>(
        "select * from av2_positions where supply_id=?",
        [supplyId],
      );
      assert(
        previous.every((p) =>
          data.positions.some((n) => n.externalId === p.externalId),
        ),
        "Новая версия удаляет существующую позицию. Историю удалять нельзя.",
      );
      const catalog = await resolveCatalogPositions(store, data);
      const imported: Record<string, unknown>[] = [];
      for (const p of data.positions) {
        text(p.externalId, "ID позиции", 1500);
        text(p.sku, "Артикул");
        text(p.name, "Название товара");
        text(p.department, "Участок");
        integer(p.plan, "План", 0);
        assert(
          p.unitsPerBox === null ||
            (typeof p.unitsPerBox === "number" &&
              Number.isSafeInteger(p.unitsPerBox) &&
              p.unitsPerBox > 0),
          "Норма короба должна быть положительным целым числом или null.",
        );
        assert(
          typeof p.ready === "boolean" &&
            (p.cutOperation === "cut" || p.cutOperation === "assembly"),
          "Проверьте готовность и вид резки.",
        );
        assert(
          p.sourceActive === undefined || typeof p.sourceActive === "boolean",
          "Не подтверждён статус исходной позиции.",
        );
        assert(
          typeof p.barcode === "string" && p.barcode.length <= 300,
          "Штрихкод должен быть строкой.",
        );
        const old = previous.find((x) => x.externalId === p.externalId);
        if (old)
          assert(
            old.sku === p.sku &&
              old.barcode === p.barcode &&
              old.department === p.department &&
              old.cutOperation === p.cutOperation,
            "У существующей позиции изменился артикул или происхождение. Нужен новый исходный ID.",
          );
        imported.push({
          ...p,
          unitsPerBox: old
            ? actor === 'ritm-source' && old.unitsPerBox === null && p.unitsPerBox !== null ? p.unitsPerBox : old.catalogImportId
              ? old.unitsPerBox
              : p.unitsPerBox
            : (catalog.get(catalogKey(p.sku))?.entry.unitsPerBox ??
              (catalog.has(catalogKey(p.sku)) ? null : p.unitsPerBox)),
          catalogImportId:
            old?.catalogImportId ??
            catalog.get(catalogKey(p.sku))?.importId ??
            null,
          catalogEntryId:
            old?.catalogEntryId ??
            catalog.get(catalogKey(p.sku))?.entry.id ??
            null,
          id: old?.id ?? id(),
          supplyId,
          ready: p.ready ? 1 : 0,
          sourceActive: p.sourceActive === false ? 0 : 1,
        });
      }
      add(
        `insert into av2_positions(id,supply_id,external_id,sku,name,barcode,department,plan,units_per_box,ready,cut_operation,catalog_import_id,catalog_entry_id,source_active)
        select json_extract(value,'$.id'),json_extract(value,'$.supplyId'),json_extract(value,'$.externalId'),json_extract(value,'$.sku'),json_extract(value,'$.name'),json_extract(value,'$.barcode'),json_extract(value,'$.department'),json_extract(value,'$.plan'),json_extract(value,'$.unitsPerBox'),json_extract(value,'$.ready'),json_extract(value,'$.cutOperation'),json_extract(value,'$.catalogImportId'),json_extract(value,'$.catalogEntryId'),json_extract(value,'$.sourceActive') from json_each(?) where 1
        on conflict(id) do update set name=excluded.name,plan=excluded.plan,units_per_box=excluded.units_per_box,ready=excluded.ready,source_active=excluded.source_active`,
        JSON.stringify(imported),
      );
      if (data.positions.some(p => p.externalId.includes("|manual:"))) {
        add("update av2_positions set source_active=0,ready=0 where supply_id=? and external_id in (select entity_id from av2_quality_repairs where kind='ritm.manualRetired')", supplyId);
      }
      result = { supplyId };
    } else if (action === "ritm.import") {
      const source = payload.source as unknown as RitmSupply,
        sourceRevision = payload.sourceRevision,
        fingerprint = text(payload.fingerprint, "Состав РИТМ", 64);
      assert(
        source &&
          ritmShipmentId(source.shipmentId) &&
          typeof sourceRevision === "number" &&
          Number.isSafeInteger(sourceRevision) &&
          sourceRevision > 0,
        "Не подтверждена версия источника РИТМ.",
      );
      assert(
        /^[a-f0-9]{64}$/.test(fingerprint) &&
          (await digest(JSON.stringify(source))) === fingerprint,
        "Состав РИТМ не прошёл проверку целостности.",
      );
      const previous = (
        await all<{ sourceRevision: number; fingerprint: string; confirmedDeleted: number }>(
          "select source_revision,fingerprint,json_extract(payload,'$.confirmedDeleted') confirmed_deleted from av2_ritm_links where shipment_id=?",
          [source.shipmentId],
        )
      )[0];
      if (previous?.confirmedDeleted) {
        return { statements: sql, result: { groups: 0, positions: 0, issues: [] } };
      }
      if (previous) {
        assert(
          sourceRevision >= previous.sourceRevision,
          "Получен устаревший снимок РИТМ.",
        );
        assert(
          sourceRevision !== previous.sourceRevision ||
            fingerprint === previous.fingerprint,
          "Состав одной версии РИТМ изменился.",
        );
      }
      const prepared = await prepareRitmImport(store, source);
      const supplyIds: string[] = [];
      for (const group of prepared.groups) {
        const p = await plan(
          "supply.import",
          group as unknown as Record<string, unknown>,
          actor,
          rev,
        );
        sql.push(...p.statements);
        supplyIds.push(String(p.result.supplyId));
      }
      add(
        "insert into av2_ritm_links(shipment_id,source_revision,fingerprint,payload,seen_at,issues) values(?,?,?,?,?,?) on conflict(shipment_id) do update set source_revision=excluded.source_revision,fingerprint=excluded.fingerprint,payload=excluded.payload,seen_at=excluded.seen_at,issues=excluded.issues",
        source.shipmentId,
        sourceRevision,
        fingerprint,
        JSON.stringify(source),
        Date.now(),
        JSON.stringify(prepared.issues),
      );
      result = {
        supplyIds,
        groups: prepared.groups.length,
        positions: source.positions.length,
        issues: prepared.issues,
      };
    } else if (action === "ritm.retire" || action === "ritm.retireConfirmed") {
      const ids = payload.ids;
      const confirmed = action === "ritm.retireConfirmed";
      assert(
        Array.isArray(ids) &&
          ids.length <= 1000 &&
          ids.every((v) => typeof v === "string" && ritmShipmentId(v)),
        "Не подтверждены исчезнувшие поставки РИТМ.",
      );
      if (confirmed) {
        assert(actor === "ritm-service", "Требуется служебное подтверждение РИТМ.");
      }
      if (ids.length) {
        const parameter = JSON.stringify(ids);
        if (confirmed) {
          // A late snapshot can still contain the old rows. Keep the deletion
          // by source ID even when the source has never been imported here.
          add(
            `insert into av2_ritm_links(shipment_id,source_revision,fingerprint,payload,seen_at,issues)
             select value,0,'',json_object('confirmedDeleted',1),?,'[]' from json_each(?) where 1
             on conflict(shipment_id) do update set payload=json_set(av2_ritm_links.payload,'$.confirmedDeleted',1)`,
            Date.now(), parameter,
          );
        }
        add(
          "update av2_positions set source_active=0,ready=0 where supply_id in(select id from av2_supplies where origin_shipment_id in(select value from json_each(?)))",
          parameter,
        );
        add(
          "update av2_supplies set source_active=0 where origin_shipment_id in(select value from json_each(?))",
          parameter,
        );
      }
      result = { retired: ids.length };
    } else if (action === "catalog.activate") {
      sql.push(
        ...(await catalogActivationPlan(store, text(payload.id, "Импорт"))),
      );
      result = { catalogId: payload.id };
    } else if (action === "carton.create") {
      const supply = await one<SupplyRow>(
        "select * from av2_supplies where id=?",
        [text(payload.supplyId, "Поставка")],
        "Поставка не найдена.",
      );
      const box = await createCarton(supply);
      result = { cartonId: box.id, label: box.label };
    } else if (action === "work.save" || action === "allocation.add") {
      const p = await one<PositionRow>(
        "select * from av2_positions where id=?",
        [text(payload.positionId, "Позиция")],
        "Позиция не найдена.",
      );
      const qty = integer(payload.qty, "Количество");
      if (!p.ready) {
        const locked = (
          await all<{ locked: number }>(
            "select coalesce(json_extract(l.payload,'$.locked'),0) locked from av2_supplies s left join av2_ritm_links l on l.shipment_id=s.origin_shipment_id where s.id=?",
            [p.supplyId],
          )
        )[0];
        assert(
          !locked?.locked,
          "Поставка закрыта для сборки в РИТМ. Чтобы записывать работу, откройте её замок в РИТМ.",
        );
      }
      assert(
        p.ready &&
          p.sourceActive !== false &&
          (p.sourceActive as unknown) !== 0,
        "Участок ещё не подтвердил готовность позиции.",
      );
      if (action === "work.save") {
        const employee = await one<Employee>(
          "select * from av2_employees where id=? and active=1",
          [text(payload.employeeId, "Ваше имя")],
          "Сотрудник не найден или неактивен.",
        );
        assert(p.ready, "Участок ещё не подтвердил готовность позиции.");
        assert(
          ["cut", "assembly", "packing"].includes(String(payload.operation)),
          "Выберите операцию.",
        );
        assert(
          !payload.cartonId || payload.operation === "packing",
          "В короб можно сразу добавить только упаковку.",
        );
        const workId = id();
        const catalog =
          p.catalogImportId && p.catalogEntryId
            ? (
                await all<{ data: string }>(
                  `select ${effectiveCatalogData()} data from av2_resolved_catalog_entries e where import_id=? and entry_id=?`,
                  [p.catalogImportId, p.catalogEntryId],
                )
              )[0]
            : null;
        const norms = (
          await all<{ data: string }>("select data from av2_shift_norms")
        ).map((n) => JSON.parse(n.data) as ShiftNorm);
        const effective = effectiveWorkNorms(
            catalog ? JSON.parse(catalog.data) : null,
            norms,
          ),
          operation = String(
            payload.operation,
          ) as import("../shared/model").Operation;
        const workNorm = effective[operation],
          coefficient = savedCoefficient(effective, operation, qty);
        add(
          "insert into av2_work(id,supply_id,position_id,employee_id,employee_name,operation,qty,actor,created_at,norm,coefficient) values(?,?,?,?,?,?,?,?,?,?,?)",
          workId,
          p.supplyId,
          p.id,
          employee.id,
          employee.name,
          String(payload.operation),
          qty,
          actor,
          now,
          workNorm === null ? null : String(workNorm),
          coefficient === null ? null : String(coefficient),
        );
        sql.push(enqueueWork(workId, now));
        increment(p.id, String(payload.operation), qty, employee);
      }
      let allocatedCarton: Carton | null = null;
      if (action === "allocation.add" || payload.cartonId) {
        const supply = await one<SupplyRow>(
          "select * from av2_supplies where id=?",
          [p.supplyId],
          "Поставка не найдена.",
        );
        assert(
          payload.newCarton !== true || !payload.cartonId,
          "Выберите существующий или новый короб.",
        );
        const box =
          payload.newCarton === true
            ? await createCarton(supply)
            : await carton(text(payload.cartonId, "Короб"));
        allocatedCarton = box;
        assert(
          box.state === "open" && !box.dispatchId,
          "Короб закрыт или уже выбран на отгрузку.",
        );
        assert(
          sameCartonScope(box, supply),
          "У короба другой маркетплейс, магазин или склад назначения.",
        );
        assert(
          p.unitsPerBox && p.unitsPerBox > 0,
          "Не задана норма вместимости товара.",
        );
        const totals = (
          await all<{ packing: number; boxed: number }>(
            "select packing,boxed from av2_position_totals where position_id=?",
            [p.id],
          )
        )[0];
        assert(
          (totals?.packing ?? 0) -
            (totals?.boxed ?? 0) +
            (action === "work.save" ? qty : 0) >=
            qty,
          "Недостаточно упакованного товара без короба. Обновите данные.",
        );
        assert(
          !box.capacityUnknown,
          "В старом коробе есть товар без подтверждённой вместимости. Выберите другой короб.",
        );
        assert(
          box.fill + qty / p.unitsPerBox <= 1 + 1e-9,
          "Количество превышает свободное место в коробе.",
        );
        add(
          "insert into av2_allocations(id,carton_id,position_id,qty,units_per_box,created_at,actor) values(?,?,?,?,?,?,?)",
          id(),
          box.id,
          p.id,
          qty,
          p.unitsPerBox,
          now,
          actor,
        );
        increment(p.id, "boxed", qty);
      }
      result = {
        positionId: p.id,
        ...(allocatedCarton
          ? { cartonId: allocatedCarton.id, label: allocatedCarton.label }
          : {}),
      };
    } else if (action === "allocation.remove") {
      const allocation = await one<{
        cartonId: string;
        positionId: string;
        qty: number;
        removedAt: string | null;
        legacy: number;
      }>(
        "select carton_id,position_id,qty,removed_at,legacy from av2_all_allocations where id=?",
        [text(payload.allocationId, "Вложение")],
        "Вложение не найдено.",
      );
      const box = await carton(allocation.cartonId);
      assert(
        !allocation.removedAt && box.state === "open" && !box.dispatchId,
        "Извлекать товар можно только из открытого короба.",
      );
      const reason = text(payload.reason, "Причина", 500).trim();
      assert(reason.length >= 3, "Укажите причину извлечения.");
      add(
        `update ${allocation.legacy ? "av2_legacy_allocations" : "av2_allocations"} set removed_at=?,removal_reason=? where id=?`,
        now,
        reason,
        String(payload.allocationId),
      );
      increment(allocation.positionId, "boxed", -allocation.qty);
    } else if (action === "work.cancel") {
      const stockWorkId = text(payload.workId, "Запись работы");
      const stockReason = text(payload.reason, "Причина", 500).trim();
      assert(stockReason.length >= 3, "Укажите причину отмены.");
      const stockCancellation = await cancelWarehouseWorkPlan(store, stockWorkId, stockReason, actor, now);
      if (stockCancellation) return stockCancellation;
      const work = await one<Work>(
        "select * from av2_work where id=?",
        [text(payload.workId, "Запись работы")],
        "Запись не найдена.",
      );
      assert(
        !(
          await all("select id from av2_corrections where work_id=?", [work.id])
        ).length,
        "Запись уже отменена.",
      );
      const reason = text(payload.reason, "Причина", 500).trim();
      assert(reason.length >= 3, "Укажите причину отмены.");
      if (work.operation === "packing") {
        const cancellation=await cancelPacking(store,work,reason,actor,now);
        sql.push(...cancellation.statements);result=cancellation.result;
      }
      const employeeName = (work as Work & { employeeName: string })
        .employeeName;
      const correctionId = id();
      add(
        "insert into av2_corrections(id,work_id,reason,actor,created_at) values(?,?,?,?,?)",
        correctionId,
        work.id,
        reason,
        actor,
        now,
      );
      sql.push(enqueueCancellation(work.id, correctionId, now));
      increment(work.positionId, work.operation, -work.qty, {
        id: work.employeeId,
        name: employeeName,
      });
    } else if (action === "carton.close") {
      const box = await carton(text(payload.cartonId, "Короб"));
      assert(
        box.state === "open" && !box.dispatchId,
        "Короб уже закрыт или выбран на отгрузку.",
      );
      assert(box.qty > 0, "Пустой короб закрыть нельзя.");
      const fingerprint = box.items
        .map((i) => ({ id: i.id, qty: i.qty }))
        .sort((a, b) => a.id.localeCompare(b.id));
      assert(
        stable(payload.items) === stable(fingerprint),
        "Состав короба изменился. Откройте и проверьте его заново.",
      );
      add(
        "update av2_cartons set state=?,closed_at=? where id=?",
        "closed",
        now,
        box.id,
      );
    } else if (action === "carton.reopen") {
      const box = await carton(text(payload.cartonId, "Короб"));
      assert(
        !box.dispatchId,
        box.dispatchState === "sent"
          ? "Короб уже отправлен."
          : "Короб включён в отгрузку. Сначала отмените подготовку отгрузки.",
      );
      assert(
        box.state === "closed" && box.closedAt === payload.closedAt,
        "Статус короба изменился. Обновите его перед открытием.",
      );
      add("update av2_cartons set state='open',closed_at=null where id=?", box.id);
      result = { cartonId: box.id, reopened: true };
    } else if (action === "dispatch.create") {
      assert(
        Array.isArray(payload.cartonIds) &&
          payload.cartonIds.length > 0 &&
          payload.cartonIds.length <= 100,
        "Выберите от 1 до 100 коробов.",
      );
      const ids = payload.cartonIds.map((value) => text(value, "Короб"));
      assert(new Set(ids).size === ids.length, "В выборе повторяются короба.");
      const boxes = await loadCartons(ids);
      assert(
        boxes.length === ids.length &&
          boxes.every(
            (b) =>
              b.state === "closed" && !b.dispatchId && sameScope(b, boxes[0]),
          ),
        "Один из коробов недоступен либо отличается магазин / назначение. Обновите выбор.",
      );
      const dispatchId = id();
      const first = boxes[0];
      add(
        "insert into av2_dispatches(id,label,market,store,destination,state,actor,created_at,carton_ids,qty) values(?,?,?,?,?,?,?,?,?,?)",
        dispatchId,
        `ОТ-${String(rev + 1).padStart(5, "0")}`,
        first.market,
        first.store,
        first.destination,
        "draft",
        actor,
        now,
        JSON.stringify(ids),
        boxes.reduce((n, b) => n + b.qty, 0),
      );
      add(
        "update av2_cartons set dispatch_id=? where id in (select value from json_each(?))",
        dispatchId,
        JSON.stringify(ids),
      );
      result = { dispatchId };
    } else if (
      ["dispatch.cancel", "export.create"].includes(action)
    ) {
      const d = await dispatch(text(payload.dispatchId, "Отгрузка"));
      if (action === "export.create") {
        assert(d.state !== "canceled", "Отгрузка отменена.");
        assert(
          payload.kind === "account" || payload.kind === "template",
          "Неизвестный вид выгрузки.",
        );
        const frozen = (d as Dispatch & { sentPayload?: string }).sentPayload;
        assert(
          d.state !== "sent" || frozen,
          "В старом РИТМ не сохранён состав на момент отправки этого короба. Историческая выгрузка не подтверждена.",
        );
        const exportPayload =
          frozen ??
          JSON.stringify({
            dispatch: d,
            cartons: await loadCartons(d.cartonIds),
          });
        const exportId = id();
        add(
          "insert into av2_exports(id,dispatch_id,kind,payload,actor,created_at) values(?,?,?,?,?,?)",
          exportId,
          d.id,
          String(payload.kind),
          exportPayload,
          actor,
          now,
        );
        result = { exportId };
      } else {
        assert(
          d.state === "draft",
          "Можно изменить только подготовленную отгрузку.",
        );
        add("update av2_dispatches set state=? where id=?", "canceled", d.id);
        add("update av2_cartons set dispatch_id=null where dispatch_id=?", d.id);
      }
    } else throw new Error("Неизвестная операция.");
    return { statements: sql, result };
  }
  return {
    ozon,
    preparedDispatches: () => readPreparedDispatches(store),
    dispatchHistory: {
      page: (page, query) => readDispatchHistoryPage(store, page, query),
      detail: (shipmentId) => readDispatchHistoryDetail(store, shipmentId),
    },
    warehouse: (url: URL) => readWarehouse(store, url),
    workHistory: (url: URL) => readWorkHistory(store, url),
    searchPositions: (url: URL) => searchPositions(store, url),
    snapshot,
    revision,
    async export(exportId) {
      const row = (
        await all<Omit<ExportSnapshot, "payload"> & { payload: string }>(
          "select * from av2_exports where id=? and kind in ('account','template')",
          [exportId],
        )
      )[0];
      return row ? { ...row, payload: JSON.parse(row.payload) } : null;
    },
    async command(action, payload, key, actor) {
      assert(
        key.length >= 16 && key.length <= 100 && actor.length > 0,
        "Недопустимый ключ операции или нет доступа.",
      );
      const canonical = stable(payload);
      // Append-only work and allocations are validated against live rows by
      // the DB commit guards; independent collectors need no global CAS retry.
      const atomicEntry =
        (action === "work.save" || action === "allocation.add") &&
        payload.newCarton !== true;
      for (let attempt = 0; attempt < 16; attempt++) {
        const previous = (
          await all<{
            action: string;
            payload: string;
            result: string;
            actor: string;
          }>(
            "select action,payload,result,actor from av2_commands where key=?",
            [key],
          )
        )[0];
        if (previous) {
          assert(
            previous.action === action &&
              previous.payload === canonical &&
              previous.actor === actor,
            "Ключ уже использован для другой операции.",
          );
          return JSON.parse(previous.result) as Record<string, unknown>;
        }
        const rev = atomicEntry ? 0 : await revision();
        const prepared = await plan(action, payload, actor, rev);
        try {
          await store.batch([
            statement(
              `insert into av2_commands(key,action,payload,result,expected_revision,actor,created_at) values(?,?,?,?,${atomicEntry ? "coalesce((select revision from av2_meta where id=1),0)" : "?"},?,?)`,
              key,
              action,
              canonical,
              JSON.stringify(prepared.result),
              ...(!atomicEntry ? [rev] : []),
              actor,
              new Date().toISOString(),
            ),
            ...prepared.statements,
            statement(
              "insert into av2_meta(id,revision) values(1,1) on conflict(id) do update set revision=revision+1",
            ),
          ]);
          return prepared.result;
        } catch (error) {
          if (
            /ASSEMBLY_REVISION_CONFLICT|UNIQUE constraint failed: av2_commands.key/.test(
              error instanceof Error ? error.message : String(error),
            )
          ) {
            await new Promise((resolve) =>
              setTimeout(resolve, 3 + Math.floor(Math.random() * 20)),
            );
            continue;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          const translated = Object.entries({
            ASSEMBLY_EMPLOYEE_INACTIVE:
              "Сотрудник неактивен. Выберите другое имя.",
            ASSEMBLY_POSITION_NOT_READY:
              "Участок ещё не подтвердил готовность позиции.",
            ASSEMBLY_CARTON_UNAVAILABLE:
              "Короб закрыт или уже выбран на отгрузку.",
            ASSEMBLY_CARTON_SCOPE:
              "У короба другой маркетплейс, магазин или склад назначения.",
            ASSEMBLY_NORM_CHANGED:
              "Норма вместимости изменилась. Обновите данные и повторите запись.",
            ASSEMBLY_STOCK_INSUFFICIENT:
              "Недостаточно упакованного товара без короба. Обновите данные.",
            ASSEMBLY_CARTON_FULL:
              "Количество превышает свободное место в коробе.",
          }).find(([code]) => message.includes(code));
          if (translated) throw new Error(translated[1]);
          throw error;
        }
      }
      throw new Error(
        "Данные одновременно изменились. Повторите операцию; двойной записи не будет.",
      );
    },
  };
}
export function camelRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    ),
  ) as T[];
}
