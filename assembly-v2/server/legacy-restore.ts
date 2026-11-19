import type { SqlStore, Statement } from "./database";
import { requireCatalog as check } from "./catalog-store";
import { digest } from "../shared/catalog";
import { workTypeKey } from "../shared/work-norm";
const q = (sql: string, ...args: (string | number | null)[]): Statement => ({
  sql,
  args,
});
const text = (v: unknown, max = 2000) =>
  typeof v === "string" && v.length <= max ? v : "";
const qty = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 2147483647;
export async function legacyRestorePlan(
  store: SqlStore,
  p: Record<string, unknown>,
  actor: string,
  now: string,
) {
  check(
    p.sourceWorkbookId === "1dn7a7s-Ev9vLuNE2W8lECVwXCdpq8DXvC5Gt_O1sBbI" &&
      /^[a-f0-9]{64}$/.test(text(p.sourceHash)),
    "Источник восстановления не подтверждён.",
  );
  check(
    typeof p.kind === "string" && Array.isArray(p.rows) && p.rows.length <= 100,
    "Некорректный пакет восстановления.",
  );
  const sql: Statement[] = [],
    affected = new Set<string>();
  let accepted = 0;
  const one = async <T>(
    query: string,
    args: (string | number | null)[],
    message: string,
  ) => {
    const row = (await store.all<T>(query, args))[0];
    check(row, message);
    return row;
  };
  for (const raw of p.rows as Record<string, unknown>[]) {
    check(
      raw && typeof raw === "object" && text(raw.sourceId),
      "Не указан исходный ID.",
    );
    const sourceId = text(raw.sourceId),
      hash = await digest(JSON.stringify(raw));
    const prior = (
      await store.all<{ hash: string }>(
        "select hash from av2_legacy_records where kind=? and source_id=?",
        [p.kind, sourceId],
      )
    )[0];
    if (prior?.hash === hash) continue;
    check(
      !prior || !["work", "corrections"].includes(p.kind),
      "Историческая запись изменилась. Автоматическое изменение остановлено.",
    );
    if (p.kind === "norms") {
      check(
        text(raw.type) &&
          ["cut", "assembly", "packing"].every(
            (k) =>
              raw[k] === null ||
              (typeof raw[k] === "number" &&
                Number.isFinite(raw[k]) &&
                Number(raw[k]) > 0),
          ),
        "Не подтверждены нормы за смену.",
      );
      sql.push(
        q(
          "insert into av2_shift_norms(type_key,data,source_hash,captured_at) values(?,?,?,?) on conflict(type_key) do update set data=excluded.data,source_hash=excluded.source_hash,captured_at=excluded.captured_at",
          workTypeKey(String(raw.type)),
          JSON.stringify(raw),
          String(p.sourceHash),
          now,
        ),
      );
    } else if (p.kind === "positions") {
      const s = raw.supply as Record<string, unknown>;
      check(
        s &&
          text(s.id) &&
          text(s.title) &&
          ["OZON", "WB"].includes(String(s.market)) &&
          text(s.store) &&
          text(s.destination),
        "Не подтверждена историческая поставка.",
      );
      check(
        text(raw.id) &&
          text(raw.externalId) &&
          text(raw.sku) &&
          text(raw.name) &&
          qty(raw.plan),
        "Не подтверждена историческая позиция.",
      );
      check(
        !(
          await store.all(
            "select id from av2_positions where id=? or external_id=?",
            [String(raw.id), String(raw.externalId)],
          )
        ).length,
        "Историческая позиция уже связана с другим ID.",
      );
      sql.push(
        q(
          `insert into av2_supplies(id,external_id,title,market,store,destination,source_version,source_payload,created_at,origin_shipment_id,source_active) values(?,?,?,?,?,?,1,'{}',?,null,0) on conflict(id) do nothing`,
          String(s.id),
          String(s.id),
          String(s.title),
          String(s.market),
          String(s.store),
          String(s.destination),
          now,
        ),
      );
      sql.push(
        q(
          `insert into av2_positions(id,supply_id,external_id,sku,name,barcode,department,plan,units_per_box,ready,cut_operation,catalog_import_id,catalog_entry_id,source_active) values(?,?,?,?,?,?,?,?,?,0,?,?,?,0)`,
          String(raw.id),
          String(s.id),
          String(raw.externalId),
          String(raw.sku),
          String(raw.name),
          text(raw.barcode),
          text(raw.department) || "История",
          Number(raw.plan),
          qty(raw.unitsPerBox) && Number(raw.unitsPerBox) > 0
            ? Number(raw.unitsPerBox)
            : null,
          raw.cutOperation === "assembly" ? "assembly" : "cut",
          text(raw.catalogImportId) || null,
          text(raw.catalogEntryId) || null,
        ),
      );
    } else if (p.kind === "employees") {
      check(text(raw.id) && text(raw.name, 120), "Сотрудник без имени или ID.");
      sql.push(
        q(
          "insert into av2_employees(id,name,active) values(?,?,0) on conflict(id) do nothing",
          String(raw.id),
          String(raw.name),
        ),
      );
    } else if (p.kind === "work") {
      check(
        !prior &&
          text(raw.id) &&
          text(raw.positionId) &&
          text(raw.employeeId) &&
          text(raw.employee) &&
          ["cut", "assembly", "packing"].includes(String(raw.operation)) &&
          qty(raw.qty) &&
          Number(raw.qty) > 0 &&
          Number.isFinite(Date.parse(String(raw.createdAt))),
        "Некорректная запись старого журнала.",
      );
      const position = await one<{
        supplyId: string;
        ready: number;
        sourceActive: number;
      }>(
        "select supply_id,ready,source_active from av2_positions where id=?",
        [String(raw.positionId)],
        "Не найдена исходная позиция работы.",
      );
      const employee = await one<{ active: number }>(
        "select active from av2_employees where id=?",
        [String(raw.employeeId)],
        "Не найден сотрудник старого журнала.",
      );
      // An atomic restoration transaction satisfies the ordinary insert guards,
      // then restores the exact readiness/active flags before any reader can see it.
      sql.push(
        q(
          "update av2_positions set ready=1,source_active=1 where id=?",
          String(raw.positionId),
        ),
        q(
          "update av2_employees set active=1 where id=?",
          String(raw.employeeId),
        ),
        q(
          "insert into av2_work(id,supply_id,position_id,employee_id,employee_name,operation,qty,actor,created_at,legacy_event_id,norm,coefficient) values(?,?,?,?,?,?,?,?,?,?,?,?)",
          String(raw.id),
          position.supplyId,
          String(raw.positionId),
          String(raw.employeeId),
          String(raw.employee),
          String(raw.operation),
          Number(raw.qty),
          actor,
          String(raw.createdAt),
          sourceId,
          raw.norm == null ? null : String(raw.norm),
          raw.coefficient == null ? null : String(raw.coefficient),
        ),
        q(
          "update av2_positions set ready=?,source_active=? where id=?",
          position.ready,
          position.sourceActive,
          String(raw.positionId),
        ),
        q(
          "update av2_employees set active=? where id=?",
          employee.active,
          String(raw.employeeId),
        ),
      );
      affected.add(String(raw.positionId));
    } else if (p.kind === "corrections") {
      const work = await one<{ id: string; positionId: string }>(
        "select id,position_id from av2_work where legacy_event_id=?",
        [text(raw.eventId)],
        "Не найдена отменяемая историческая работа.",
      );
      sql.push(
        q(
          "insert into av2_corrections(id,work_id,reason,actor,created_at) values(?,?,?,?,?) on conflict(work_id) do nothing",
          "legacy:" + sourceId,
          work.id,
          text(raw.reason, 500) || "Отмена в старом Assembly",
          text(raw.actor) || actor,
          text(raw.createdAt) || now,
        ),
      );
      affected.add(work.positionId);
    } else if (p.kind === "cartons") {
      check(
        text(raw.id) &&
          text(raw.label) &&
          ["OZON", "WB"].includes(String(raw.market)) &&
          /^[1-9]\d*$/.test(text(raw.store)) &&
          text(raw.destination) &&
          ["open", "closed"].includes(String(raw.state)),
        "Не подтверждены назначение и номер старого короба.",
      );
      sql.push(
        q(
          "insert into av2_cartons(id,label,market,store,destination,state,created_at,closed_at) values(?,?,?,?,?,?,?,?) on conflict(id) do nothing",
          String(raw.id),
          String(raw.label),
          String(raw.market),
          String(raw.store),
          String(raw.destination),
          String(raw.state),
          text(raw.createdAt) || now,
          text(raw.closedAt) || null,
        ),
      );
    } else if (p.kind === "allocations") {
      check(
        text(raw.id) &&
          text(raw.cartonId) &&
          text(raw.positionId) &&
          qty(raw.qty) &&
          Number(raw.qty) > 0,
        "Некорректное вложение старого короба.",
      );
      await one(
        "select id from av2_cartons where id=?",
        [String(raw.cartonId)],
        "Старый короб не найден.",
      );
      await one(
        "select id from av2_positions where id=?",
        [String(raw.positionId)],
        "Позиция вложения не найдена.",
      );
      sql.push(
        q(
          "insert into av2_legacy_allocations(id,carton_id,position_id,qty,units_per_box,created_at,actor) values(?,?,?,?,?,?,?) on conflict(id) do nothing",
          String(raw.id),
          String(raw.cartonId),
          String(raw.positionId),
          Number(raw.qty),
          qty(raw.unitsPerBox) && Number(raw.unitsPerBox) > 0
            ? Number(raw.unitsPerBox)
            : null,
          text(raw.createdAt) || now,
          actor,
        ),
      );
      affected.add(String(raw.positionId));
    } else if (p.kind === "warehouseCartons") {
      check(
        text(raw.id) &&
          text(raw.label) &&
          ["OZON", "WB"].includes(String(raw.market)) &&
          /^[1-9]\d*$/.test(text(raw.store)) &&
          ["open", "closed"].includes(String(raw.state)),
        "Не подтверждён складской короб.",
      );
      sql.push(
        q(
          "insert into av2_warehouse_cartons(id,label,market,store,state,version,created_at,closed_at) values(?,?,?,?,?,0,?,?) on conflict(id) do nothing",
          String(raw.id),
          String(raw.label),
          String(raw.market),
          String(raw.store),
          String(raw.state),
          text(raw.createdAt) || now,
          text(raw.closedAt) || null,
        ),
      );
    } else if (p.kind === "warehouseReceipts") {
      check(
        text(raw.id) &&
          text(raw.cartonId) &&
          text(raw.sku) &&
          text(raw.name) &&
          text(raw.employeeId) &&
          qty(raw.qty) &&
          Number(raw.qty) > 0,
        "Не подтверждено поступление на склад.",
      );
      sql.push(
        q(
          "insert into av2_warehouse_receipts(id,carton_id,position_id,sku,name,search,qty,catalog_import_id,photo_id,employee_id,employee,supply,comment,actor,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do nothing",
          String(raw.id),
          String(raw.cartonId),
          text(raw.positionId) || null,
          String(raw.sku),
          String(raw.name),
          [raw.sku, raw.name, raw.supply].join(" ").toLocaleUpperCase("ru"),
          Number(raw.qty),
          text(raw.catalogImportId) || null,
          text(raw.photoId) || null,
          String(raw.employeeId),
          text(raw.employee) || "Сотрудник не указан · старая запись",
          text(raw.supply),
          text(raw.comment, 500),
          actor,
          text(raw.createdAt) || now,
        ),
      );
      if (raw.positionId) affected.add(String(raw.positionId));
    } else if (p.kind === "reservations") {
      check(text(raw.label, 80), "Пустой номер старого короба.");
      sql.push(
        q(
          "insert into av2_carton_number_reservations(label,source) values(?,'legacy-restore') on conflict(label) do nothing",
          String(raw.label),
        ),
      );
    } else if (p.kind === "dispatches") {
      check(
        text(raw.id) &&
          text(raw.cartonId) &&
          text(raw.label) &&
          Number.isFinite(Date.parse(String(raw.sentAt))) &&
          qty(raw.qty),
        "Не подтверждена отправка старого короба.",
      );
      const box = await one<{
        market: string;
        store: string;
        destination: string;
        state: string;
      }>(
        "select market,store,destination,state from av2_cartons where id=?",
        [String(raw.cartonId)],
        "Отправленный короб не найден.",
      );
      check(
        box.state === "closed",
        "В старом РИТМ отправлен открытый короб. Требуется сверка.",
      );
      sql.push(
        q(
          `insert into av2_dispatches(id,label,market,store,destination,state,actor,created_at,sent_at,sent_payload,carton_ids,qty) values(?,?,?,?,?,'sent',?,?,?,?,?,?) on conflict(id) do nothing`,
          String(raw.id),
          String(raw.label),
          box.market,
          box.store,
          box.destination,
          text(raw.actor) || actor,
          String(raw.sentAt),
          String(raw.sentAt),
          raw.frozen ? JSON.stringify(raw.frozen) : null,
          JSON.stringify([raw.cartonId]),
          Number(raw.qty),
        ),
        q(
          "update av2_cartons set dispatch_id=? where id=? and (dispatch_id is null or dispatch_id=?)",
          String(raw.id),
          String(raw.cartonId),
          String(raw.id),
        ),
      );
    } else if (p.kind === "manifest") {
      sql.push(
        q(
          "insert into av2_legacy_runs(id,source_hash,state,report,created_at) values(?,?,'complete',?,?) on conflict(id) do nothing",
          String(p.sourceHash),
          String(p.sourceHash),
          JSON.stringify(raw),
          now,
        ),
      );
    } else check(false, "Неизвестный раздел восстановления.");
    sql.push(
      q(
        "insert into av2_legacy_records(kind,source_id,hash,data,captured_at) values(?,?,?,?,?) on conflict(kind,source_id) do update set hash=excluded.hash,data=excluded.data,captured_at=excluded.captured_at",
        p.kind,
        sourceId,
        hash,
        JSON.stringify(raw),
        now,
      ),
    );
    accepted++;
  }
  for (const positionId of affected) {
    sql.push(
      q(
        `insert into av2_position_totals(position_id,cut,assembly,packing,boxed) select ?,coalesce(sum(case when w.operation='cut' and c.id is null then w.qty else 0 end),0),coalesce(sum(case when w.operation='assembly' and c.id is null then w.qty else 0 end),0),coalesce(sum(case when w.operation='packing' and c.id is null then w.qty else 0 end),0),(select coalesce(sum(qty),0) from av2_allocations where position_id=? and removed_at is null)+(select coalesce(sum(qty),0) from av2_legacy_allocations where position_id=? and removed_at is null)+(select coalesce(sum(qty),0) from av2_warehouse_receipts where position_id=?) from av2_work w left join av2_corrections c on c.work_id=w.id where w.position_id=? on conflict(position_id) do update set cut=excluded.cut,assembly=excluded.assembly,packing=excluded.packing,boxed=excluded.boxed`,
        positionId,
        positionId,
        positionId,
        positionId,
        positionId,
      ),
    );
    sql.push(
      q(
        `insert into av2_team_totals(id,position_id,employee_id,name,cut,assembly,packing) select ?||w.employee_id,w.position_id,w.employee_id,w.employee_name,sum(case when w.operation='cut' and c.id is null then w.qty else 0 end),sum(case when w.operation='assembly' and c.id is null then w.qty else 0 end),sum(case when w.operation='packing' and c.id is null then w.qty else 0 end) from av2_work w left join av2_corrections c on c.work_id=w.id where w.position_id=? group by w.position_id,w.employee_id on conflict(position_id,employee_id) do update set cut=excluded.cut,assembly=excluded.assembly,packing=excluded.packing`,
        "legacy-team:" + positionId + ":",
        positionId,
      ),
    );
  }
  return {
    statements: sql,
    result: { kind: p.kind, accepted, skipped: p.rows.length - accepted },
  };
}
