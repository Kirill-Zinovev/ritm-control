import type { Supply } from "./model";

// Same rule as nextCartonNumber_/cartonSupplyAbbreviation_ in the live Assembly.
export function cartonPrefix(supply: Pick<Supply, "store" | "title">): string {
  const shop = supply.store.trim().match(/^(?:магазин\s*)?(\d+)$/iu);
  if (!shop || !Number.isSafeInteger(Number(shop[1])))
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
  return String(Number(shop[1])) + letters.slice(0, 3);
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
