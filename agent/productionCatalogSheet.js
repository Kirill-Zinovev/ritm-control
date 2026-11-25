export const productionCatalogSheet = "_RITM_СПРАВОЧНИК";
export const productionCatalogFields = ["Фото", "Кол-во листов", "Размер", "Папка печати", "Кратность"];
export const stockCatalogFields = [...productionCatalogFields, "Станок", "расширения", "Магазин"];

export function supplyCatalogShop(name) {
  const matches = [...String(name).matchAll(/(?:магазин\s*([12])(?!\d)|(?<!\d)([12])\s*(?:[-‑–]\s*)?(?:й|ый)?\s*магазин)/giu)];
  const shops = new Set(matches.map(match => match[1] || match[2]));
  return shops.size === 1 ? [...shops][0] : "";
}

export function selectSupplyCatalogEntries(entries, shop) {
  const scoped = entries.filter(entry => !shop || entry.store === shop);
  const primary = scoped.filter(entry => entry.primary === true);
  return primary.length ? primary : scoped;
}

const rowArticle = row => `REGEXREPLACE(REGEXREPLACE(UPPER(TRIM(TO_TEXT($E${row})));"\\s+";"");"\\(OZ\\)$";"")`;

export function sheetCatalogFormula({ market, shop, department, stock }, row, field) {
  const sku = rowArticle(row);
  const key = `"${market}|${shop}|"&${sku}`;
  const lookup = `IFERROR(VLOOKUP(${key};'${productionCatalogSheet}'!$A$2:$${stock ? "I" : "F"};${field + 1};FALSE);"")`;
  const result = field === 1 ? 'IFERROR(IMAGE(catalog_value);"")' : "catalog_value";
  const empty = stock ? `TRIM(TO_TEXT($E${row}))=""` : `$E${row}=""`;
  const skip = field === 5 && department === "box"
    ? `OR(${empty};NOT(REGEXMATCH(UPPER(TRIM(TO_TEXT($D${row})));"^(XEROX|КСЕРОКС|X|Х)$")))` : empty;
  return `=IF(${skip};"";LET(catalog_value;${lookup};IF(OR(catalog_value="";catalog_value=0);"";${result})))`;
}

const formulaText = value => `"${String(value).replaceAll('"', '""')}"`;

export function stockCatalogValueFormula(sheet, row, article, field, value) {
  const live = sheetCatalogFormula(sheet, row, field);
  const scalar = typeof value === "number" ? value : formulaText(value);
  return `=IF(${rowArticle(row)}=${formulaText(article)};${scalar};${live.slice(1)})`;
}
