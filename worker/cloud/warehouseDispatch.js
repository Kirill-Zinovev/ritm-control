import { CloudError } from "./access.js";

const schemaByDb = new WeakMap();
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ritm_warehouse_carton_dispatch (
    carton_id TEXT PRIMARY KEY NOT NULL,
    shipment_id TEXT NOT NULL,
    is_sent INTEGER NOT NULL CHECK (is_sent IN (0, 1)),
    sent_at INTEGER,
    changed_at INTEGER NOT NULL,
    changed_by TEXT NOT NULL
  )`,
];
const text = (value) => String(value ?? "").trim();

export async function ensureWarehouseDispatchSchema(db) {
  await ensureSchema(db);
}

async function ensureSchema(db) {
  if (!db?.prepare || !db?.batch) throw new CloudError("cloud_database_missing", "Облачное хранилище ещё не подключено.");
  let ready = schemaByDb.get(db);
  if (!ready) {
    ready = db.batch(SCHEMA.map((statement) => db.prepare(statement))).catch((error) => {
      schemaByDb.delete(db);
      throw error;
    });
    schemaByDb.set(db, ready);
  }
  await ready;
}

export async function listWarehouseCartonDispatch(db) {
  await ensureSchema(db);
  const result = await db.prepare("SELECT carton_id,shipment_id,is_sent,sent_at,changed_at,changed_by FROM ritm_warehouse_carton_dispatch").all();
  return new Map((result.results || []).map((row) => [String(row.carton_id), {
    shipmentId: String(row.shipment_id),
    status: Number(row.is_sent) === 1 ? "sent" : "pending",
    sentAt: Number.isFinite(Number(row.sent_at)) && row.sent_at !== null ? new Date(Number(row.sent_at)).toISOString() : null,
    changedAt: Number.isFinite(Number(row.changed_at)) ? new Date(Number(row.changed_at)).toISOString() : null,
    changedBy: text(row.changed_by),
  }]));
}

export async function setWarehouseCartonDispatch(db, { cartonId, shipmentId, status, changedBy, now = Date.now() }) {
  await ensureSchema(db);
  const id = text(cartonId), supplyId = text(shipmentId), actor = text(changedBy).slice(0, 80);
  if (!id || id.length > 160 || !supplyId || supplyId.length > 200 || !["sent", "pending"].includes(status) || !actor || !Number.isSafeInteger(now))
    throw new CloudError("warehouse_dispatch_invalid", "Не удалось подтвердить короб и его статус.", 400);

  const isSent = status === "sent" ? 1 : 0;
  const result = await db.prepare(`INSERT INTO ritm_warehouse_carton_dispatch
    (carton_id,shipment_id,is_sent,sent_at,changed_at,changed_by)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(carton_id) DO UPDATE SET
      is_sent=excluded.is_sent,
      sent_at=CASE WHEN excluded.is_sent=1 THEN COALESCE(ritm_warehouse_carton_dispatch.sent_at,excluded.sent_at) ELSE ritm_warehouse_carton_dispatch.sent_at END,
      changed_at=excluded.changed_at,
      changed_by=excluded.changed_by
    WHERE ritm_warehouse_carton_dispatch.shipment_id=excluded.shipment_id`).bind(
    id, supplyId, isSent, isSent ? now : null, now, actor,
  ).run();
  if (result.meta?.changes !== 1) throw new CloudError("warehouse_dispatch_conflict", "Этот короб уже связан с другой поставкой. Обновите склад.", 409);
  const row = await db.prepare("SELECT shipment_id,is_sent,sent_at,changed_at,changed_by FROM ritm_warehouse_carton_dispatch WHERE carton_id=?").bind(id).first();
  if (!row) throw new CloudError("warehouse_dispatch_unconfirmed", "Статус короба не подтвердился. Обновите склад перед повтором.", 503);
  return {
    cartonId: id,
    shipmentId: String(row.shipment_id),
    status: Number(row.is_sent) === 1 ? "sent" : "pending",
    sentAt: Number.isFinite(Number(row.sent_at)) && row.sent_at !== null ? new Date(Number(row.sent_at)).toISOString() : null,
    changedAt: Number.isFinite(Number(row.changed_at)) ? new Date(Number(row.changed_at)).toISOString() : null,
    changedBy: text(row.changed_by),
  };
}
