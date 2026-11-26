import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { CloudSheetsReader } from "../worker/cloud/googleSheets.js";
import { layoutPhotoIndex, machineLayoutPhotoFormula, syncMachineLayoutPhotos } from "../worker/cloud/machineLayoutPhotos.js";
import { machineLayoutPhotoSheet as cache } from "../worker/cloud/machineLayouts.js";
import { sourceId } from "../worker/cloud/config.js";

const photo = id => "https://basket-01.wbbasket.ru/vol1/part1/1/images/big/" + id + ".webp";
const article = "AA0001.A1234";
const catalogItem = (id, store, sku = article, primary = true) => ({ article: sku, store, primary, photoUrl: photo(id) });

test("photo matching respects the store, OZ suffix and ambiguous duplicates", () => {
  const index = layoutPhotoIndex([article], [
    ["WB", [catalogItem(1, 1), catalogItem(2, 2), catalogItem(9, 1, article, false)]],
    ["OZON", [catalogItem(3, 2, article + "(OZ)")]],
  ]);
  assert.equal(index.get(article + "|1"), photo(1));
  assert.equal(index.get(article + "|2"), photo(2));
  assert.equal(index.get(article + "|"), "");
  assert.equal(index.get(article + "(OZ)|2"), photo(3));
  assert.equal(index.has(article + "(OZ)|1"), false);
});

test("the live sync replaces the old import while preserving manual photos and all other columns", async () => {
  const id = sourceId({}, "machineLayoutsId"), legacy = sourceId({}, "assemblyPhotosId");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const account = JSON.stringify({ type: "service_account", client_email: "test@example.test", private_key: privateKey });
  const bindings = { RITM_GOOGLE_READER_JSON: account, RITM_GOOGLE_WRITER_JSON: account,
    RITM_CLOUD_WRITES_ENABLED: "true", RITM_CLOUD_CUTOVER_ID: "test-cutover",
    RITM_ASSEMBLY_V2_TARGET_URL: "https://assembly-v2.zinovevkirill234.chatgpt.site",
    RITM_ASSEMBLY_V2_FEED_SECRET: "a".repeat(64) };
  const properties = { title: "Все макеты", sheetId: 0, gridProperties: { rowCount: 5, columnCount: 22 } };
  const value = (stringValue) => ({ effectiveValue: { stringValue } });
  const row = (...values) => ({ values });
  const old = { userEnteredValue: { formulaValue: '=IMPORTRANGE("' + legacy + '";"A1")' } };
  const manual = { userEnteredValue: { formulaValue: '=IMAGE("' + photo(5) + '")' } };
  const writes = [];
  const fetcher = async (href, options) => {
    const url = new URL(href);
    if (url.origin === "https://oauth2.googleapis.com") return Response.json({ access_token: "synthetic", expires_in: 3600 });
    if (url.pathname.endsWith("/production-catalog")) {
      const market = JSON.parse(options.body).market;
      return Response.json({ ok: true, entries: market === "WB" ? [catalogItem(1, 1)] : [] });
    }
    if (url.pathname.endsWith(":batchUpdate")) {
      const { requests } = JSON.parse(options.body);
      writes.push(requests);
      return Response.json({ spreadsheetId: id, replies: requests.map(() => ({})) });
    }
    const ranges = url.searchParams.getAll("ranges");
    const data = ranges.length > 1 ? [
      { startColumn: 1, rowData: [row(value("Артикул"), value("Фото")), row(value(article), old), row(value(article)), row(value(article), manual)] },
      { startColumn: 5, rowData: [row(value("Магазин")), row(value("1"))] },
    ] : ranges.length ? [{ startColumn: 2, rowData: [row(value("Фото")), row(old), row(), row(manual)] }] : undefined;
    return Response.json({ spreadsheetId: id, sheets: [{ properties, data }] });
  };
  const store = { acquire: async () => "layout", renew: async () => {}, release: async () => {} };
  const preview = await syncMachineLayoutPhotos(bindings, store, { fetcher });
  assert.equal(preview.matched, 3);
  assert.equal(writes.length, 0);
  const outcome = await syncMachineLayoutPhotos(bindings, store, { fetcher, dryRun: false });
  assert.equal(outcome.formulas, 2);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].map(request => Object.keys(request)[0]), ["addSheet", "updateCells", "repeatCell"]);
  assert.equal(writes[0][0].addSheet.properties.hidden, true);
  assert.equal(writes[0][1].updateCells.range.sheetId, cache.id);
  const { range, cell } = writes[0][2].repeatCell;
  assert.deepEqual(range, { sheetId: 0, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 3 });
  assert.equal(cell.userEnteredValue.formulaValue, machineLayoutPhotoFormula);
  assert.doesNotMatch(machineLayoutPhotoFormula, /IMPORTRANGE/);
  const writer = new CloudSheetsReader(bindings, { writer: true, fetcher, beforeWrite: async () => {} });
  await assert.rejects(writer.request("https://sheets.googleapis.com/v4/spreadsheets/" + id, { write: true }),
    { code: "source_read_only" });
});
