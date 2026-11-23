import type { Carton, Dispatch, PreparedDispatch } from "../shared/model";
import { warehouseCity } from "../shared/warehouse-filter";
import type { SqlStore, Statement } from "./database";

export async function readPreparedDispatches(store: SqlStore, ids?: string[]): Promise<PreparedDispatch[]> {
  type Row = Omit<PreparedDispatch, "cartons" | "cartonIds"> & { cartons: string; cartonIds: string | null };
  const rows = await store.all<Row>(`
    select d.id,d.label,d.market,d.store,d.destination,d.state,d.created_at,d.sent_at,d.carton_ids,
      coalesce(d.qty,0) qty,
      (select json_group_array(json_object('id',id,'label',label,'qty',qty)) from (
        select c.id,c.label,coalesce((select sum(a.qty) from av2_all_allocations a
          where a.carton_id=c.id and a.removed_at is null),0) qty
        from av2_cartons c where c.dispatch_id=d.id and c.state='closed' order by c.label,c.id
      )) cartons
    from av2_dispatches d where d.state='draft' ${ids ? "and d.id in (select value from json_each(?))" : ""}
    order by d.created_at desc,d.id desc
  `, ids ? [JSON.stringify(ids)] : []);
  return rows.map(({ cartonIds, cartons, ...dispatch }) => {
    const boxes = JSON.parse(cartons) as PreparedDispatch["cartons"];
    return { ...dispatch, cartons: boxes, cartonIds: cartonIds ? JSON.parse(cartonIds) as string[] : boxes.map((box) => box.id) };
  });
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 300;
}

export async function planDeparture(
  store: SqlStore,
  payload: Record<string, unknown>,
  actor: string,
  revision: number,
  now: string,
  loadCartons: (ids: string[]) => Promise<Carton[]>,
  splitOzon: (draftId: string, sentId: string, selected: ReadonlySet<string>, remaining: string[],
    actor: string, now: string) => Promise<Statement[]>,
) {
  check(payload.confirmed === true, "Подтвердите фактический выезд.");
  const bulk = payload.departures !== undefined;
  const raw = bulk ? payload.departures : [{ dispatchId: payload.dispatchId, cartonIds: payload.cartonIds }];
  check(Array.isArray(raw) && raw.length > 0, "Выберите короба для выезда.");
  const selections = raw.map((value: unknown) => {
    check(value && typeof value === "object", "Проверьте список коробов.");
    const { dispatchId, cartonIds } = value as Record<string, unknown>;
    check(isId(dispatchId), "Проверьте поле «Отгрузка».");
    if (bulk || cartonIds !== undefined)
      check(Array.isArray(cartonIds) && cartonIds.length > 0 && cartonIds.every(isId) &&
        new Set(cartonIds).size === cartonIds.length, "Выберите короба без повторов.");
    return { dispatchId, cartonIds: cartonIds as string[] | undefined };
  });
  const ids = selections.map(({ dispatchId }) => dispatchId);
  check(new Set(ids).size === ids.length, "В выборе повторяются отгрузки.");
  const drafts = await readPreparedDispatches(store, ids);
  check(drafts.length === ids.length, "Можно отметить выезд только подготовленной отгрузки. Обновите список.");
  check(drafts.every((draft) => draft.market === drafts[0].market && warehouseCity(draft).key === warehouseCity(drafts[0]).key),
    "За один раз отметьте короба одного города и маркетплейса.");
  const byId = new Map(drafts.map((draft) => [draft.id, draft]));
  const departures = selections.map(({ dispatchId, cartonIds }) => {
    const { cartons, ...dispatch } = byId.get(dispatchId)!;
    const reserved = new Set(cartons.map((box) => box.id));
    check(dispatch.cartonIds.length === cartons.length && dispatch.cartonIds.every((id) => reserved.has(id)),
      "Список коробов изменился. Обновите подготовку и выберите короба заново.");
    const chosen = new Set(cartonIds ?? dispatch.cartonIds);
    check(chosen.size && [...chosen].every((id) => reserved.has(id)),
      "В выборе есть короб, который уже не входит в эту подготовку.");
    return { dispatch, chosen, remaining: cartons.filter((box) => !chosen.has(box.id)) };
  });
  const chosenIds = departures.flatMap(({ chosen }) => [...chosen]);
  const boxes = new Map<string, Carton[]>();
  for (const box of await loadCartons(chosenIds)) {
    const group = boxes.get(box.dispatchId ?? "") ?? [];
    group.push(box);
    boxes.set(box.dispatchId ?? "", group);
  }
  const statements: Statement[] = [];
  const add = (sql: string, ...args: Statement["args"]) => statements.push({ sql, args });
  const sentIds: string[] = [];
  for (const { dispatch, chosen, remaining } of departures) {
    const current = boxes.get(dispatch.id) ?? [];
    check(current.length === chosen.size && current.every((box) => chosen.has(box.id) && box.state === "closed"),
      "Статус выбранных коробов изменился. Обновите список.");
    const sent: Dispatch = {
      ...dispatch, state: "sent", sentAt: now,
      cartonIds: dispatch.cartonIds.filter((id) => chosen.has(id)),
      qty: current.reduce((qty, box) => qty + box.qty, 0),
    };
    if (remaining.length) {
      sent.id = crypto.randomUUID();
      sent.label = `ОТ-${String(revision + 1).padStart(5, "0")}-${sentIds.length + 1}`;
    }
    const frozen = JSON.stringify({
      dispatch: sent,
      cartons: current.map((box) => ({ ...box, dispatchId: sent.id, dispatchState: "sent" })),
    });
    if (!remaining.length) {
      add("update av2_dispatches set state='sent',sent_at=?,sent_payload=?,qty=?,carton_ids=? where id=?",
        now, frozen, sent.qty, JSON.stringify(sent.cartonIds), dispatch.id);
    } else {
      add(`insert into av2_dispatches(id,label,market,store,destination,state,actor,created_at,sent_at,sent_payload,carton_ids,qty)
        values(?,?,?,?,?,'sent',?,?,?,?,?,?)`, sent.id, sent.label, sent.market, sent.store, sent.destination,
        actor, sent.createdAt, now, frozen, JSON.stringify(sent.cartonIds), sent.qty);
      const remainingIds = dispatch.cartonIds.filter((id) => !chosen.has(id));
      add("update av2_dispatches set carton_ids=?,qty=? where id=?", JSON.stringify(remainingIds),
        remaining.reduce((qty, box) => qty + box.qty, 0), dispatch.id);
      add("update av2_cartons set dispatch_id=? where dispatch_id=? and id in (select value from json_each(?))",
        sent.id, dispatch.id, JSON.stringify(sent.cartonIds));
      if (dispatch.market === "OZON")
        statements.push(...await splitOzon(dispatch.id, sent.id, chosen, remainingIds, actor, now));
    }
    sentIds.push(sent.id);
  }
  return { statements, result: { dispatchIds: sentIds, cartonCount: chosenIds.length } };
}
