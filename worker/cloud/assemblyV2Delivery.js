import { createHash } from "node:crypto";
import { buildAssemblyV2Feed } from "./assemblyV2Feed.js";
import { cloudConfig, sourceId } from "./config.js";
import { callAssemblyV2 } from "./assemblyV2Transport.js";
const target = "https://assembly-v2.zinovevkirill234.chatgpt.site";
const confirmed = new Set(["verified", "verified_with_calculation_errors"]);
const moveKind = "production-department-move";
const removalKind = "box-position-removal";
const fullDeleteKind = "production-delete";
const shipmentPattern = /^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i;
const sourcePending = new Set(["assembly_v2_source_busy", "assembly_v2_snapshot_pending", "assembly_v2_source_changed"]);

export function supplyDeliveryJob(kind, operation, now) {
  if (!confirmed.has(operation?.status)) return null;
  const fullDelete = kind === "production" && operation.status === "verified" &&
    /^RITM-SUPPLY-[a-f0-9-]{36}$/i.test(operation.shipmentId || "") &&
    (operation.action === "deleteSupply" || (operation.action === "deletePart" && operation.survivors?.length === 0));
  if (fullDelete)
    return { id: fullDeleteKind + ":" + operation.id, shipmentId: operation.shipmentId, createdAt: now };
  let shipmentId = operation.shipmentId || operation.result?.shipmentId || operation.payload?.removal?.shipmentId ||
    (kind === moveKind ? operation.input?.shipmentId : null);
  if (!shipmentId && kind === "roll") {
    const sheetId = operation.result?.sheetId || operation.payload?.sheetId;
    if (Number.isSafeInteger(sheetId) && sheetId > 0)
      shipmentId = "RITM-ROLL-" + sheetId;
  }
  if (shipmentId && !shipmentPattern.test(shipmentId)) shipmentId = null;
  if (["delete", "deletePart"].includes(operation.action))
    shipmentId = null;
  // Global jobs still require a fresh persisted feed receipt (e.g. deleting a
  // physical sheet). Creation jobs additionally require the canonical supply.
  return { id: kind + ":" + operation.id, shipmentId, createdAt: now };
}
export function snapshotDeliveryJob(printing, now) {
  const identity = JSON.stringify(
    (printing.supplies || [])
      .map((o) => [
        o.assemblyShipmentId,
        o.sourceId,
        o.sheetId,
        o.row,
        o.rawUid,
        o.article,
        o.quantity,
        o.shop,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
  return {
    id: "snapshot:" + createHash("sha256").update(identity).digest("hex"),
    shipmentId: null,
    createdAt: now,
  };
}
export async function queueSnapshotDelivery(
  store,
  printing,
  sourceAt = store.now(),
) {
  const job = snapshotDeliveryJob(printing, sourceAt);
  await store.db
    .prepare(
      "insert into assembly_v2_supply_deliveries(id,shipment_id,created_at) values(?,?,?) on conflict(id) do nothing",
    )
    .bind(job.id, job.shipmentId, job.createdAt)
    .run();
}
export async function supplyDeliveryStatus(store) {
  return await store.db
    .prepare(
      `select count(*) total,sum(case when delivered_at is null then 1 else 0 end) pending,
    sum(case when delivered_at is null and last_error is not null then 1 else 0 end) failed,max(delivered_at) lastDeliveredAt from assembly_v2_supply_deliveries`,
    )
    .first();
}
async function retryTargetWork(bindings,store,fetcher){
  // A work retry does not depend on there being a new supply. Rate-limit the
  // service poke durably across concurrent RITM requests and Worker instances.
  const gate=await store.db.prepare("insert into cloud_state(key,value,updated_at) values('assemblyV2WorkPoke','true',?) on conflict(key) do update set updated_at=excluded.updated_at where cloud_state.updated_at<?").bind(store.now(),store.now()-30000).run();
  if(gate.meta?.changes!==1)return;
  try{const response=await callAssemblyV2(bindings,'/api/ritm/deliver',{method:'POST',body:'{}',fetcher,timeout:18000});await response.body?.cancel();}catch{/* Durable work events remain pending in Assembly until the next retry. */}
}
const exactDeleteJob = "id like 'production-delete:%' and shipment_id like 'RITM-SUPPLY-%'";
async function deliverConfirmedDeletes(bindings, store, fetcher) {
  // These jobs were written in the same checkpoint as the verified removal.
  // They can be delivered even when a refresh owns the regular delivery lease.
  const { results: jobs = [] } = await store.db.prepare(
    `select id,shipment_id,attempts from assembly_v2_supply_deliveries
      where delivered_at is null and next_attempt_at<=? and (${exactDeleteJob})
      order by created_at desc,id limit 10`,
  ).bind(store.now()).all();
  if (!jobs.length) return;
  const deletions = jobs.map(job => ({ eventId:job.id, shipmentId:job.shipment_id }));
  try {
    const response = await callAssemblyV2(bindings, "/api/ritm/retire-shipments", {
      method:"POST", body:JSON.stringify({deletions}), fetcher, timeout:5000,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("retirement_unconfirmed");
    }
    const receipt = await response.json();
    if (receipt?.ok !== true || !Array.isArray(receipt.retired) ||
        !deletions.every(event => receipt.retired.some(row => row?.eventId === event.eventId && row?.shipmentId === event.shipmentId)))
      throw Error("retirement_unconfirmed");
    await store.db.batch(deletions.map(event => store.db.prepare(
      "update assembly_v2_supply_deliveries set delivered_at=?,attempts=attempts+1,last_error=null,receipt=? where id=? and delivered_at is null",
    ).bind(store.now(),JSON.stringify(event),event.eventId)));
  } catch {
    await store.db.batch(jobs.map(job => store.db.prepare(
      "update assembly_v2_supply_deliveries set attempts=attempts+1,next_attempt_at=?,last_error=? where id=? and delivered_at is null",
    ).bind(store.now()+Math.min(30000,5000*2**Math.min(job.attempts,3)),
      "Снятие поставки с нового Assembly ожидает подтверждения",job.id)));
  }
}
export async function drainAssemblyV2(
  bindings,
  store,
  { fetcher = fetch, refresh = null } = {},
) {
  if (
    bindings.RITM_ASSEMBLY_V2_TARGET_URL !== target ||
    !bindings.RITM_ASSEMBLY_V2_TARGET_TOKEN
  )
    return { configured: false };
  await deliverConfirmedDeletes(bindings, store, fetcher);
  const due = await store.db
    .prepare(
      `select * from assembly_v2_supply_deliveries where delivered_at is null and next_attempt_at<=?
        and (shipment_id is null or not (${exactDeleteJob}))
        order by (shipment_id is not null) desc, (id like 'box-position-removal:%') desc,created_at,id limit 10`,
    )
    .bind(store.now())
    .all();
  const eligible = due.results || [];
  const targeted = eligible.filter(job => job.shipment_id || job.id.startsWith(moveKind + ":"));
  const jobs = targeted.length ? targeted : eligible;
  if (!jobs.length) {
    await retryTargetWork(bindings,store,fetcher);
    return { configured: true, ...(await supplyDeliveryStatus(store)) };
  }
  let lease;
  try {
    lease = await store.acquire("assembly-v2-delivery", 60000);
  } catch (e) {
    if (e.code === "cloud_operation_busy")
      return { configured: true, busy: true };
    throw e;
  }
  try {
    const minimum = Math.max(...jobs.map((j) => j.created_at));
    const sourceMinimum = Math.max(0, ...jobs.filter(j => !j.id.startsWith("lock:")).map(j => j.created_at));
    const readSnapshot = () => store.assemblySourceSnapshot ? store.assemblySourceSnapshot() : store.snapshot("printing");
    let snapshot = await readSnapshot();
    let refreshed = false;
    const refreshSource = async () => {
      if (!refresh) throw new Error("source_refresh_required");
      const updated = await refresh();
      if (updated?.stale || updated?.refreshFailed) throw new Error("source_refresh_unconfirmed");
      snapshot = await readSnapshot();
      refreshed = true;
    };
    if (
      !snapshot ||
      snapshot.at < sourceMinimum ||
      store.now() - snapshot.at >= 240000
    ) {
      await refreshSource();
    }
    // Older move receipts were queued without a shipment ID. Recover the
    // original target from the immutable, verified operation.
    for (const job of jobs) {
      if (job.shipment_id || !job.id.startsWith(moveKind + ":")) continue;
      const id = job.id.slice(moveKind.length + 1);
      const scope = await store.operationReadScope(moveKind, id);
      const operation = scope.operations.get(job.id)?.value;
      if (operation?.status === "verified" && shipmentPattern.test(operation.input?.shipmentId || "")) {
        job.shipment_id = operation.input.shipmentId;
        await store.db.prepare("update assembly_v2_supply_deliveries set shipment_id=? where id=? and delivered_at is null")
          .bind(job.shipment_id,job.id).run();
      }
    }
    const exact = new Set(jobs.filter(job => job.shipment_id &&
      [moveKind, removalKind, fullDeleteKind, "roll"].some(kind => job.id.startsWith(kind + ":"))).map(job => job.id));
    const global = jobs.some(job => !job.shipment_id && !job.id.startsWith(moveKind + ":"));
    let ids = [...new Set(jobs.map(job => job.shipment_id).filter(Boolean))];
    let authoritative = null;
    if (exact.size || global) {
      const readFeed = async () => buildAssemblyV2Feed({
        snapshot,
        scope: await (store.assemblyFeedContext ? store.assemblyFeedContext() : store.scope()),
        now: store.now(),
        maxAgeMs: cloudConfig(bindings).snapshotMaxAgeMs,
        documents: {
          "roll-printing": sourceId(bindings, "rollPrintingId"),
          "box-printing": sourceId(bindings, "boxPrintingId"),
        },
      });
      try {
        authoritative = await readFeed();
      } catch (error) {
        if (refreshed || !refresh || !sourcePending.has(error.code)) throw error;
        await refreshSource();
        authoritative = await readFeed();
      }
      // Every active source must be confirmed. A partial source composition
      // cannot acknowledge an unrelated global delivery as complete.
      if (global && (
        authoritative.issues.length ||
        authoritative.activeShipmentIds.some(
          (id) => !authoritative.supplies.some((s) => s.shipmentId === id),
        )
      ))
        throw new Error("source_composition_unconfirmed");
      if (global) ids = [...new Set([...ids, ...authoritative.activeShipmentIds])];
    }
    const response = await callAssemblyV2(bindings, "/api/ritm/sync", {
      method: "POST",
      fetcher, timeout:25000,
      body: JSON.stringify({ force: true, expectedShipmentIds: ids, ...(exact.size && {includePositionIds:true}) }),
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    ) {
      await response.body?.cancel();
      throw new Error("target_unavailable");
    }
    const receipt = await response.json();
    if (["syncing", "waiting"].includes(receipt.status)) throw new Error("target_sync_pending");
    const confirmedShipment = (id) => receipt.receipts?.some(
      (r) => r.shipmentId === id && r.sourceRevision >= minimum && r.groups > 0 && r.positions > 0 &&
        (!authoritative || r.positions >= (authoritative.supplies.find((s) => s.shipmentId === id)?.positions.length || 0)),
    );
    const confirmedPositions = job => {
      const id = job.shipment_id;
      if (authoritative.issues.some(issue => issue.shipmentId === id || !issue.shipmentId) ||
          receipt.issues?.some(issue => issue.shipmentId === id || !issue.shipmentId)) return false;
      const supply = authoritative.supplies.find(row => row.shipmentId === id);
      if (!supply && authoritative.activeShipmentIds.includes(id)) return false;
      const applied = receipt.positionReceipts?.find(row => row.shipmentId === id);
      const expected = supply?.positions.map(position => position.positionId) || [];
      if (!Number.isSafeInteger(applied?.sourceRevision) || applied.sourceRevision < job.created_at ||
          !Array.isArray(applied.positionIds) || applied.positionIds.length !== expected.length) return false;
      const active = new Set(applied.positionIds);
      return active.size === expected.length && expected.every(positionId => active.has(positionId));
    };
    if (
      !["synced", "partial"].includes(receipt.status) ||
      !Number.isSafeInteger(receipt.sourceRevision) ||
      receipt.sourceRevision < minimum ||
      !Array.isArray(receipt.receipts)
    )
      throw new Error("target_receipt_unconfirmed");
    await store.db.batch(
      jobs.map((j) => {
        // One old/unresolved identity must not erase a confirmed receipt for
        // another supply. Global snapshots still require every active source.
        const accepted = exact.has(j.id) ? confirmedPositions(j)
          : j.shipment_id ? confirmedShipment(j.shipment_id)
          : !j.id.startsWith(moveKind + ":") && ids.every(confirmedShipment);
        if (!accepted)
          return store.db.prepare("update assembly_v2_supply_deliveries set attempts=attempts+1,next_attempt_at=?,last_error=? where id=? and delivered_at is null")
            .bind(store.now()+Math.min(300000,5000*2**Math.min(j.attempts,6)),"Доставка в новый Assembly ожидает подтверждения",j.id);
        return store.db
          .prepare(
            "update assembly_v2_supply_deliveries set delivered_at=?,attempts=attempts+1,last_error=null,receipt=? where id=? and delivered_at is null",
          )
          .bind(
            store.now(),
            JSON.stringify({
              sourceRevision: receipt.sourceRevision,
              receipts: j.shipment_id ? receipt.receipts.filter(row => row.shipmentId === j.shipment_id) : receipt.receipts,
              ...(exact.has(j.id) && { positionReceipt: receipt.positionReceipts.find(row => row.shipmentId === j.shipment_id) }),
            }),
            j.id,
          );
      }),
    );
    // Also gives the target's durable work queue a browser-independent retry.
    try {
      const r = await callAssemblyV2(bindings, "/api/ritm/deliver", {
        method: "POST",
        fetcher, timeout:18000,
        body: "{}",
      });
      await r.body?.cancel();
    } catch {
      /* Work remains in its own target outbox. */
    }
  } catch (error) {
    await store.db.batch(
      jobs.map((j) =>
        store.db
          .prepare(
            "update assembly_v2_supply_deliveries set attempts=attempts+1,next_attempt_at=?,last_error=? where id=? and delivered_at is null",
          )
          .bind(
            store.now() + (sourcePending.has(error.code) ||
              ["cloud_operation_busy","source_refresh_required","source_refresh_unconfirmed","target_sync_pending"].includes(error.code || error.message)
              ? 5000 : Math.min(300000, 5000 * 2 ** Math.min(j.attempts, 6))),
            "Доставка в новый Assembly ожидает подтверждения",
            j.id,
          ),
      ),
    );
  } finally {
    await store.release(lease);
  }
  return { configured: true, ...(await supplyDeliveryStatus(store)) };
}
