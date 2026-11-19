import type { SqlStore, Statement } from "./database";
import type { CatalogEntry } from "../shared/catalog";
import { catalogKey, digest, cleanCatalogText, duplicateCapacity } from "../shared/catalog";
import { effectiveWorkNorms, type ShiftNorm } from "../shared/work-norm";
import { catalogEntryWithStore, catalogSourceStoreUpdates, requireCatalog as check, effectiveCatalogData } from "./catalog-store";
import { enqueueCancellation, enqueueNormRepair } from "./ritm-outbox";
import { ritmShipmentId } from "../shared/ritm";

const q = (sql: string, ...args: (string | number | null)[]): Statement => ({ sql, args });
const string = (value: unknown, max = 500): string => {
  check(typeof value === "string" && value.trim().length > 0 && value.length <= max, "Не подтверждены данные исправления.");
  return value.trim();
};
type WorkRow = {
  id: string; supplyId: string; positionId: string; employeeId: string;
  employeeName: string; operation: "cut" | "assembly" | "packing";
  qty: number; norm: string | null; coefficient: string | null; createdAt: string;
  legacyEventId: string | null; sku: string; externalId: string;
  market: "OZON" | "WB"; shop: string; originShipmentId: string | null;
  catalogImportId: string | null; catalogEntryId: string | null;
};

