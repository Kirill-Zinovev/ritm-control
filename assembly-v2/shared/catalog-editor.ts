import { catalogKey, type CatalogDetail, type CatalogEntry } from './catalog';
import type { Market, Operation } from './model';
import { ozonArticle } from './ozon-shipment';

export type ManagedProduct = CatalogEntry & {
  editRevision?: number;
  updatedAt?: string;
  workNorms?: Partial<Record<Operation, number | null>>;
  labelSha?: string | null;
  retiredIdentity?: true;
  sheetCountSourceError?: true;
};
export type ManagedDetail = CatalogDetail & ManagedProduct;
export type CatalogHandoffLookup =
  | { status: 'found'; entry: ManagedDetail }
  | { status: 'missing'; importId: string };
export const catalogHandoffBarcode = (value: unknown, market: Market): value is string =>
  typeof value === 'string' &&
  (/^[0-9]{6,32}$/.test(value) || (market === 'OZON' && /^OZN[0-9]{9,10}$/.test(value)));
export const catalogHandoffStore = (value: unknown): value is '1' | '2' =>
  value === '1' || value === '2';
export type CatalogFamilyCard = Pick<ManagedDetail, 'id' | 'sku' | 'market' | 'store' | 'name'>;
export interface CatalogFamilyMatches {
  cards: CatalogFamilyCard[];
  hasMore: boolean;
}
export function catalogFamilyKey(sku: string) {
  const family = catalogKey(sku).split('.')[0];
  return /^[\p{L}\p{N}_-]{2,60}$/u.test(family) ? family : '';
}
export function catalogArticleForMarket(sku: string, market: Market) {
  const base = catalogKey(sku).replace(/(?:\s*\((?:OZ|WB)\))+$/u, '').trimEnd();
  return base && market === 'OZON' ? ozonArticle(base) : base;
}
export function catalogMachineSection(machine: string) {
  const value = catalogKey(machine).replace(/[-‑–\s]+/g, ' ');
  if (['2 GO','УФ','УФ БЕЛ.','УФ. БЕЛ','УФ БЕЛЫЙ','УФ ДВУСТОРОННИЙ'].includes(value)) return 'Рулонная печать';
  return ['УФ ПЛАНШЕТ','DTF','XEROX'].includes(value) ? 'Бокс' : '';
}
export const productFields = [
  ['name', 'Название товара'], ['barcode', 'Штрихкод'], ['kind', 'Вид для расчёта выработки'],
  ['category', 'Категория'], ['machine', 'Станок'], ['catalogDepartment', 'Участок печати'],
  ['packaging', 'Упаковка'], ['size', 'Размер'], ['sheetsPerUnit', 'Листов на изделие'],
  ['printFolder', 'Папка печати'], ['boxType', 'Тип короба'],
  ['printExtension', 'Расширение печати'],
  ['rollMultiplicity', 'Кратность рулонной печати'], ['xeroxMultiplicity', 'Кратность Xerox'],
] as const;
export const mediaPath = (sha: string) => `/api/catalog/media?sha256=${sha}`;
export const isCatalogMedia = (value: string) => /^\/api\/catalog\/media\?sha256=[a-f0-9]{64}$/.test(value);
