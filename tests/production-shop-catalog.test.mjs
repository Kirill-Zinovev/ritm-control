import test from "node:test";
import assert from "node:assert/strict";
process.env.RITM_GOOGLE_CATALOG_ID = "synthetic-catalog-document-000000000";
const { readProductionShopCatalog } = await import("../agent/adapters.js");
const { CATALOG_ID } = await import("../worker/printing.js");

function fixture() {
  return { spreadsheetId: CATALOG_ID, valueRanges: [
    { range: "WB!A1:B100", values: [["Артикул", "Артикул (oz)"], ["WB-OWN", "WB-ALIAS"]] },
    { range: "WB!T1:T100", values: [["магазин"], ["2"]] },
    { range: "OZON!A1:B200", values: [["Артикул", ""], ["OZ-OWN(OZ)", "OZ-OWN"]] },
    { range: "OZON!P1:P200", values: [["магазин"], ["1"]] },
  ] };
}
const reader = (data, inspect = () => {}) => ({
  accessToken: async () => "synthetic-test-token",
  request: async (url, options) => { inspect(url, options); return Response.json(data); },
});

test("catalog reader accepts canonical Google A1 ranges and preserves both WB aliases", async () => {
  const rows = await readProductionShopCatalog(reader(fixture(), (url, options) => {
    assert.equal(options.method, "GET");
    assert.deepEqual(url.searchParams.getAll("ranges"), ["'WB'!A:B", "'WB'!T:T", "'OZON'!A:B", "'OZON'!P:P"]);
  }));
  assert.equal(rows.WB[1][0], "WB-OWN");
  assert.equal(rows.WB[1][1], "WB-ALIAS");
  assert.equal(rows.WB[1][19], "2");
  assert.equal(rows.OZON[1][15], "1");
});

test("catalog reader refuses a different workbook or column instead of accepting misaligned values", async () => {
  const wrongBook = fixture(); wrongBook.spreadsheetId = "different-workbook";
  await assert.rejects(readProductionShopCatalog(reader(wrongBook)), /response invalid/);
  const wrongColumn = fixture(); wrongColumn.valueRanges[3].range = "OZON!O1:O200";
  await assert.rejects(readProductionShopCatalog(reader(wrongColumn)), /response invalid/);
  const wrongStart = fixture(); wrongStart.valueRanges[2].range = "OZON!A2:B200";
  await assert.rejects(readProductionShopCatalog(reader(wrongStart)), /response invalid/);
});

test("unavailable catalog remains unknown and never triggers a write", async () => {
  assert.equal(await readProductionShopCatalog(null), null);
  await assert.rejects(readProductionShopCatalog({ accessToken: async () => "test", request: async (_url, options) => {
    assert.equal(options.method, "GET"); return new Response("denied", { status: 403 });
  } }), /unavailable/);
});
