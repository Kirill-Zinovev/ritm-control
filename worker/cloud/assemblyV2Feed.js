import { createHmac } from "node:crypto";
import { CloudError, json } from "./access.js";
import { cloudConfig, sourceId } from "./config.js";
import { shipmentLock } from "./shipmentLocks.js";
import { boxRemovalKind } from "./boxPositionRemoval.js";
import { physicalShipmentId, productionOperationPending, productionOperationTarget } from "./productionOperationTarget.js";

const PATH = "/api/assembly-v2/feed";
function assemblyPhoto(value) {
  try {
    const u = new URL(String(value || ""));
    return u.protocol === "https:" && !u.username && !u.password && !u.port
      && /^(?:basket-\d+\.wbbasket\.ru|mow-basket-cdn-\d+\.geobasket\.ru)$/.test(u.hostname)
      && /^\/vol\d+\/part\d+\/\d+\/images\//.test(u.pathname) ? u.href : "";
  } catch { return ""; }
}
const terminal = new Set([
  "verified",
  "verified_with_calculation_errors",
  "cancelled",
]);
const shipmentId = /^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i;
const fail = (code, message, status = 409) => {
  throw new CloudError(code, message, status);
};
export function feedSignature(secret, { path, at, nonce }) {
  return createHmac("sha256", secret)
    .update(JSON.stringify([1, "GET", path, at, nonce]))
    .digest("hex");
}
export function verifyAssemblyV2Feed(request, bindings, now = Date.now()) {
  const url = new URL(request.url),
    secret = bindings.RITM_ASSEMBLY_V2_FEED_SECRET;
  if (request.method !== "GET" || url.pathname !== PATH)
    fail("method_not_allowed", "Метод запроса не поддерживается.", 405);
  if (!/^[a-f0-9]{64}$/.test(secret || ""))
    fail(
      "assembly_v2_unconfigured",
      "Отдельная связь с новым Assembly ещё не настроена.",
      503,
    );
  const at = request.headers.get("x-assembly-v2-at") || "",
    nonce = request.headers.get("x-assembly-v2-nonce") || "",
    signature = request.headers.get("x-assembly-v2-signature") || "";
  if (
    !/^\d{13}$/.test(at) ||
    Math.abs(now - Number(at)) > 120000 ||
    !/^[a-f0-9-]{36}$/i.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    fail(
      "assembly_v2_forbidden",
      "Служебная связь с новым Assembly не подтверждена.",
      403,
    );
  const expected = feedSignature(secret, {
    path: url.pathname + url.search,
    at,
    nonce,
  });
  let mismatch = 0;
  for (let i = 0; i < 64; i++)
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (mismatch)
    fail(
      "assembly_v2_forbidden",
      "Служебная связь с новым Assembly не подтверждена.",
      403,
    );
}
function market(name) {
  const s = String(name).toUpperCase(),
    ozon = /(?:^|[^\p{L}\p{N}])(?:OZON|ОЗОН)(?=$|[^\p{L}\p{N}])/u.test(s),
    wb = /(?:^|[^\p{L}\p{N}])(?:WB|ВБ|WILDBERRIES)(?=$|[^\p{L}\p{N}])/u.test(s);
  return ozon === wb ? null : ozon ? "OZON" : "WB";
}
const key = (o) =>
  `${o.rawUid ? `uid:${o.rawUid}` : `row:${o.row}`}|${o.article}`;
const rootId = (o) =>
  o.assemblyShipmentId ||
  `RITM-${o.sourceId === "box-printing" ? "BOX" : "ROLL"}-${o.sheetId}`;

export function buildAssemblyV2Feed({
  snapshot,
  scope,
  now,
  maxAgeMs = 300000,
  documents,
}) {
  if (scope.meta("migrationReady") !== true)
    fail(
      "assembly_v2_source_unconfirmed",
      "Реестр РИТМ пока не подтверждён. Предыдущие поставки нового Assembly сохранены.",
    );
  if (
    !snapshot ||
    !Number.isSafeInteger(snapshot.at) ||
    snapshot.at > now + 60000 ||
    now - snapshot.at >= maxAgeMs
  )
    fail(
      "assembly_v2_source_stale",
      "РИТМ ещё не подтвердил свежий снимок поставок. Обновите поставки в РИТМ; прежние данные нового Assembly сохранены.",
      503,
    );
  const p = snapshot.value;
  if (
    p?.ok !== true ||
    !Array.isArray(p.supplies) ||
    !Array.isArray(p.sheets) ||
    !["valid", "partial"].includes(p.quality?.status)
  )
    fail(
      "assembly_v2_source_invalid",
      "Снимок поставок РИТМ не прошёл проверку.",
    );
  if (
    (p.productionMoveRevision || null) !==
    (scope.meta("printingMoveRevision") || null)
  )
    fail(
      "assembly_v2_source_changed",
      "РИТМ обновляет состав участков после переноса. Предыдущий состав сохранён.",
    );
  const operations = [...scope.operations.values()];
  if ((p.productionSupplyRevision || null) !== (scope.meta("productionSupplyRevision") || null))
    fail("assembly_v2_snapshot_pending", "Новая поставка сохранена. Обновляем общий состав автоматически.");
  // Only status/timestamps are needed here; cloning historical write plans
  // twice can exhaust the Worker while a fresh snapshot is already in memory.
  const productionRows = operations.filter(row => row.kind === "production");
  const productionOperations = productionRows.length ? productionRows.map(row => row.value) : scope.meta("productionSupplyOperations") || [];
  const pendingProduction = productionOperations.filter(productionOperationPending);
  // During a confirmed removal delivery, safe compositions can advance while
  // a different, precisely identified production request is still in review.
  // Retain that request's entire roster (including sheet aliases) and never
  // feed its provisional quantities to Assembly. Unscoped requests still
  // require the usual full stop.
  const hold = new Map();
  if (pendingProduction.length && scope.boxRemovalsPendingDelivery?.size) {
    for (const op of pendingProduction) {
      const target = productionOperationTarget(op);
      if (!target || target.parts.some(part => part.documentId !== documents[`${part.department}-printing`])) {
        hold.clear();
        break;
      }
      const title = target.name || target.id;
      hold.set(target.id, title);
      for (const part of target.parts) {
        hold.set(physicalShipmentId(part), title);
        for (const sheet of p.sheets)
          if (sheet.sourceId === `${part.department}-printing` &&
              sheet.sheetId === part.sheetId && sheet.spreadsheetId === part.documentId &&
              shipmentId.test(sheet.assemblyShipmentId || ""))
            hold.set(sheet.assemblyShipmentId, title);
      }
    }
  }
  const independentRemoval = hold.size > 0 && operations.some(({kind, value}) =>
    kind === boxRemovalKind && value.status === "verified" &&
    scope.boxRemovalsPendingDelivery.has(value.id) &&
    shipmentId.test(value.shipmentId || "") && !hold.has(value.shipmentId) &&
    Date.parse(value.updatedAt) <= snapshot.at);
  const moves = operations.filter(r => r.kind === "production-department-move" && !terminal.has(r.value.status));
  const heldMoves = p.assemblyHeldMoves || [];
  const removals = operations.filter(r => r.kind === boxRemovalKind && !terminal.has(r.value.status));
  const heldRemovals = p.assemblyHeldRemovals || [];
  const matchingMoves = heldMoves.length === moves.length &&
    moves.every(r => heldMoves.some(target => target.moveId === r.value.id));
  const matchingRemovals = heldRemovals.length === removals.length && removals.every(({value}) =>
    heldRemovals.some(target => target.operationId === value.id && target.id === value.shipmentId &&
      target.sheetId === value.identity?.sheetId));
  if (!matchingMoves || !matchingRemovals ||
      (pendingProduction.length > 0 && !independentRemoval))
    fail("assembly_v2_source_busy", "РИТМ ещё подтверждает изменение поставки. Повторим чтение после завершения операции.");
  for (const target of heldRemovals) {
    hold.set(target.id, target.name);
    hold.set(physicalShipmentId({department:"box",sheetId:target.sheetId}), target.name);
    for (const sheet of p.sheets)
      if (sheet.sourceId === "box-printing" && sheet.sheetId === target.sheetId &&
          shipmentId.test(sheet.assemblyShipmentId || "")) hold.set(sheet.assemblyShipmentId, target.name);
  }
  for (const target of heldMoves) {
    hold.set(target.id, target.name);
    for (const part of target.parts) {
      hold.set(physicalShipmentId(part), target.name);
      for (const sheet of p.sheets)
        if (sheet.sourceId === part.department + "-printing" && sheet.sheetId === part.sheetId &&
            shipmentId.test(sheet.assemblyShipmentId || "")) hold.set(sheet.assemblyShipmentId, target.name);
    }
  }
  if (
    productionOperations.some(
      (o) =>
        !productionOperationPending(o) && o.status !== "cancelled" &&
        Date.parse(o.updatedAt || o.createdAt) > snapshot.at,
    )
  )
    fail(
      "assembly_v2_snapshot_pending",
      "Изменение поставки подтверждено; ожидается обновление общего снимка РИТМ.",
    );
  if (
    p.quality.status === "partial" &&
    (!Array.isArray(p.issues) || p.issues.some((i) => !i?.source))
  )
    fail(
      "assembly_v2_source_partial",
      "Источник РИТМ неполный. Прежний состав нового Assembly сохранён.",
    );
  const registry = new Map(
    (scope.meta("productionSupplies") || []).map((s) => [s.id, s]),
  );
  const sheets = new Map(
    p.sheets
      .filter((s) => ["roll-printing", "box-printing"].includes(s.sourceId))
      .map((s) => [`${s.sourceId}:${s.sheetId}`, s]),
  );
  const explicit = new Map();
  for (const e of scope.syncEvents()) {
    if (e.action !== "transfer" || e.outcome !== "synced" || !e.payload)
      continue;
    try {
      const t = JSON.parse(e.payload).transfer;
      if (
        !t ||
        !["roll", "box"].includes(t.department) ||
        !Array.isArray(t.keys)
      )
        continue;
      const k = `${t.department}-printing:${t.sheetId}`;
      explicit.set(k, new Set([...(explicit.get(k) || []), ...t.keys]));
    } catch {}
  }
  const groups = new Map(),
    issues = [],
    active = new Set();
  const issue = (id, title, message) => {
    if (!issues.some((i) => i.shipmentId === id && i.message === message))
      issues.push({ shipmentId: id, title, message });
  };
  for (const s of registry.values())
    if (shipmentId.test(s.id)) active.add(s.id);
  for (const [id, title] of hold) {
    active.add(id);
    issue(id, title, "РИТМ ещё сверяет изменение этой поставки. Предыдущий состав сохранён.");
  }
  for (const o of p.supplies) {
    if (!["roll-printing", "box-printing"].includes(o.sourceId)) continue;
    const id = rootId(o),
      s = sheets.get(`${o.sourceId}:${o.sheetId}`),
      managed = id.startsWith("RITM-SUPPLY-");
    if (!shipmentId.test(id) || (managed && !registry.has(id))) continue;
    // Unlinked box tabs are transferred only after the existing explicit receipt.
    if (
      o.sourceId === "box-printing" &&
      !o.assemblyShipmentId &&
      !explicit.get(`${o.sourceId}:${o.sheetId}`)?.has(key(o))
    )
      continue;
    active.add(id);
    const title = registry.get(id)?.name || s?.name || o.sheetName;
    if (
      !s ||
      s.spreadsheetId !== o.spreadsheetId ||
      o.spreadsheetId !== documents[o.sourceId] ||
      String(s.assemblyShipmentId || id) !== id
    ) {
      issue(
        id,
        title,
        "Не удалось подтвердить источник позиции и связь участков.",
      );
      continue;
    }
    if (
      (p.issues || []).some(
        (i) =>
          i.source === s.name ||
          i.source === s.sourceId ||
          i.source === s.sourceName ||
          String(i.source).endsWith(` · ${s.name}`),
      )
    ) {
      issue(
        id,
        title,
        "В исходном листе есть ошибки данных. Предыдущий состав сохранён.",
      );
      continue;
    }
    if (
      !market(title) ||
      typeof o.article !== "string" ||
      !o.article.trim() ||
      !Number.isSafeInteger(o.quantity) ||
      o.quantity < 1 ||
      !Number.isSafeInteger(o.row) ||
      o.row < 1 ||
      !Number.isSafeInteger(o.sheetId) ||
      o.sheetId < 1
    ) {
      issue(
        id,
        title,
        "Проверьте маркетплейс, артикул, план и исходные ID поставки.",
      );
      continue;
    }
    const group = groups.get(id) || {
      shipmentId: id,
      title,
      market: market(title),
      // Match the canonical shipment lock used by RITM and old Assembly.
      locked: shipmentLock(scope, id).locked,
      positions: [],
    };
    const positionId = `${id}|${o.sourceId === "box-printing" ? `box:${o.sheetId}|` : ""}${key(o)}`;
    if (group.positions.some((p) => p.positionId === positionId)) {
      issue(id, title, "Повторяются исходные ID позиций.");
      continue;
    }
    const photoUrl = assemblyPhoto(o.photoUrl);
    group.positions.push({
      positionId,
      sku: o.article.trim(),
      ...(photoUrl ? {photoUrl} : {}),
      name: typeof o.productName === "string" ? o.productName : "",
      quantity: o.quantity,
      sourceId: o.sourceId,
      sheetId: o.sheetId,
      row: o.row,
      rawUid: o.rawUid || null,
      store: o.shopCatalogStatus === "matched" ? String(o.shop || "") : "",
      storeStatus: o.shopCatalogStatus || "unknown",
      unitsPerBox: o.shopCatalogStatus === "matched" && Number.isSafeInteger(o.catalogUnitsPerBox) && o.catalogUnitsPerBox > 0 ? o.catalogUnitsPerBox : null,
    });
    groups.set(id, group);
  }
  for (const s of registry.values()) {
    for (const part of s.parts || []) {
      const descriptor = sheets.get(
        `${part.department}-printing:${part.sheetId}`,
      );
      if (
        !descriptor ||
        descriptor.spreadsheetId !== part.documentId ||
        descriptor.assemblyShipmentId !== s.id
      )
        issue(
          s.id,
          s.name,
          "Общий снимок ещё не подтверждает полный состав обоих участков.",
        );
    }
    if (!groups.has(s.id)) {
      const removed = operations.some(({kind, value}) =>
        value.action === "removeItem" && value.status === "verified" && Date.parse(value.updatedAt) <= snapshot.at &&
        (kind === boxRemovalKind ? value.shipmentId === s.id && value.wasLastSource === true
          : kind === "roll" && value.result?.shipmentId === s.id && value.result?.wasLastSource === true));
      const remainingSource = p.supplies.some(order => rootId(order) === s.id);
      if (removed && !remainingSource && p.quality.status === "valid" && !issues.some(i => i.shipmentId === s.id)) {
        const hasAssemblyItems = operations.some(r => r.kind === "assembly-only-item" &&
          r.value.shipmentId === s.id && r.value.status !== "removed");
        if (hasAssemblyItems && market(s.name)) {
          groups.set(s.id, { shipmentId: s.id, title: s.name, market: market(s.name), locked: shipmentLock(scope, s.id).locked, positions: [] });
        } else if (!hasAssemblyItems) {
          active.delete(s.id);
        }
        if (!hasAssemblyItems || groups.has(s.id)) continue;
      }
      issue(
        s.id,
        s.name,
        "В подтверждённом снимке ещё нет позиций этой поставки.",
      );
    }
  }
  for (const r of operations.filter(
    (r) => r.kind === "assembly-only-item" && r.value?.status !== "removed",
  )) {
    const item = r.value,
      g = groups.get(item.shipmentId);
    if (!g) continue;
    if (item.status === "removing") {
      issue(
        g.shipmentId,
        g.title,
        "РИТМ ещё подтверждает удаление дополнительного товара.",
      );
      continue;
    }
    if (
      typeof item.positionId !== "string" ||
      !item.positionId.startsWith(`${g.shipmentId}|manual:`) ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1
    ) {
      issue(
        g.shipmentId,
        g.title,
        "Не подтверждено происхождение дополнительного товара.",
      );
      continue;
    }
    g.positions.push({
      positionId: item.positionId,
      sku: item.article,
      name: "",
      quantity: item.quantity,
      sourceId: "assembly-only",
      sheetId: null,
      row: null,
      rawUid: item.id,
      store: "",
      storeStatus: "unknown",
    });
  }
  const blocked = new Set(issues.map((i) => i.shipmentId));
  // A lock checkpoint can change independently of the printing snapshot.
  let sourceRevision = snapshot.at;
  for (const id of groups.keys()) {
    const changedAt = Date.parse(shipmentLock(scope, id).changedAt || "");
    if (Number.isFinite(changedAt) && changedAt > sourceRevision) {
      if (changedAt > now + 60000)
        fail(
          "assembly_v2_lock_unconfirmed",
          "Время подтверждения замка РИТМ требует проверки.",
        );
      sourceRevision = changedAt;
    }
  }
  return {
    format: "ritm-assembly-v2",
    version: 1,
    sourceRevision,
    sourceAt: new Date(sourceRevision).toISOString(),
    activeShipmentIds: [...active].sort(),
    supplies: [...groups.values()]
      .filter((g) => !blocked.has(g.shipmentId))
      .map((g) => ({
        ...g,
        positions: g.positions.sort((a, b) =>
          a.positionId.localeCompare(b.positionId),
        ),
      }))
      .sort((a, b) => a.shipmentId.localeCompare(b.shipmentId)),
    issues,
  };
}

export async function assemblyV2Feed(request, bindings, store) {
  verifyAssemblyV2Feed(request, bindings, store.now());
  const snapshotReadAllowed = async () => typeof store.productionSnapshotReadAllowed === "function"
    ? await store.productionSnapshotReadAllowed()
    : !await store.leaseIsActive("production");
  if (!await snapshotReadAllowed())
    fail(
      "assembly_v2_source_busy",
      "В РИТМ выполняется изменение поставок. Предыдущие данные нового Assembly сохранены.",
    );
  const snapshot = await (store.assemblySourceSnapshot ? store.assemblySourceSnapshot() : store.snapshot("printing")),
    scope = await (store.assemblyFeedContext ? store.assemblyFeedContext() : store.scope());
  const feed = buildAssemblyV2Feed({
    snapshot,
    scope,
    now: store.now(),
    maxAgeMs: cloudConfig(bindings).snapshotMaxAgeMs,
    documents: {
      "roll-printing": sourceId(bindings, "rollPrintingId"),
      "box-printing": sourceId(bindings, "boxPrintingId"),
    },
  });
  if (!await snapshotReadAllowed())
    fail(
      "assembly_v2_source_busy",
      "Состав РИТМ изменяется. Повторим чтение после подтверждения.",
    );
  return json(feed);
}
