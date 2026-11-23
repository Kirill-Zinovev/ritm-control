import test from "node:test";
import assert from "node:assert/strict";
process.env.RITM_GOOGLE_CATALOG_ID = "synthetic-catalog-document-000000000";
const { readProductionShopCatalog } = await import("../agent/adapters.js");
const { CATALOG_ID, assignCatalogStores, assignWorkloadDetails } = await import("../worker/printing.js");
const { readWorkloadCatalog, readAssemblyItemCatalog } = await import("../worker/cloud/assemblyProductionCatalog.js");

const assembly = {
  RITM_ASSEMBLY_V2_TARGET_URL: "https://assembly-v2.zinovevkirill234.chatgpt.site",
  RITM_ASSEMBLY_V2_FEED_SECRET: "a".repeat(64),
};

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

test("workload asks the modern catalog for current active articles and preserves production facts", async () => {
  const orders = [
    { sheetName: "OZON Москва", article: "A-1(OZ)", machine: "УФ", productName: "Старое название", quantity: 10, plannedArea: 4.3 },
    { sheetName: "WB Щербинка", article: "B-2", machine: "УФ", quantity: 2, plannedArea: 1.25 },
  ];
  const stock = [{ sheetName: "Запасы", article: "A-2", quantity: 15 }];
  const calls = new Map();
  const fetcher = async (url, init) => {
    assert.equal(url, assembly.RITM_ASSEMBLY_V2_TARGET_URL + "/api/ritm/production-catalog");
    assert.ok(init.headers["x-assembly-v2-signature"]);
    const { market, articles, includeProductDetails } = JSON.parse(init.body);
    assert.equal(includeProductDetails, true);
    calls.set(market, articles);
    const entries = articles.filter(article => article !== "A-1").map(article => ({ article, store: market === "OZON" ? "1" : "2",
      machine: market === "OZON" ? "2-GO" : "XEROX", name: "Карточка", boxType: "М", unitsPerBox: 200 }));
    return Response.json({ ok: true, productDetailsVersion: 1, entries });
  };
  const values = await readWorkloadCatalog(assembly, orders, stock, fetcher);
  assert.deepEqual(calls.get("OZON"), ["A-1(OZ)", "A-1", "A-2"]);
  assert.deepEqual(calls.get("WB"), ["B-2"]);
  assert.equal(assignCatalogStores(orders, values).matched, 2);
  assignWorkloadDetails(orders, values, null, {preferCatalog: true});
  assert.deepEqual(orders.map(o => [o.shop, o.machine, o.productName, o.plannedArea, o.catalogUnitsPerBox]),
    [["1", "2-GO", "Карточка", 4.3, 200], ["2", "XEROX", "Карточка", 1.25, 200]]);
  const [item] = await readAssemblyItemCatalog(assembly, "WB", ["B-2"], fetcher);
  assert.equal(item.capacity, "200");
  assert.equal(item.boxType, "М");
  assert.equal(item.found, true);
});
