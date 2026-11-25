import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { labelsApi } from "../server/labels-api";
import { catalogList } from "../server/catalog-store";
import { api } from "../server/api";
import { productFields, type ManagedProduct } from "../shared/catalog-editor";
import { labelInputKey } from "../shared/product-label-fields";
import { openDatabase } from "../server/local-db";
import { catalogApi, type FileStore } from "../server/catalog-api";
import { digest } from "../shared/catalog";
import { labelArticle, type LabelEntry, type LabelManifest, type PrintableLabel } from "../shared/labels";
import type { Snapshot } from "../shared/model";
import type { PositionSearchPage } from "../shared/position-search";
import type { RitmSupply } from "../shared/ritm";
import { validateLabelPrint } from "../src/label-print";
import { bootstrap, fixture } from "./fixtures";

const origin = "https://assembly.test";
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNTcAAAAASUVORK5CYII=", "base64"));
const sha = await digest(png);
const fileId = "original-file-123456";
async function context(t: TestContext) {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  const objects = new Map<string, Uint8Array>();
  const files: FileStore = {
    async get(key) { const data = objects.get(key); return data ? { body: new Uint8Array(data).buffer, contentType: "image/png" } : null; },
    async put(key, data) { objects.set(key, new Uint8Array(data)); },
  };
  const call = (path: string, method = "GET", body?: BodyInit, role: "owner" | "collector" | "service" = "owner", requestOrigin = origin) =>
    labelsApi(new Request(origin + path, { method, body, headers: { origin: requestOrigin } }), db.store, files, role, "label-owner");
  const sourceHash = await digest("original-index");
  objects.set("legacy-backups/" + sourceHash, new TextEncoder().encode("original-index"));
  const entry = (market: "OZON" | "WB" = "OZON", sku = f.a.sku): LabelEntry => ({ market, sku, status: "found", fileIds: [fileId], sha256: sha, sources: [{ spreadsheetId: "sheet-original-1234", sheet: "Этикетки", row: 2, rawSku: sku, fileId }] });
  async function stage(entries: LabelEntry[], capturedAt = "2026-11-16T12:00:00Z") {
    const data = JSON.stringify(entries);
    const manifest: LabelManifest = { version: 1, sourceHash, capturedAt, entries: entries.length, chunks: [{ sha256: await digest(data), count: entries.length }] };
    const start = await call("/api/labels/import", "POST", JSON.stringify(manifest));
    assert.equal(start.status, 200);
    const { id } = await start.json() as { id: string };
    return { id, data, manifest, chunk: () => call(`/api/labels/chunk?import=${encodeURIComponent(id)}&part=0`, "PUT", data), activate: () => call("/api/labels/activate", "POST", JSON.stringify({ id })) };
  }
  const upload = () => call("/api/labels/file?sha256=" + sha, "PUT", png.buffer);
  return { ...f, db, objects, files, call, entry, stage, upload };
}

test("печать использует сохранённый оригинал; неполная база не включается, повтор не меняет работу или короба", async t => {
  const c = await context(t), before = await c.db.snapshot(null);
  const version = await c.stage([c.entry()]);
  assert.equal((await version.activate()).status, 409);
  assert.equal((await version.chunk()).status, 409);
  assert.equal((await c.upload()).status, 200);
  assert.equal((await c.upload()).status, 200);
  assert.equal((await version.chunk()).status, 200);
  assert.equal((await version.chunk()).status, 200);
  const beforeActivation = await c.call(`/api/labels/image?import=${encodeURIComponent(version.id)}&sha256=${sha}`);
  assert.equal(beforeActivation.status, 404);
  assert.equal((await version.activate()).status, 200);
  assert.equal((await version.activate()).status, 200);
  const result = await (await c.call("/api/labels?position=" + c.a.id, "GET", undefined, "collector")).json() as { items: PrintableLabel[] };
  assert.equal(result.items[0].status, "found");
  const image = await c.call(result.items[0].imageUrl!, "GET", undefined, "collector");
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  assert.deepEqual(await c.db.snapshot(null), before);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_label_files").get()!.n, 1);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_label_entries").get()!.n, 1);
});

