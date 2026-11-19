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
  `CREATE TABLE IF NOT EXISTS ritm_warehouse_dispatch_snapshots (
    carton_id TEXT PRIMARY KEY NOT NULL,
    shipment_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
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

export async function listWarehouseDispatchSnapshots(db) {
  await ensureSchema(db);
  const result = await db.prepare("SELECT carton_id,shipment_id,snapshot_json FROM ritm_warehouse_dispatch_snapshots").all();
  const snapshots = new Map();
  for (const row of result.results || []) {
    try {
      const box = JSON.parse(row.snapshot_json);
      if (box && box.id === row.carton_id && box.shipmentId === row.shipment_id && Array.isArray(box.contents)) snapshots.set(String(row.carton_id), box);
    } catch { /* An invalid snapshot must never replace confirmed live data. */ }
  }
  return snapshots;
}

export async function setWarehouseCartonDispatch(db, { cartonId, shipmentId, status, changedBy, cartonSnapshot = null, now = Date.now() }) {
  await ensureSchema(db);
  const id = text(cartonId), supplyId = text(shipmentId), actor = text(changedBy).slice(0, 80);
  if (!id || id.length > 160 || !supplyId || supplyId.length > 200 || !["sent", "pending"].includes(status) || !actor || !Number.isSafeInteger(now))
    throw new CloudError("warehouse_dispatch_invalid", "Не удалось подтвердить короб и его статус.", 400);

  const isSent = status === "sent" ? 1 : 0;
  const statement = db.prepare(`INSERT INTO ritm_warehouse_carton_dispatch
    (carton_id,shipment_id,is_sent,sent_at,changed_at,changed_by)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(carton_id) DO UPDATE SET
      is_sent=excluded.is_sent,
      sent_at=CASE WHEN excluded.is_sent=1 AND ritm_warehouse_carton_dispatch.is_sent=0 THEN excluded.sent_at WHEN excluded.is_sent=1 THEN COALESCE(ritm_warehouse_carton_dispatch.sent_at,excluded.sent_at) ELSE ritm_warehouse_carton_dispatch.sent_at END,
      changed_at=excluded.changed_at,
      changed_by=excluded.changed_by
    WHERE ritm_warehouse_carton_dispatch.shipment_id=excluded.shipment_id`).bind(
    id, supplyId, isSent, isSent ? now : null, now, actor,
  );
  let result;
  if (isSent && cartonSnapshot && cartonSnapshot.id === id && cartonSnapshot.shipmentId === supplyId) {
    const snapshotJson = JSON.stringify(cartonSnapshot);
    if (snapshotJson.length > 200000) throw new CloudError("warehouse_snapshot_too_large", "Состав короба слишком велик для сохранения. Статус не изменён.", 400);
    const stored = db.prepare(`INSERT INTO ritm_warehouse_dispatch_snapshots (carton_id,shipment_id,snapshot_json,recorded_at)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM ritm_warehouse_carton_dispatch WHERE carton_id=? AND shipment_id=? AND is_sent=1)
      ON CONFLICT(carton_id) DO UPDATE SET shipment_id=excluded.shipment_id,snapshot_json=excluded.snapshot_json,recorded_at=excluded.recorded_at
      WHERE ritm_warehouse_dispatch_snapshots.shipment_id=excluded.shipment_id
        AND ritm_warehouse_dispatch_snapshots.recorded_at < (SELECT sent_at FROM ritm_warehouse_carton_dispatch WHERE carton_id=excluded.carton_id)`).bind(id,supplyId,snapshotJson,now,id,supplyId);
    [result] = await db.batch([statement, stored]);
  } else result = await statement.run();
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
