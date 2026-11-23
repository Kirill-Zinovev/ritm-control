import type { Dispatch } from "./model";

export interface OzonProduct {
  sku: string;
  name: string;
  qty: number;
}
export interface OzonBox {
  id: string;
  label: string;
  qty: number;
  products: OzonProduct[];
}
export interface OzonPreviewBox {
  id: string;
  label: string;
  qty: number;
  state: "open" | "closed";
  proof: string;
}
export interface OzonPreviewGroup {
  key: string;
  store: string;
  city: string;
  cluster: string;
  boxes: OzonPreviewBox[];
}
export interface OzonPreview {
  groups: OzonPreviewGroup[];
  issues: { label: string; reason: string }[];
}
export interface OzonComposition {
  batchId: string;
  city: string;
  cluster: string;
  boxes: OzonBox[];
}
export interface OzonLabels {
  id: string;
  codes: string[];
  products: { sku: string; barcode: string }[];
}
export interface OzonGroup extends OzonComposition {
  dispatch: Dispatch;
  labels: OzonLabels | null;
}
export interface OzonBatchSummary {
  id: string;
  createdAt: string;
  groupCount: number;
  boxCount: number;
  labelCount: number;
}
export interface OzonBatch {
  id: string;
  groups: OzonGroup[];
}

export const ozonBoxLimit = 500;
export const ozonGroupBoxLimit = 100;

export function ozonCartonKey(label: string) {
  return label.normalize("NFC").trim().toLocaleLowerCase("ru-RU");
}
export function parseOzonCartonNumbers(input: string) {
  const numbers = [...new Set(input.split(/[\s,;]+/u).map(ozonCartonKey).filter(Boolean))];
  if (!numbers.length) throw Error("Вставьте номера коробов.");
  if (numbers.length > ozonBoxLimit || numbers.some((number) => number.length > 80))
    throw Error("Проверьте список. За один раз можно подготовить до " + ozonBoxLimit + " коробов.");
  return numbers;
}
export const isOzonCargoCode = (value: string) => /^\d{12,24}$/u.test(value);
export const ozonArticle = (sku: string) => sku.trim().replace(/(?:\s*\(OZ\))+$/iu, "") + "(OZ)";

export function ozonProductBarcodes(labels: OzonLabels | null) {
  const codes = new Map<string, string | null>();
  for (const { sku, barcode } of labels?.products ?? []) {
    const code = barcode.trim();
    if (!code) continue;
    const article = ozonArticle(sku);
    const previous = codes.get(article);
    codes.set(article, previous === undefined || previous === code ? code : null);
  }
  return codes;
}

export function ozonCodesByCarton(group: OzonGroup | null) {
  const codes = new Map<string, string>();
  if (group?.labels && group.labels.codes.length === group.boxes.length) {
    for (const [index, box] of group.boxes.entries()) {
      const code = group.labels.codes[index];
      if (isOzonCargoCode(code)) codes.set(box.id, code);
    }
  }
  return codes;
}

export function readOzonCargoCodes(input: string) {
  const codes = input.split(/[\s,;]+/u).filter(Boolean);
  if (!codes.length || codes.some((code) => !isOzonCargoCode(code)))
    throw Error("Вставьте штрихкоды грузомест Ozon, по одному на строку.");
  if (new Set(codes).size !== codes.length)
    throw Error("В списке повторяются штрихкоды грузомест.");
  return codes;
}

export function summarizeOzonProducts(
  boxes: readonly OzonBox[],
  article = (sku: string) => sku,
): OzonProduct[] {
  const products = new Map<string, OzonProduct>();
  for (const box of boxes) {
    for (const item of box.products) {
      const sku = article(item.sku);
      const previous = products.get(sku);
      products.set(sku, {
        sku,
        name: previous?.name || item.name,
        qty: (previous?.qty ?? 0) + item.qty,
      });
    }
  }
  return [...products.values()].sort((a, b) => a.sku.localeCompare(b.sku, "ru"));
}
