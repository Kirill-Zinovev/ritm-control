import type { LiveOrder, LivePrinting } from "./livePrinting";
import { rollCut, supplyPrinted } from "./liveSupplyProgress";
import { buildProductionGroups } from "./productionData";
import { buildSupplyDirections } from "./supplyDirectionData";

export type DispatchStage = "planned" | "print" | "cut" | "pack" | "ready";

export type DispatchControlRow = {
  key: string;
  direction: string;
  supplyId: string;
  supplyName: string;
  store: string;
  market?: string;
  article: string;
  plan: number;
  sent: number | null;
  remaining: number | null;
  stage: DispatchStage | null;
  location: string;
  cartons: { label: string; quantity: number }[];
  issue?: string;
  workQty: number;
  plannedQty: number;
  printQty: number;
  cutQty: number;
  packQty: number;
  readyQty: number;
};

export type DispatchFact = {
  supplyId: string;
  supplyTitle?: string;
  positionId: string;
  sku: string;
  department: string;
  market: "OZON" | "WB";
  store: string;
  destination: string;
  plan: number;
  packed: number;
  sent: number | null;
  cartons: {
    id: string;
    label: string;
    qty: number;
    state: "open" | "closed";
    prepared: boolean;
  }[];
};

export type DispatchReport = {
  ok: true;
  schemaVersion: 1;
  revision: number;
  rows: DispatchFact[];
  checkedAt: string;
  stale: boolean;
};

export type DispatchPosition = {
  supplyId: string;
  supplyName: string;
  positionId: string;
  store: string;
  market?: "OZON" | "WB";
  department: "roll" | "box" | "assembly";
  article: string;
  plan: number;
  printed: number | null;
  cut: number | null;
  issue?: string;
};

const unsupportedScope = "Нет данных по позиции из «РИТМ Сборки».";
const missingHistory = "Нет данных о количестве отправленных штук.";
const assemblyLocation = "Сборка · короб не указан";
const unknownLocation = "Место не указано";
const normalizeArticle = (value: string) =>
  value.trim().normalize("NFC").toUpperCase();
const normalizeStore = (value: string) =>
  /^\s*(?:магазин\s*)?(\d+)\s*$/iu.exec(value)?.[1] || value.trim();
const displayStore = (value: string) =>
  /^\d+$/.test(value) ? `Магазин ${value}` : value || "Не указан";
const shipmentPattern =
  /^RITM-(?:(?:ROLL|BOX)-\d{1,16}|SUPPLY-[a-f0-9-]{36})$/i;
const additionalCities: [string, RegExp][] = [
  ["Ярославль", /(?:^|[^\p{L}])ярославл(?:ь|я|е)(?!\p{L})/iu],
  ["Уфа", /(?:^|[^\p{L}])уф[аыеу](?!\p{L})/iu],
  ["Красноярск", /(?:^|[^\p{L}])красноярск[ае]?(?!\p{L})/iu],
];

function shipmentId(order: LiveOrder, groupKey: string) {
  if (order.assemblyShipmentId) return order.assemblyShipmentId;
  if (groupKey.startsWith("shipment:"))
    return groupKey.slice("shipment:".length);
  return `RITM-${order.sourceId === "box-printing" ? "BOX" : "ROLL"}-${order.sheetId}`;
}

export function buildDispatchPositions(live: LivePrinting | null) {
  const result = new Map<string, DispatchPosition>();
  for (const group of buildProductionGroups(live)) {
    for (const row of group.rows) {
      for (const order of row.orders) {
        const supplyId = shipmentId(order, group.key);
        const department =
          order.sourceId === "roll-printing"
            ? "roll"
            : order.sourceId === "box-printing"
              ? "box"
              : row.department;
        const sheet = department === "box" ? `box:${order.sheetId}|` : "";
        const rowKey = order.rawUid
          ? `uid:${order.rawUid}`
          : `row:${order.row}`;
        const positionId = `${supplyId}|${sheet}${rowKey}|${order.article}`;
        const old = result.get(positionId);
        if (!Number.isSafeInteger(order.quantity) || order.quantity <= 0)
          continue;
        if (old) {
          old.plan += order.quantity;
          old.issue = "В исходном листе повторяется идентификатор позиции.";
          continue;
        }
        result.set(positionId, {
          supplyId,
          supplyName: group.name,
          positionId,
          store: row.store === "Не указан" ? "" : normalizeStore(row.store),
          market: group.market
            ? group.market === "WB"
              ? "WB"
              : "OZON"
            : undefined,
          department,
          article: normalizeArticle(order.article),
          plan: order.quantity,
          printed:
            live?.stale || live?.refreshFailed ? null : supplyPrinted(order),
          cut: live?.stale || live?.refreshFailed ? null : rollCut(order),
        });
      }
    }
  }
  return [...result.values()];
}

function productionLocation(
  position: DispatchPosition,
  waitingForPrint = false,
) {
  const department = position.department === "box" ? "Бокс" : "Рулонная печать";
  return waitingForPrint ? `${department} · очередь печати` : department;
}