test("OZON/WB разделены, конфликт оригиналов блокируется, штрихкод не подменяет этикетку", async t => {
  const c = await context(t);
  await c.cmd("supply.import", { ...fixture, externalId: "LABEL-WB", market: "WB", title: "WB · Тест", positions: fixture.positions.map(p => ({ ...p, externalId: "WB-" + p.externalId })) });
  const wb = (await c.db.snapshot(null)) as { supplies: { id: string; market: string }[] };
  const supply = wb.supplies.find(s => s.market === "WB")!;
  const wbPositions = (await c.db.snapshot(supply.id)) as { positions: { id: string; sku: string }[] };
  const conflict = c.entry("WB"); conflict.fileIds.push("another-file-123456"); conflict.status = "conflict"; conflict.sha256 = null;
  conflict.sources.push({ ...conflict.sources[0], fileId: conflict.fileIds[1], row: 3 });
  const version = await c.stage([c.entry(), conflict]);
  await c.upload(); assert.equal((await version.chunk()).status, 200); assert.equal((await version.activate()).status, 200);
  c.db.sqlite.prepare("update av2_positions set sku=sku||'(OZ)' where id=?").run(c.a.id);
  const ids = [c.a.id, wbPositions.positions.find(p => p.sku === c.a.sku)!.id, c.b.id];
  const data = await (await c.call("/api/labels?" + ids.map(id => "position=" + id).join("&"))).json() as { items: PrintableLabel[] };
  assert.deepEqual(data.items.map(i => i.status), ["found", "conflict", "barcode_only"]);
  assert.equal(data.items[1].imageUrl, undefined);
  assert.equal(labelArticle(" A001(OZ) ", "OZON"), "A001");
  assert.equal(labelArticle(" A001(OZ) ", "WB"), "A001(OZ)");
});

test("неверные байты, контрольные суммы, чужой origin и права сборщика не позволяют изменить базу", async t => {
  const c = await context(t);
  assert.equal((await c.call("/api/labels/file?sha256=" + sha, "PUT", new TextEncoder().encode("<script>wrong</script>"))).status, 409);
  assert.equal((await c.call("/api/labels/file?sha256=" + "00".repeat(32), "PUT", png.buffer)).status, 409);
  for (const role of ["collector", "service"] as const) {
    assert.equal((await c.call("/api/labels/file?sha256=" + sha, "PUT", png.buffer, role)).status, 403);
    assert.equal((await c.call("/api/labels/import", "POST", "{}", role)).status, 403);
    assert.equal((await c.call("/api/labels/files?hashes=" + sha, "GET", undefined, role)).status, 403);
  }
  assert.equal((await c.call("/api/labels/file?sha256=" + sha, "PUT", png.buffer, "owner", "https://other.test")).status, 403);
  assert.equal(c.objects.has("labels/files/" + sha), false);
  const v = await c.stage([c.entry()]);
  const corrupted = await c.call(`/api/labels/chunk?import=${encodeURIComponent(v.id)}&part=0`, "PUT", "[]");
  assert.equal(corrupted.status, 409);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_label_entries").get()!.n, 0);
});

test("превью карточки и печать позиции выбирают файл её артикула и магазина, даже если другая карточка имеет тот же псевдоним", async t => {
  const c = await context(t);
  const importId = "product-label-catalog";
  c.db.sqlite.prepare("insert into av2_catalog_imports values(?,?,?,?,?)").run(importId, "{}", "active", "now", "test");
  c.db.sqlite.prepare("update av2_meta set active_catalog_id=? where id=1").run(importId);
  const insert = c.db.sqlite.prepare("insert into av2_catalog_products values(?,?,?,?,?,?,?,?,?,?,?)");
  const shop = c.supply.store;
  const add = (market: "OZON" | "WB", store: string, sku: string, sha: string) => {
    const id = JSON.stringify([market, store, sku]);
    const product = { id, market, store, sku, name: sku, aliases: [sku, c.a.sku], barcode: "123456789000", labelSha: sha };
    insert.run(id, market, store, sku, sku, "", 0, JSON.stringify(product), 1, "test", "now");
    return id;
  };
  add("OZON", shop, "ALIAS-ONLY", "11".repeat(32));
  add("WB", shop, c.a.sku, "22".repeat(32));
  add("OZON", shop === "1" ? "2" : "1", c.a.sku, "33".repeat(32));
  const own = "44".repeat(32);
  const id = add("OZON", shop, c.a.sku, own);
  for (const query of [
    `entry=${encodeURIComponent(id)}&catalogImport=${importId}`,
    `position=${encodeURIComponent(c.a.id)}`,
  ]) {
    const response = await c.call("/api/labels?" + query);
    assert.equal(response.status, 200);
    const { items } = await response.json() as { items: PrintableLabel[] };
    assert.equal(items[0].imageUrl, "/api/catalog/media?sha256=" + own);
  }
});

