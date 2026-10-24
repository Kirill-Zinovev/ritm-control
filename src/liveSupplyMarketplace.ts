export type SupplyMarketplace = "Ozon" | "WB";

function hasWord(value: string, word: string) {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`,
    "u",
  ).test(value);
}

export function supplyMarketplace(name: string): SupplyMarketplace | null {
  const normalized = name.toLocaleUpperCase("ru-RU");
  const isOzon = hasWord(normalized, "OZON");
  const isWb =
    hasWord(normalized, "WB") || hasWord(normalized, "WILDBERRIES");
  if (isOzon === isWb) return null;
  return isWb ? "WB" : "Ozon";
}
