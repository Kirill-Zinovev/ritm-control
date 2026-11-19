import { spreadsheetError } from './catalog';
import type { ManagedProduct } from './catalog-editor';

export type LabelProduct = Pick<ManagedProduct, 'market' | 'sku' | 'name' | 'barcode' | 'store' | 'packaging'>;

export function missingLabelFields(product: LabelProduct): string[] {
  const fields = [
    [product.sku, 'артикул'],
    [product.barcode, 'штрихкод'],
    [product.store, 'номер магазина'],
    product.market === 'WB' ? [product.packaging, 'упаковка (строка «Размер» на этикетке WB)'] : [product.name, 'название товара'],
  ];
  return fields.filter(([value]) => !value.trim() || spreadsheetError(value)).map(([, field]) => field);
}

export function labelInputKey(product: LabelProduct): string {
  const shared = [product.market, product.sku, product.barcode, product.store];
  return JSON.stringify([...shared, product.market === 'WB' ? product.packaging : product.name].map(v => v.trim()));
}
