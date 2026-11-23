import {receiptRoot, warehouseWorkQty} from "./warehouse-splits";
import type { SqlStore, Statement } from "./database";
import type {
  WarehouseCarton,
  WarehousePage,
  WarehouseReceipt,
} from "../shared/warehouse";
import type { CatalogEntry } from "../shared/catalog";
import { effectiveCatalogData, requireCatalog as check } from "./catalog-store";
import { catalogKey } from "../shared/catalog";
import { effectiveWorkNorms, savedCoefficient, type ShiftNorm } from "../shared/work-norm";
import { enqueueStockCutWork, enqueueWarehouseWork } from "./ritm-outbox";
const q = (sql: string, ...args: (string | number | null)[]): Statement => ({
  sql,
  args,
});
const str = (v: unknown, max = 300) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max
    ? v.trim()
    : "";
export async function readWarehouse(
  store: SqlStore,
  url: URL,
): Promise<WarehousePage> {
  if (url.searchParams.get("choices") === "1") {
    const cartons = await store.all<WarehouseCarton>("select c.*,(select coalesce(sum(qty),0) from av2_warehouse_receipts r where r.carton_id=c.id and r.voided_at is null) qty from av2_warehouse_cartons c where c.market=? and c.store=? and c.state='open' order by length(c.label),c.label", [url.searchParams.get("market") || "", url.searchParams.get("store") || ""]);
    return {cartons, total:cartons.length, page:0, itemPage:0};
  }
  const page =
    Math.max(0, Math.min(10000, Number(url.searchParams.get("page")) || 0)) | 0;
  const itemPage =
    Math.max(
      0,
      Math.min(10000, Number(url.searchParams.get("itemPage")) || 0),
    ) | 0;
  const search = catalogKey(url.searchParams.get("q") || "").slice(0, 150);
  const carton = url.searchParams.get("carton") || "";
  const exporting=url.searchParams.has("export");
  const includeSummary = !exporting && url.searchParams.get("summary") === "1";
  const exportAll=url.searchParams.get("export")==="all";
  const ids:unknown=exporting&&!exportAll?JSON.parse(url.searchParams.get("export")||"[]"):[];
  check(Array.isArray(ids)&&ids.length<=100&&ids.every(id=>typeof id==='string'&&id.length<=300),"Выберите не больше 100 складских коробов.");
  if(exporting&&!exportAll)check(ids.length>0,"Выберите складские короба.");
  const market=url.searchParams.get("market")||"", shop=url.searchParams.get("store")||"", status=url.searchParams.get("state")||"";
  const filter = `(?='' or c.id=?) and (?='' or instr(lower(c.label),?)>0 or exists(select 1 from av2_warehouse_receipts r where r.carton_id=c.id and r.voided_at is null and instr(r.search,?)>0))
    and (?='' or c.market=?) and (?='' or c.store=?) and (?='' or c.state=?) ${exporting&&!exportAll?'and c.id in(select value from json_each(?))':''}`;
  const args = [carton, carton, search, search.toLocaleLowerCase("ru"), search,market,market,shop,shop,status,status,...(exporting&&!exportAll?[JSON.stringify(ids)]:[])];
  const offset=exporting?0:page*5;
  const selection = `select c.id from av2_warehouse_cartons c where ${filter} order by c.created_at desc,c.id desc limit ${exportAll?500:exporting?100:5} offset ?`;
  const batch = await store.readBatch([
    q(
      `select count(*) total ${includeSummary ? `,
        count(case when c.state='open' then 1 end) open_count,
        coalesce(sum((select sum(r.qty) from av2_warehouse_receipts r
          where r.carton_id=c.id and r.voided_at is null)),0) qty` : ""}
        from av2_warehouse_cartons c where ${filter}`,
      ...args,
    ),
    q(
      `select c.*,(c.state='open' and c.id=(select x.id from av2_warehouse_cartons x where x.market=c.market and x.store=c.store and x.state='open' order by length(x.label) desc,x.label desc limit 1)) current,(select coalesce(sum(r.qty),0) from av2_warehouse_receipts r where r.carton_id=c.id and r.voided_at is null) qty,(select count(*) from av2_warehouse_receipts r where r.carton_id=c.id and r.voided_at is null) item_count from av2_warehouse_cartons c where c.id in (${selection}) order by c.created_at desc,c.id desc`,
      ...args,
      offset,
    ),
    q(
      `select * from (select r.*,w.id work_id,w.norm,w.coefficient,${warehouseWorkQty()} work_qty,coalesce((select json_extract(o.data,'$.photoUrl') from av2_catalog_products o join av2_warehouse_cartons wc on wc.id=r.carton_id where o.market=wc.market and o.store=wc.store and upper(r.sku) in(select value from json_each(o.data,'$.aliases')) limit 1),(select o.url from av2_photo_overrides o where o.sku=upper(r.sku)),(select json_extract(${effectiveCatalogData()},'$.photoUrl') from av2_resolved_catalog_entries e where e.import_id=r.catalog_import_id and e.sku=r.sku limit 1),(select sp.url from av2_positions p join av2_source_photos sp on sp.position_id=p.external_id and sp.sku=p.sku where p.id=r.position_id)) photo_url,row_number() over(partition by r.carton_id order by r.created_at desc,r.id desc) rn from av2_warehouse_receipts r left join av2_warehouse_work w on w.receipt_id=${receiptRoot()} where r.carton_id in (${selection}) and r.voided_at is null) where rn>? and rn<=? limit ${exporting?10001:150}`,
      ...args,
      offset,
      exporting?0:itemPage * 30,
      exporting?10001:(itemPage + 1) * 30,
    ),
  ]);
  const items = batch[2] as unknown as WarehouseReceipt[];
  if(exporting){
    check(batch[1].length===(exportAll?Number(batch[0][0]?.total||0):new Set(ids).size),exportAll?"Для такой выгрузки выберите магазин или статус: за раз доступно до 500 коробов.":"Часть выбранных коробов не найдена. Обновите список.");
    check(items.length<=10000&&batch[1].every(c=>Number(c.itemCount)===items.filter(i=>i.cartonId===c.id).length),"Слишком большой состав. Выберите меньше коробов для выгрузки.");
  }
  return {
    total: Number(batch[0][0]?.total || 0),
    ...(includeSummary ? { summary: {
      qty: Number(batch[0][0]?.qty ?? 0),
      openCount: Number(batch[0][0]?.openCount ?? 0),
    } } : {}),
    page,
    itemPage,
    cartons: (batch[1] as unknown as WarehouseCarton[]).map((c) => ({
      ...c,
      current: !!c.current,
      items: items.filter((i) => i.cartonId === c.id),
    })),
  };
}
export async function cancelWarehouseWorkPlan(store: SqlStore, workId: string, reason: string, actor: string, now: string) {
  const [cut] = await store.all<{canceledAt: string | null}>("select canceled_at from av2_stock_cut_work where id=?", [workId]);
  if (cut) {
    check(!cut.canceledAt, "Запись уже отменена.");
    const event = {id: "av2:cancel:" + crypto.randomUUID(), kind: "cancel", eventId: "av2:" + workId, reason, createdAt: now};
    return {statements: [
      q("update av2_stock_cut_work set canceled_at=?,cancel_reason=?,cancel_actor=? where id=?", now, reason, actor, workId),
      q("insert into av2_ritm_work_outbox(id,payload,created_at) values(?,?,?)", event.id, JSON.stringify(event), now),
    ], result: {workId, canceled: true}};
  }
  const [row] = await store.all<{ receiptId: string; cartonId: string; state: string; canceledAt: string | null; voidedAt: string | null }>(
    "select w.receipt_id,w.canceled_at,r.voided_at,r.carton_id,c.state from av2_warehouse_work w join av2_warehouse_receipts r on r.id=w.receipt_id join av2_warehouse_cartons c on c.id=r.carton_id where w.id=?", [workId]);
  if (!row) return null;
  check(!row.canceledAt && !row.voidedAt, "Запись уже отменена.");
  check(row.state === "open", "Упаковку на склад можно отменить только в открытом складском коробе. Проверьте его статус.");
  const parts=await store.all<{id:string;cartonId:string;state:string}>(`select r.id,r.carton_id,c.state from av2_warehouse_receipts r join av2_warehouse_cartons c on c.id=r.carton_id where ${receiptRoot()}=? and r.voided_at is null`,[row.receiptId]);
  check(parts.every(p=>p.state==="open"),"Часть этой упаковки в закрытом коробе. Откройте все её короба перед отменой работы.");
  const correctionId = crypto.randomUUID(), event = { id: "av2:cancel:" + correctionId, kind: "cancel", eventId: "av2:" + workId, reason, createdAt: now };
  return { statements: [
    q("update av2_warehouse_work set canceled_at=?,cancel_reason=?,cancel_actor=? where id=?", now, reason, actor, workId),
    ...parts.map(p=>q("update av2_warehouse_receipts set voided_at=?,void_reason=? where id=?", now, reason, p.id)),
    ...[...new Set(parts.map(p=>p.cartonId))].map(id=>q("update av2_warehouse_cartons set version=version+1 where id=?",id)),
    q("insert into av2_ritm_work_outbox(id,payload,created_at) values(?,?,?)", event.id, JSON.stringify(event), now),
  ], result: { workId, warehouseReceiptId: row.receiptId, canceled: true } };
}
export async function warehousePlan(
  store: SqlStore,
  action: string,
  p: Record<string, unknown>,
  actor: string,
  now: string,
): Promise<{ statements: Statement[]; result: Record<string, unknown> }> {
  if (action === "warehouse.receive" && p.additionalWork !== undefined) {
    check(p.receiptMode === "packing", "Дополнительная операция доступна только при записи работы в запас.");
    check(p.additionalWork !== null && typeof p.additionalWork === "object" && !Array.isArray(p.additionalWork), "Проверьте дополнительную операцию.");
    const additional = p.additionalWork as Record<string, unknown>;
    const operation = p.operation ?? "packing";
    check(["cut", "assembly", "packing"].includes(String(additional.operation)), "Выберите дополнительную операцию.");
    check(operation !== additional.operation, "Одна операция указана дважды. Оставьте одну запись.");
    const single = { ...p, additionalWork: undefined };
    // Both plans validate before the command transaction: never save one employee without the other.
    const first = await warehousePlan(store, action, single, actor, now);
    const second = await warehousePlan(store, action, { ...single, operation: additional.operation, employeeId: additional.employeeId, qty: additional.qty === undefined ? p.qty : additional.qty }, actor, now);
    return {
      statements: [...first.statements, ...second.statements],
      result: { ...first.result, ...(second.result.warehouseCartonId ? second.result : {}), additionalWork: second.result, combined: true },
    };
  }
  const sql: Statement[] = [];
  const one = async <T>(
    query: string,
    args: (string | number | null)[],
    message: string,
  ) => {
    const row = (await store.all<T>(query, args))[0];
    check(row, message);
    return row;
  };
  if (action === "warehouse.move") {
    const item = await one<{id:string;cartonId:string;qty:number;voidedAt:string|null}>("select id,carton_id,qty,voided_at from av2_warehouse_receipts where id=?",[str(p.receiptId)],"Вложение не найдено.");
    check(!item.voidedAt && item.cartonId === p.fromCartonId, "Товар уже перемещён или удалён. Обновите список.");
    const from = await one<WarehouseCarton>("select * from av2_warehouse_cartons where id=?",[item.cartonId],"Исходный короб не найден.");
    const to = await one<WarehouseCarton>("select * from av2_warehouse_cartons where id=?",[str(p.toCartonId)],"Выберите короб назначения.");
    check(from.id !== to.id, "Выберите другой короб.");
    check(from.state === "open" && to.state === "open", "Для перемещения оба короба должны быть открыты.");
    check(from.version === p.version, "Состав исходного короба изменился. Обновите список.");
    check(from.market === to.market && from.store === to.store, "Перемещение возможно только внутри одного магазина и маркетплейса.");
    const quantity = p.qty === undefined ? item.qty : p.qty;
    check(typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity>0 && quantity<=item.qty,"Укажите целое количество от 1 до доступного остатка.");
    const changes:Statement[]=[];let movedId=item.id;
    if(quantity===item.qty)changes.push(q("update av2_warehouse_receipts set carton_id=? where id=?",to.id,item.id));
    else {
      movedId=crypto.randomUUID();
      const [root]=await store.all<{rootId:string}>(`select ${receiptRoot()} root_id from av2_warehouse_receipts r where r.id=?`,[item.id]);
      const [work]=await store.all<{id:string;qty:number}>(`select w.id,${warehouseWorkQty()} qty from av2_warehouse_work w join av2_warehouse_receipts r on r.id=w.receipt_id where w.receipt_id=?`,[root.rootId]);
      if(work)changes.push(q('insert or ignore into av2_quality_repairs(id,kind,entity_id,"before","after",evidence,actor,created_at) values(?,?,?,?,?,?,?,?)',crypto.randomUUID(),"warehouse.split.work",work.id,JSON.stringify(work),JSON.stringify({qty:work.qty}),"Сохранение исходного количества работы при разделении",actor,now));
      changes.push(q('insert into av2_quality_repairs(id,kind,entity_id,"before","after",evidence,actor,created_at) values(?,?,?,?,?,?,?,?)',crypto.randomUUID(),"warehouse.split.receipt",movedId,JSON.stringify(item),JSON.stringify({rootReceiptId:root.rootId,qty:quantity}),JSON.stringify({from:from.id,to:to.id}),actor,now));
      changes.push(q("update av2_warehouse_receipts set qty=qty-? where id=?",quantity,item.id));
      changes.push(q("insert into av2_warehouse_receipts(id,carton_id,position_id,sku,name,search,qty,catalog_import_id,photo_id,employee_id,employee,supply,comment,actor,created_at) select ?,?,position_id,sku,name,search,?,catalog_import_id,photo_id,employee_id,employee,supply,comment,actor,created_at from av2_warehouse_receipts where id=?",movedId,to.id,quantity,item.id));
    }
    return {statements:[...changes,
      q("update av2_warehouse_cartons set version=version+1 where id in (?,?)",from.id,to.id),
    ],result:{warehouseReceiptId:movedId,fromCartonId:from.id,warehouseCartonId:to.id,qty:quantity}};
  }
  let market = str(p.market),
    shop = str(p.store),
    source = "",
    positionId: string | null = null,
    importId: string | null = null,
    photoId: string | null = null,
    sku = "",
    name = "",
    qty = 0;
  if (action === "warehouse.remove") {
    const reason = str(p.reason, 500);
    check(reason.length >= 3, "Укажите причину удаления.");
    const row = await one<{ id: string; cartonId: string; positionId: string | null; qty: number; voidedAt: string | null; state: string; version: number; workId: string | null }>(
      "select r.id,r.carton_id,r.position_id,r.qty,r.voided_at,c.state,c.version,w.id work_id from av2_warehouse_receipts r join av2_warehouse_cartons c on c.id=r.carton_id left join av2_warehouse_work w on w.receipt_id=r.id where r.id=? and c.id=?",
      [str(p.receiptId), str(p.cartonId)], "Складская запись не найдена.");
    check(!row.voidedAt, "Запись уже удалена из короба.");
    check(row.state === "open", "Сначала откройте складской короб для исправления.");
    check(row.version === p.version, "Состав складского короба изменился. Обновите список и проверьте запись.");
    const [linked] = await store.all<{workId:string}>(`select w.id work_id from av2_warehouse_receipts r join av2_warehouse_work w on w.receipt_id=${receiptRoot()} where r.id=? and exists(select 1 from av2_quality_repairs q where q.kind='warehouse.split.work' and q.entity_id=w.id)`,[row.id]);
    check(!linked,"Товар разделён между коробами. Для отмены исходной упаковки используйте «История работы в запас» — будут убраны все её части и отменён кэф один раз.");
    if (row.workId) {
      const cancellation = await cancelWarehouseWorkPlan(store, row.workId, reason, actor, now);
      check(cancellation, "Связанная упаковка не найдена.");
      return cancellation;
    }
    sql.push(q("update av2_warehouse_receipts set voided_at=?,void_reason=? where id=?", now, reason, row.id),
      q("update av2_warehouse_cartons set version=version+1 where id=?", row.cartonId));
    if (row.positionId) {
      const totals = await one<{ boxed: number }>("select boxed from av2_position_totals where position_id=?", [row.positionId], "Итоги позиции не найдены.");
      check(totals.boxed >= row.qty, "Остатки изменились. Обновите список.");
      sql.push(q("update av2_position_totals set boxed=boxed-? where position_id=?", row.qty, row.positionId));
    }
    return { statements: sql, result: { warehouseReceiptId: row.id, warehouseCartonId: row.cartonId, removed: true } };
  }
  if (action === "warehouse.reopen") {
    const box = await one<WarehouseCarton>("select * from av2_warehouse_cartons where id=?", [str(p.cartonId)], "Складской короб не найден.");
    check(box.state === "closed" && box.version === p.version, "Статус складского короба изменился. Обновите список.");
    return { statements: [q("update av2_warehouse_cartons set state='open',closed_at=null,version=version+1 where id=?", box.id)], result: { warehouseCartonId: box.id, reopened: true } };
  }
  if (action === "warehouse.close") {
    const box = await one<WarehouseCarton>(
      "select * from av2_warehouse_cartons where id=?",
      [str(p.cartonId)],
      "Складской короб не найден.",
    );
    check(
      box.state === "open" && box.version === p.version,
      "Состав складского короба изменился. Обновите его перед закрытием.",
    );
    check(
      (
        await store.all<{ n: number }>(
          "select count(*) n from av2_warehouse_receipts where carton_id=? and voided_at is null",
          [box.id],
        )
      )[0].n > 0,
      "Пустой короб закрыть нельзя.",
    );
    sql.push(
      q(
        "update av2_warehouse_cartons set state='closed',closed_at=?,version=version+1 where id=?",
        now,
        box.id,
      ),
    );
    return { statements: sql, result: { warehouseCartonId: box.id } };
  }
  let employee: { id: string; name: string } | null = null;
  let packingWork: { norm: number | null; coefficient: number | null; productType: string } | null = null;
  if (action === "warehouse.receive" || action === "warehouse.transfer") {
    check(
      typeof p.qty === "number" &&
        Number.isSafeInteger(p.qty) &&
        p.qty > 0 &&
        p.qty <= 2147483647,
      "Введите положительное целое количество.",
    );
    qty = p.qty;
    employee = await one(
      "select id,name from av2_employees where id=? and active=1",
      [str(p.employeeId)],
      "Выберите действующего сотрудника.",
    );
    if (action === "warehouse.receive") {
      check((market === "OZON" || market === "WB") && /^[1-9]\d{0,5}$/.test(shop), "Подтвердите маркетплейс и номер магазина.");
      const receiptMode = p.receiptMode ?? "receipt";
      check(receiptMode === "packing" || receiptMode === "receipt", "Выберите новую упаковку или приём готового остатка.");
      const row = await one<{ importId: string; data: string }>(
        `select e.import_id,${effectiveCatalogData()} data from av2_resolved_catalog_entries e where e.import_id=(select active_catalog_id from av2_meta where id=1) and e.entry_id=?`,
        [str(p.entryId, 1500)],
        "Выберите товар из действующего справочника.",
      );
      check(
        row.importId === p.catalogImportId,
        "Справочник изменился. Найдите товар заново.",
      );
      const entry = JSON.parse(row.data) as CatalogEntry;
      check(
        entry.market === market && entry.store === shop,
        "Магазин или маркетплейс карточки не совпадает.",
      );
      sku = entry.sku;
      name = entry.name || sku;
      importId = row.importId;
      photoId = entry.photoId;
      source = "Ручное поступление на склад";
      if (receiptMode === "packing") {
        const operation = p.operation ?? "packing";
        check(operation === "packing" || operation === "assembly" || operation === "cut", "Выберите операцию.");
        const norms = (await store.all<{ data: string }>("select data from av2_shift_norms")).map(n => JSON.parse(n.data) as ShiftNorm);
        const effective = effectiveWorkNorms(entry as unknown as Record<string, unknown>, norms);
        if (operation !== "packing") {
          const workId = crypto.randomUUID(), norm = effective[operation], coefficient = savedCoefficient(effective, operation, qty);
          check(typeof p.comment !== "string" || p.comment.length <= 500, "Комментарий длиннее 500 символов.");
          return {statements: [
            q("insert into av2_stock_cut_work(id,sku,name,market,store,employee_id,employee,operation,qty,catalog_import_id,product_type,norm,coefficient,created_at,actor) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              workId, sku, name, market, shop, employee!.id, employee!.name, operation, qty, importId, entry.kind || "", norm === null ? null : String(norm), coefficient === null ? null : String(coefficient), now, actor),
            q("update av2_stock_cut_work set comment=? where id=?", typeof p.comment === "string" ? p.comment.trim() : "", workId),
            enqueueStockCutWork(workId, now),
          ], result: {workId, operation, qty}};
        }
        packingWork = { norm: effective.packing, coefficient: savedCoefficient(effective, "packing", qty), productType: entry.kind || "" };
        source = "Новая упаковка на склад";
      }
    } else {
      const row = await one<{
        market: string;
        store: string;
        title: string;
        sku: string;
        name: string;
        catalogImportId: string | null;
        photoId: string | null;
        ready: number;
        sourceActive: number;
        plan: number;
        packing: number;
        boxed: number;
        assigned: number;
      }>(
        `select s.market,s.store,s.title,p.sku,p.name,p.catalog_import_id,json_extract(e.data,'$.photoId') photo_id,p.ready,p.source_active,p.plan,coalesce(t.packing,0) packing,coalesce(t.boxed,0) boxed,(select coalesce(sum(a.qty),0) from av2_all_allocations a where a.position_id=p.id and a.removed_at is null) assigned from av2_positions p join av2_supplies s on s.id=p.supply_id left join av2_position_totals t on t.position_id=p.id left join av2_resolved_catalog_entries e on e.import_id=p.catalog_import_id and e.entry_id=p.catalog_entry_id where p.id=?`,
        [str(p.positionId)],
        "Позиция не найдена.",
      );
      check(
        row.ready && row.sourceActive,
        "Поставка недоступна для размещения.",
      );
      check(
        qty <=
          Math.max(
            0,
            row.packing - row.boxed - Math.max(0, row.plan - row.assigned),
          ),
        "На склад можно переместить только свободный излишек сверх плана.",
      );
      market = row.market;
      shop = row.store;
      source = row.title;
      sku = row.sku;
      name = row.name;
      importId = row.catalogImportId;
      photoId = row.photoId;
      positionId = str(p.positionId);
    }
  }
  check(
    (market === "OZON" || market === "WB") && /^[1-9]\d{0,5}$/.test(shop),
    "Подтвердите маркетплейс и номер магазина.",
  );
  let box = (
    await store.all<WarehouseCarton>(
      "select * from av2_warehouse_cartons where market=? and store=? and state='open' order by length(label) desc,label desc limit 1",
      [market, shop],
    )
  )[0];
  const selected = str(p.warehouseCartonId);
  if (selected) {
    box = await one<WarehouseCarton>("select * from av2_warehouse_cartons where id=?",[selected],"Выбранный складской короб не найден.");
    check(box.state === "open" && box.market === market && box.store === shop, "Выберите открытый короб нужного магазина и маркетплейса.");
  }
  if (action === "warehouse.create" || p.newWarehouseCarton === true || !box) {
    const labels = await store.all<{ label: string }>(
      "select label from av2_warehouse_cartons union select label from av2_carton_number_reservations union select label from av2_cartons",
    );
    const prefix = shop + "скл";
    const max = labels.reduce(
      (n, r) =>
        r.label.toLocaleLowerCase("ru").startsWith(prefix) &&
        /^\d+$/.test(r.label.slice(prefix.length))
          ? Math.max(n, Number(r.label.slice(prefix.length)))
          : n,
      0,
    );
    check(
      Number.isSafeInteger(max) && max < 2147483647,
      "Не удалось определить следующий номер складского короба.",
    );
    const id = crypto.randomUUID();
    box = {
      id,
      label: prefix + (max + 1),
      market: market as "WB" | "OZON",
      store: shop,
      state: "open",
      version: 0,
      createdAt: now,
      closedAt: null,
      current: true,
      qty: 0,
      itemCount: 0,
      items: [],
    };
    sql.push(
      q(
        "insert into av2_warehouse_cartons(id,label,market,store,state,version,created_at) values(?,?,?,?,'open',0,?)",
        id,
        box.label,
        market,
        shop,
        now,
      ),
    );
  }
  if (employee) {
    check(
      p.comment === undefined ||
        (typeof p.comment === "string" && p.comment.length <= 500),
      "Комментарий длиннее 500 символов.",
    );
    const comment = typeof p.comment === "string" ? p.comment.trim() : "";
    const receiptId = crypto.randomUUID();
    sql.push(
      q(
        "insert into av2_warehouse_receipts(id,carton_id,position_id,sku,name,search,qty,catalog_import_id,photo_id,employee_id,employee,supply,comment,actor,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        receiptId,
        box.id,
        positionId,
        sku,
        name,
        catalogKey([sku, name, source].join(" ")),
        qty,
        importId,
        photoId,
        employee.id,
        employee.name,
        source,
        comment,
        actor,
        now,
      ),
      q(
        "update av2_warehouse_cartons set version=version+1 where id=?",
        box.id,
      ),
    );
    if (positionId)
      sql.push(
        q(
          "update av2_position_totals set boxed=boxed+? where position_id=?",
          qty,
          positionId,
        ),
      );
    if (packingWork) {
      const workId = crypto.randomUUID();
      sql.push(q("insert into av2_warehouse_work(id,receipt_id,product_type,norm,coefficient,created_at,actor) values(?,?,?,?,?,?,?)",
        workId, receiptId, packingWork.productType, packingWork.norm === null ? null : String(packingWork.norm), packingWork.coefficient === null ? null : String(packingWork.coefficient), now, actor), enqueueWarehouseWork(workId, now));
    }
  }
  return {
    statements: sql,
    result: { warehouseCartonId: box.id, label: box.label },
  };
}
