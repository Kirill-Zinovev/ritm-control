import {
  emptyPlanning,
  validateResources,
  validateDeadlines,
} from "../../shared/productionPlanning.js";
import { CloudError } from "./access.js";

export function readPlanning(scope) {
  const stored = scope.meta("productionPlanning");
  const state = (Array.isArray(stored) && stored[0]) || emptyPlanning();
  const deadlines = { ...state.deadlines };
  for (const supply of scope.meta("productionSupplies") || []) {
    const key = `shipment:${supply.id}`;
    if (!Object.hasOwn(deadlines, key) && supply.planning)
      deadlines[key] = supply.planning;
  }
  return { ...state, deadlines };
}

// Same identity rule as buildProductionGroups: never merge by shipment title.
export function activePlanningKeys(printing) {
  const keys = new Set();
  for (const sheet of printing?.sheets || []) {
    if (!["roll-printing", "box-printing"].includes(sheet.sourceId)) continue;
    const ids = new Set(
      [
        sheet.assemblyShipmentId,
        ...(printing.supplies || [])
          .filter(
            (o) => o.sheetId === sheet.sheetId && o.sourceId === sheet.sourceId,
          )
          .map((o) => o.assemblyShipmentId),
      ].filter(Boolean),
    );
    keys.add(
      ids.size === 1
        ? `shipment:${[...ids][0]}`
        : ids.size === 0 && sheet.sourceId === "roll-printing"
          ? `shipment:RITM-ROLL-${sheet.sheetId}`
          : `sheet:${sheet.sourceId}:${sheet.sheetId}`,
    );
  }
  return keys;
}

export function savePlanning(
  scope,
  input,
  { principal, printing, now = Date.now() } = {},
) {
  if (!principal || !["owner", "manager"].includes(principal.role))
    throw new CloudError(
      "planning_forbidden",
      "Настройки доступны после входа в RITM.",
      403,
    );
  const state = readPlanning(scope);
  if (
    !Number.isSafeInteger(input?.revision) ||
    input.revision !== state.revision
  )
    throw new CloudError(
      "planning_conflict",
      "Настройки изменились у другого сотрудника. Обновите их и повторите сохранение.",
      409,
    );
  const allowed =
    input.action === "resources"
      ? ["action", "revision", "resources"]
      : input.action === "packing-stock" || input.action === "cut-confirmation"
        ? ["action", "revision", "taskId", "article", "quantity"]
      : ["action", "revision", "key", "deadlines"];
  if (Object.keys(input).some((k) => !allowed.includes(k)))
    throw new CloudError(
      "planning_invalid",
      "Неподдерживаемые параметры прогноза.",
      400,
    );
  try {
    if (input.action === "resources") {
      if (principal.role !== "owner")
        throw new CloudError(
          "planning_owner_required",
          "Скорость и график участков настраивает руководитель.",
          403,
        );
      state.resources = validateResources(input.resources);
    } else if (input.action === "cut-confirmation") {
      if (principal.role !== "owner")
        throw new CloudError("planning_owner_required", "Порезку для прогноза подтверждает руководитель.", 403);
      if (typeof input.taskId !== "string" || !input.taskId || input.taskId.length > 500 ||
          typeof input.article !== "string" || !input.article || input.article.length > 100 ||
          !Number.isSafeInteger(input.quantity) || input.quantity < 0)
        throw new Error("Проверьте артикул и количество порезки.");
      const matches = (printing?.supplies || []).filter((o) =>
        ["roll-printing", "box-printing"].includes(o.sourceId) &&
        `${o.spreadsheetId || o.sourceId}:${o.sheetId}:${o.rawUid || o.uid || o.row}` === input.taskId &&
        o.article === input.article,
      );
      const order = matches[0];
      if (matches.length !== 1 || !Number.isSafeInteger(order.quantity) || order.quantity <= 0 ||
          (input.quantity > 0 && (input.quantity !== order.quantity ||
            order.printProgress !== order.quantity || order.cutProgress !== 0 ||
            (order.planningCut !== undefined && order.planningCut !== 0))))
        throw new CloudError("planning_cut_source_conflict", "Позиция или отметки производства изменились. Обновите данные и проверьте порезку.", 409);
      state.cutConfirmations = [...(state.cutConfirmations || []), {
        taskId: input.taskId,
        article: input.article,
        quantity: input.quantity,
        sourcePlan: order.quantity,
        recordedAt: new Date(now).toISOString(),
        recordedBy: principal.displayName || principal.username || "Руководитель",
      }];
    } else if (input.action === "packing-stock") {
      if (principal.role !== "owner")
        throw new CloudError("planning_owner_required", "Источник товара подтверждает руководитель.", 403);
      if (typeof input.taskId !== "string" || !input.taskId || input.taskId.length > 500 ||
          typeof input.article !== "string" || !input.article || input.article.length > 100 ||
          !Number.isSafeInteger(input.quantity) || input.quantity < 0)
        throw new Error("Проверьте артикул и количество товара со склада.");
      const matches = (printing?.supplies || []).filter((o) =>
        ["roll-printing", "box-printing"].includes(o.sourceId) &&
        `${o.spreadsheetId || o.sourceId}:${o.sheetId}:${o.rawUid || o.uid || o.row}` === input.taskId &&
        o.article === input.article,
      );
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].packed) ||
          !Number.isSafeInteger(matches[0].quantity) || matches[0].quantity < 0 || input.quantity > matches[0].packed ||
          (input.quantity > 0 && (!Array.isArray(matches[0].packingEventIds) ||
            !matches[0].packingEventIds.length || matches[0].packingEventIds.some((id) => typeof id !== "string" || !id))))
        throw new CloudError("planning_stock_source_conflict", "Позиция или количество упаковки изменились. Обновите данные и проверьте источник.", 409);
      state.stockSources = [...(state.stockSources || []), {
        taskId: input.taskId,
        article: input.article,
        quantity: input.quantity,
        packingEventIds: [...(matches[0].packingEventIds || [])],
        recordedAt: new Date(now).toISOString(),
        recordedBy: principal.displayName || principal.username || "Руководитель",
      }];
    } else if (input.action === "deadlines") {
      const keys = activePlanningKeys(printing);
      for (const s of scope.meta("productionSupplies") || [])
        keys.add(`shipment:${s.id}`);
      if (!keys.has(input.key))
        throw new CloudError(
          "planning_supply_missing",
          "Поставка не найдена в подтверждённом реестре. Обновите данные.",
          409,
        );
      const prior = state.deadlines[input.key];
      const dates = input.deadlines && !Object.hasOwn(input.deadlines, "packingAt") && prior?.packingAt
        ? { ...input.deadlines, packingAt: prior.packingAt }
        : input.deadlines;
      state.deadlines[input.key] = validateDeadlines(dates);
    } else throw new Error("Неизвестное действие с прогнозом.");
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError("planning_invalid", error.message, 400);
  }
  const next = {
    ...state,
    revision: state.revision + 1,
    updatedAt: new Date(now).toISOString(),
    updatedBy: principal.displayName || principal.username || "Руководитель",
  };
  scope.meta("productionPlanning", [next]);
  scope.log(
    "production_planning",
    `${principal.role} ${input.action} ${input.key || ""}`,
  );
  return next;
}