test("сборщик находит позицию с неподтверждённым магазином и сразу видит сохранённую этикетку её маркетплейса", async t => {
  const c = await context(t);
  const importId = "live-label-catalog";
  c.db.sqlite.prepare("insert into av2_catalog_imports values(?,?,?,?,?)").run(importId, "{}", "active", "now", "test");
  c.db.sqlite.prepare("update av2_meta set active_catalog_id=? where id=1").run(importId);
  const shipmentId = "RITM-ROLL-7706", sku = "VD0038.A7706";
  const source: RitmSupply = {
    shipmentId, title: "OZON СПБ 2-й магазин", market: "OZON", locked: false,
    positions: [["current", sku], ["removed", sku], ["other", "OTHER-ACTIVE"]].map(([uid, article]) => ({
      positionId: `${shipmentId}|uid:${uid}|${article}`, sku: article, name: article, quantity: 5,
      sourceId: "roll-printing", sheetId: 45, row: 2, rawUid: uid, store: "", storeStatus: "missing",
    })),
  };
  const sync = async (feed: RitmSupply, sourceRevision: number) => c.cmd("ritm.import", {
    source: feed, sourceRevision, fingerprint: await digest(JSON.stringify(feed)),
  });
  await sync(source, 1);
  const [position] = await c.db.store.all<{ id: string; supplyId: string }>(
    "select id,supply_id from av2_positions where external_id=?", [source.positions[0].positionId],
  );
  await c.cmd("work.save", { positionId: position.id, employeeId: c.employee.id, operation: "packing", qty: 5 });
  const product = {
    ...Object.fromEntries(productFields.map(([key]) => [key, ""])),
    sku: sku + "(OZ)", market: "OZON", store: "2", aliases: [sku],
    name: "Товар из справочника", kind: "Наклейки", barcode: "OZN2789046032",
    unitsPerBox: 108, boxType: "О",
  };
  const save = (product: Record<string, unknown>, revision: number) => c.cmd("catalog.save", {
    importId, product, revision, create: revision === 0,
  });
  await save(product, 0);
  await save({ ...product, sku, market: "WB", barcode: "2037000000001" }, 0);
  await sync({ ...source, positions: source.positions.filter(p => p.rawUid !== "removed") }, 2);
  const readSearch = await api(new Request(`${origin}/api/positions/search?q=${sku}&supply=${c.supply.id}`), c.db, "collector", "collector");
  assert.equal(readSearch.status, 200);
  const search = await readSearch.json() as PositionSearchPage;
  assert.deepEqual(search.items.map(({ id, supplyId, packing, storeNeedsReview }) =>
    ({ id, supplyId, packing, storeNeedsReview })), [{ ...position, packing: 5, storeNeedsReview: true }]);
  const labelForPosition = async () => {
    const response = await c.call("/api/labels?position=" + position.id, "GET", undefined, "collector");
    assert.equal(response.status, 200);
    return ((await response.json()) as { items: PrintableLabel[] }).items[0];
  };
  assert.equal((await labelForPosition()).imageUrl, undefined);

  const upload = await catalogApi(new Request(origin + "/api/catalog/media", { method: "POST", body: png.buffer }),
    c.db.store, c.db, "owner", c.files);
  assert.equal(upload.status, 200);
  const old = await c.db.snapshot(position.supplyId) as Snapshot;
  await save({ ...product, name: "Обновлённое название", labelSha: sha }, 1);
  const label = await labelForPosition();
  assert.equal(label.imageUrl, "/api/catalog/media?sha256=" + sha);
  assert.equal(label.status, "found");
  assert.equal(label.name, "Обновлённое название");
  const image = await catalogApi(new Request(origin + label.imageUrl), c.db.store, c.db, "collector", c.files);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);

  const state = await c.db.snapshot(position.supplyId) as Snapshot;
  const updated = state.positions.find(p => p.id === position.id);
  assert.ok(state.revision > old.revision);
  assert.equal(updated?.name, label.name);
  assert.equal(updated?.catalog?.labelSha, sha);
  assert.equal(updated?.catalog?.kind, product.kind);
  assert.equal(updated?.catalogEntryId, null);
  assert.equal(updated?.sourceActive, false);
  assert.equal(updated?.ready, false);
  assert.equal(updated?.packing, 5);
  assert.equal(state.supplies.find(s => s.id === position.supplyId)?.store, "Не подтверждён");
  assert.deepEqual(state.works, old.works);
});

