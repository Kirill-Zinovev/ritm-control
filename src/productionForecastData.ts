import { buildMachineWorkload, resolveMachine } from "./machineWorkloadData";
import { rollPrinted, rollCut } from "./liveSupplyProgress";
import type { LivePrinting, LiveOrder } from "./livePrinting";
import type { LiveAssembly } from "./liveAssembly";
import type {
  ForecastInput,
  ForecastTask,
  ForecastSupply,
} from "./productionForecastModel";
import type { PackingStockSource, ProductionCutConfirmation } from "../shared/productionPlanning";

/** Apply an audited owner confirmation only to the same unchanged task and plan. */
export function applyConfirmedProductionCuts(
  input: ForecastInput,
  confirmations: ProductionCutConfirmation[] | undefined,
): ForecastInput {
  const latest = new Map<string, ProductionCutConfirmation>();
  for (const item of confirmations || []) latest.set(item.taskId, item);
  const counts = new Map<string, number>();
  for (const task of input.tasks) counts.set(task.id, (counts.get(task.id) || 0) + 1);
  const tasks = input.tasks.map((task) => {
    const item = latest.get(task.id);
    if (!item || item.quantity === 0) return task;
    const valid = counts.get(task.id) === 1 && item.article === task.article &&
      Number.isSafeInteger(item.quantity) && item.quantity > 0 &&
      Number.isSafeInteger(item.sourcePlan) && item.sourcePlan === task.plan &&
      item.quantity === task.plan && task.printed != null &&
      Number.isFinite(task.printed) && task.printed >= item.quantity &&
      task.cut != null && Number.isFinite(task.cut) && task.cut >= 0 &&
      Number.isFinite(Date.parse(item.recordedAt)) && !!item.recordedBy;
    if (!valid || task.cut! >= item.quantity) return task;
    return { ...task, cut: item.quantity, cutConfirmation: {
      quantity: item.quantity, sourceCut: task.cut!, recordedAt: item.recordedAt, recordedBy: item.recordedBy,
    } };
  });
  const deltas = new Map<string, number>();
  for (const task of tasks) if (task.cutConfirmation)
    deltas.set(task.supplyKey, (deltas.get(task.supplyKey) || 0) + task.cutConfirmation.quantity - task.cutConfirmation.sourceCut);
  const supplies = input.supplies.map((supply) => ({
    ...supply,
    cut: supply.cut === null ? null : supply.cut + (deltas.get(supply.key) || 0),
  }));
  return { ...input, tasks, supplies };
}

