import test from "node:test";
import assert from "node:assert/strict";
import { CloudStore } from "../worker/cloud/store.js";
import { CloudSheetsReader } from "../worker/cloud/googleSheets.js";
import { productionTabVisibility, reconcileProductionTabs } from "../worker/cloud/productionTabs.js";
import { buildAssemblyV2Feed } from "../worker/cloud/assemblyV2Feed.js";
import { loadPrinting, ROLL_PRINTING_SHEET, ROLL_PRINTING_SHEET_ID } from "../worker/printing.js";
import { LocalD1 } from "./helpers/d1-sqlite.mjs";
import { cloudSchemaStatements } from "./helpers/cloud-schema.mjs";
import { bindings } from "./cloud-env.mjs";

test("automatic hiding and manual return leave the Assembly roster unchanged", async t => {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(";\n"));
  t.after(() => db.close());
  const store = new CloudStore(db);
  const originalToken = CloudSheetsReader.prototype.accessToken;
  CloudSheetsReader.prototype.accessToken = async () => "local-test-only";
  t.after(() => { CloudSheetsReader.prototype.accessToken = originalToken; });
  const env = { ...bindings, DB: db, RITM_CLOUD_WRITES_ENABLED: "true",
    RITM_CLOUD_CUTOVER_ID: "visibility-test", RITM_GOOGLE_WRITER_JSON: "test" };
  await store.withScope(scope => {
    scope.meta("migrationReady", true);
    scope.meta("cloudCutover", { id: "visibility-test", localWriterDisabled: true });
  });
  const id = "RITM-SUPPLY-00000000-0000-4000-8000-000000000123", name = "OZON ТЕСТ";
  const tabs = [
    { sourceId: "roll-printing", spreadsheetId: env.RITM_GOOGLE_ROLL_PRINTING_ID, sheetId: 101, name, assemblyShipmentId: id },
    { sourceId: "box-printing", spreadsheetId: env.RITM_GOOGLE_BOX_PRINTING_ID, sheetId: 102, name, assemblyShipmentId: id },
  ];
  const documents = Object.fromEntries(tabs.map(sheet => [sheet.sourceId, sheet.spreadsheetId]));
  await store.withScope(scope => scope.meta("productionSupplies", [{ id, name, parts: tabs.map(sheet => ({
    department: sheet.sourceId.split("-")[0], sheetId: sheet.sheetId, documentId: sheet.spreadsheetId,
  })) }]));
  const facts = tabs.map((sheet, index) => ({...sheet, sheetName:name, row:5, rawUid:"item" + index, article:"SKU" + index,
    quantity:20, printProgress:20, cutProgress:20, productionTabComplete:index === 0, shop:"1", shopCatalogStatus:"matched"}));
  const report = { ok:true, snapshotAt:new Date().toISOString(), quality:{status:"valid"}, issues:[], sheets:tabs, supplies:facts };
  const lease = await store.acquire("refresh:printing");
  await store.saveSnapshot("printing", report, lease);
  await store.release(lease);
  const actual = new Map(tabs.map(tab => [tab.spreadsheetId, {sheetId:tab.sheetId,title:tab.name,hidden:false}]));
  const sent = [];
  const fetcher = async (input, options) => {
    const document = new URL(input).pathname.split("/").at(-1).split(":")[0];
    const tab = actual.get(document);
    assert.ok(tab);
    if (options.method === "POST") {
      assert.equal(await store.productionSnapshotReadAllowed(), true, "visibility never uses the shipment write lease");
      const requests = JSON.parse(options.body).requests;
      for (const request of requests) {
        const expected = request.updateSheetProperties?.properties?.hidden;
        assert.equal(typeof expected, "boolean");
        assert.deepEqual(request, { updateSheetProperties:{properties:{sheetId:tab.sheetId,hidden:expected},fields:"hidden"} });
        tab.hidden = expected;
        sent.push([tab.sheetId, expected]);
      }
      return Response.json({});
    }
    return Response.json({spreadsheetId:document,sheets:[{properties:tab},{properties:{sheetId:999,title:"Журнал",hidden:false}}]});
  };
  const feed = async () => buildAssemblyV2Feed({
    snapshot:await store.snapshot("printing"), scope:await store.assemblyFeedContext(), now:store.now(), documents,
  });
  const before = await feed();
  assert.equal(before.supplies[0].positions.length, 2);
  assert.deepEqual(await reconcileProductionTabs(env,store,report,fetcher), {hidden:1,shown:0});
  assert.deepEqual(sent, [[101,true]]);
  assert.deepEqual(await feed(), before);
  const request = { department:"roll", sheetId:101, name, hidden:false };
  assert.equal((await productionTabVisibility(request,{bindings:env,store,fetcher,change:true})).hidden, false);
  assert.deepEqual(await reconcileProductionTabs(env,store,report,fetcher), {hidden:0,shown:0});
  assert.deepEqual(sent, [[101,true],[101,false]]);
  const block = { ...request, sheetId:999 };
  await assert.rejects(productionTabVisibility(block,{bindings:env,store,fetcher,change:true}), {code:"production_tab_missing"});
});

test("a hidden source falls back to the same tab's formatted Sheets values", async () => {
  const selected = { department:"roll", sheetId:ROLL_PRINTING_SHEET.gid, name:ROLL_PRINTING_SHEET.name };
  let fallback = false;
  const grid = Array.from({length:5}, () => Array(30).fill(""));
  grid[0][29] = "UID";
  grid[3][4] = "Артикул";
  grid[3][14] = "Кол-во";
  grid[4][4] = "SKU";
  grid[4][14] = "30";
  grid[4][29] = "stored-id";
  const source = await loadPrinting(async url => {
    if (new URL(url).searchParams.get("gid") === String(selected.sheetId)) return new Response("",{status:404});
    return new Response('ID записи,Дата,Сотрудник,Операция,Лист,Строка,Артикул,UID заказа,Рулон,Сделано,Площадь,Выпуск м²,Дата создания,Комментарий');
  }, {supplyTarget:selected,readHiddenSupply:async (id,sheetId,name) => {
    assert.deepEqual([id,sheetId,name],[ROLL_PRINTING_SHEET_ID,selected.sheetId,selected.name]);
    fallback = true;
    return grid;
  }});
  assert.equal(fallback, true);
  assert.deepEqual(source.supplies.map(row => [row.article,row.quantity,row.rawUid]), [["SKU",30,"stored-id"]]);
});
