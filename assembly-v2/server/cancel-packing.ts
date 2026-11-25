import type { SqlStore, Statement } from "./database";
import type { Work } from "../shared/model";

// Packing and placements are fungible within one exact source position.
// Attribute placements to active packing records FIFO, never by SKU/name.
export async function cancelPacking(
  store: SqlStore,
  work: Work,
  reason: string,
  actor: string,
  now: string,
) {
  const q = (sql: string, ...args: (string | number | null)[]): Statement => ({
    sql,
    args,
  });
  const check = (ok: unknown, message: string) => {
    if (!ok) throw Error(message);
  };
  const works = await store.all<{ id: string; qty: number }>(
    `select w.id,w.qty from av2_work w left join av2_corrections c on c.work_id=w.id where w.position_id=? and w.operation='packing' and c.id is null order by w.created_at,w.id`,
    [work.positionId],
  );
  let start = 0;
  for (const w of works) {
    if (w.id === work.id) break;
    start += w.qty;
  }
  const [totals] = await store.all<{ packing: number; boxed: number }>(
    "select packing,boxed from av2_position_totals where position_id=?",
    [work.positionId],
  );
  check(
    totals &&
      works.some((w) => w.id === work.id) &&
      works.reduce((n, w) => n + w.qty, 0) === totals.packing,
    "Журнал упаковки и итоги расходятся. Отмена не выполнена.",
  );
  const placements = await store.all<{
    id: string;
    qty: number;
    cartonId: string;
    label: string;
    state: string;
    dispatchId: string | null;
    closedAt: string | null;
    createdAt: string;
    legacy: number;
    kind: string;
  }>(
    `
 select a.id,a.qty,a.carton_id,c.label,c.state,c.dispatch_id,c.closed_at,a.created_at,a.legacy,'direction' kind,
   coalesce(split.root_id,a.id) order_id
 from av2_all_allocations a join av2_cartons c on c.id=a.carton_id
 left join av2_carton_merge_splits split on split.id=a.id and split.legacy=a.legacy
 where a.position_id=? and a.removed_at is null
 union all select r.id,r.qty,r.carton_id,c.label,c.state,null,c.closed_at,r.created_at,0,'warehouse' kind,r.id
 from av2_warehouse_receipts r join av2_warehouse_cartons c on c.id=r.carton_id
 where r.position_id=? and r.voided_at is null order by 8,11,1`,
    [work.positionId, work.positionId],
  );
  check(
    placements.reduce((n, a) => n + a.qty, 0) === totals.boxed,
    "Вложения и итог «В коробах» расходятся. Отмена не выполнена.",
  );
  const statements: Statement[] = [],
    changes: Record<string, unknown>[] = [],
    reopened = new Set<string>();
  let offset = 0,
    removed = 0;
  for (const a of placements) {
    const amount = Math.max(
      0,
      Math.min(offset + a.qty, start + work.qty) - Math.max(offset, start),
    );
    offset += a.qty;
    if (!amount) continue;
    check(
      a.kind === "direction",
      "Часть этой упаковки уже на складе. Сначала верните её из складского размещения; отмена не выполнена.",
    );
    check(
      !a.dispatchId,
      `Короб ${a.label} выбран на отгрузку или отправлен. Сначала верните короб из отгрузки; отмена не выполнена.`,
    );
    const after = a.qty - amount;
    statements.push(
      q(
        'insert into av2_quality_repairs(id,kind,entity_id,"before","after",evidence,actor,created_at) values(?,?,?,?,?,?,?,?)',
        crypto.randomUUID(),
        "work.cancel." + work.id,
        a.id,
        JSON.stringify(a),
        JSON.stringify({ qty: after, removed: amount }),
        JSON.stringify({
          workId: work.id,
          reason,
          attribution: "position-packing-FIFO",
        }),
        actor,
        now,
      ),
    );
    const table = a.legacy ? "av2_legacy_allocations" : "av2_allocations";
    statements.push(
      after
        ? q(`update ${table} set qty=? where id=?`, after, a.id)
        : q(
            `update ${table} set removed_at=?,removal_reason=? where id=?`,
            now,
            reason,
            a.id,
          ),
    );
    if (a.state === "closed" && !reopened.has(a.cartonId)) {
      statements.push(
        q(
          "update av2_cartons set state='open',closed_at=null where id=?",
          a.cartonId,
        ),
      );
      reopened.add(a.cartonId);
    }
    removed += amount;
    changes.push({
      allocationId: a.id,
      cartonId: a.cartonId,
      label: a.label,
      removed: amount,
      remaining: after,
    });
  }
  check(
    totals.packing - work.qty >= totals.boxed - removed,
    "После отмены недостаточно подтверждённой упаковки.",
  );
  if (removed)
    statements.push(
      q(
        "update av2_position_totals set boxed=boxed-? where position_id=?",
        removed,
        work.positionId,
      ),
    );
  return {
    statements,
    result: {
      removedFromCartons: removed,
      cartonChanges: changes,
      reopenedCartons: [...reopened],
    },
  };
}
