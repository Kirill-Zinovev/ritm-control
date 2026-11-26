import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../server/api";
import type { Database } from "../server/api";
import { catalogImportWbPhotosPlan } from "../server/catalog-wb-photo";
import type { SqlStore } from "../server/database";
import { emptyCatalogProduct } from "../shared/catalog-editor";

const importId = "catalog-test";
const at = "2026-11-26T13:00:00Z";
const sku = "AA0001.A1234";
const photoUrl = "https://basket-01.wbbasket.ru/vol123/part12345/12345678/images/big/1.webp";
const row = { market: "WB", store: "2", sku, wbId: "12345678", title: "Точный товар WB", photoUrl };

test("imports new WB cards with photos and preserves existing private photos, identity and production data", async () => {
  const existingSku = "AA0002.A1234(OZ)";
  const privatePhoto = "/api/catalog/media?sha256=" + "a".repeat(64);
  const current = { ...emptyCatalogProduct(), id: JSON.stringify(["OZON", "2", existingSku]), sku: existingSku,
    store: "2", photoUrl: privatePhoto, barcode: "OZN5555555555", unitsPerBox: 160, kind: "Наклейки", editRevision: 4,
  };
  const store = {
    async all(sql: string, args: unknown[]) {
      if (sql.startsWith("select active_catalog_id")) return [{ activeCatalogId: importId }];
      if (sql.includes("av2_catalog_aliases") && args[0] === "OZON")
        return [{ data: JSON.stringify(current), alias: existingSku }];
      return [];
    },
  } as SqlStore;
  const result = await catalogImportWbPhotosPlan(store,
    { importId, entries: [row, { ...row, sku: existingSku, market: "OZON" }] }, "owner", at);
  assert.deepEqual(result.result.rows.map(item => item.status), ["created", "updated"]);
  assert.equal(result.statements.length, 4);
  assert.ok(result.statements.every(statement => !/av2_positions|av2_allocations|av2_warehouse_receipts/.test(statement.sql)));
  const added = JSON.parse(String(result.statements[0].args[7]));
  const updated = JSON.parse(String(result.statements[2].args[7]));
  assert.deepEqual([added.sku, added.photoUrl, added.unitsPerBox, added.barcode], [sku, photoUrl, null, ""]);
  assert.deepEqual([updated.photoUrl, updated.layoutPhotoUrl, updated.unitsPerBox, updated.barcode, updated.editRevision],
    [privatePhoto, photoUrl, 160, "OZN5555555555", 5]);
  await assert.rejects(catalogImportWbPhotosPlan(store,
    { importId, entries: [{ ...row, wbId: "87654321" }] }, "owner", at), /не совпадает/);
});

test("bulk photo import requires the owner role", async () => {
  const response = await api(new Request("https://assembly.example.test/api/command", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "catalog.importWbPhotos", key: "test", payload: { importId, entries: [row] } }),
  }), {} as Database, "manager-session", "manager");
  assert.equal(response.status, 403);
});
