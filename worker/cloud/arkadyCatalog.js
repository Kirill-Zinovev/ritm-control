import { randomUUID } from "node:crypto";
import { CloudError } from "./access.js";
import { callAssemblyV2 } from "./assemblyV2Transport.js";
import { readAssemblyProductionCatalog } from "./assemblyProductionCatalog.js";
import { routeAssemblyCatalogLines } from "../../agent/productionSupplies.js";
import { marketplaceForSupply } from "../printing.js";

const route = "/api/ritm/arkady-catalog";
const catalogFields = new Set(["machine", "size", "rollMultiplicity", "xeroxMultiplicity", "cutNorm", "assemblyNorm", "packingNorm"]);
const normFields = new Set(["cutNorm", "assemblyNorm", "packingNorm"]);
const entryKey = value => typeof value === "string" && value.length > 0 && value.length <= 160;

export async function arkadyCatalog(input, { bindings, principal, writesEnabled, fetcher }) {
  if (!principal || !["owner", "manager"].includes(principal.role))
    throw new CloudError("arkady_catalog_forbidden", "Войдите в РИТМ, чтобы открыть справочник.", 403);

  const { action, market, article, store } = input ?? {};
  if (!["read", "apply", "check"].includes(action) || !["OZON", "WB"].includes(market) ||
      typeof article !== "string" || !article.trim() || article.length > 120 ||
      (store !== undefined && !["1", "2"].includes(store)))
    throw new CloudError("arkady_catalog_input", "Проверьте артикул, маркетплейс и магазин.", 400);

  if (action === "check") {
    const { quantity, supplyName } = input;
    if (!store || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000 ||
        typeof supplyName !== "string" || supplyName.length > 200 ||
        marketplaceForSupply(supplyName) !== market)
      throw new CloudError("arkady_catalog_preview", "Уточните поставку и количество позиции.", 400);
    const entries = await readAssemblyProductionCatalog(bindings, market, [article.trim()], fetcher);
    const [line] = routeAssemblyCatalogLines([{ article: article.trim(), quantity }], entries, supplyName);
    if (line.store && line.store !== store)
      throw new CloudError("arkady_catalog_store", "Поставка использует карточку другого магазина.", 409);
    return { ok: true, line };
  }

  const write = action === "apply";
  const canEdit = principal.role === "owner" && writesEnabled === true;
  const body = { action, market, article: article.trim(), ...(store ? { store } : {}) };
  if (write) {
    if (!canEdit)
      throw new CloudError("arkady_catalog_owner_required", "Правку справочника выполняет владелец РИТМа при включённой записи.", 403);
    if (input.explicitWriteApproval !== true)
      throw new CloudError("arkady_catalog_confirmation", "Подтвердите выбранное изменение справочника.", 409);
    const { id, importId, revision, field, value } = input;
    if (!store || ![id, importId].every(entryKey) || !Number.isSafeInteger(revision) || revision < 0 || !catalogFields.has(field) ||
        typeof value !== "string" || !value.trim() || value.length > 100)
      throw new CloudError("arkady_catalog_change", "Откройте точную карточку и проверьте новое значение.", 400);
    const cleaned = value.trim();
    const nextValue = normFields.has(field) && /^\d+(?:[.,]\d+)?$/.test(cleaned)
      ? Number(cleaned.replace(",", ".")) : cleaned;
    Object.assign(body, { id, importId, revision, field, value: nextValue,
      approvalId: randomUUID(), approvedBy: principal.id });
  }

  let response, data;
  try {
    response = await callAssemblyV2(bindings, route, {
      method: "POST", body: JSON.stringify(body), fetcher, timeout: 12000,
    });
    data = await response.json();
  } catch {
    throw new CloudError("arkady_catalog_unavailable", write
      ? "Сборка пока не подтвердила сохранение. Откройте карточку заново для проверки."
      : "Справочник РИТМ Сборки временно недоступен.", 503);
  }
  if (response.status === 409 || response.status === 404 && data?.code === "arkady_catalog_not_found")
    throw new CloudError("arkady_catalog_conflict", "Карточка изменилась или стала недоступна. Откройте её заново.", 409);
  if (response.status === 400 || response.status === 422)
    throw new CloudError("arkady_catalog_value", "Справочник отклонил значение. Проверьте формат поля.", 400);
  if (!response.ok || data?.ok !== true || (!write && !Array.isArray(data.entries)))
    throw new CloudError("arkady_catalog_unavailable", write
      ? "Сборка пока не подтвердила сохранение. Откройте карточку заново для проверки."
      : "Справочник РИТМ Сборки временно недоступен.", 503);
  return write ? { ok: true } : { ok: true, canEdit, entries: data.entries, fieldOptions: data.fieldOptions };
}
