import type { Scope } from "../shared/model";

export function CatalogArticleLink({ sku, scope, label = sku }: { sku: string; scope: Pick<Scope, "market" | "store">; label?: string }) {
  const params = new URLSearchParams({
    view: "catalog", catalog_q: sku, catalog_market: scope.market, catalog_store: scope.store, catalog_open: "1",
  });
  return <a className="catalog-article-link" href={`/?${params}`} target="_blank" rel="noopener"
    title="Открыть карточку в справочнике">{label}</a>;
}