function stageFromMarks(
  position: DispatchPosition,
  fact: DispatchFact | undefined,
): DispatchStage | null {
  if (position.issue) return null;
  const closed =
    fact?.cartons.reduce(
      (sum, box) => sum + (box.state === "closed" ? box.qty : 0),
      0,
    ) ?? 0;
  if (closed >= position.plan) return "ready";
  if (
    position.department === "assembly" ||
    (position.cut ?? 0) >= position.plan ||
    (fact?.packed ?? 0) >= position.plan
  )
    return "pack";
  if ((position.printed ?? 0) >= position.plan) return "cut";
  if ((position.printed ?? 0) > 0) return "print";
  if (fact?.cartons.some((box) => box.state === "open")) return "pack";
  if (fact?.cartons.length) return "ready";
  if ((position.cut ?? 0) > 0) return "pack";
  if (position.printed === 0 && !fact?.sent && !fact?.packed) return "planned";
  return null;
}

function classify(
  position: DispatchPosition,
  fact: DispatchFact | undefined,
  direction: string,
) {
  const store = normalizeStore(fact?.store || position.store);
  const article = position.article;
  const key = JSON.stringify([
    position.supplyId,
    position.market,
    store,
    article,
  ]);
  const result: DispatchControlRow = {
    key,
    direction,
    supplyId: position.supplyId,
    supplyName: position.supplyName,
    store: displayStore(store),
    market: position.market,
    article,
    plan: position.plan,
    sent: fact?.sent ?? null,
    remaining:
      fact?.sent == null ? null : Math.max(0, position.plan - fact.sent),
    stage: null,
    location: unknownLocation,
    cartons: [],
    workQty: 0,
    plannedQty: 0,
    printQty: 0,
    cutQty: 0,
    packQty: 0,
    readyQty: 0,
  };

  const boxes = [...(fact?.cartons ?? [])].sort(
    (a, b) =>
      Number(b.state === "closed") - Number(a.state === "closed") ||
      a.label.localeCompare(b.label, "ru-RU", { numeric: true }),
  );
  result.cartons = boxes.map((box) => ({
    label: box.label,
    quantity: box.qty,
  }));
  if (!fact || fact.sent === null || position.plan !== fact.plan) {
    result.issue =
      position.issue ||
      (!fact
        ? unsupportedScope
        : position.plan !== fact.plan
          ? "План в производстве отличается от состава РИТМ Сборки."
          : missingHistory);
    result.remaining = null;
    result.stage = stageFromMarks(position, fact);
    if (result.cartons.length) result.location = cartonLabels(result.cartons);
    else if (result.stage === "planned")
      result.location = productionLocation(position, true);
    else if (result.stage === "print" || result.stage === "cut")
      result.location = productionLocation(position);
    else if (result.stage === "pack") result.location = assemblyLocation;
    return result;
  }
  const quantity = result.remaining ?? 0;
  if (quantity === 0) return result;
  let available = quantity;
  let inBoxesToPack = 0;
  for (const box of boxes) {
    const counted = Math.min(available, box.qty);
    available -= counted;
    if (box.state === "closed") result.readyQty += counted;
    else inBoxesToPack += counted;
  }

  const afterBoxes = fact.sent + quantity - available;
  const packedOutside = Math.min(
    available,
    Math.max(0, fact.packed - afterBoxes),
  );
  const toPack =
    position.department === "assembly"
      ? available
      : Math.max(
          packedOutside,
          Math.min(
            available,
            Math.max(0, Math.floor(position.cut ?? 0) - afterBoxes),
          ),
        );
  available -= toPack;
  const toCut = Math.min(
    available,
    Math.max(0, Math.floor(position.printed ?? 0) - afterBoxes - toPack),
  );
  available -= toCut;
  const toPrint =
    position.printed === null
      ? 0
      : Math.min(
          available,
          Math.max(0, position.plan - Math.floor(position.printed)),
        );
  available -= toPrint;

  const planned = toPrint === position.plan && fact.packed === 0 ? toPrint : 0;
  result.workQty = toPrint + toCut + toPack + inBoxesToPack;
  result.plannedQty = planned;
  result.printQty = toPrint - planned;
  result.cutQty = toCut;
  result.packQty = toPack + inBoxesToPack;
  result.stage =
    planned > 0
      ? "planned"
      : result.printQty > 0
        ? "print"
        : toCut > 0
          ? "cut"
          : result.packQty > 0
            ? "pack"
            : result.readyQty > 0
              ? "ready"
              : null;
  const places: string[] = [];
  if (planned > 0 || result.printQty > 0 || toCut > 0)
    places.push(productionLocation(position, planned > 0));
  if (toPack > 0) places.push(assemblyLocation);
  if (result.cartons.length) places.push(cartonLabels(result.cartons));
  if (available > 0) {
    result.issue = "Нет отметок по этапу для части остатка.";
  }
  result.location = places.join(" · ") || unknownLocation;
  return result;
}

