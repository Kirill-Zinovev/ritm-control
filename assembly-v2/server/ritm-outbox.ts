import {warehouseWorkQty} from "./warehouse-splits";
import type { SqlStore, Statement } from "./database";
import { digest } from "../shared/catalog";
import type { RitmEnv } from "./ritm-api";

const path = "/api/assembly-v2/events";
const endpoint = "https://ritm-erp.zinovevkirill234.chatgpt.site" + path;
const q = (sql: string, ...args: (string | number | null)[]): Statement => ({
  sql,
  args,
});

// The queue row commits in the same transaction as the work or cancellation.
// Legacy restoration deliberately bypasses this producer: RITM already reads it.
export function enqueueWork(workId: string, now: string): Statement {
  return q(
    `insert into av2_ritm_work_outbox(id,payload,created_at)
    select 'av2:'||w.id,json_object('id','av2:'||w.id,'kind','work','eventId','av2:'||w.id,
    'shipmentId',s.origin_shipment_id,'positionId',p.external_id,'sku',p.sku,'productType',json_extract(e.data,'$.kind'),
    'employeeId',case when w.employee_id like 'legacy:%' then substr(w.employee_id,8) else 'av2:'||w.employee_id end,
    'employee',w.employee_name,'operation',w.operation,'qty',w.qty,'norm',w.norm,'coefficient',w.coefficient,'createdAt',w.created_at),?
    from av2_work w join av2_positions p on p.id=w.position_id join av2_supplies s on s.id=w.supply_id
    left join av2_resolved_catalog_entries e on e.import_id=p.catalog_import_id and e.entry_id=p.catalog_entry_id
    where w.id=? and w.legacy_event_id is null and s.origin_shipment_id is not null and s.is_demo=0 on conflict(id) do nothing`,
    now,
    workId,
  );
}
export function enqueueNormRepair(workId: string, repairId: string, now: string, productType: string): Statement {
  return q(
    `insert into av2_ritm_work_outbox(id,payload,created_at)
     select 'av2:norm:'||?,json_object('id','av2:norm:'||?,'kind','norm',
       'eventId',coalesce(w.legacy_event_id,'av2:'||w.id),
       'shipmentId',coalesce(s.origin_shipment_id,substr(p.external_id,1,instr(p.external_id,'|')-1)),
       'positionId',p.external_id,'sku',p.sku,'productType',?,
       'employeeId',case when w.employee_id like 'legacy:%' then substr(w.employee_id,8) else 'av2:'||w.employee_id end,
       'operation',w.operation,'qty',w.qty,'norm',w.norm,'coefficient',w.coefficient,
       'originalCreatedAt',w.created_at,'createdAt',?),?
     from av2_work w join av2_positions p on p.id=w.position_id join av2_supplies s on s.id=w.supply_id
     where w.id=? and s.is_demo=0 on conflict(id) do nothing`,
    repairId,repairId,productType,now,now,workId,
  );
}
export function enqueueStockCutWork(workId: string, now: string): Statement {
  return q(
    `insert into av2_ritm_work_outbox(id,payload,created_at)
     select 'av2:'||w.id,json_object('id','av2:'||w.id,'kind','warehouse-work','eventId','av2:'||w.id,
       'taskId',w.id,'market',w.market,'store',w.store,'sku',w.sku,'productType',w.product_type,
       'employeeId',case when w.employee_id like 'legacy:%' then substr(w.employee_id,8) else 'av2:'||w.employee_id end,
       'employee',w.employee,'operation',w.operation,'qty',w.qty,'norm',w.norm,'coefficient',w.coefficient,'createdAt',w.created_at),?
     from av2_stock_cut_work w where w.id=? on conflict(id) do nothing`, now, workId,
  );
}
export function enqueueWarehouseWork(workId: string, now: string): Statement {
  return q(
    `insert into av2_ritm_work_outbox(id,payload,created_at)
     select 'av2:'||w.id,json_object('id','av2:'||w.id,'kind','warehouse-work','eventId','av2:'||w.id,
       'receiptId',r.id,'market',c.market,'store',c.store,'sku',r.sku,'productType',w.product_type,
       'employeeId',case when r.employee_id like 'legacy:%' then substr(r.employee_id,8) else 'av2:'||r.employee_id end,
       'employee',r.employee,'operation','packing','qty',${warehouseWorkQty()},'norm',w.norm,'coefficient',w.coefficient,'createdAt',w.created_at),?
     from av2_warehouse_work w join av2_warehouse_receipts r on r.id=w.receipt_id join av2_warehouse_cartons c on c.id=r.carton_id
     where w.id=? on conflict(id) do nothing`, now, workId,
  );
}
export function enqueueCancellation(
  workId: string,
  correctionId: string,
  now: string,
): Statement {
  return q(
    `insert into av2_ritm_work_outbox(id,payload,created_at)
    select 'av2:cancel:'||c.id,json_object('id','av2:cancel:'||c.id,'kind','cancel',
    'eventId',coalesce(w.legacy_event_id,'av2:'||w.id),'reason',c.reason,'createdAt',c.created_at),?
    from av2_corrections c join av2_work w on w.id=c.work_id join av2_supplies s on s.id=w.supply_id
    where c.id=? and w.id=? and (s.origin_shipment_id is not null or w.legacy_event_id is not null) on conflict(id) do nothing`,
    now,
    correctionId,
    workId,
  );
}
export async function workDeliveryStatus(store: SqlStore) {
  return (
    await store.all<{
      pending: number;
      delivered: number;
      failed: number;
      lastDelivered: string | null;
    }>(`select
    sum(case when delivered_at is null then 1 else 0 end) pending,
    sum(case when delivered_at is not null then 1 else 0 end) delivered,
    sum(case when delivered_at is null and last_error is not null then 1 else 0 end) failed,max(delivered_at) last_delivered from av2_ritm_work_outbox`)
  )[0];
}
export async function drainWorkOutbox(
  store: SqlStore,
  env: RitmEnv,
  { fetcher = fetch }: { fetcher?: typeof fetch } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(env.RITM_ASSEMBLY_V2_FEED_SECRET || ""))
    return { configured: false };
  const rows = await store.all<{
    id: string;
    payload: string;
    attempts: number;
  }>(
    `select id,payload,attempts from av2_ritm_work_outbox where delivered_at is null and next_attempt_at<=? order by created_at,id limit 40`,
    [Date.now()],
  );
  if (!rows.length) return workDeliveryStatus(store);
  const body = JSON.stringify({
    format: "assembly-v2-events",
    version: 1,
    events: rows.map((r) => JSON.parse(r.payload)),
  });
  const at = String(Date.now()),
    nonce = crypto.randomUUID();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.RITM_ASSEMBLY_V2_FEED_SECRET!),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = [
      ...new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(
            JSON.stringify([1, "POST", path, at, nonce, await digest(body)]),
          ),
        ),
      ),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const response = await fetcher(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        "content-type": "application/json",
        "x-assembly-v2-at": at,
        "x-assembly-v2-nonce": nonce,
        "x-assembly-v2-signature": signature,
      },
      body,
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    ) {
      await response.body?.cancel();
      throw new Error(`RITM HTTP ${response.status}`);
    }
    const receipt = (await response.json()) as {
      ok?: boolean;
      acceptedIds?: string[];
    };
    if (
      receipt.ok !== true ||
      !Array.isArray(receipt.acceptedIds) ||
      rows.some((r) => !receipt.acceptedIds!.includes(r.id))
    )
      throw new Error("RITM receipt incomplete");
    await store.batch(
      rows.map((r) =>
        q(
          "update av2_ritm_work_outbox set delivered_at=?,last_error=null where id=? and delivered_at is null",
          new Date().toISOString(),
          r.id,
        ),
      ),
    );
  } catch (error) {
    const message =
      error instanceof Error &&
      /^RITM (?:HTTP \d+|receipt incomplete)$/.test(error.message)
        ? error.message
        : "Связь с РИТМ временно недоступна";
    await store.batch(
      rows.map((r) =>
        q(
          "update av2_ritm_work_outbox set attempts=attempts+1,next_attempt_at=?,last_error=? where id=? and delivered_at is null",
          Date.now() + Math.min(300000, 3000 * 2 ** Math.min(7, r.attempts)),
          message,
          r.id,
        ),
      ),
    );
  }
  return workDeliveryStatus(store);
}
