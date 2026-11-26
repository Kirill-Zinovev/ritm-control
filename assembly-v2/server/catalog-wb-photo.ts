import { catalogKey, photoAllowed } from "../shared/catalog";
import { emptyCatalogProduct, type ManagedProduct } from "../shared/catalog-editor";
import { catalogWbPhotoBatchSize, type CatalogWbPhoto, type CatalogWbPhotoResult } from "../shared/catalog-wb-photo";
import { catalogEditAudit, saveCard } from "./catalog-editor";
import { findCatalogAliases, requireCatalog as check } from "./catalog-store";
import type { SqlStore, Statement } from "./database";

const baseArticle = (sku: string) => sku.replace(/\(OZ\)$/, "");
const identity = ({ market, store, sku }: CatalogWbPhoto) => JSON.stringify([market, store, sku]);
const allowed = (url: string | null | undefined) => !!url && photoAllowed(url);

export async function catalogImportWbPhotosPlan(store: SqlStore, payload: Record<string, unknown>, actor: string, now: string) {
  check(Array.isArray(payload.entries) && payload.entries.length > 0 && payload.entries.length <= catalogWbPhotoBatchSize,
    "Проверьте количество ссылок на фото WB.");
  const entries: CatalogWbPhoto[] = payload.entries.map((raw: unknown) => {
    const value = raw as Partial<CatalogWbPhoto> | null;
    check(value && (value.market === "WB" || value.market === "OZON") && (value.store === "1" || value.store === "2") &&
      typeof value.sku === "string" && value.sku.length <= 120 &&
      typeof value.wbId === "string" && /^\d{5,16}$/.test(value.wbId) &&
      typeof value.photoUrl === "string" && value.photoUrl.length <= 2048 && photoAllowed(value.photoUrl) &&
      typeof value.title === "string" && value.title.trim() && value.title.length <= 1000,
      "Проверьте артикул, магазин и ссылку на фото WB.");
    const sku = catalogKey(value.sku);
    check(/^[\p{L}\p{N}._-]+$/u.test(baseArticle(sku)) && new URL(value.photoUrl).pathname.split("/")[3] === value.wbId,
      "Артикул в ссылке на фото не совпадает с карточкой WB.");
    return { ...value, sku, title: value.title.trim() } as CatalogWbPhoto;
  });
  const ids = entries.map(identity);
  check(new Set(ids).size === ids.length, "В списке повторяется карточка.");
  const [meta] = await store.all<{ activeCatalogId: string | null }>("select active_catalog_id from av2_meta where id=1");
  check(meta?.activeCatalogId && payload.importId === meta.activeCatalogId, "Справочник изменился. Откройте загрузку заново.");
  const importId = meta.activeCatalogId;
  const matched = new Map<string, Map<string, ManagedProduct>>();
  for (const market of ["WB", "OZON"] as const) {
    const codes = [...new Set(entries.filter(row => row.market === market).flatMap(({ sku }) => [sku, baseArticle(sku)]))];
    if (!codes.length) continue;
    for (const row of await findCatalogAliases(store, market, codes)) {
      const product = JSON.parse(row.data) as ManagedProduct;
      const key = market + "|" + baseArticle(row.alias);
      const cards = matched.get(key) ?? new Map<string, ManagedProduct>();
      cards.set(product.id, product);
      matched.set(key, cards);
    }
  }
  const photoIds = [...new Set([...matched.values()].flatMap(cards => [...cards.values()].map(card => card.photoId))
    .filter((id): id is string => !!id))];
  const legacy = new Map((photoIds.length ? await store.all<{ photoId: string; url: string }>(
    "select photo_id,json_extract(data,'$.primary') url from av2_catalog_photos where import_id=? and photo_id in (select value from json_each(?))",
    [importId, JSON.stringify(photoIds)]) : []).map(row => [row.photoId, row.url]));
  const retired = new Set((await store.all<{ entryId: string }>(
    "select entry_id from av2_catalog_products where json_extract(data,'$.retiredIdentity')=1 and entry_id in (select value from json_each(?))",
    [JSON.stringify(ids)])).map(row => row.entryId));
  const statements: Statement[] = [];
  const rows: CatalogWbPhotoResult[] = [];
  for (const [index, row] of entries.entries()) {
    const id = ids[index];
    const candidates = [...(matched.get(row.market + "|" + baseArticle(row.sku))?.values() || [])];
    const sameSku = candidates.filter(card => baseArticle(card.sku) === baseArticle(row.sku));
    const sameStore = sameSku.filter(card => card.store === row.store);
    const exact = sameStore.length ? sameStore : sameSku.filter(card => !card.store);
    const before = exact.length === 1 ? exact[0] : null;
    if (exact.length > 1 || (!before && (candidates.length || row.market !== "WB" || retired.has(id)))) {
      rows.push({ sku: row.sku, status: "review" });
      continue;
    }
    const current = before?.photoUrl || (before?.photoId ? legacy.get(before.photoId) : "");
    if (allowed(current) || allowed(before?.layoutPhotoUrl)) {
      rows.push({ sku: row.sku, status: "already" });
      continue;
    }
    const base: ManagedProduct = before ?? {
      ...emptyCatalogProduct(), id, sku: row.sku, aliases: [row.sku], market: "WB", store: row.store, name: row.title,
      issues: ["Вместимость короба не задана", "Штрихкод не указан"],
    };
    const photo = base.photoUrl ? { layoutPhotoUrl: row.photoUrl } : { photoUrl: row.photoUrl };
    const product: ManagedProduct = { ...base, ...photo, editRevision: (base.editRevision ?? 0) + 1, updatedAt: now };
    statements.push(saveCard(product, actor, now), catalogEditAudit(before, product, actor, now, "Фото WB · артикул " + row.wbId));
    rows.push({ sku: row.sku, status: before ? "updated" : "created" });
  }
  return { statements, result: { rows } };
}