/** Attach only the latest confirmed source to its exact production position. */
export function applyConfirmedPackingStock(
  input: ForecastInput,
  sources: PackingStockSource[] | undefined,
): ForecastInput {
  const latest = new Map<string, PackingStockSource>();
  for (const source of sources || []) latest.set(source.taskId, source);
  const counts = new Map<string, number>();
  for (const task of input.tasks) counts.set(task.id, (counts.get(task.id) || 0) + 1);
  const issues = [...(input.packingIssues || [])];
  const tasks = input.tasks.map((task) => {
    const source = latest.get(task.id);
    if (!source || source.quantity === 0) return task;
    const valid = source.article === task.article &&
      Number.isSafeInteger(source.quantity) && source.quantity > 0 &&
      Number.isSafeInteger(task.packed) && source.quantity <= task.packed! &&
      Number.isSafeInteger(task.plan) && task.plan >= 0 &&
      Array.isArray(source.packingEventIds) && source.packingEventIds.length > 0 &&
      Array.isArray(task.packingEventIds) && source.packingEventIds.every((id) => task.packingEventIds!.includes(id)) &&
      counts.get(task.id) === 1;
    if (!valid) {
      issues.push(`${task.article}: подтверждённый источник со склада не совпадает с текущей упаковкой. Проверьте запись.`);
      return task;
    }
    return { ...task, stockPacked: source.quantity };
  });
  return { ...input, tasks, packingIssues: issues };
}
export type AssemblyOnlyForecastItem = {
  shipmentId: string;
  positionId: string;
  article: string;
  quantity: number;
  status: string;
  createdAt: string;
};
export type AssemblyStockSnapshot = {
  updatedAt: string;
  items: Array<{
    department: "box" | "roll";
    documentId: string;
    sheetId: number;
    uid: string;
    article: string;
    quantity: number;
    archivedAt: string;
    positionId: string;
  }>;
};
export function forecastInput(
  live: LivePrinting | null,
  now: number,
  extraItems: AssemblyOnlyForecastItem[] | null = null,
  assembly: LiveAssembly | null = null,
  stockSnapshot: AssemblyStockSnapshot | null = null,
  stockReason?: string,
): ForecastInput {
  const tasks: ForecastTask[] = [],
    supplies: ForecastSupply[] = [],
    issues: string[] = [];
  // A checkbox and the active journal can establish completion even if the
  // catalogue's current Xerox sheet conversion differs from its historical
  // conversion. Never match another document, sheet, duplicate SKU or journal
  // position; partial and ambiguous work stays governed by the source cells.
  const boxKey = (documentId: string, sheetId: number, article: string) =>
    JSON.stringify([documentId, sheetId, article]);
  const boxOrderCounts = new Map<string, number>();
  for (const order of [...(live?.supplies || []), ...(live?.stockBox?.orders || [])]) {
    if (order.sourceId !== "box-printing" || order.archived || !order.spreadsheetId || !order.article) continue;
    const key = boxKey(order.spreadsheetId, order.sheetId, order.article);
    boxOrderCounts.set(key, (boxOrderCounts.get(key) || 0) + 1);
  }
  const journalConfirmsPlan = (order: LiveOrder, phase: "print" | "cut") => {
    if (live?.boxPrinting?.status !== "available" || live.boxPrinting.stockStatus !== "available" || !order.spreadsheetId ||
        boxOrderCounts.get(boxKey(order.spreadsheetId, order.sheetId, order.article)) !== 1 ||
        !Number.isSafeInteger(order.quantity) || order.quantity <= 0 ||
        (phase === "print" ? order.printProgress : order.cutProgress) !== order.quantity) return false;
    const events = (phase === "print" ? live.boxPrinting.events : live.boxPrinting.cutEvents || [])
      .filter((event) => event.spreadsheetId === order.spreadsheetId && event.sheetId === order.sheetId && event.article === order.article);
    if (!events.length || events.some((event) => !event.id || !event.positionId || !Number.isFinite(event.quantity) || event.quantity <= 0) ||
        new Set(events.map((event) => event.id)).size !== events.length ||
        new Set(events.map((event) => event.positionId)).size !== 1) return false;
    return Math.abs(events.reduce((total, event) => total + event.quantity, 0) - order.quantity) < 1e-8;
  };
  const add = (
    o: LiveOrder,
    key: string,
    name: string,
    machine: string,
    department: "roll" | "box",
    stock: boolean,
    urgent: boolean,
  ) => {
    const identity = `${o.spreadsheetId || o.sourceId}:${o.sheetId}:${o.rawUid || o.uid || o.row}`;
    const sourceXerox = /^(xerox|ксерокс|x|х)$/i.test(
      (o.sourceMachine || o.machine)?.trim() || "",
    );
    const factor = sourceXerox
      ? o.sheetsInProduct &&
        o.multiplicity &&
        o.sheetsInProduct > 0 &&
        o.multiplicity > 0
        ? o.sheetsInProduct / o.multiplicity
        : null
      : 1;
    // Zero physical output is zero pieces even when a Xerox conversion is missing.
    // Positive sheet output still requires the confirmed conversion factor.
    const unconfirmedExcess = (key: "planningPrinted" | "planningCut") =>
      sourceXerox &&
      o.planningPhysicalUnits === true &&
      typeof o[key] === "number" &&
      factor !== null &&
      Number.isFinite(o.quantity) &&
      o[key]! / factor > o.quantity + 0.000001;
    const fact = (
      key: "planningPrinted" | "planningCut",
      fallback: number | null,
    ) =>
      sourceXerox && o.planningPhysicalUnits === true &&
      journalConfirmsPlan(o, key === "planningPrinted" ? "print" : "cut")
        ? o.quantity :
      // Historical Xerox rows used another sheet unit. A value above the
      // current good-sheet plan is ambiguous; a checked completion flag
      // confirms the plan only, not the purported extra quantity.
      unconfirmedExcess(key)
        ? fallback === o.quantity && o.quantity > 0 ? o.quantity : null
        : o[key] === undefined
        ? fallback
        : o.planningPhysicalUnits
          ? o[key] === 0
            ? 0
            : typeof o[key] === "number" && factor !== null
              ? o[key]! / factor
              : null
          : typeof o[key] === "number"
            ? o[key]!
            : null;
    tasks.push({
      id: identity,
      supplyKey: key,
      name,
      article: o.article,
      machine,
      department,
      stock,
      urgent,
      plan: o.quantity,
      printed: fact("planningPrinted", rollPrinted(o)),
      cut: fact("planningCut", rollCut(o)),
      unconfirmedPrintExcess: unconfirmedExcess("planningPrinted"),
      unconfirmedCutExcess: unconfirmedExcess("planningCut"),
      packed: typeof o.packed === "number" ? o.packed : null,
      packingEventIds: o.packingEventIds,
      packingExcluded:
        stock &&
        o.sheetName.trim().toLocaleLowerCase("ru-RU") !== "запасы склад",
      stockPositionId:
        stock && o.rawUid && o.spreadsheetId
          ? `RITM-STOCK-WAREHOUSE|uid:${department}:${o.spreadsheetId}:${o.sheetId}:${o.rawUid}|${o.article}`
          : undefined,
      areaPerPiece:
        o.areaKnown === false ||
        !Number.isFinite(o.plannedArea) ||
        o.plannedArea <= 0 ||
        o.quantity <= 0
          ? null
          : o.plannedArea / o.quantity,
      sheetsPerPiece:
        machine === "xerox" &&
        o.sheetsInProduct &&
        o.multiplicity &&
        o.sheetsInProduct > 0 &&
        o.multiplicity > 0
          ? o.sheetsInProduct / o.multiplicity
          : null,
    });
  };
  for (const s of buildMachineWorkload(live)) {
    const start = tasks.length,
      urgent = s.name.includes("🔥");
    for (const m of s.machines)
      for (const row of m.rows)
        for (const o of row.orders) {
          const sourceDepartment =
            o.sourceId === "box-printing" ? "box" : "roll";
          // Catalog grouping is visual. A task stays in the department of its
          // actual sheet; a conflicting catalog must never move its queue.
          const sourceMachine = resolveMachine(o.sourceMachine);
          // The physical printer and the cutting department are separate.
          // A box order can explicitly name the same roll printer in both
          // the source and the catalog; this does not move the source task.
          const agreedCrossDepartmentMachine =
            m.department !== sourceDepartment &&
            o.machineSource === "catalog" &&
            sourceMachine?.id === m.id
              ? sourceMachine.id
              : "";
          const machine =
            m.department === sourceDepartment
              ? m.id === "unknown"
                ? ""
                : m.id
              : sourceMachine?.department === sourceDepartment
                ? sourceMachine.id
                : agreedCrossDepartmentMachine;
          add(o, s.key, s.name, machine, sourceDepartment, false, urgent);
        }
    const items = tasks.slice(start),
      sum = (field: "printed" | "cut") =>
        items.some((t) => t[field] === null)
          ? null
          : items.reduce((a, t) => a + (t[field] || 0), 0);
    supplies.push({
      key: s.key,
      name: s.name,
      plan: s.plan,
      printed: sum("printed"),
      cut: sum("cut"),
      stock: false,
      urgent,
      market: s.market,
    });
  }
  for (const [department, source] of [
    ["roll", live?.stockRoll],
    ["box", live?.stockBox],
  ] as const) {
    if (!source || source.status !== "available") {
      issues.push(
        `Не подтверждена очередь запасов: ${department === "roll" ? "рулонная печать" : "бокс"}`,
      );
      continue;
    }
    for (const o of source.orders.filter((o) => !o.archived)) {
      const key = `stock:${o.spreadsheetId}:${o.sheetId}`,
        name = `Запасы · ${o.sheetName} · ${department === "roll" ? "рулонная печать" : "бокс"}`,
        urgent = /срочн/i.test(o.sheetName);
      const catalogMachine = resolveMachine(o.planningMachine || o.machine);
      const sourceMachine = resolveMachine(o.sourceMachine || o.machine);
      const machine =
        catalogMachine?.department === department
          ? catalogMachine
          : sourceMachine?.department === department
            ? sourceMachine
            : null;
      add(o, key, name, machine?.id || "", department, true, urgent);
      if (!supplies.some((s) => s.key === key))
        supplies.push({
          key,
          name,
          plan: 0,
          printed: 0,
          cut: 0,
          stock: true,
          urgent,
          market: "Ozon",
        });
      const s = supplies.find((s) => s.key === key)!;
      s.plan += o.quantity;
      const t = tasks[tasks.length - 1];
      s.printed =
        s.printed === null || t.printed === null ? null : s.printed + t.printed;
      s.cut = s.cut === null || t.cut === null ? null : s.cut + t.cut;
    }
  }
  if (live?.quality && live.quality.invalidRecords > 0)
    issues.push(
      "В источниках есть неподтверждённые записи. Сначала сверьте ошибки данных, чтобы не пропустить работу в очереди.",
    );
  const packingIssues: string[] = [];
  if (extraItems === null)
    packingIssues.push("Дополнительные товары Assembly обновляются; повторяем проверку.");
  const activeIds = new Set<string>();
  const shipmentKeys = new Map<string, string>();
  for (const sheet of live?.sheets || []) {
    if (!["roll-printing", "box-printing"].includes(sheet.sourceId || ""))
      continue;
    const ids = new Set(
      [
        sheet.assemblyShipmentId,
        ...(live?.supplies || [])
          .filter(
            (o) => o.sheetId === sheet.sheetId && o.sourceId === sheet.sourceId,
          )
          .map((o) => o.assemblyShipmentId),
      ].filter((id): id is string => !!id),
    );
    if (ids.size === 0)
      ids.add(
        `RITM-${sheet.sourceId === "box-printing" ? "BOX" : "ROLL"}-${sheet.sheetId}`,
      );
    for (const id of ids) activeIds.add(id);
    if (ids.size === 1) {
      const id = [...ids][0],
        direct = `shipment:${id}`,
        legacy = `sheet:${sheet.sourceId}:${sheet.sheetId}`;
      if (supplies.some((s) => s.key === direct)) shipmentKeys.set(id, direct);
      else if (supplies.some((s) => s.key === legacy))
        shipmentKeys.set(id, legacy);
    }
  }
  const assemblyAt = Date.parse(
    assembly?.snapshotAt || assembly?.updatedAt || "",
  );
  const sourceReady =
    !!assembly?.ok &&
    !assembly.stale &&
    !assembly.staleSnapshot &&
    !assembly.refreshInProgress &&
    assembly.sources?.assembly.status === "available" &&
    !assembly.sources.assembly.invalidRecords &&
    Number.isFinite(assemblyAt) &&
    assemblyAt <= now + 60000 &&
    now - assemblyAt <= 15 * 60000;
  const packedFor = (
    positionId: string,
    shipmentId: string,
    article: string,
    after?: number,
  ) => {
    const events = (assembly?.events || []).filter(
      (e) => e.operationId === "packing" && e.positionId === positionId,
    );
    const unique = new Map<string, (typeof events)[number]>();
    let valid =
      sourceReady &&
      Array.isArray(assembly?.events) &&
      (after === undefined || (Number.isFinite(after) && after <= assemblyAt));
    for (const e of events) {
      const prior = unique.get(e.eventId);
      if (
        !e.eventId ||
        e.shipmentId !== shipmentId ||
        e.article !== article ||
        !Number.isSafeInteger(e.quantity) ||
        e.quantity <= 0 ||
        (prior && JSON.stringify(prior) !== JSON.stringify(e))
      )
        valid = false;
      else unique.set(e.eventId, e);
    }
    return valid
      ? [...unique.values()].reduce((n, e) => n + e.quantity, 0)
      : null;
  };
  for (const item of extraItems || []) {
    if (!activeIds.has(item.shipmentId)) {
      const past = packedFor(
        item.positionId,
        item.shipmentId,
        item.article,
        Date.parse(item.createdAt),
      );
      if (past === null)
        packingIssues.push(
          `Не подтверждена упаковка дополнительного товара ${item.article || "без артикула"} вне текущих поставок.`,
        );
      else if (
        item.status !== "active" ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity <= 0 ||
        past < item.quantity
      )
        packingIssues.push(
          `Дополнительный товар ${item.article || "без артикула"} не связан с текущей поставкой или не завершён.`,
        );
      continue;
    }
    const key = shipmentKeys.get(item.shipmentId) || "",
      supply = supplies.find((s) => s.key === key);
    if (
      !supply ||
      item.status !== "active" ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      !item.positionId?.startsWith(`${item.shipmentId}|manual:`) ||
      !item.article
    ) {
      packingIssues.push(
        "Не подтверждён состав дополнительных товаров Assembly.",
      );
      continue;
    }
    const packed = packedFor(
      item.positionId,
      item.shipmentId,
      item.article,
      Date.parse(item.createdAt),
    );
    tasks.push({
      id: `assembly-only:${item.positionId}`,
      supplyKey: key,
      name: supply.name,
      article: item.article,
      machine: "",
      department: "box",
      plan: item.quantity,
      printed: item.quantity,
      cut: item.quantity,
      packed,
      assemblyOnly: true,
      areaPerPiece: null,
      sheetsPerPiece: null,
      stock: false,
      urgent: supply.urgent,
    });
  }
  const stockAt = Date.parse(stockSnapshot?.updatedAt || "");
  if (
    !stockSnapshot ||
    !Array.isArray(stockSnapshot.items) ||
    !Number.isFinite(stockAt) ||
    stockAt > now + 60000 ||
    now - stockAt > 15 * 60000
  )
    packingIssues.push(
      !stockSnapshot && stockReason
        ? stockReason
        : "Не подтверждён состав заданий «Запасы склад» в Assembly.",
    );
  else {
    const seen = new Set<string>();
    for (const item of stockSnapshot.items) {
      const expected = `RITM-STOCK-WAREHOUSE|uid:${item.department}:${item.documentId}:${item.sheetId}:${item.uid}|${item.article}`;
      if (
        !["roll", "box"].includes(item.department) ||
        !item.documentId ||
        !Number.isSafeInteger(item.sheetId) ||
        !item.uid ||
        !item.article ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity <= 0 ||
        item.positionId !== expected ||
        seen.has(expected)
      ) {
        packingIssues.push("Не подтверждена позиция задания «Запасы склад».");
        continue;
      }
      seen.add(expected);
      const matches = tasks.filter(
        (t) => t.stockPositionId === expected && !t.packingExcluded,
      );
      if (
        matches.length > 1 ||
        (matches.length === 1 && matches[0].plan !== item.quantity)
      ) {
        packingIssues.push(
          `${item.article}: план запасов изменился — обновите данные.`,
        );
        continue;
      }
      const packed = packedFor(expected, "RITM-STOCK-WAREHOUSE", item.article);
      if (matches.length === 1) {
        matches[0].packed = packed;
        continue;
      }
      if (!item.archivedAt || !Number.isFinite(Date.parse(item.archivedAt))) {
        packingIssues.push(
          `${item.article}: позиция запасов отсутствует в подтверждённом производственном снимке.`,
        );
        continue;
      }
      const key = `stock:${item.documentId}:${item.sheetId}`;
      let supply = supplies.find((s) => s.key === key);
      if (!supply) {
        supply = {
          key,
          name: `Запасы · Запасы склад · ${item.department === "roll" ? "рулонная печать" : "бокс"}`,
          plan: 0,
          printed: 0,
          cut: 0,
          stock: true,
          urgent: false,
          market: "Ozon",
        };
        supplies.push(supply);
      }
      tasks.push({
        id: `archived-stock:${expected}`,
        supplyKey: key,
        name: supply.name,
        article: item.article,
        machine: "",
        department: item.department,
        plan: item.quantity,
        printed: item.quantity,
        cut: item.quantity,
        packed,
        stock: true,
        urgent: false,
        assemblyOnly: true,
        areaPerPiece: null,
        sheetsPerPiece: null,
      });
    }
    for (const task of tasks.filter(
      (t) => t.stock && !t.packingExcluded && !t.assemblyOnly,
    ))
      if (!task.stockPositionId || !seen.has(task.stockPositionId))
        packingIssues.push(
          `${task.article}: производственные запасы не совпадают с заданием Assembly.`,
        );
  }
  const timestamp = Date.parse(live?.snapshotAt || live?.updatedAt || "");
  return {
    tasks,
    supplies,
    issues,
    packingIssues: [...new Set(packingIssues)],
    packingFresh:
      !!live?.packing &&
      live.packing.status === "available" &&
      live.packing.invalidRecords === 0 &&
      Number.isFinite(Date.parse(live.packing.checkedAt)) &&
      Date.parse(live.packing.checkedAt) <= now + 60000 &&
      now - Date.parse(live.packing.checkedAt) <= 15 * 60000,
    fresh:
      !!live?.ok &&
      !live.stale &&
      Number.isFinite(timestamp) &&
      timestamp <= now + 60000 &&
      now - timestamp <= 15 * 60000,
  };
}
