import { shipmentProductBarcodes, summarizeOzonProducts, type OzonGroup, type OzonLabels } from "./ozon-shipment";

export interface WbCartonCode {
  code: string;
  printCode: string | null;
}

export const wbCodeKey = (code: string) => code.toUpperCase();
export const isWbCartonCode = (code: unknown): code is string =>
  typeof code === "string" && code.length > 0 && code.length <= 128 && !/[\s\p{Cc}]/u.test(code);
export const isWbPrintCode = (code: unknown): code is string =>
  typeof code === "string" && code.length > 0 && code.length <= 512 && !/[\s\p{Cc}]/u.test(code);

export function validateWbCartonCodes(entries: readonly WbCartonCode[], boxCount: number) {
  if (entries.length !== boxCount) throw Error(`Кодов WB: ${entries.length}. Коробов RITM: ${boxCount}.`);
  const codes = new Set<string>();
  const printCodes = new Set<string>();
  for (const entry of entries) {
    if (!isWbCartonCode(entry?.code) ||
      (entry.printCode !== null && (!isWbPrintCode(entry.printCode) || entry.printCode === entry.code)))
      throw Error("Проверьте ШК короба и QR для печати в файле WB.");
    const key = wbCodeKey(entry.code);
    if (codes.has(key) || (entry.printCode && printCodes.has(entry.printCode)))
      throw Error("Один код WB указан для нескольких коробов.");
    codes.add(key);
    if (entry.printCode) printCodes.add(entry.printCode);
  }
}

export function wbCodesForBoxes(entries: WbCartonCode[], labels: OzonLabels | null, count: number) {
  validateWbCartonCodes(entries, count);
  if (!labels) return entries;
  const byCode = new Map(entries.map((entry) => [entry.code, entry]));
  return labels.codes.map((code, index) => {
    const entry = byCode.get(code);
    if (!entry) throw Error("В файле другие ШК коробов. Проверьте, что это выгрузка этой поставки WB.");
    return { ...entry, printCode: entry.printCode ?? labels.printCodes?.[index] ?? null };
  });
}

export function wbProductBarcodes(group: OzonGroup) {
  return shipmentProductBarcodes(group.products ?? group.labels?.products ?? []);
}

export function wbUnresolvedArticles(group: OzonGroup) {
  const codes = wbProductBarcodes(group);
  return summarizeOzonProducts(group.boxes).filter(({ sku }) => !codes.get(sku)).map(({ sku }) => sku);
}
