import { createHash, createHmac } from "node:crypto";
import { CloudError, json } from "./access.js";
import { workLogRecords, summarizeAssemblyDays } from "../assembly.js";
import { reconcileAssemblySources } from "../assemblyReconciliation.js";
import { attachAssemblyPacking } from "../../agent/assemblyPacking.js";

export const eventSignature = (secret, { path, at, nonce, body }) =>
  createHmac("sha256", secret)
    .update(
      JSON.stringify([
        1,
        "POST",
        path,
        at,
        nonce,
        createHash("sha256").update(body).digest("hex"),
      ]),
    )
    .digest("hex");
const fail = (code, message, status = 409) => {
  throw new CloudError(code, message, status);
};
export async function receiveAssemblyV2Events(request, bindings, store) {
  const path = "/api/assembly-v2/events",
    secret = bindings.RITM_ASSEMBLY_V2_FEED_SECRET;
  if (request.method !== "POST")
    fail("method_not_allowed", "Ожидается POST.", 405);
  if (!/^[a-f0-9]{64}$/.test(secret || ""))
    fail(
      "assembly_v2_unconfigured",
      "Связь с новым Assembly не настроена.",
      503,
    );
  const at = request.headers.get("x-assembly-v2-at") || "",
    nonce = request.headers.get("x-assembly-v2-nonce") || "",
    signature = request.headers.get("x-assembly-v2-signature") || "";
  if (
    !/^\d{13}$/.test(at) ||
    Math.abs(store.now() - Number(at)) > 120000 ||
    !/^[a-f0-9-]{36}$/i.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    fail("assembly_v2_forbidden", "Подпись Assembly не подтверждена.", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    fail("json_required", "Ожидается JSON.", 415);
  const body = await request.text();
  if (body.length > 256000)
    fail("body_too_large", "Слишком большой пакет.", 413);
  const expected = eventSignature(secret, { path, at, nonce, body });
  let mismatch = 0;
  for (let i = 0; i < 64; i++)
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (mismatch)
    fail("assembly_v2_forbidden", "Подпись Assembly не подтверждена.", 403);
  const data = JSON.parse(body);
  if (
    data?.format !== "assembly-v2-events" ||
    data.version !== 1 ||
    !Array.isArray(data.events) ||
    data.events.length < 1 ||
    data.events.length > 40
  )
    fail("events_invalid", "Неверный формат журнала.");
  const now = store.now(),
    statements = [],
    ids = new Set();
  for (const e of data.events) {
    if (
      !e ||
      typeof e.id !== "string" ||
      !/^av2:(?:cancel:|norm:)?[0-9a-f-]{36}$/i.test(e.id) ||
      ids.has(e.id) ||
      !["work", "warehouse-work", "cancel", "norm"].includes(e.kind) ||
      typeof e.eventId !== "string" ||
      e.eventId.length > 150 ||
      !Number.isFinite(Date.parse(e.createdAt))
    )
      fail("event_invalid", "Не подтверждены ID и время работы.");
    if (
      e.kind === "work" &&
      (!/^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i.test(
        e.shipmentId || "",
      ) ||
        typeof e.positionId !== "string" ||
        !e.positionId.startsWith(e.shipmentId + "|") ||
        !e.sku ||
        !e.positionId.endsWith("|" + e.sku) ||
        !e.employeeId ||
        !e.employee ||
        !["cut", "assembly", "packing"].includes(e.operation) ||
        !Number.isSafeInteger(e.qty) ||
        e.qty < 1 ||
        e.qty > 2147483647 ||
        e.eventId !== e.id)
    )
      fail(
        "work_invalid",
        "Не подтверждены позиция, сотрудник или количество.",
      );
    if (
      e.kind === "cancel" &&
      (!e.reason || typeof e.reason !== "string" || e.reason.length > 500)
    )
      fail("cancellation_invalid", "Укажите причину отмены.");
    if (e.kind === "warehouse-work") {
      const unknownNorm = e.norm === null && e.coefficient === null;
      const norm = Number(e.norm), coefficient = Number(e.coefficient);
      if (!/^av2:[0-9a-f-]{36}$/i.test(e.id) || e.eventId !== e.id ||
          !(e.operation === "packing" ? /^[0-9a-f-]{36}$/i.test(e.receiptId || "") && !e.taskId : /^[0-9a-f-]{36}$/i.test(e.taskId || "") && e.taskId === e.id.slice(4) && !e.receiptId) || !["OZON","WB"].includes(e.market) ||
          !/^[1-9]\d{0,5}$/.test(e.store || "") || e.shipmentId || e.positionId ||
          typeof e.sku !== "string" || !e.sku.trim() || e.sku.length > 300 ||
          typeof e.employeeId !== "string" || !e.employeeId || e.employeeId.length > 150 ||
          typeof e.employee !== "string" || !e.employee.trim() || e.employee.length > 120 ||
          typeof e.productType !== "string" || e.productType.length > 1000 || !["packing","cut","assembly"].includes(e.operation) ||
          !Number.isSafeInteger(e.qty) || e.qty <= 0 || e.qty > 2147483647 ||
          (!unknownNorm && (!Number.isFinite(norm) || norm <= 0 || !Number.isFinite(coefficient) || coefficient <= 0 || Math.abs(coefficient-e.qty/norm) > 1e-12*Math.max(1,coefficient))))
        fail("warehouse_work_invalid", "Не подтверждены складская упаковка, сотрудник и расчёт кэфа.");
    }
    if (e.kind === "norm") {
      const norm=Number(e.norm), coefficient=Number(e.coefficient);
      if (!/^av2:norm:[0-9a-f-]{36}$/i.test(e.id) ||
          !/^(?:av2:)?[0-9a-f-]{36}$/i.test(e.eventId) ||
          !/^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i.test(e.shipmentId||"") ||
          typeof e.positionId!=="string" || !e.positionId.startsWith(e.shipmentId+"|") || !e.positionId.endsWith("|"+e.sku) ||
          typeof e.employeeId!=="string" || !e.employeeId || !["cut","assembly","packing"].includes(e.operation) ||
          !Number.isSafeInteger(e.qty) || e.qty<=0 || !Number.isFinite(Date.parse(e.originalCreatedAt)) ||
          !Number.isFinite(norm) || norm<=0 || !Number.isFinite(coefficient) || coefficient<=0 ||
          Math.abs(coefficient-e.qty/norm)>1e-12*Math.max(1,coefficient))
        fail("norm_repair_invalid","Не подтверждены исходная работа и расчёт нормы.");
    }
    const payload = JSON.stringify(e),
      hash = createHash("sha256").update(payload).digest("hex");
    statements.push(
      store.db
        .prepare(
          `insert into assembly_v2_work_events(id,kind,event_id,payload,hash,received_at) values(?,?,?,?,?,?) on conflict(id) do update set hash=excluded.hash,payload=excluded.payload`,
        )
        .bind(e.id, e.kind, e.eventId, payload, hash, now),
    );
    ids.add(e.id);
  }
  // A retry uses the same event IDs; changing a committed event is rejected by
  // the immutable-hash trigger. A cancellation is a separate durable event.
  statements.unshift(
    store.db
      .prepare(
        "insert into cloud_bridge_nonces(id,bridge_id,seen_at) values(?,?,?)",
      )
      .bind("av2-events:" + nonce, "assembly-v2", now),
  );
  await store.db.batch(statements);
  return json({ ok: true, acceptedIds: [...ids] });
}
export async function readAssemblyV2Events(store) {
  const result = await store.db
    .prepare(
      "select payload from assembly_v2_work_events order by received_at,id",
    )
    .all();
  return (result.results || []).map((r) => JSON.parse(r.payload));
}
export function normalizedV2Work(e) {
  return {
    eventId: e.eventId,
    shipmentId: e.kind === "warehouse-work" ? "" : e.shipmentId,
    positionId: e.kind === "warehouse-work" ? "" : e.positionId,
    ...(e.kind === "warehouse-work" ? { scope: "warehouse", warehouseReceiptId: e.receiptId, stockWorkId: e.taskId, market: e.market, store: e.store, direction: `В запас · ${e.market} · Магазин ${e.store}` } : {}),
    article: e.sku,
    employeeId: e.employeeId,
    employee: e.employee,
    operationId: e.operation,
    quantity: e.qty,
    norm: e.norm == null ? null : Number(e.norm),
    coefficient: e.coefficient == null ? null : Number(e.coefficient),
    productType: e.productType || "",
    createdAt: e.createdAt,
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(e.createdAt)),
  };
}
export function applyNormRepairs(records, events) {
  const repairs = new Map(events.filter(e=>e.kind==="norm").map(e=>[e.eventId,e]));
  let applied=0;
  const matched=new Set();
  const corrected=records.map(record=>{
    const repair=repairs.get(record.eventId);
    if (!repair) return record;
    const same = repair.shipmentId===record.shipmentId && repair.positionId===record.positionId &&
      repair.sku===record.article && repair.employeeId===record.employeeId && repair.operation===record.operationId &&
      repair.qty===record.quantity && Date.parse(repair.originalCreatedAt)===Date.parse(record.createdAt);
    const norm=Number(repair.norm), coefficient=Number(repair.coefficient);
    if (!same) return record;
    if (record.coefficient!=null) {
      if (Number(record.norm)===norm && Math.abs(Number(record.coefficient)-coefficient)<1e-12) matched.add(record.eventId);
      return record;
    }
    if (record.norm!=null && Number(record.norm)!==norm) return record;
    matched.add(record.eventId); applied++;
    return {...record,norm,coefficient,productType:record.productType||repair.productType||"",normRepairId:repair.id};
  });
  const canceled=new Set(events.filter(e=>e.kind==="cancel").map(e=>e.eventId));
  return {records:corrected,applied,unresolved:[...repairs.keys()].filter(id=>!matched.has(id)&&!canceled.has(id))};
}
export function overlayAssemblyV2(snapshot, events) {
  if (!events.length) return snapshot;
  const canceled = new Set(
    events.filter((e) => e.kind === "cancel").map((e) => e.eventId),
  );
  const merged = new Map(
    (snapshot.events || [])
      .filter((e) => !canceled.has(e.eventId))
      .map((e) => [e.eventId, e]),
  );
  for (const e of events)
    if (["work", "warehouse-work"].includes(e.kind) && !canceled.has(e.eventId) && !merged.has(e.eventId))
      merged.set(e.eventId, normalizedV2Work(e));
  const repaired=applyNormRepairs([...merged.values()],events);
  const all = repaired.records,
    records = workLogRecords(all),
    fbo = snapshot.recordsBySource?.fbo || [];
  const reconciliation = reconcileAssemblySources({
    fboRecords: fbo,
    assemblyRecords: records,
    fboStatus: snapshot.sources?.fbo?.status || "unavailable",
    assemblyStatus: snapshot.sources?.assembly?.status || "partial",
    startDate: "2000-01-01",
    endDate: "9999-12-31",
  });
  return {
    ...snapshot,
    events: all,
    recordsBySource: { ...snapshot.recordsBySource, assembly: records },
    history: summarizeAssemblyDays([
      ...reconciliation.fboRecords,
      ...reconciliation.assemblyRecords,
    ]),
    sources: {
      ...snapshot.sources,
      assembly: {
        ...snapshot.sources?.assembly,
        eventCount: all.length,
        assemblyV2Events: events.filter((e) => ["work", "warehouse-work"].includes(e.kind)).length,
        normRepairsApplied: repaired.applied,
        normRepairsUnresolved: repaired.unresolved,
      },
    },
  };
}
export function overlayPrintingV2(printing, events) {
  const warehouseIds = new Set(events.filter(e => e.kind === "warehouse-work").map(e => e.eventId));
  events = events.filter(e => e.kind !== "warehouse-work" && !(e.kind === "cancel" && warehouseIds.has(e.eventId)));
  const stages = printing._assemblyStages;
  if (!stages) {
    // An older cached snapshot has no evidence for subtracting cancelled work.
    // Request a refresh rather than displaying a fabricated zero.
    return events.length
      ? { ...printing, assemblyV2: { pendingRefresh: true } }
      : printing;
  }
  const canceled = new Set(
    events.filter((e) => e.kind === "cancel").map((e) => e.eventId),
  );
  const results = {};
  for (const operation of ["packing", "cut", "assembly"]) {
    const base = stages[operation] || { events: [], invalid: [] },
      merged = new Map(
        base.events
          .filter((e) => !canceled.has(e.eventId))
          .map((e) => [e.eventId, e]),
      );
    for (const e of events)
      if (
        e.kind === "work" &&
        e.operation === operation &&
        !canceled.has(e.eventId) &&
        !merged.has(e.eventId)
      )
        merged.set(e.eventId, normalizedV2Work(e));
    results[operation] = attachAssemblyPacking(
      printing,
      { events: [...merged.values()], invalid: base.invalid },
      stages.checkedAt,
    );
  }
  const { _assemblyStages, ...publicPrinting } = printing;
  return {
    ...publicPrinting,
    supplies: results.packing.supplies.map((row, i) => ({
      ...row,
      assemblyMachineCut: results.cut.supplies[i].packed,
      assemblyManualCut: results.assembly.supplies[i].packed,
    })),
    packing: results.packing.packing,
    assemblyV2: {
      events: events.filter(
        (e) => e.kind === "work" && !canceled.has(e.eventId),
      ).length,
    },
  };
}