test("фильтр без этикеток проверяет весь справочник и обновляется после сохранения файла", async t => {
  const c = await context(t);
  const id = "catalog-missing-label-test";
  c.db.sqlite.prepare("insert into av2_catalog_imports values(?,?,?,?,?)").run(id, "{}", "active", "now", "test");
  c.db.sqlite.prepare("update av2_meta set active_catalog_id=? where id=1").run(id);
  const insert = c.db.sqlite.prepare("insert into av2_catalog_entries values(?,?,?,?,?,?,?,?,?,?)");
  const add = (market: "WB" | "OZON", shop: string, sku: string) => {
    const key = JSON.stringify([market, shop, sku.toUpperCase()]);
    const product = { id: key, market, store: shop, sku, barcode: "0012345678900" };
    insert.run(key, id, key, market, shop, sku, sku.toUpperCase(), "2-GO", 0, JSON.stringify(product));
    return key;
  };
  add("OZON", "1", "Тест(OZ)");
  add("WB", "1", "ТЕСТ");
  const uploadId = add("WB", "1", "MANUAL");
  const aliasId = add("WB", "1", "ALIAS");
  const absentId = add("WB", "2", "MANUAL");
  add("OZON", "2", "UNAVAILABLE");
  for (let n = 0; n < 35; n++) add("WB", "2", "ZZ-" + String(n).padStart(2, "0"));
  const original = c.entry("OZON", "ТЕСТ");
  const unavailable = { ...c.entry("OZON", "UNAVAILABLE"), status: "file_unavailable" as const, sha256: null };
  const stage = await c.stage([original, unavailable]);
  await c.upload();
  assert.equal((await stage.chunk()).status, 200);
  assert.equal((await stage.activate()).status, 200);
  const list = (query = "") => catalogList(c.db.store, new URL(origin + "/api/catalog?missingLabel=1" + query));
  const before = await list();
  assert.equal(before.total, 40);
  assert.equal(before.items.length, 30);
  assert.equal((await list("&page=20")).items.length, 10);
  assert.deepEqual((await list("&q=тест")).items.map(item => item.market), ["WB"]);

  c.db.sqlite.prepare("insert into av2_catalog_media values(?,?,?,?)").run(sha, "image/png", png.length, "now");
  const product = { id: uploadId, market: "WB", store: "1", sku: "MANUAL", aliases: ["MANUAL", "ALIAS"], labelSha: sha };
  c.db.sqlite.prepare("insert into av2_catalog_products values(?,?,?,?,?,?,?,?,?,?,?)")
    .run(uploadId, "WB", "1", "MANUAL", "MANUAL", "2-GO", 0, JSON.stringify(product), 1, "test", "now");
  assert.equal((await list()).total, 38);
  assert.equal((await list("&market=WB&store=1&q=MANUAL")).total, 0);
  assert.deepEqual((await list("&market=WB&store=2&q=MANUAL")).items.map(item => item.id), [absentId]);
  assert.equal((await list("&q=ALIAS")).total, 0);
  assert.equal((await list("&market=OZON&store=2&q=UNAVAILABLE")).total, 1);
  const aliased = await c.call("/api/labels?" + new URLSearchParams({ entry: aliasId, catalogImport: id }));
  assert.equal(((await aliased.json()) as { items: PrintableLabel[] }).items[0].status, "found");
});

