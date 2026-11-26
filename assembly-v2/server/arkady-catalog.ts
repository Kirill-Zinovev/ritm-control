import { catalogKey, spreadsheetError } from "../shared/catalog";
import { catalogArticleForMarket, catalogMachineSection, type ManagedProduct } from "../shared/catalog-editor";
import type { Market } from "../shared/model";
import { json, type Database } from "./api";
import { catalogEditAudit, saveCard } from "./catalog-editor";
import { requireCatalog as check, selectableCatalog } from "./catalog-store";
import type { SqlStore } from "./database";

export const arkadyCatalogAction = "ritm.arkadyCatalogApply";
const editableFields = [
  "machine", "size", "rollMultiplicity", "xeroxMultiplicity", "cutNorm", "assemblyNorm", "packingNorm",
] as const;
type EditableField = (typeof editableFields)[number];
const normOperations = { cutNorm: "cut", assemblyNorm: "assembly", packingNorm: "packing" } as const;
const readKeys = ["action", "market", "store", "article"];
const writeKeys = [...readKeys, "id", "importId", "revision", "field", "value", "approvalId", "approvedBy"];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && !!value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function target(input: Record<string, unknown>): { market: Market; article: string; store?: string } {
  const { market, article, store } = input;
  check((market === "OZON" || market === "WB") && text(article, 120), "Укажите маркетплейс и артикул.");
  check(store === undefined || text(store, 100), "Укажите магазин из справочника.");
  return { market, article: catalogKey(article), store: store?.trim() };
}

function isEditableField(value: unknown): value is EditableField {
  return editableFields.some(field => field === value);
}

function parseValue(field: EditableField, value: unknown): string | number {
  if (field === "machine" || field === "size") {
    check(text(value, 100) && !spreadsheetError(value) && !/^[=+@]/.test(value.trim()), "Укажите корректное значение поля.");
    if (field === "machine") check(catalogMachineSection(value), "Выберите станок из справочника.");
    return value.trim();
  }
  const multiplicity = field === "rollMultiplicity" || field === "xeroxMultiplicity";
  const quantity = typeof value === "number" ? value
    : multiplicity && typeof value === "string" && /^\d+(?:[.,]\d+)?$/.test(value.trim())
      ? Number(value.trim().replace(",", ".")) : NaN;
  check(quantity > 0 && quantity <= 10_000_000, "Укажите число больше нуля.");
  return multiplicity ? String(quantity) : quantity;
}

function parseApply(input: Record<string, unknown>) {
  check(input.action === "apply" && !Object.keys(input).some(key => !writeKeys.includes(key)), "Проверьте запрос изменения.");
  const item = target(input);
  const { id, importId, revision, field, approvalId, approvedBy } = input;
  check(item.store && text(id, 1000) && text(importId, 200)
    && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0,
    "Откройте нужную карточку и проверьте её версию.");
  check(isEditableField(field), "Выберите доступное поле справочника.");
  check(typeof approvalId === "string" && uuid.test(approvalId) && text(approvedBy, 180), "Требуется подтверждение владельца РИТМ.");
  return { ...item, store: item.store, action: "apply", id, importId, revision, field,
    value: parseValue(field, input.value), approvalId: approvalId.toLowerCase(), approvedBy };
}

async function catalogImport(store: SqlStore) {
  const [meta] = await store.all<{ id: string | null }>("select active_catalog_id id from av2_meta where id=1");
  return meta?.id;
}

async function machineOptions(store: SqlStore, importId: string) {
  const rows = await store.all<{ machine: string }>(
    `select distinct machine from ${selectableCatalog} where import_id=? and machine<>'' order by machine`,
    [importId],
  );
  return [...new Set(rows.map(({ machine }) => machine.trim()).filter(catalogMachineSection))];
}

function readEntry(product: ManagedProduct, importId: string) {
  return {
    id: product.id, importId, revision: product.editRevision ?? 0, market: product.market,
    store: product.store, article: product.sku,
    fields: {
      machine: product.machine, size: product.size,
      rollMultiplicity: product.rollMultiplicity, xeroxMultiplicity: product.xeroxMultiplicity,
      cutNorm: product.workNorms?.cut ?? null, assemblyNorm: product.workNorms?.assembly ?? null,
      packingNorm: product.workNorms?.packing ?? null,
    },
  };
}

