import test from "node:test";
import assert from "node:assert/strict";
process.env.RITM_GOOGLE_CATALOG_ID = "synthetic-catalog-document-000000000";
const { readProductionShopCatalog } = await import("../agent/adapters.js");
const { CATALOG_ID } = await import("../worker/printing.js");

function fixture() {
  const wbHeader = Array(20).fill(""); wbHeader[0] = "Артикул"; wbHeader[1] = "Артикул (oz)"; wbHeader[19] = "магазин";
  const wb = Array(20).fill(""); wb[0] = "WB-OWN"; wb[1] = "WB-ALIAS"; wb[19] = "2";
  const ozHeader = Array(16).fill(""); ozHeader[0] = "Артикул"; ozHeader[15] = "магазин";
  const oz = Array(16).fill(""); oz[0] = "OZ-OWN(OZ)"; oz[1] = "OZ-OWN"; oz[15] = "1";
  return { spreadsheetId: CATALOG_ID, valueRanges: [
    { range: "WB!A1:T100", values: [wbHeader, wb] },
    { range: "OZON!A1:P200", values: [ozHeader, oz] },
  ] };
}
const reader = (data, inspect = () => {}) => ({
  accessToken: async () => "synthetic-test-token",
  request: async (url, options) => { inspect(url, options); return Response.json(data); },
});

test("catalog reader accepts canonical Google A1 ranges and preserves both WB aliases", async () => {
  const rows = await readProductionShopCatalog(reader(fixture(), (url, options) => {
    assert.equal(options.method, "GET");
    assert.deepEqual(url.searchParams.getAll("ranges"), ["'WB'!A:T", "'OZON'!A:P"]);
  }));
  assert.equal(rows.WB[1][0], "WB-OWN");
  assert.equal(rows.WB[1][1], "WB-ALIAS");
  assert.equal(rows.WB[1][19], "2");
  assert.equal(rows.OZON[1][15], "1");
});

test("catalog reader refuses a different workbook or column instead of accepting misaligned values", async () => {
  const wrongBook = fixture(); wrongBook.spreadsheetId = "different-workbook";
  await assert.rejects(readProductionShopCatalog(reader(wrongBook)), /response invalid/);
  const wrongColumn = fixture(); wrongColumn.valueRanges[1].range = "OZON!A1:O200";
  await assert.rejects(readProductionShopCatalog(reader(wrongColumn)), /response invalid/);
  const wrongStart = fixture(); wrongStart.valueRanges[1].range = "OZON!A2:P200";
  await assert.rejects(readProductionShopCatalog(reader(wrongStart)), /response invalid/);
});

test("unavailable catalog remains unknown and never triggers a write", async () => {
  assert.equal(await readProductionShopCatalog(null), null);
  await assert.rejects(readProductionShopCatalog({ accessToken: async () => "test", request: async (_url, options) => {
    assert.equal(options.method, "GET"); return new Response("denied", { status: 403 });
  } }), /unavailable/);
});