test("пакетная привязка этикеток сохраняет поля и производство, проверяет свежесть карточки и не заменяет оригинал", async t => {
  const c = await context(t);
  const importId = "attach-labels-local";
  c.db.sqlite.prepare("insert into av2_catalog_imports values(?,?,?,?,?)").run(importId, "{}", "active", "now", "test");
  c.db.sqlite.prepare("update av2_meta set active_catalog_id=? where id=1").run(importId);
  const add = (sku:string) => {
    const id = JSON.stringify(["WB", "1", sku]);
    const product = {id,sku,market:"WB",store:"1",name:"Название",packaging:"П.17x22",barcode:"0012345",
      machine:"2-GO", aliases:[sku], issues:["Есть замечание"], photoUrl:null, unitsPerBox:350,
      capacitySource:"consistent", workNorms:{packing:300}, rows:[] } as unknown as ManagedProduct;
    c.db.sqlite.prepare("insert into av2_catalog_entries values(?,?,?,?,?,?,?,?,?,?)")
      .run(id, importId, id, "WB", "1", sku, "SPECIAL SEARCH " + sku, "2-GO", 1, JSON.stringify(product));
    return product;
  };
  const intended = add("ADD"), stale = add("STALE"), original = add("ORIGINAL");
  const stage = await c.stage([c.entry("WB", original.sku)]); await c.upload(); await stage.chunk(); await stage.activate();
  c.db.sqlite.prepare("insert into av2_catalog_media values(?,?,?,?)").run(sha, "image/png", png.length, "now");
  const request = (p:ManagedProduct) => ({id:p.id,sha256:sha,inputKey:labelInputKey(p),revision:0});
  const payload = {importId,entries:[request(intended),{...request(stale),inputKey:"previous"},request(original)]};
  const command = {action:"catalog.attachLabels",payload,key:crypto.randomUUID()};
  const send = (role:"owner"|"manager"|"collector") => api(new Request(origin+"/api/command",
    {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(command)}),c.db,"test",role);
  const before = await c.db.snapshot(null);
  assert.equal((await send("collector")).status,403);
  assert.equal((await send("manager")).status,403);
  const response = await send("owner");
  assert.equal(response.status,200);
  const result = await response.json() as {result:{attached:string[];skipped:{id:string}[]}};
  assert.deepEqual(result.result.attached,[intended.id]);
  assert.deepEqual(result.result.skipped.map(x => x.id),[stale.id,original.id]);
  const row = c.db.sqlite.prepare("select * from av2_catalog_products where entry_id=?").get(intended.id)!;
  const {updatedAt, ...data} = JSON.parse(String(row.data));
  assert.ok(updatedAt);
  assert.deepEqual(data,{...intended,labelSha:sha,editRevision:1});
  assert.equal(row.review,1);
  assert.equal(row.search,"SPECIAL SEARCH ADD");
  const after = await c.db.snapshot(null) as Record<string,unknown>;
  assert.deepEqual({...after,revision:(before as typeof after).revision},before);
  assert.deepEqual((await (await send("owner")).json() as typeof result).result,result.result);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_quality_repairs where kind='catalog.edit'").get()?.n,1);
});

test("обновление базы не ломает открытый оригинал; неготовая новая версия не подменяет активную", async t => {
  const c = await context(t);
  const first = await c.stage([c.entry()]);
  await c.upload(); await first.chunk(); await first.activate();
  const original = (await (await c.call("/api/labels?position=" + c.a.id)).json() as { items: PrintableLabel[] }).items[0];
  const unavailable = { ...c.entry(), status: "file_unavailable" as const, sha256: null };
  const next = await c.stage([unavailable], "2026-11-16T13:00:00Z");
  assert.equal((await next.activate()).status, 409);
  assert.equal(((await (await c.call("/api/labels?position=" + c.a.id)).json()) as { items: PrintableLabel[] }).items[0].status, "found");
  await next.chunk(); await next.activate();
  assert.equal(((await (await c.call("/api/labels?position=" + c.a.id)).json()) as { items: PrintableLabel[] }).items[0].status, "file_unavailable");
  assert.equal((await c.call(original.imageUrl!)).status, 200);
});