async function readRows(store: SqlStore, importId: string, market: Market, article: string, shop?: string) {
  // Accept the exact printed Ozon article with or without its conventional
  // suffix. An alias never grants permission to choose a different card.
  const sku = market === "OZON" ? catalogArticleForMarket(article, market) : article;
  return store.all<{ data: string }>(
    `select data from ${selectableCatalog}
      where import_id=? and market=? and store<>'' and (? is null or store=?)
      and sku in (?,?) order by store,sku limit 21`,
    [importId, market, shop ?? null, shop ?? null, article, sku],
  );
}

export async function arkadyCatalogApi(request: Request, store: SqlStore, db: Database, actor: string) {
  if (actor !== "ritm-service") return json({ error: "Требуется служебный запрос РИТМ." }, 403);
  if (request.method !== "POST") return json({ error: "Метод запроса не поддерживается." }, 405);
  let input: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 4000) return json({ error: "Слишком большой запрос." }, 413);
    const value: unknown = JSON.parse(raw);
    check(value && typeof value === "object" && !Array.isArray(value), "Ожидается объект JSON.");
    input = value as Record<string, unknown>;
  } catch {
    return json({ error: "Проверьте запрос Аркадия." }, 400);
  }
  if (input.action === "read") {
    let item;
    try {
      check(!Object.keys(input).some(key => !readKeys.includes(key)), "Лишние поля в запросе справочника.");
      item = target(input);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Проверьте запрос справочника." }, 400);
    }
    const importId = await catalogImport(store);
    if (!importId) return json({ error: "Справочник RITM Сборка не подключён." }, 503);
    const [rows, machine] = await Promise.all([
      readRows(store, importId, item.market, item.article, item.store), machineOptions(store, importId),
    ]);
    if (rows.length > 20) return json({ error: "Несколько карточек. Уточните магазин и артикул." }, 409);
    const entries = rows.map(({ data }) => readEntry(JSON.parse(data) as ManagedProduct, importId));
    return json({ ok: true, entries, fieldOptions: { machine } });
  }
  if (input.action !== "apply") return json({ error: "Неизвестное действие со справочником." }, 400);
  let change;
  try { change = parseApply(input); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "Проверьте правку." }, 400); }
  try {
    const result = await db.command(arkadyCatalogAction, change, "ritm:arkady-catalog:" + change.approvalId,
      "ritm-owner:" + change.approvedBy);
    return json({ ok: true, ...result });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Правка справочника не подтверждена." }, 409);
  }
}

export async function arkadyCatalogPlan(store: SqlStore, input: Record<string, unknown>, actor: string, now: string) {
  const change = parseApply(input);
  check(actor === "ritm-owner:" + change.approvedBy, "Требуется подтверждение владельца РИТМ.");
  check(await catalogImport(store) === change.importId, "Справочник обновился. Подготовьте правку заново.");
  const [row] = await store.all<{ data: string }>(
    `select data from ${selectableCatalog} where import_id=? and entry_id=? and market=? and store=? and sku=?`,
    [change.importId, change.id, change.market, change.store, change.article],
  );
  check(row, "Карточка изменилась. Подготовьте правку заново.");
  const before = JSON.parse(row.data) as ManagedProduct;
  check((before.editRevision ?? 0) === change.revision, "Карточка изменилась. Подготовьте правку заново.");
  if (change.field === "machine")
    check((await machineOptions(store, change.importId)).some(option => option === change.value),
      "Выберите действующий станок из справочника.");
  const { field, value } = change;
  check(readEntry(before, change.importId).fields[field] !== value, "Указанное значение уже сохранено.");
  const product: ManagedProduct = { ...before, editRevision: change.revision + 1, updatedAt: now };
  // A revision created for another field does not validate an imported sheet count.
  if (!before.editRevision && before.rows.some(row => spreadsheetError(row.raw.sheetsPerUnit || "")))
    product.sheetCountSourceError = true;
  if (field === "machine" || field === "size" || field === "rollMultiplicity" || field === "xeroxMultiplicity")
    product[field] = String(value);
  else
    product.workNorms = { ...before.workNorms, [normOperations[field]]: Number(value) };
  return {
    statements: [
      saveCard(product, actor, now),
      catalogEditAudit(before, product, actor, now, "Подтверждённая правка Аркадия " + change.approvalId),
    ],
    result: { entryId: product.id, revision: product.editRevision },
  };
}
