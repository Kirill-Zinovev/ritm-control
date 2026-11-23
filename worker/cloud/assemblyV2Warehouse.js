import { randomUUID } from "node:crypto";
import { CloudError } from "./access.js";
import { assemblyV2Configured, callAssemblyV2 } from "./assemblyV2Transport.js";
import { warehouseCartonFingerprint } from "../../src/warehouseFingerprint.js";
import { warehouseVisualNumberKey } from "../../src/warehouseNumber.js";
import { readWarehouseForDispatch } from "./warehouse.js";
import { listWarehouseCartonDispatch } from "./warehouseDispatch.js";

export function legacyCartonComparison(box) {
  const contents = box.contents
    .map((i) => [i.shipmentId || "", i.positionId, i.article, i.quantity])
    .sort((a, b) =>
      JSON.stringify(a) < JSON.stringify(b)
        ? -1
        : JSON.stringify(a) > JSON.stringify(b)
          ? 1
          : 0,
    );
  return JSON.stringify([box.number, box.status, box.quantity, contents]);
}
const invalid = () =>
  new CloudError(
    "assembly_v2_warehouse_invalid",
    "«RITM Сборка» не подтвердила полный список коробов. Предыдущие данные сохранены.",
    503,
  );
function validBox(box, kind) {
  return (
    box?.sourceSystem === "assembly-v2" &&
    box.sourceKind === kind &&
    typeof box.assemblyV2Id === "string" &&
    box.assemblyV2Id.length <= 200 &&
    typeof box.id === "string" &&
    typeof box.number === "string" &&
    ["open", "closed"].includes(box.status) &&
    ["sent", "pending"].includes(box.dispatchStatus) &&
    Number.isSafeInteger(box.quantity) &&
    box.quantity >= 0 &&
    Array.isArray(box.contents) &&
    box.contents.every(
      (i) =>
        typeof i.article === "string" &&
        typeof i.positionId === "string" &&
        Number.isSafeInteger(i.quantity) &&
        i.quantity > 0,
    ) &&
    box.quantity === box.contents.reduce((n, i) => n + i.quantity, 0) &&
    Array.isArray(box.issues) &&
    Array.isArray(box.history)
  );
}
export async function readAssemblyV2Warehouse(
  bindings,
  store,
  { fetcher = fetch, force = false } = {},
) {
  if (!assemblyV2Configured(bindings)) return null;
  const cached = await store.snapshot("warehouse-v2");
  if (!force && cached && store.now() - cached.at < 15000)
    return { ...cached.value, stale: false };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let revision = null,
        changed = false;
      const result = { cartons: [], stockCartons: [] };
      for (const kind of ["direction", "warehouse"]) {
        let cursor = "",
          total = null;
        const list = [];
        const cursors = new Set();
        do {
          const params = new URLSearchParams({ kind });
          if (cursor) params.set("cursor", cursor);
          if (revision !== null) params.set("revision", String(revision));
          const response = await callAssemblyV2(
            bindings,
            "/api/ritm/warehouse?" + params,
            { fetcher },
          );
          if (response.status === 409) {
            await response.body?.cancel();
            changed = true;
            break;
          }
          if (
            !response.ok ||
            !response.headers.get("content-type")?.includes("application/json")
          ) {
            await response.body?.cancel();
            throw invalid();
          }
          const raw = await response.text();
          if (raw.length > 4_000_000) throw invalid();
          const page = JSON.parse(raw);
          if (
            page?.ok !== true ||
            page.format !== "assembly-v2-warehouse" ||
            page.version !== 1 ||
            page.kind !== kind ||
            !Number.isSafeInteger(page.revision) ||
            !Number.isSafeInteger(page.total) ||
            page.total < 0 ||
            page.total > 5000 ||
            !Array.isArray(page.cartons) ||
            page.cartons.length > 100 ||
            page.cartons.some((b) => !validBox(b, kind)) ||
            ![null, "string"].includes(
              page.nextCursor === null ? null : typeof page.nextCursor,
            )
          )
            throw invalid();
          if (
            (revision !== null && page.revision !== revision) ||
            (total !== null && total !== page.total)
          )
            throw invalid();
          revision = page.revision;
          total = page.total;
          list.push(...page.cartons);
          if (
            page.nextCursor !== null &&
            (page.nextCursor.length > 200 ||
              cursors.has(page.nextCursor) ||
              !page.cartons.length)
          )
            throw invalid();
          cursor = page.nextCursor;
          if (cursor) cursors.add(cursor);
        } while (cursor);
        if (changed) break;
        if (
          list.length !== total ||
          new Set(list.map((b) => b.id)).size !== list.length
        )
          throw invalid();
        result[kind === "direction" ? "cartons" : "stockCartons"] = list;
      }
      if (changed) continue;
      const value = {
        ...result,
        revision,
        checkedAt: new Date(store.now()).toISOString(),
        stale: false,
      };
      let lease;
      try {
        lease = await store.acquire("refresh:warehouse-v2", 15000);
        await store.saveSnapshot("warehouse-v2", value, lease);
      } finally {
        if (lease) await store.release(lease);
      }
      return value;
    }
    throw invalid();
  } catch (error) {
    if (cached)
      return {
        ...cached.value,
        stale: true,
        staleReason:
          "«RITM Сборка» временно недоступна. Короба показаны по последнему снимку.",
      };
    return {
      cartons: [],
      stockCartons: [],
      checkedAt: null,
      stale: true,
      staleReason:
        "Не удалось получить короба «RITM Сборка». Повторите обновление.",
    };
  }
}
export function mergeAssemblyWarehouses(legacy, modern) {
  if (!modern) return legacy;
  const merge = (oldBoxes, newBoxes) => {
    const byId = new Map(
      oldBoxes.map((b) => [
        b.id,
        { ...b, sourceSystem: "legacy", sourceStale: !!legacy.stale },
      ]),
    );
    for (const box of newBoxes) {
      if (
        box.sourceKind === "direction" &&
        !/^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i.test(
          box.shipmentId,
        )
      )
        continue;
      const current = byId.get(box.id),
        next = { ...box, sourceStale: !!modern.stale };
      if (!box.legacyId) byId.set(box.id, next);
      else if (!current) {
        // Keep the legacy roster rule: a fresh old snapshot has deliberately
        // excluded deleted production sources. A copied pending carton must
        // not bring such a source back into active warehouse totals.
        if(!box.modifiedInV2 && box.dispatchStatus!=='sent' && !legacy.stale)continue;
        byId.set(box.id, {
          ...next,
          archivedSourceUnavailable: !!box.archivedSourceUnavailable || !box.modifiedInV2,
          sourceStale: !!modern.stale || !box.modifiedInV2,
        });
      }
      else if (
        box.modifiedInV2 ||
        (box.legacyBaseline === legacyCartonComparison(current) &&
          box.dispatchStatus === (current.dispatchStatus || "pending"))
      ) {
        if (box.legacyBaseline === legacyCartonComparison(current))
          byId.set(box.id, {
            ...next,
            sourceStale: !!modern.stale || !!legacy.stale,
          });
        else
          byId.set(box.id, {
            ...current,
            ready: false,
            dispatchBlocked: true,
            issues: [
              ...current.issues,
              "Короб изменён в обеих версиях сборки. Требуется сверка состава.",
            ],
          });
      }
    }
    const boxes = [...byId.values()],
      numbers = new Map();
    for (const box of boxes) {
      const key = warehouseVisualNumberKey(box.number);
      numbers.set(key, [...(numbers.get(key) || []), box]);
    }
    for (const same of numbers.values())
      if (same.length > 1)
        for (const box of same) {
          box.ready = false;
          box.dispatchBlocked = true;
          box.issues = [
            ...box.issues,
            "Номер короба повторяется в обеих версиях сборки. Требуется сверка.",
          ];
        }
    return boxes;
  };
  return {
    ...legacy,
    cartons: merge(legacy.cartons || [], modern.cartons),
    stockCartons: merge(legacy.stockCartons || [], modern.stockCartons),
    assemblyV2: {
      checkedAt: modern.checkedAt,
      revision: modern.revision,
      stale: modern.stale,
    },
    stale: !!legacy.stale || modern.stale,
    staleReason: [
      legacy.stale ? legacy.staleReason : "",
      modern.stale ? modern.staleReason : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

// Archived cartons do not return to the live warehouse totals. A copied box
// can be used by the import flow only after both sources independently agree.
export function reconcileArchivedWarehouse(legacy, modern, dispatch = new Map()) {
  const activeIds = new Set((legacy.cartons || []).map((box) => box.id));
  const safeCatalogIssues = new Set(["Магазин не подтверждён для всех товаров", "Тип короба не подтверждён"]);
  return (legacy.archivedCartons || []).filter((box) => !activeIds.has(box.id)).map((old) => {
    const copies = (modern?.cartons || []).filter((box) => box.id === old.id && box.legacyId === old.id);
    const copy = copies.length === 1 ? copies[0] : null;
    const previous = dispatch.get(old.id);
    const sent = previous?.shipmentId === old.shipmentId && previous.status === "sent";
    const badLegacy = (old.issues || []).some((issue) => !safeCatalogIssues.has(issue));
    const storeInNumber = String(old.number || "").match(/^(\d+)/)?.[1] || "";
    const sameBox = copy && copy.sourceSystem === "assembly-v2" && copy.sourceKind === "direction" &&
      /^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i.test(old.shipmentId || "") &&
      copy.shipmentId === old.shipmentId && copy.number === old.number && copy.directionId === old.directionId && copy.market === old.market &&
      copy.createdAt === old.createdAt && copy.closedAt === old.closedAt &&
      copy.legacyBaseline === legacyCartonComparison(old) &&
      legacyCartonComparison(copy) === legacyCartonComparison(old) &&
      (!old.boxType || String(copy.boxType || "").trim().toLocaleLowerCase("ru-RU") === String(old.boxType).trim().toLocaleLowerCase("ru-RU")) &&
      storeInNumber && Number(copy.store) === Number(storeInNumber);
    const verified = !legacy.stale && modern && !modern.stale && sameBox && !copy.modifiedInV2 && copy.dispatchStatus === "pending" &&
      old.status === "closed" && Number.isFinite(Date.parse(old.closedAt)) && old.quantity > 0 &&
      !badLegacy && !copy.issues.length && !copy.reserved && !copy.dispatchBlocked && !copy.archivedSourceUnavailable && !copy.historicalSnapshotMissing &&
      (!previous || previous.shipmentId === old.shipmentId) && !sent;
    if (verified) return { ...copy, archivedOrigin: true, sourceStale: false, dispatchBlocked: false };
    return {
      ...old, archivedOrigin: true, dispatchStatus: sent || copy?.dispatchStatus === "sent" ? "sent" : "pending",
      sourceStale: !!legacy.stale || !modern || !!modern.stale,
      dispatchBlocked: true,
      issues: [...new Set([...(old.issues || []), "Архивный короб требует сверки с «RITM Сборка»."])],
    };
  });
}
export async function warehouseForSelection(
  ids,
  bindings,
  store,
  { fetcher = fetch, reader } = {},
) {
  const [modern, legacy] = await Promise.all([
    readAssemblyV2Warehouse(bindings, store, { fetcher, force: true }),
    ids.every((id) => id.startsWith("av2:"))
      ? Promise.resolve({ cartons: [], stockCartons: [], stale: false })
      : readWarehouseForDispatch(bindings, store, { fetcher, reader }),
  ]);
  const merged = mergeAssemblyWarehouses(legacy, modern);
  const hasArchived = ids.some((id) => (legacy.archivedCartons || []).some((box) => box.id === id));
  const dispatch = hasArchived ? await listWarehouseCartonDispatch(bindings.DB) : new Map();
  const known = new Set(merged.cartons.map((box) => box.id));
  const archived = hasArchived ? reconcileArchivedWarehouse(legacy, modern, dispatch).filter((box) => !known.has(box.id)) : [];
  const cartons = [...merged.cartons, ...archived];
  const numbers = new Map();
  for (const box of cartons) {
    const key = warehouseVisualNumberKey(box.number);
    numbers.set(key, (numbers.get(key) || 0) + 1);
  }
  for (const id of ids) {
    const box = cartons.find((b) => b.id === id);
    if (!box || box.sourceStale || box.dispatchBlocked || numbers.get(warehouseVisualNumberKey(box.number)) !== 1)
      throw new CloudError(
        "warehouse_carton_unconfirmed",
        "Короб изменён или его свежий состав не подтверждён. Обновите склад.",
        409,
      );
  }
  return { ...merged, cartons };
}
export async function dispatchAssemblyV2(
  box,
  input,
  bindings,
  { fetcher = fetch } = {},
) {
  if (box.sourceSystem !== "assembly-v2" || !box.assemblyV2Id)
    throw new CloudError(
      "warehouse_dispatch_invalid",
      "Не подтверждён источник короба.",
      409,
    );
  const response = await callAssemblyV2(
    bindings,
    "/api/ritm/warehouse/dispatch",
    {
      method: "POST",
      fetcher,
      body: JSON.stringify({
        key: input.key || randomUUID(),
        cartonId: box.assemblyV2Id,
        status: input.status,
        fingerprint: warehouseCartonFingerprint(box),
        changedBy: input.changedBy,
      }),
    },
  );
  const body = await response.json().catch(() => null);
  if (
    !response.ok ||
    body?.ok !== true ||
    body.dispatch?.cartonId !== box.id ||
    body.dispatch?.status !== input.status
  )
    throw new CloudError(
      "assembly_v2_dispatch_unconfirmed",
      body?.error ||
        "Отправка в «RITM Сборка» не подтверждена. Обновите склад перед повтором.",
      response.status === 409 ? 409 : 503,
    );
  await bindings.DB?.prepare("update cloud_snapshots set updated_at=0 where kind='warehouse-v2'").run();
  return {
    ...body.dispatch,
    shipmentId: box.shipmentId,
    changedBy: input.changedBy,
  };
}
