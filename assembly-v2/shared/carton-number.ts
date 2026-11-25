import type { Supply } from "./model";

export function cartonNumberKey(label: string) {
  return label.normalize("NFC").trim().toLocaleLowerCase("ru-RU");
}

export function cartonNumberList(input: string) {
  return [...new Set(input.split(/[\s,;]+/u).map(cartonNumberKey).filter(Boolean))];
}

export function cartonStoreNumber(store: string): number | null {
  const match = store.trim().match(/^(?:магазин\s*)?(\d+)$/iu);
  if (!match) return null;
  const storeNumber = Number(match[1]);
  return Number.isSafeInteger(storeNumber) ? storeNumber : null;
}

// Same rule as nextCartonNumber_/cartonSupplyAbbreviation_ in the live Assembly.
export function cartonPrefix(supply: Pick<Supply, "store" | "title">): string {
  const shop = cartonStoreNumber(supply.store);
  if (shop === null)
    throw new Error("Магазин товара не подтверждён. Короб не создан.");
  const letters = supply.title
    .replace(/^\s*(?:ozon|wildberries|wb)\s*/i, "")
    .replace(/\s+\d{1,2}[_./-]\d{1,2}\s*$/i, "")
    .replace(/\s+\d{1,4}\s*$/i, "")
    .toLocaleLowerCase("ru-RU")
    .replace(/[^a-zа-яё]/gi, "");
  if (letters.length < 3)
    throw new Error(
      "В названии поставки не удалось определить первые три буквы для номера короба.",
    );
  return String(shop) + letters.slice(0, 3);
}

export function nextCartonLabel(
  supply: Pick<Supply, "store" | "title">,
  labels: string[],
): string {
  const prefix = cartonPrefix(supply);
  let maximum = 0;
  for (const label of labels) {
    const m = label.trim().match(/^(.*?)(\d+)$/u);
    if (!m || m[1].toLocaleLowerCase("ru-RU") !== prefix) continue;
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER)
      throw new Error("Некорректный номер короба. Требуется проверка журнала.");
    maximum = Math.max(maximum, n);
  }
  return prefix + String(maximum + 1);
}
