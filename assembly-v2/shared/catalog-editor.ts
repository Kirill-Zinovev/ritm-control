import type { CatalogDetail, CatalogEntry } from './catalog';
import type { Operation } from './model';

export type ManagedProduct = CatalogEntry & {
  editRevision?: number;
  updatedAt?: string;
  workNorms?: Partial<Record<Operation, number | null>>;
  labelSha?: string | null;
};
export type ManagedDetail = CatalogDetail & ManagedProduct;
export const productFields = [
  ['name', 'Название товара'], ['barcode', 'Штрихкод'], ['kind', 'Вид для расчёта выработки'],
  ['category', 'Категория'], ['machine', 'Станок'], ['catalogDepartment', 'Участок печати'],
  ['packaging', 'Упаковка'], ['size', 'Размер'], ['sheetsPerUnit', 'Листов на изделие'],
  ['printFolder', 'Папка печати'], ['boxType', 'Тип короба'],
  ['rollMultiplicity', 'Кратность рулонной печати'], ['xeroxMultiplicity', 'Кратность Xerox'],
] as const;
export const mediaPath = (sha: string) => `/api/catalog/media?sha256=${sha}`;
export const isCatalogMedia = (value: string) => /^\/api\/catalog\/media\?sha256=[a-f0-9]{64}$/.test(value);
