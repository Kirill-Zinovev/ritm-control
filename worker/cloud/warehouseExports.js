import { createHash } from "node:crypto";
import { CloudError } from "./access.js";
import { warehouseForSelection } from "./assemblyV2Warehouse.js";
import {
  listWarehouseCartonDispatch,
  listWarehouseDispatchSnapshots,
} from "./warehouseDispatch.js";
import { warehouseCartonFingerprint } from "../../src/warehouseFingerprint.js";
const ready = new WeakMap();
async function schema(db) {
  let promise = ready.get(db);
  if (!promise) {
    promise = db
      .prepare(
        "create table if not exists ritm_warehouse_exports(id text primary key not null,request_hash text not null,actor text not null,created_at text not null,carton_count integer not null,quantity integer not null,payload text not null)",
      )
      .run()
      .catch((e) => {
        ready.delete(db);
        throw e;
      });
    ready.set(db, promise);
  }
  await promise;
}
export const ensureWarehouseExportSchema=schema;
export async function warehouseExportRecords(db){await schema(db);return (await db.prepare('select * from ritm_warehouse_exports order by id').all()).results||[];}
export async function readWarehouseExports(db, id = null) {
  await schema(db);
  if (id) {
    if (!/^[a-f0-9-]{36}$/i.test(id))
      throw new CloudError(
        "warehouse_export_invalid",
        "Не подтверждена выгрузка.",
        400,
      );
    const row = await db
      .prepare("select payload from ritm_warehouse_exports where id=?")
      .bind(id)
      .first();
    if (!row)
      throw new CloudError(
        "warehouse_export_not_found",
        "Выгрузка не найдена.",
        404,
      );
    return JSON.parse(row.payload);
  }
  return (
    (
      await db
        .prepare(
          "select id,created_at,carton_count,quantity from ritm_warehouse_exports order by created_at desc,id desc limit 100",
        )
        .all()
    ).results || []
  );
}
export async function prepareWarehouseExport(
  input,
  bindings,
  store,
  { actor, fetcher = fetch } = {},
) {
  const requested = input?.cartons,
    key = input?.key;
  if (
    !/^[a-f0-9-]{36}$/i.test(key || "") ||
    !Array.isArray(requested) ||
    !requested.length ||
    requested.length > 100 ||
    new Set(requested.map((r) => r?.cartonId)).size !== requested.length ||
    requested.some(
      (r) =>
        typeof r?.cartonId !== "string" ||
        r.cartonId.length > 160 ||
        typeof r.fingerprint !== "string" ||
        r.fingerprint.length > 200000 ||
        !["pending", "sent"].includes(r.dispatchStatus),
    )
  )
    throw new CloudError(
      "warehouse_export_invalid",
      "Выберите от 1 до 100 коробов с проверенным составом.",
      400,
    );
  await schema(bindings.DB);
  const hash = createHash("sha256")
    .update(JSON.stringify(requested))
    .digest("hex");
  const previous = await bindings.DB.prepare(
    "select request_hash,actor,payload from ritm_warehouse_exports where id=?",
  )
    .bind(key)
    .first();
  if (previous) {
    if (previous.request_hash !== hash || previous.actor !== actor)
      throw new CloudError(
        "warehouse_export_conflict",
        "Ключ уже использован для другой выгрузки.",
        409,
      );
    return JSON.parse(previous.payload);
  }
  const [dispatch, saved] = await Promise.all([
    listWarehouseCartonDispatch(bindings.DB),
    listWarehouseDispatchSnapshots(bindings.DB),
  ]);
  const originals = new Map();
  for (const row of requested) {
    const box = saved.get(row.cartonId),
      state = dispatch.get(row.cartonId);
    if (
      row.dispatchStatus === "sent" &&
      state?.status === "sent" &&
      box &&
      warehouseCartonFingerprint(box) === row.fingerprint
    )
      originals.set(row.cartonId, {
        ...box,
        dispatchStatus: "sent",
        sentAt: state.sentAt,
      });
  }
  const live = requested.filter((r) => !originals.has(r.cartonId));
  const current = live.length
    ? await warehouseForSelection(
        live.map((r) => r.cartonId),
        bindings,
        store,
        { fetcher },
      )
    : { cartons: [] };
  const boxes = requested.map(
    (row) =>
      originals.get(row.cartonId) ||
      current.cartons.find((b) => b.id === row.cartonId),
  );
  for (let i = 0; i < requested.length; i++) {
    const box = boxes[i],
      row = requested[i];
    if (
      !box ||
      box.historicalSnapshotMissing ||
      warehouseCartonFingerprint(box) !== row.fingerprint ||
      (box.dispatchStatus || "pending") !== row.dispatchStatus
    )
      throw new CloudError(
        "warehouse_export_changed",
        "Состав или статус выбранного короба изменился. Обновите склад.",
        409,
      );
  }
  const payload = {
      id: key,
      createdAt: new Date(store.now()).toISOString(),
      cartons: boxes,
    },
    serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).length > 850000)
    throw new CloudError(
      "warehouse_export_too_large",
      "Состав слишком большой. Разделите выбор на несколько выгрузок.",
      400,
    );
  await bindings.DB.prepare(
    "insert into ritm_warehouse_exports(id,request_hash,actor,created_at,carton_count,quantity,payload) values(?,?,?,?,?,?,?) on conflict(id) do nothing",
  )
    .bind(
      key,
      hash,
      actor,
      payload.createdAt,
      boxes.length,
      boxes.reduce((n, b) => n + b.quantity, 0),
      serialized,
    )
    .run();
  const stored = await bindings.DB.prepare(
    "select request_hash,actor,payload from ritm_warehouse_exports where id=?",
  )
    .bind(key)
    .first();
  if (stored?.request_hash !== hash || stored?.actor !== actor)
    throw new CloudError(
      "warehouse_export_conflict",
      "Выгрузка не подтверждена. Повторите с прежним ключом.",
      409,
    );
  return JSON.parse(stored.payload);
}
