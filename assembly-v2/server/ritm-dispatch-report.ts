import type { Market } from "../shared/model";
import { directionCity } from "../shared/cities";
import type { SqlStore } from "./database";

interface DispatchCarton {
  id: string;
  label: string;
  qty: number;
  state: "open" | "closed";
  prepared: boolean;
}

interface DispatchPosition {
  supplyId: string;
  supplyTitle: string;
  positionId: string;
  sku: string;
  department: string;
  market: Market;
  store: string;
  destination: string;
  plan: number;
  packed: number;
  sent: number | null;
  cartons: DispatchCarton[];
  sentCartons: { id: string; label: string; qty: number }[];
}

export interface RitmDispatchReport {
  schemaVersion: 1;
  revision: number;
  checkedAt: string;
  rows: DispatchPosition[];
}

type PositionRow = Omit<DispatchPosition, "sent" | "cartons" | "sentCartons"> & { id: string };
type CartonRow = Omit<DispatchCarton, "prepared"> & {
  positionId: string;
  dispatchState: "draft" | "sent" | "canceled" | null;
  archivedQty: number | null;
  correctScope: number;
};

const positionLimit = 20_000;
const cartonLimit = 100_000;
const scopedPositions = `
  with positions as materialized (
    select p.id,p.external_id position_id,coalesce(s.origin_shipment_id,s.external_id) supply_id,s.title supply_title,
      p.sku,p.department,p.plan,s.market,s.store,s.destination
    from av2_positions p join av2_supplies s on s.id=p.supply_id
    where s.is_demo=0 and s.source_active=1 and p.source_active=1 and p.plan>0
      and coalesce(s.origin_shipment_id,s.external_id) in (select value from json_each(?))
  )`;

export async function readRitmDispatchReport(store: SqlStore, supplyIds: string[]): Promise<RitmDispatchReport | null> {
  const ids = JSON.stringify(supplyIds);
  const [meta, rawPositions, rawCartons] = await store.readBatch([
    { sql: "select coalesce((select revision from av2_meta where id=1),0) revision", args: [] },
    {
      sql: `${scopedPositions}
        select p.*,coalesce(t.packing,0) packed
        from positions p left join av2_position_totals t on t.position_id=p.id
        order by p.supply_id,p.market,p.store,p.position_id,p.id limit ?`,
      args: [ids, positionLimit + 1],
    },
    {
      sql: `${scopedPositions}, allocations as materialized (
        select p.id position_id,a.carton_id,sum(a.qty) qty
        from positions p join av2_all_allocations a on a.position_id=p.id
        where a.removed_at is null and a.qty>0 group by p.id,a.carton_id
      ), cartons as materialized (
        select c.id,c.label,c.state,c.market,c.store,d.state dispatch_state,
          case when d.state='sent' and c.state='closed' and d.sent_at is not null
            and (d.carton_ids is null or c.id in (select value from json_each(d.carton_ids)))
            then (
              select box.value from json_each(
                case when json_valid(d.sent_payload) then d.sent_payload else null end,'$.cartons'
              ) box where json_extract(box.value,'$.id')=c.id limit 1
            ) end shipped_carton
        from (select distinct carton_id from allocations) wanted
        join av2_production_cartons c on c.id=wanted.carton_id
        left join av2_dispatches d on d.id=c.dispatch_id
      )
      select p.id position_id,c.id,c.label,c.state,a.qty,c.dispatch_state,
        (c.market=p.market and c.store=p.store) correct_scope,
        (select sum(json_extract(item.value,'$.qty')) from json_each(c.shipped_carton,'$.items') item
          where json_type(item.value,'$.qty')='integer' and json_extract(item.value,'$.qty')>0
            and (json_extract(item.value,'$.positionId')=p.id or
              (json_extract(item.value,'$.externalSupplyId')=p.supply_id and
               json_extract(item.value,'$.externalPositionId')=p.position_id))) archived_qty
      from allocations a join positions p on p.id=a.position_id join cartons c on c.id=a.carton_id
      order by p.id,c.label,c.id limit ?`,
      args: [ids, cartonLimit + 1],
    },
  ]);
  if (rawPositions.length > positionLimit || rawCartons.length > cartonLimit) return null;

  const positions = new Map<string, DispatchPosition>();
  for (const { id, ...position } of rawPositions as unknown as PositionRow[]) {
    const destination = position.destination || position.supplyTitle;
    const city = directionCity(destination, position.market);
    positions.set(id, { ...position, destination: city?.label ?? destination, sent: 0, cartons: [], sentCartons: [] });
  }
  for (const carton of rawCartons as unknown as CartonRow[]) {
    const position = positions.get(carton.positionId)!;
    if (carton.dispatchState === "sent") {
      // A returned carton has no live sent link. If sent again, only its new
      // departure counts. Mutable contents alone cannot confirm a legacy shipment.
      if (!carton.correctScope || carton.archivedQty === null) position.sent = null;
      else {
        if (position.sent !== null) position.sent += carton.archivedQty;
        if (carton.archivedQty > 0) position.sentCartons.push({ id: carton.id, label: carton.label, qty: carton.archivedQty });
      }
    } else if (carton.correctScope) {
      const { id, label, qty, state } = carton;
      position.cartons.push({ id, label, qty, state, prepared: carton.dispatchState === "draft" });
    }
  }
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), revision: Number(meta[0].revision), rows: [...positions.values()] };
}
