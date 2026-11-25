import test from "node:test";
import assert from "node:assert/strict";
import { planCatalogBook, sheetCatalogRow } from "../worker/cloud/productionSheetCatalog.js";

const headers = ["Фото", "Наличие макета", "Станок", "Артикул", "расширения", "Кол-во листов", "Размер", "Ширина", "Высота", "м²", "Осталось", "Папка печати", "Кратность", "", "Кол-во"];
const cacheHeaders = ["Ключ", "Фото", "Кол-во листов", "Размер", "Папка печати", "Кратность"];
const article = "WI0009.A0143";
const legacy = "=IFNA(VLOOKUP(E5;'Cache FBO'!B:G;5;0);\"\")";
const photo = "=IFERROR(VLOOKUP(E5;IMPORTRANGE(\"photo-book\";\"'Ссылки'!A:C\");3;0);\"\")";
const data = [photo, "Макет не готов", '="2-GO"', article, "CBI", legacy, "", "", "", "", "", "Ручная папка", legacy, "", 20];
const book = (row = data, department = "roll", stored = [cacheHeaders]) => ({ stored, sheets: [{
  market: "OZON", shop: "2", department, id: 17, entries: [{ row: 5, article }], values: [headers, row],
}] });
const catalogs = (...entries) => new Map([["OZON", new Map([[article, entries]])]]);
const correct = { article, store: "2", primary: true, sheetsPerUnit: "3", machine: "2-GO", size: "22х16", printFolder: "Порезка", rollMultiplicity: "10", xeroxMultiplicity: "4", photoUrl: "https://images.example.test/one.webp" };

test("a position missing from Assembly is wired once and fills from the next cache refresh", () => {
  const first = planCatalogBook(book(), catalogs());
  assert.deepEqual(first.patches.map(patch => patch.column), [1, 6, 7, 12, 13]);
  assert.equal(first.changedRows.length, 0);
  assert.match(first.patches[0].formula, /IMAGE\(catalog_value\)/);
  assert.ok(first.patches.every(patch => !/Cache FBO|_RITM_WB_SOURCE|IMPORTRANGE/.test(patch.formula)));
  assert.match(first.patches[2].formula, /OZON\|2\|/);
  const linked = [...data];
  for (const patch of first.patches) linked[patch.column - 1] = patch.formula;
  const second = planCatalogBook(book(linked), catalogs(correct));
  assert.equal(second.patches.length, 0);
  assert.deepEqual(second.changedRows[0].data, ["OZON|2|WI0009.A0143", correct.photoUrl, 3, "22х16", "Порезка", 10]);
  assert.equal(planCatalogBook(book(linked, "roll", [cacheHeaders, ...second.cacheRows]), catalogs(correct)).changedRows.length, 0);
});

test("synchronization respects marketplace, store, conflicting product fields and print department", () => {
  const sheet = book().sheets[0];
  assert.equal(sheetCatalogRow(sheet, article, [{ ...correct, store: "1" }])[2], "");
  const mixed = sheetCatalogRow({ ...sheet, shop: "" }, article, [correct, { ...correct, store: "1", sheetsPerUnit: "4" }]);
  assert.equal(mixed[2], "");
  assert.equal(mixed[3], "22х16");
  assert.equal(sheetCatalogRow({ ...sheet, department: "box" }, article, [correct])[5], 4);
  const boxRow = [...data];
  boxRow[2] = '="УФ планшет"';
  const multiple = planCatalogBook(book(boxRow, "box"), catalogs(correct)).patches.find(patch => patch.column === 13);
  assert.match(multiple.formula, /NOT\(REGEXMATCH\(UPPER\(TRIM\(TO_TEXT\(\$D5\)\)\);"\^\(XEROX\|КСЕРОКС\|X\|Х\)\$"\)\)/);
  assert.equal(planCatalogBook(book(), new Map([["WB", catalogs(correct).get("OZON")]])).patches.length, 0);
});

test("previously connected cells and machine assignments lose their old lookup", () => {
  const previous = [...data];
  previous[2] = legacy;
  previous[5] = `=IFERROR(VLOOKUP(E5;'_RITM_СПРАВОЧНИК'!A:F;3;FALSE);${legacy.slice(1)})`;
  const source = book(previous);
  source.sheets[0].machines = [["УФ", article]];
  const current = planCatalogBook(source, catalogs(correct));
  assert.equal(current.patches.find(patch => patch.column === 3).formula, '="УФ"');
  assert.ok(current.patches.every(patch => !/Cache FBO|_RITM_WB_SOURCE|IMPORTRANGE/.test(patch.formula)));
  source.sheets[0].machines[0][1] = "OTHER";
  assert.ok(!planCatalogBook(source, catalogs(correct)).patches.some(patch => patch.column === 3));
});
