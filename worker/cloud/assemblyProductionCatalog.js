import { CloudError } from "./access.js";
import { callAssemblyV2 } from "./assemblyV2Transport.js";
import { marketplaceForSupply, normalizeCatalogArticle } from "../printing.js";

const exactArticle = article => String(article ?? "").trim().normalize("NFC").toLocaleUpperCase("ru-RU");

export async function readAssemblyProductionCatalog(bindings, market, articles, fetcher, { includePhotos = false, includeProductDetails = false } = {}) {
  try {
    const response = await callAssemblyV2(bindings, "/api/ritm/production-catalog", {
      method: "POST", body: JSON.stringify({ market, articles, ...(includePhotos ? { includePhotos } : {}), ...(includeProductDetails ? { includeProductDetails } : {}) }),
      fetcher, timeout: 15000,
    });
    if (!response.ok) throw new Error("catalog status");
    const data = await response.json();
    if (data.ok !== true || !Array.isArray(data.entries) || (includeProductDetails && data.productDetailsVersion !== 1))
      throw new Error("catalog response");
    return data.entries;
  } catch {
    throw new CloudError("production_catalog_unavailable", "Не удалось прочитать справочник «RITM Сборка». Повторите проверку распределения.", 503);
  }
}

// The printing snapshot already knows the active articles. Ask the catalog
// for these articles only and feed the existing store/machine matching rules.
export async function readWorkloadCatalog(bindings, orders, stockOrders, fetcher) {
  const markets = { OZON: new Set(), WB: new Set() };
  for (const [rows, stock] of [[orders, false], [stockOrders, true]]) {
    for (const row of rows) {
      const market = stock ? "OZON" : marketplaceForSupply(row.sheetName);
      const exact = exactArticle(row.article);
      if (markets[market] && exact && exact.length <= 120 && !exact.startsWith("#")) {
        markets[market].add(exact);
        const alias = normalizeCatalogArticle(exact);
        if (alias) markets[market].add(alias);
      }
    }
  }
  const resolved = await Promise.all(Object.entries(markets).map(async ([market, articles]) => {
    const keys = [...articles], batches = [];
    for (let index = 0; index < keys.length; index += 500) {
      batches.push(readAssemblyProductionCatalog(bindings, market, keys.slice(index, index + 500), fetcher,
        { includePhotos: true, includeProductDetails: true }));
    }
    try {
      const entries = (await Promise.all(batches)).flat();
      const equipment = market === "OZON" ? "Станок" : "Вид станка по умолчанию";
      return [market, [
        ["Артикул", "", "Магазин", equipment, "Название товара", "Фото", "В коробке", "Тип короба"],
        ...entries.map(entry => [entry.article, "", entry.store, entry.machine, entry.name, entry.photoUrl, entry.unitsPerBox, entry.boxType]),
      ]];
    } catch {
      return [market, null];
    }
  }));
  return Object.fromEntries(resolved);
}

export async function readAssemblyItemCatalog(bindings, market, articles, fetcher) {
  if (!["OZON", "WB"].includes(market)) throw new CloudError("catalog_market_unknown", "Укажите маркетплейс поставки.", 400);
  const requested = [...new Set(articles.map(exactArticle).filter(Boolean))];
  if (!requested.length) return [];
  if (requested.length > 500 || requested.some(article => article.length > 120))
    throw new CloudError("catalog_articles_invalid", "Проверьте список артикулов.", 400);
  const entries = await readAssemblyProductionCatalog(bindings, market, requested, fetcher,
    { includePhotos: true, includeProductDetails: true });
  const byArticle = new Map();
  for (const entry of entries) {
    const key = exactArticle(entry.article);
    if (!byArticle.has(key)) byArticle.set(key, []);
    byArticle.get(key).push(entry);
  }
  return requested.map(article => {
    const matches = byArticle.get(article) || [];
    const one = (field, requireAll = false) => {
      const all = matches.map(row => String(row[field] ?? "").trim());
      const values = new Set(all.filter(Boolean));
      return values.size === 1 && (!requireAll || all.every(Boolean)) ? [...values][0] : "";
    };
    return { article, found: matches.length > 0, ambiguous: matches.length > 1,
      name: one("name"), type: one("kind"), boxType: one("boxType", true), capacity: one("unitsPerBox", true),
      photoUrl: one("photoUrl"), photoStatus: "checked" };
  });
}

export async function importAssemblyProductionExtensions(bindings, rows, fetcher) {
  const response = await callAssemblyV2(bindings, "/api/ritm/production-extensions", {
    method: "POST", body: JSON.stringify({rows}), fetcher, timeout: 25000,
  });
  const receipt = await response.json().catch(() => null);
  if (!response.ok || receipt?.ok !== true || !Number.isSafeInteger(receipt.matched))
    throw new CloudError("production_extensions_import_failed", "«RITM Сборка» не подтвердила импорт расширений.", 503);
  return {ok:true, matched:receipt.matched, different:receipt.different};
}