export async function qualityPlan(
  store: SqlStore, action: string, payload: Record<string, unknown>, actor: string, now: string,
): Promise<{ statements: Statement[]; result: Record<string, unknown> }> {
  const statements: Statement[] = [];
  const one = async <T>(sql: string, args: (string | number | null)[], message: string): Promise<T> => {
    const row = (await store.all<T>(sql, args))[0]; check(row, message); return row;
  };
  const reason = string(payload.reason, 1000);
  const audit = (kind: string, entity: string, before: unknown, after: unknown, evidence: unknown) => {
    const id = crypto.randomUUID();
    statements.push(q("insert into av2_quality_repairs(id,kind,entity_id,\"before\",\"after\",evidence,actor,created_at) values(?,?,?,?,?,?,?,?)",
      id, kind, entity, JSON.stringify(before), JSON.stringify(after), JSON.stringify({ reason, evidence }), actor, now));
    return id;
  };
  if (action === "quality.assignCatalogStore") {
    const importId=string(payload.importId),entryId=string(payload.entryId),shop=string(payload.store,100);
    check(shop==='1'||shop==='2','Подтвердите магазин 1 или 2.');
    const active=await one<{id:string}>('select active_catalog_id id from av2_meta where id=1',[],'Справочник не подключён.');
    check(active.id===importId,'Справочник изменился. Повторите проверку.');
    const row=await one<{data:string}>("select data from av2_catalog_entries where import_id=? and entry_id=? and store=''",[importId,entryId],'Карточка без магазина не найдена.');
    const before=JSON.parse(row.data) as CatalogEntry;
    check(before.store===''&&await digest(JSON.stringify(before.rows))===payload.sourceRowsDigest,'Исходная карточка изменилась.');
    check(!(await store.all('select entry_id from av2_catalog_products where entry_id=?',[entryId])).length,'Карточка уже отредактирована. Сначала сверите изменения.');
    const after=catalogEntryWithStore(before,shop);
    check(!(await store.all('select entry_id from av2_resolved_catalog_entries where import_id=? and entry_id=?',[importId,after.id])).length,'Карточка этого магазина уже существует. Откройте её для сверки.');
    check(!(await store.all(`select alias from av2_resolved_catalog_aliases where import_id=? and market=? and store=? and alias in(select value from json_each(?)) limit 1`,[importId,before.market,shop,JSON.stringify(before.aliases)])).length,'В магазине уже есть связанный артикул. Нужна сверка.');
    const positions=await store.all<{id:string;shop:string;market:string}>(`select p.id,s.store shop,s.market from av2_positions p join av2_supplies s on s.id=p.supply_id where p.catalog_import_id=? and p.catalog_entry_id=?`,[importId,entryId]);
    check(positions.every(p=>p.shop===shop && p.market===before.market),'Карточка связана с другим магазином или маркетплейсом в поставке. Нужна сверка.');
    audit('catalog.assignStore',importId+':'+entryId,{entry:before,positions},after,{confirmedStore:shop,sourceRowsDigest:payload.sourceRowsDigest});
    statements.push(...catalogSourceStoreUpdates(importId,entryId,after));
    return {statements,result:{entryId:after.id,previousEntryId:entryId,store:shop,updatedPositions:positions.length}};
  }
  if (action === "quality.repairEmptyCapacityDuplicates") {
    const [active] = await store.all<{id:string}>("select active_catalog_id id from av2_meta where id=1");
    check(active?.id === payload.importId, "Справочник изменился. Повторите проверку.");
    const entries = await store.all<{id:string;data:string}>("select id,data from av2_resolved_catalog_entries where import_id=? and json_extract(data,'$.unitsPerBox') is null and json_array_length(data,'$.rows')>1",[active.id]);
    const [count] = await store.all<{n:number}>("select count(*) n from av2_resolved_catalog_entries where import_id=?",[active.id]);
    const repaired:unknown[]=[];const unresolved:string[]=[];
    for (const row of entries) {
      const e=JSON.parse(row.data) as CatalogEntry, resolved=duplicateCapacity(e.rows,e.market);
      if (!resolved.value) {unresolved.push(e.sku);continue;}
      const positions=await store.all<{id:string;unitsPerBox:number|null}>("select id,units_per_box from av2_positions where catalog_import_id=? and catalog_entry_id=? and units_per_box is null",[active.id,e.id]);
      const ids=JSON.stringify(positions.map(p=>p.id));
      const allocations=await store.all("select a.* from av2_all_allocations a join av2_cartons c on c.id=a.carton_id where a.position_id in(select value from json_each(?)) and a.units_per_box is null and a.removed_at is null and c.dispatch_id is null",[ids]);
      const after={...e,unitsPerBox:resolved.value,capacitySource:resolved.source,issues:e.issues.filter(i=>i!=="Вместимость короба требует проверки")};
      repaired.push({id:e.id,sku:e.sku,unitsPerBox:resolved.value,positions:positions.length,allocations:allocations.length});
      if (payload.apply === true) {
        audit("catalog.emptyCapacityDuplicates",active.id+":"+e.id,{entry:e,positions,allocations},after,e.rows);
        for(const table of ["av2_catalog_entries","av2_catalog_references"])statements.push(q(`update ${table} set data=?,review=? where id=?`,JSON.stringify(after),after.issues.length?1:0,row.id));
        statements.push(q("update av2_positions set units_per_box=? where id in(select value from json_each(?)) and units_per_box is null",resolved.value,ids));
        for(const table of ["av2_allocations","av2_legacy_allocations"])statements.push(q(`update ${table} set units_per_box=? where position_id in(select value from json_each(?)) and units_per_box is null and removed_at is null and carton_id in(select id from av2_cartons where dispatch_id is null)`,resolved.value,ids));
      }
    }
    return {statements,result:{scanned:count.n,duplicateUnknown:entries.length,repaired,unresolved,applied:payload.apply===true}};
  }
  const work = async (id: unknown): Promise<WorkRow> => {
    const row = await one<WorkRow>(
      `select w.*,p.sku,p.external_id,p.catalog_import_id,p.catalog_entry_id,s.market,s.store shop,s.origin_shipment_id
       from av2_work w join av2_positions p on p.id=w.position_id join av2_supplies s on s.id=w.supply_id
       where w.id=? and s.is_demo=0`, [string(id)], "Рабочая запись не найдена.");
    check(!(await store.all("select id from av2_corrections where work_id=?", [row.id])).length, "Запись уже исключена или отменена.");
    check(row.coefficient === null, "У записи уже сохранён коэффициент. Изменение остановлено.");
    return row;
  };

  if (action === "quality.resolveStores") {
    check(Array.isArray(payload.positions) && payload.positions.length > 0 && payload.positions.length <= 20, "Выберите от 1 до 20 позиций.");
    const seen = new Set<string>(), references = new Map<string, CatalogEntry>();
    const resolvedByShipment = new Map<string,Set<string>>();
    for (const input of payload.positions as Record<string, unknown>[]) {
      const positionId = string(input.positionId); check(!seen.has(positionId), "Позиция повторяется."); seen.add(positionId);
      const before = await one<{
        id: string; supplyId: string; externalId: string; sku: string; name: string; barcode: string;
        unitsPerBox: number | null; catalogImportId: string | null; catalogEntryId: string | null;
        market: string; shop: string; destination: string; originShipmentId: string; ready: number; sourceActive: number;
      }>(`select p.*,s.market,s.store shop,s.destination,s.origin_shipment_id from av2_positions p join av2_supplies s on s.id=p.supply_id where p.id=?`, [positionId], "Позиция не найдена.");
      check(before.externalId === input.externalId && before.market === "OZON" && !/^[1-9]\d*$/.test(before.shop) && ritmShipmentId(before.originShipmentId), "Исходная привязка позиции изменилась.");
      const activity = await one<{ n: number }>(`select
        (select count(*) from av2_work where position_id=?)+(select count(*) from av2_all_allocations where position_id=?)+(select count(*) from av2_warehouse_receipts where position_id=?) n`, [positionId,positionId,positionId], "Не удалось проверить историю.");
      check(activity.n === 0, "У позиции уже есть работа или вложения; требуется отдельная сверка истории.");
      const source = await one<{ data: string; importId: string; entryId: string }>(
        "select data,import_id,entry_id from av2_catalog_entries where import_id=(select active_catalog_id from av2_meta where id=1) and entry_id=? and market='WB'", [string(input.sourceEntryId)], "Исходная строка справочника не найдена.");
      const base = JSON.parse(source.data) as CatalogEntry;
      check(await digest(JSON.stringify(base)) === input.sourceDigest && base.aliases.includes(catalogKey(before.sku)), "Исходная карточка изменилась.");
      const targets = base.rows.map(row => ({
        sku: cleanCatalogText(row.raw.alias || ""), barcode: cleanCatalogText(row.raw.ozonBarcode || ""), shop: cleanCatalogText(row.raw.store || ""),
      }));
      const target = targets[0];
      check(target && targets.every(t => JSON.stringify(t) === JSON.stringify(target)) &&
        target.sku === catalogKey(target.sku) && /\(OZ\)$/.test(target.sku) && /^OZN\d+$/.test(target.barcode) &&
        /^[1-9]\d*$/.test(target.shop) && target.shop === base.store && base.market === "WB", "Нет однозначных явных OZON-артикула, штрихкода и магазина.");
      check(!(await store.all(`select 1 from av2_catalog_aliases where import_id=? and market='OZON' and alias in (?,?) limit 1`, [source.importId,catalogKey(before.sku),target.sku])).length, "Для артикула уже есть собственные данные OZON. Используйте их.");
      const entryId = JSON.stringify(["OZON",target.shop,target.sku]);
      const entry: CatalogEntry = { ...base, id: entryId, market: "OZON", store: target.shop, sku: target.sku,
        barcode: target.barcode, aliases: [...new Set([catalogKey(before.sku),target.sku])] };
      if (!references.has(entryId)) {
        check(!(await store.all("select id from av2_catalog_references where import_id=? and entry_id=?", [source.importId,entryId])).length, "Связка уже сохранена; обновите план исправления.");
        const evidence = { sourceImportId: source.importId, sourceEntryId: base.id, sourceDigest: input.sourceDigest,
          fields: base.rows.map(row => ({ sheet: row.sheet, row: row.row, refs: row.refs, ozonArticle: row.raw.alias, ozonBarcode: row.raw.ozonBarcode, shop: row.raw.store })) };
        statements.push(q(`insert into av2_catalog_references(id,import_id,entry_id,source_entry_id,market,store,sku,search,machine,review,data,evidence,actor,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          JSON.stringify([source.importId,"reference",entryId]),source.importId,entryId,base.id,"OZON",target.shop,target.sku,
          catalogKey([target.sku,before.sku,entry.name].join(" ")),entry.machine,entry.issues.length?1:0,JSON.stringify(entry),JSON.stringify(evidence),actor,now));
        references.set(entryId,entry);
      }
      const group = await one<{ id: string }>(`select id from av2_supplies where origin_shipment_id=? and market='OZON' and store=? and destination=? and is_demo=0`, [before.originShipmentId,target.shop,before.destination], "Подтверждённое направление этого магазина не найдено.");
      check(!(await store.all("select id from av2_positions where supply_id=? and external_id=? and id<>?", [group.id,before.externalId,positionId])).length, "Исходная позиция уже есть в другом направлении.");
      const after = { supplyId: group.id, store: target.shop, catalogImportId: source.importId, catalogEntryId: entryId, barcode: target.barcode, unitsPerBox: before.unitsPerBox ?? entry.unitsPerBox };
      audit("position.store", positionId, before, after, { sourceEntryId: base.id, sourceDigest: input.sourceDigest });
      statements.push(q(`update av2_positions set supply_id=?,catalog_import_id=?,catalog_entry_id=?,barcode=?,units_per_box=?,name=? where id=?`,
        group.id,source.importId,entryId,target.barcode,after.unitsPerBox,before.name===before.sku?entry.name:before.name,positionId));
      statements.push(q("update av2_supplies set source_active=0 where id=? and not exists(select 1 from av2_positions where supply_id=?)", before.supplyId,before.supplyId));
      const resolved=resolvedByShipment.get(before.originShipmentId) || new Set<string>();
      resolved.add(before.sku);resolvedByShipment.set(before.originShipmentId,resolved);
    }
    // Only remove the precise derived warnings just repaired. Keep the original
    // source fingerprint/revision/lock; an unchanged feed is still unchanged.
    for (const [shipmentId,skus] of resolvedByShipment) {
      const link=(await store.all<{issues:string}>("select issues from av2_ritm_links where shipment_id=?",[shipmentId]))[0];
      if(link){const issues=JSON.parse(link.issues) as {message:string}[];
        const remaining=issues.filter(issue=>![...skus].some(sku=>issue.message.startsWith(sku+": магазин не подтверждён.")));
        statements.push(q("update av2_ritm_links set issues=? where shipment_id=?",JSON.stringify(remaining),shipmentId));
      }
    }
    return { statements, result: { repaired: seen.size, references: references.size } };
  }

  if (action === "quality.repairNorms") {
    check(Array.isArray(payload.workIds) && payload.workIds.length > 0 && payload.workIds.length <= 50, "Выберите от 1 до 50 записей.");
    const shifts = await store.all<{ data: string; sourceHash: string }>("select data,source_hash from av2_shift_norms");
    const norms = shifts.map(s => JSON.parse(s.data) as ShiftNorm);
    const seen = new Set<string>();
    for (const id of payload.workIds) {
      const row = await work(id); check(!seen.has(row.id), "Запись повторяется."); seen.add(row.id);
      const entries = await store.all<{ data: string; importId: string; entryId: string }>(row.catalogEntryId && row.catalogImportId ?
        `select ${effectiveCatalogData()} data,e.import_id,e.entry_id from av2_resolved_catalog_entries e where e.import_id=? and e.entry_id=?` :
        `select distinct ${effectiveCatalogData()} data,e.import_id,e.entry_id from av2_resolved_catalog_aliases a join av2_resolved_catalog_entries e on e.import_id=a.import_id and e.entry_id=a.entry_id where a.import_id=(select active_catalog_id from av2_meta where id=1) and a.market=? and a.alias=?`,
        row.catalogEntryId && row.catalogImportId ? [row.catalogImportId,row.catalogEntryId] : [row.market,catalogKey(row.sku)]);
      check(entries.length > 0, `${row.sku}: не найдена подтверждённая карточка своей площадки.`);
      const candidates = entries.map(e => ({ ...e, entry: JSON.parse(e.data) as CatalogEntry }));
      check(candidates.every(c => c.entry.market===row.market), "Карточка другой площадки не является основанием нормы.");
      const values = candidates.map(c => effectiveWorkNorms(c.entry as unknown as Record<string,unknown>,norms)[row.operation]);
      const saved = row.norm===null ? null : Number(row.norm);
      const norm = saved ?? values[0];
      check(norm && Number.isFinite(norm) && norm>0 && (saved!==null || values.every(n=>n===norm)), `${row.sku}: нет однозначной нормы этой операции.`);
      const coefficient = row.qty/norm;
      check(Number.isFinite(coefficient) && coefficient>0, "Не удалось проверить коэффициент.");
      const repairId = audit("work.norm",row.id,row,{norm:String(norm),coefficient:String(coefficient)},
        { catalog: candidates.map(c=>({importId:c.importId,entryId:c.entryId,kind:c.entry.kind,sheetsPerUnit:c.entry.sheetsPerUnit,rows:c.entry.rows})), shifts, savedNormUsed:saved!==null });
      statements.push(q("update av2_work set norm=?,coefficient=? where id=? and coefficient is null",String(norm),String(coefficient),row.id));
      statements.push(enqueueNormRepair(row.id,repairId,now,candidates[0].entry.kind));
    }
    return { statements, result: { repaired: seen.size } };
  }

  if (action === "quality.archiveDemo") {
    const supply = await one<{ id: string; externalId: string; originShipmentId: string | null; market: string; store: string; destination: string }>("select * from av2_supplies where id=?", [string(payload.supplyId)], "Поставка не найдена.");
    const positions = await store.all<{ id: string; externalId: string; sku: string; ready: number; sourceActive: number }>("select * from av2_positions where supply_id=?", [supply.id]);
    check(/^TEST-/.test(supply.externalId) && !supply.originShipmentId && positions.length>0 && positions.every(p=>p.externalId.startsWith(supply.externalId+"|") && /^ДЕМО-\d+$/.test(p.sku)), "Поставка не подтверждена как демонстрационная.");
    check(!(await store.all(`select a.id from av2_all_allocations a join av2_positions p on p.id=a.position_id join av2_cartons c on c.id=a.carton_id where c.market=? and c.store=? and c.destination=? and p.supply_id<>? and a.removed_at is null`,[supply.market,supply.store,supply.destination,supply.id])).length, "В направлении есть рабочий товар.");
    audit("supply.demo",supply.id,{supply,positions},{isDemo:true},{externalId:supply.externalId});
    statements.push(q("update av2_supplies set is_demo=1,source_active=0 where id=?",supply.id));
    statements.push(q("update av2_positions set source_active=0,ready=0 where supply_id=?",supply.id));
    return { statements, result: { supplyId:supply.id,archived:true } };
  }

  if (action === "quality.excludeWork") {
    check(payload.classification==="test" || payload.classification==="unconfirmed", "Укажите причину исключения.");
    const row = await work(payload.workId);
    check(row.qty===payload.expectedQty && row.employeeId===payload.employeeId && row.positionId===payload.positionId, "Данные записи изменились.");
    const totals = await one<{cut:number;assembly:number;packing:number;boxed:number}>("select * from av2_position_totals where position_id=?",[row.positionId],"Итоги не найдены.");
    const team = await one<{cut:number;assembly:number;packing:number}>("select * from av2_team_totals where position_id=? and employee_id=?",[row.positionId,row.employeeId],"Вклад сотрудника не найден.");
    check(totals[row.operation]>=row.qty && team[row.operation]>=row.qty, "Журнал и итоги расходятся; автоматическое исключение остановлено.");
    const allocations = row.operation==="packing" ? await store.all<{id:string;cartonId:string;qty:number;legacy:number;state:string;dispatchId:string|null}>(`select a.id,a.carton_id,a.qty,a.legacy,c.state,c.dispatch_id from av2_all_allocations a join av2_cartons c on c.id=a.carton_id where a.position_id=? and a.removed_at is null`,[row.positionId]) : [];
    if (row.operation==="packing") {
      check(totals.packing===row.qty && allocations.every(a=>!a.legacy && a.state==="open" && !a.dispatchId) && allocations.reduce((n,a)=>n+a.qty,0)===totals.boxed, "У пробной упаковки есть другие записи, закрытые короба или складские размещения. Нужна отдельная сверка.");
    }
    const repairId = audit("work.exclude",row.id,{work:row,allocations},{classification:payload.classification,excluded:true},{ownerDecision:reason});
    const correctionId = crypto.randomUUID();
    statements.push(q("insert into av2_corrections(id,work_id,reason,actor,created_at) values(?,?,?,?,?)",correctionId,row.id,reason,actor,now));
    const checkedCartons = new Set<string>();
    for (const a of allocations) {
      statements.push(q("update av2_allocations set removed_at=?,removal_reason=? where id=?",now,reason,a.id));
      const other = await store.all<{ n:number }>("select count(*) n from av2_all_allocations where carton_id=? and position_id<>? and removed_at is null",[a.cartonId,row.positionId]);
      if (!other[0].n && !checkedCartons.has(a.cartonId)) audit("carton.test",a.cartonId,{allocations:allocations.filter(x=>x.cartonId===a.cartonId)},{excluded:true},{workId:row.id,repairId});
      checkedCartons.add(a.cartonId);
    }
    const boxed = allocations.reduce((n,a)=>n+a.qty,0);
    statements.push(q(`update av2_position_totals set ${row.operation}=${row.operation}-?,boxed=boxed-? where position_id=?`,row.qty,boxed,row.positionId));
    statements.push(q(`update av2_team_totals set ${row.operation}=${row.operation}-? where position_id=? and employee_id=?`,row.qty,row.positionId,row.employeeId));
    statements.push(enqueueCancellation(row.id,correctionId,now));
    return { statements, result: { workId:row.id,excluded:true,classification:payload.classification,removedAllocations:allocations.length } };
  }
  throw new Error("Неизвестное исправление данных.");
}