test("пакет печати допускает только готовые оригиналы и ограниченное целое количество", () => {
  const label: PrintableLabel = { positionId: "one", sku: "A001", name: "Товар", market: "OZON", status: "found", imageUrl: `/api/labels/image?import=labels:${"ab".repeat(32)}&sha256=${sha}` };
  assert.doesNotThrow(() => validateLabelPrint([{ label, copies: 999 }, { label, copies: 1 }], origin));
  assert.throws(() => validateLabelPrint([{ label, copies: 999 }, { label, copies: 2 }], origin), /1 000/);
  for (const copies of [0, -1, 1.2, NaN, Infinity, 1000]) assert.throws(() => validateLabelPrint([{ label, copies }], origin));
  assert.throws(() => validateLabelPrint([{ label: { ...label, status: "conflict" }, copies: 1 }], origin));
  assert.throws(() => validateLabelPrint([{ label: { ...label, imageUrl: "https://evil.test/label.png" }, copies: 1 }], origin));
  assert.throws(() => validateLabelPrint([{ label: { ...label, imageUrl: "/api/catalog/photo?id=product" }, copies: 1 }], origin));
});

test("этикетка складского товара без поставки доступна сборщику из справочника и поступления; скачивается тот же оригинал", async t => {
  const c=await context(t), sku="STOCK-ONLY(OZ)", entryId=JSON.stringify(["OZON","2",sku]);
  const product={id:entryId,market:"OZON",store:"2",sku,name:"Товар только в запас",barcode:"00123456",photoId:null};
  c.db.sqlite.prepare("insert into av2_catalog_imports values(?,?,?,?,?)").run("stock-label-catalog","{}","active",new Date().toISOString(),"test");
  c.db.sqlite.prepare("insert into av2_catalog_entries values(?,?,?,?,?,?,?,?,?,?)").run("stock-entry","stock-label-catalog",entryId,"OZON","2",sku,sku,"",0,JSON.stringify(product));
  c.db.sqlite.prepare("update av2_meta set active_catalog_id=? where id=1").run("stock-label-catalog");
  const v=await c.stage([c.entry("OZON","STOCK-ONLY")]);await c.upload();await v.chunk();await v.activate();
  const byCatalog=`/api/labels?entry=${encodeURIComponent(entryId)}&catalogImport=stock-label-catalog`;
  let result=await c.call(byCatalog,"GET",undefined,"collector");assert.equal(result.status,200);
  const label=((await result.json()) as {items:PrintableLabel[]}).items[0];
  assert.equal(label.status,"found");assert.equal(label.sku,sku);
  await c.cmd("warehouse.receive",{market:"OZON",store:"2",entryId,catalogImportId:"stock-label-catalog",employeeId:c.employee.id,qty:17,receiptMode:"receipt"});
  const receipt=c.db.sqlite.prepare("select id,carton_id from av2_warehouse_receipts where sku=?").get(sku)!;
  const before=await c.db.snapshot(c.supply.id);
  result=await c.call("/api/labels?receipt="+receipt.id,"GET",undefined,"collector");
  const stored=((await result.json()) as {items:PrintableLabel[]}).items[0];assert.equal(stored.imageUrl,label.imageUrl);
  const download=await c.call(stored.imageUrl+"&download=1&name="+encodeURIComponent("Этикетка "+sku),"GET",undefined,"collector");
  assert.equal(download.status,200);assert.match(download.headers.get("content-disposition")!,/^attachment;/);
  assert.match(download.headers.get("content-disposition")!,/filename\*=UTF-8''/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()),png);
  assert.deepEqual(await c.db.snapshot(c.supply.id),before);
  assert.equal((await c.call(byCatalog+"&position="+c.a.id)).status,409);
  assert.equal((await c.call(byCatalog.replace("stock-label-catalog","old"))).status,409);
  assert.equal((await c.call("/api/labels?receipt=missing")).status,409);
  assert.equal((await c.call("/api/labels?receipt="+receipt.id,"GET",undefined,"service")).status,403);
  const box=c.db.sqlite.prepare("select version from av2_warehouse_cartons where id=?").get(receipt.carton_id)!;
  await c.cmd("warehouse.remove",{receiptId:receipt.id,cartonId:receipt.carton_id,version:box.version,reason:"Ошибка приёмки"});
  assert.equal((await c.call("/api/labels?receipt="+receipt.id)).status,409);
  assert.equal((await c.call(byCatalog)).status,200,"catalog printing works even with no finished stock");
});
