import type { CartonItem } from "../shared/model";
import { ProductPhoto } from "./ProductPhoto";

export function CartonProduct({ item }: { item: CartonItem }) {
  return (
    <div className="carton-product">
      <ProductPhoto
        importId={item.catalogImportId || ""}
        id={item.photoId || null}
        sourceUrl={item.photoUrl}
        sku={item.sku}
        className="carton-content-photo"
      />
      <div className="carton-product-copy">
        <strong className="carton-product-sku">{item.sku}</strong>
        {item.name !== item.sku ? (
          <span className="carton-product-name" title={item.name}>
            {item.name}
          </span>
        ) : null}
        <small className="carton-product-supply">{item.supply}</small>
      </div>
    </div>
  );
}