function cartonLabels(cartons: DispatchControlRow["cartons"]) {
  return `${cartons.length === 1 ? "Короб" : "Короба"} ${cartons.map((box) => box.label).join(", ")}`;
}

const stageRank: Record<DispatchStage, number> = {
  planned: 0,
  print: 1,
  cut: 2,
  pack: 3,
  ready: 4,
};

function mergeRow(row: DispatchControlRow, next: DispatchControlRow) {
  const hadRemaining = row.remaining !== 0;
  row.plan += next.plan;
  row.sent =
    row.sent === null || next.sent === null ? null : row.sent + next.sent;
  row.remaining =
    row.remaining === null || next.remaining === null
      ? null
      : row.remaining + next.remaining;
  const hasRemaining = next.remaining !== 0;
  if (
    hasRemaining &&
    next.stage &&
    (!row.stage || stageRank[next.stage] < stageRank[row.stage])
  )
    row.stage = next.stage;
  row.workQty += next.workQty;
  row.plannedQty += next.plannedQty;
  row.printQty += next.printQty;
  row.cutQty += next.cutQty;
  row.packQty += next.packQty;
  row.readyQty += next.readyQty;
  if (next.issue)
    row.issue = [...new Set([row.issue, next.issue].filter(Boolean))].join(" ");
  if (hasRemaining) {
    row.location = [
      ...new Set(
        (hadRemaining
          ? [row.location, next.location]
          : [next.location]
        ).flatMap((x) => x.split(" · ")),
      ),
    ].join(" · ");
    for (const nextBox of next.cartons) {
      const box = row.cartons.find((x) => x.label === nextBox.label);
      if (box) box.quantity += nextBox.quantity;
      else row.cartons.push({ ...nextBox });
    }
  }
}

export function buildDispatchRows(
  positions: DispatchPosition[],
  input: DispatchFact[],
): DispatchControlRow[] {
  const facts = new Map(input.map((row) => [row.positionId, row]));
  const supplied = new Map(positions.map((pos) => [pos.supplyId, pos]));
  const positionIds = new Set(positions.map((pos) => pos.positionId));
  const all = [...positions];
  for (const fact of input) {
    const supply = supplied.get(fact.supplyId);
    if (
      !supply ||
      positionIds.has(fact.positionId) ||
      !fact.positionId.startsWith(`${fact.supplyId}|manual:`) ||
      fact.plan <= 0
    )
      continue;
    all.push({
      ...supply,
      supplyName: fact.supplyTitle || supply.supplyName,
      positionId: fact.positionId,
      article: normalizeArticle(fact.sku),
      store: normalizeStore(fact.store),
      market: fact.market,
      department: "assembly",
      plan: fact.plan,
      printed: null,
      cut: null,
      issue: undefined,
    });
  }

  // Use the existing direction parser on both source titles; exact identities still
  // control all joins. An unrecognized city remains scoped to the whole title.
  const directions = new Map<string, string>();
  const destinations = new Map(
    input
      .filter((fact) => fact.destination)
      .map((fact) => [fact.supplyId, fact.destination]),
  );
  for (const [id, pos] of supplied) {
    const destination = destinations.get(id) || pos.supplyName;
    const parsed = buildSupplyDirections([
      {
        id,
        name: destination,
        orders: [],
        missingPositions: 0,
        lock: "unknown",
      },
    ])[0]?.city;
    const aliases = additionalCities.filter(([, pattern]) =>
      pattern.test(destination),
    );
    directions.set(
      id,
      parsed && parsed !== destination
        ? parsed
        : aliases.length === 1
          ? aliases[0][0]
          : destination,
    );
  }

  const rows = new Map<string, DispatchControlRow>();
  for (const pos of all) {
    let fact = facts.get(pos.positionId);
    if (
      pos.issue ||
      (fact &&
        (fact.supplyId !== pos.supplyId ||
          normalizeArticle(fact.sku) !== pos.article ||
          fact.market !== pos.market ||
          !normalizeStore(fact.store) ||
          (pos.store && normalizeStore(fact.store) !== pos.store)))
    )
      fact = undefined;
    const row = classify(
      pos,
      fact,
      directions.get(pos.supplyId) || pos.supplyName,
    );
    const previous = rows.get(row.key);
    if (previous) mergeRow(previous, row);
    else rows.set(row.key, row);
  }
  return [...rows.values()]
    .filter((row) => row.remaining !== 0)
    .sort(
      (a, b) =>
        (a.workQty > 0 ? 0 : a.readyQty > 0 ? 1 : 2) -
          (b.workQty > 0 ? 0 : b.readyQty > 0 ? 1 : 2) ||
        (b.remaining ?? -1) - (a.remaining ?? -1) ||
        a.article.localeCompare(b.article, "ru-RU", { numeric: true }),
    );
}

export function dispatchSupplyIds(positions: DispatchPosition[]) {
  return [
    ...new Set(
      positions
        .map((pos) => pos.supplyId)
        .filter((id) => shipmentPattern.test(id)),
    ),
  ].sort();
}
